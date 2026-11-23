#!/usr/bin/env python3
"""Play every starter in headless Firefox and report what broke. Standard library only.

    python3 scripts/smoke.py                 # all starters, desktop and phone sizes
    python3 scripts/smoke.py platformer      # one starter

Serves this folder on a free local port (as its README says to), opens each starter at 1280x800 and as a phone
(375x667, touch), presses Space, and fails (exit 1) on a script error, a file that would not load, or a page that
stayed blank. Needs Firefox (set FIREFOX=/path/to/firefox if it is not found). Sound is muted.
"""
import functools
import http.server
import os
import socketserver
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
import bidi  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SIZES = [("desktop", 1280, 800, False), ("phone", 375, 667, True)]
MUTE = "try{localStorage.setItem('gameSfxMuted','1');window.GameSfx&&GameSfx.mute&&GameSfx.mute(true)}catch(e){};1"


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(Quiet, directory=str(ROOT))
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def play(ff, base, name, w, h, mobile):
    errors = []
    ctx = ff.call("browsingContext.create", {"type": "tab"})["context"]

    def on_event(method, p):
        c = p.get("context") or (p.get("source") or {}).get("context")
        if c != ctx:
            return
        if method == "log.entryAdded" and p.get("level") == "error":
            errors.append(str(p.get("text", ""))[:200])
        elif method == "network.responseCompleted" and p["response"]["status"] >= 400:
            url = p["request"]["url"].replace(base, "")
            if not url.endswith("favicon.ico"):
                errors.append(f"{p['response']['status']} {url}")
        elif method == "network.fetchError" and "ABORT" not in p.get("errorText", ""):
            errors.append(f"{p.get('errorText')} {p['request']['url'].replace(base, '')}")

    ff.handlers.append(on_event)
    try:
        ff.call("browsingContext.setViewport", {"context": ctx, "viewport": {"width": w, "height": h}})
        ff.call("browsingContext.navigate", {"context": ctx, "url": f"{base}/starters/{name}.html", "wait": "complete"}, 30)
        ff.evaluate(ctx, MUTE)
        time.sleep(2.5)
        ff.call("input.performActions", {"context": ctx, "actions": [{"type": "key", "id": "k", "actions": [
            {"type": "keyDown", "value": " "}, {"type": "pause", "duration": 120}, {"type": "keyUp", "value": " "}]}]})
        time.sleep(1.5)
        png = ff.call("browsingContext.captureScreenshot", {"context": ctx})["data"]
        import base64
        stats = bidi.blank_stats(base64.b64decode(png))
        if stats.get("blank"):
            errors.append("the page stayed blank")
    except bidi.BiDiError as e:
        errors.append(str(e)[:200])
    finally:
        ff.handlers.remove(on_event)
        try:
            ff.call("browsingContext.close", {"context": ctx})
        except bidi.BiDiError:
            pass
    return errors


def main():
    names = sys.argv[1:] or sorted(p.stem for p in (ROOT / "starters").glob("*.html"))
    server, base = serve()
    failed = 0
    try:
        for label, w, h, mobile in SIZES:
            ff = bidi.Firefox(mobile=mobile)
            try:
                for name in names:
                    errors = play(ff, base, name, w, h, mobile)
                    print(f"{'FAIL' if errors else 'ok  '} {label:7} {name}")
                    for e in dict.fromkeys(errors):
                        print(f"       {e}")
                    failed += bool(errors)
            finally:
                ff.cleanup()
    finally:
        server.shutdown()
    print(f"\n{failed} failure(s)" if failed else "\nAll starters played.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
