"""A tiny WebDriver BiDi client over a hand-written WebSocket, plus a headless-Firefox launcher.
Standard library only. Used by shot.py."""
import atexit
import base64
import json
import os
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import threading
import time
import urllib.request
import zlib

class WebSocket:
    """Client side of RFC 6455: text frames only (what DevTools speaks)."""

    def __init__(self, host, port, path):
        self.sock = socket.create_connection((host, port), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
                           f"Sec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("websocket handshake failed")
            buf += chunk
        head, _, self.buf = buf.partition(b"\r\n\r\n")
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ConnectionError("websocket handshake refused: " + head.split(b"\r\n")[0].decode(errors="replace"))
        self.sock.settimeout(None)
        self.send_lock = threading.Lock()

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(1 << 16)
            if not chunk:
                raise ConnectionError("websocket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text, opcode=1):
        data = text.encode("utf-8") if isinstance(text, str) else text
        header = bytes([0x80 | opcode])
        n = len(data)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 1 << 16:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i & 3] for i, b in enumerate(data)) if n < 4096 else _mask_big(data, mask)
        with self.send_lock:
            self.sock.sendall(header + mask + masked)

    def recv(self):
        """The next text message (None when closed)."""
        message, opcode0 = b"", None
        while True:
            b0, b1 = self._read(2)
            fin, opcode, n = b0 & 0x80, b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            payload = self._read(n) if n else b""
            if opcode == 8:
                return None
            if opcode == 9:
                self.send(payload, 10)
                continue
            if opcode == 10:
                continue
            if opcode in (1, 2):
                opcode0, message = opcode, payload
            else:
                message += payload
            if fin:
                return message.decode("utf-8", "replace")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def _mask_big(data, mask):
    key = (mask * (len(data) // 4 + 1))[:len(data)]
    return (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(len(data), "big")

MOBILE_UA = ("Mozilla/5.0 (Android 14; Mobile; rv:159.0) Gecko/159.0 Firefox/159.0")

FIREFOX_CANDIDATES = [
    os.environ.get("FIREFOX", ""),
    "/Applications/Firefox.app/Contents/MacOS/firefox",
    "/Applications/Firefox Nightly.app/Contents/MacOS/firefox",
    "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox",
    "firefox", "firefox-esr",
]


def find_firefox():
    for c in FIREFOX_CANDIDATES:
        if not c:
            continue
        if os.path.isabs(c):
            if os.path.isfile(c) and os.access(c, os.X_OK):
                return c
        elif shutil.which(c):
            return shutil.which(c)
    return None


class BiDiError(Exception):
    pass


PREFS = {
    # no first-run pages, updates, telemetry or network chatter
    "browser.shell.checkDefaultBrowser": False, "app.update.enabled": False, "app.update.auto": False,
    "datareporting.policy.dataSubmissionEnabled": False, "toolkit.telemetry.enabled": False,
    "toolkit.telemetry.reportingpolicy.firstRun": False, "browser.aboutwelcome.enabled": False,
    "browser.startup.homepage_override.mstone": "ignore", "startup.homepage_welcome_url": "",
    "network.captive-portal-service.enabled": False, "browser.safebrowsing.malware.enabled": False,
    "browser.safebrowsing.phishing.enabled": False, "extensions.update.enabled": False,
    "network.connectivity-service.enabled": False, "browser.search.update": False,
    # games: sound allowed to start without a click, but silent
    "media.autoplay.default": 0, "media.autoplay.blocking_policy": 0, "media.volume_scale": "0.0",
    # a game tab must keep running whatever else is going on
    "dom.min_background_timeout_value": 4, "privacy.reduceTimerPrecision": False,
}


class Firefox:
    """A headless Firefox of our own (temp profile) with its WebDriver BiDi session."""

    def __init__(self, mobile=False):
        exe = find_firefox()
        if not exe:
            raise RuntimeError("no Firefox found (set FIREFOX=/path/to/firefox)")
        self.profile = tempfile.mkdtemp(prefix="gamefox-")
        prefs = dict(PREFS)
        if mobile:
            prefs["dom.w3c_touch_events.enabled"] = 1
            prefs["general.useragent.override"] = MOBILE_UA
        with open(os.path.join(self.profile, "user.js"), "w") as f:
            for k, v in prefs.items():
                f.write("user_pref(%s, %s);\n" % (json.dumps(k), json.dumps(v)))
        self.proc = subprocess.Popen([exe, "--headless", "--no-remote", "--profile", self.profile,
                                      "--remote-debugging-port", "0"],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     # Its own process group, so cleanup() can end the content processes too.
                                     start_new_session=True)
        _LIVE.add(self)
        info = os.path.join(self.profile, "WebDriverBiDiServer.json")
        deadline = time.time() + 40
        port = None
        while time.time() < deadline:
            if self.proc.poll() is not None:
                self.cleanup()
                raise RuntimeError("Firefox exited at start")
            try:
                with open(info) as f:
                    port = json.load(f)["ws_port"]
                break
            except (OSError, ValueError, KeyError):
                time.sleep(0.1)
        if port is None:
            self.cleanup()
            raise RuntimeError("Firefox did not open its WebDriver BiDi port")
        self.lock = threading.Lock()
        self.next_id = 0
        self.waiting = {}
        self.handlers = []
        self.closed = False
        for _ in range(100):  # the port file is written a moment before the server accepts
            try:
                self.ws = WebSocket("127.0.0.1", port, "/session")
                break
            except (ConnectionError, OSError):
                time.sleep(0.1)
        else:
            self.cleanup()
            raise RuntimeError("cannot connect to Firefox's BiDi port")
        threading.Thread(target=self._reader, daemon=True).start()
        self.call("session.new", {"capabilities": {}})
        self.call("session.subscribe", {"events": [
            "log.entryAdded", "network.responseCompleted", "network.fetchError",
            "browsingContext.load", "browsingContext.userPromptOpened"]})

    def _reader(self):
        try:
            while True:
                text = self.ws.recv()
                if text is None:
                    break
                msg = json.loads(text)
                if msg.get("type") in ("success", "error") or "id" in msg and "method" not in msg:
                    with self.lock:
                        slot = self.waiting.pop(msg.get("id"), None)
                    if slot:
                        slot["msg"] = msg
                        slot["event"].set()
                elif msg.get("type") == "event":
                    for h in list(self.handlers):
                        try:
                            h(msg["method"], msg.get("params", {}))
                        except Exception:
                            pass
        except (ConnectionError, OSError, ValueError):
            pass
        self.closed = True
        with self.lock:
            for slot in self.waiting.values():
                slot["msg"] = {"type": "error", "error": "connection closed", "message": "Firefox went away"}
                slot["event"].set()
            self.waiting.clear()

    def call(self, method, params=None, timeout=30):
        slot = {"event": threading.Event(), "msg": None}
        with self.lock:
            self.next_id += 1
            mid = self.next_id
            self.waiting[mid] = slot
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        if not slot["event"].wait(timeout):
            with self.lock:
                self.waiting.pop(mid, None)
            raise BiDiError(f"{method}: timed out after {timeout}s")
        msg = slot["msg"]
        if msg.get("type") == "error":
            raise BiDiError(f"{method}: {msg.get('error')}: {msg.get('message')}")
        return msg.get("result", {})

    def evaluate(self, context, expression, timeout=30):
        """Evaluates a JS expression (promises awaited); the value comes back as JSON text parsed here."""
        wrapped = "(async()=>{const v=await (0,eval)(%s);return JSON.stringify(v===undefined?null:v)})()" % json.dumps(expression)
        r = self.call("script.evaluate", {"expression": wrapped, "target": {"context": context},
                                          "awaitPromise": True}, timeout)
        if r.get("type") == "exception":
            d = r["exceptionDetails"]
            raise BiDiError("evaluate: " + str(d.get("text")))
        return json.loads(r["result"]["value"])

    def cleanup(self):
        """Ends this Firefox and every process it started (the whole group), then removes its profile."""
        _LIVE.discard(self)
        try:
            self.ws.close()
        except Exception:
            pass
        for sig, wait in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
            try:
                os.killpg(self.proc.pid, sig)
            except (ProcessLookupError, PermissionError):
                break
            try:
                self.proc.wait(wait)
            except subprocess.TimeoutExpired:
                continue
            # The parent is gone; make sure no child of the group is left either.
            try:
                os.killpg(self.proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            break
        shutil.rmtree(self.profile, ignore_errors=True)


# Every Firefox still running, ended on exit, Ctrl-C or SIGTERM, whatever path the script leaves by.
_LIVE = set()


def _end_all(*_):
    for ff in list(_LIVE):
        ff.cleanup()


def _on_signal(signum, _frame):
    _end_all()
    raise SystemExit(128 + signum)


atexit.register(_end_all)
for _sig in (signal.SIGTERM, signal.SIGHUP):
    try:
        signal.signal(_sig, _on_signal)
    except (ValueError, OSError):
        pass


# ---- PNG decoding (8-bit, non-interlaced; enough for Chrome's screenshots) ----------------------------------

def decode_png(data):
    """Returns (width, height, channels, rows) with rows a list of bytearrays."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat, w = 8, b"", None
    while pos < len(data):
        n, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert depth == 8 and interlace == 0 and ctype in (2, 6, 0), "unsupported PNG"
        elif kind == b"IDAT":
            idat += body
        pos += 12 + n
    ch = {0: 1, 2: 3, 6: 4}[ctype]
    raw = zlib.decompress(idat)
    stride = w * ch
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        line = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if f == 1:
            for i in range(ch, stride):
                line[i] = (line[i] + line[i - ch]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                left = line[i - ch] if i >= ch else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - ch] if i >= ch else 0
                b = prev[i]
                c = prev[i - ch] if i >= ch else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        rows.append(line)
        prev = line
    return w, h, ch, rows


def blank_stats(png):
    """How uniform a screenshot is: the share of the commonest colour (4 bits per channel) and the number of
    distinct colours."""
    w, h, ch, rows = decode_png(png)
    counts = {}
    for row in rows:
        for x in range(0, w * ch, ch):
            key = (row[x] >> 4, row[x + 1 if ch > 1 else x] >> 4, row[x + 2 if ch > 1 else x] >> 4)
            counts[key] = counts.get(key, 0) + 1
    top = max(counts.items(), key=lambda kv: kv[1])
    return {"dominant_share": top[1] / (w * h), "dominant": "#%x%x%x" % top[0], "colors": len(counts)}
