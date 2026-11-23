/**
 * game-pad.js v0.1.0 — GamePad: a game's own gamepad mapping, played as its keys.
 * Plain script, no dependencies. Sets window.GamePad.
 *
 * A game that already plays with the keyboard names which pad button (or stick) presses which key, and the pad then
 * sends real keydown/keyup events (with `code` and `key`) on `document`, so the game's own key code handles both:
 *
 *   GamePad.start({ a: 'Space', b: 'KeyX', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
 *                   stick: 'arrows' });          // left stick as the arrows ('wasd', or omit)
 *
 * Button names (the standard layout every browser reports): a b x y lb rb lt rt select start ls rs up down left right.
 * A value may be one code or a list of codes. Each press sends one keydown (repeat: false) and one keyup on release,
 * however many pads or buttons hold the same key. `rstick: 'arrows' | 'wasd'` maps the right stick the same way.
 *
 * For analog control read the sticks yourself each frame: GamePad.stick() -> { lx, ly, rx, ry, lt, rt } (sticks -1..1
 * with a small dead zone, triggers 0..1), and GamePad.connected tells whether a pad is plugged in.
 * Loading this script also tells the play page not to add its generic gamepad shim.
 */
(function () {
  'use strict';
  const BUTTONS = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, select: 8, start: 9, ls: 10, rs: 11, up: 12, down: 13, left: 14, right: 15 };
  const DIRS = { arrows: ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], wasd: ['KeyW', 'KeyS', 'KeyA', 'KeyD'] };
  const KEYS = { Space: ' ', Enter: 'Enter', Escape: 'Escape', ShiftLeft: 'Shift', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
  const keyOf = (code) => KEYS[code] || (/^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : /^Digit\d$/.test(code) ? code.slice(5) : code);
  const dead = (v, d) => Math.abs(v) < d ? 0 : (v - Math.sign(v) * d) / (1 - d);

  let map = {}, held = new Set(), running = false;
  const sticks = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };

  function send(code, down) {
    document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: keyOf(code), bubbles: true, cancelable: true }));
  }
  function poll() {
    if (!running) return;
    const want = new Set();
    let lx = 0, ly = 0, rx = 0, ry = 0, lt = 0, rt = 0, any = false;
    for (const pad of (navigator.getGamepads ? navigator.getGamepads() : [])) {
      if (!pad || !pad.connected) continue;
      any = true;
      const b = (i) => pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.5);
      for (const [name, codes] of Object.entries(map)) {
        if (name === 'stick' || name === 'rstick') continue;
        if (BUTTONS[name] !== undefined && b(BUTTONS[name])) for (const c of [].concat(codes)) want.add(c);
      }
      const ax = (i) => pad.axes[i] || 0;
      for (const [name, x, y] of [['stick', 0, 1], ['rstick', 2, 3]]) {
        const dirs = DIRS[map[name]];
        if (!dirs) continue;
        if (ax(y) < -0.5) want.add(dirs[0]); if (ax(y) > 0.5) want.add(dirs[1]);
        if (ax(x) < -0.5) want.add(dirs[2]); if (ax(x) > 0.5) want.add(dirs[3]);
      }
      // the strongest pad wins each analog value
      const pick = (cur, v) => Math.abs(v) > Math.abs(cur) ? v : cur;
      lx = pick(lx, dead(ax(0), 0.12)); ly = pick(ly, dead(ax(1), 0.12)); rx = pick(rx, dead(ax(2), 0.12)); ry = pick(ry, dead(ax(3), 0.12));
      lt = Math.max(lt, pad.buttons[6] ? pad.buttons[6].value : 0); rt = Math.max(rt, pad.buttons[7] ? pad.buttons[7].value : 0);
    }
    Object.assign(sticks, { lx, ly, rx, ry, lt, rt });
    GamePad.connected = any;
    for (const c of want) if (!held.has(c)) send(c, true);
    for (const c of held) if (!want.has(c)) send(c, false);
    held = want;
    requestAnimationFrame(poll);
  }

  window.GamePad = {
    version: '0.1.0',
    connected: false,
    /** Start mapping pad buttons to key codes (see the top of this file). Calling it again replaces the mapping. */
    start(mapping) { map = mapping || {}; if (!running) { running = true; requestAnimationFrame(poll); } },
    /** Stop, releasing any key a pad still holds. */
    stop() { running = false; for (const c of held) send(c, false); held = new Set(); },
    /** The sticks and triggers now: { lx, ly, rx, ry, lt, rt }. */
    stick() { return Object.assign({}, sticks); },
  };
})();
