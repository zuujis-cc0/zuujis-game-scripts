/* game-assets.js v0.6.0 — loader for the shared asset library in public/assets/.
 *
 * One copy of every asset, for every game: improve a file in public/assets, run scripts/stamp-assets.py --library and
 * scripts/deploy-games.sh, and every game that uses it shows the new one (no build). Never copy a library file into a
 * game; ask for it by its library path.
 *
 *   await GameAssets.ready()                         // fetches files.json, the library's index (never cached)
 *   GameAssets.has('painted/props/oak-summer.webp')  // after ready(): is it in the library?
 *   GameAssets.url('painted/props/oak-summer.webp')  // -> /assets/painted/props/oak-summer.webp?v=<hash> after ready()
 *   await GameAssets.load()                          // fetches manifest.json (cached)
 *   GameAssets.packs                                 // manifest.packs, after load()
 *   GameAssets.url('pixel/characters.png')           // -> site-relative URL
 *   await GameAssets.image('backgrounds/meadow-day/1.png')
 *   await GameAssets.packImage('kenney-boardgame', 'PNG/Dice/dieRed3.png')    // any image file inside a manifest pack
 *
 *   // Sprite sheets we generate (characters, towers): one row per sprite, frames across.
 *   const chars = await GameAssets.sprites('zuujis-characters');
 *   chars.draw(ctx, 'soldier', frame, x, y, { scale: 3, flip: false, alpha: 1 });
 *   chars.names  chars.frames('soldier')
 *
 *   // The other generated sheets use the same call: 'zuujis-tiles' (terrain, autotiles, props), 'zuujis-items' (items, icons),
 *   // 'zuujis-fx' (effects, ~12 fps strips). Tile names: grass, path_ne, shore_nesw, tree, slot, portal, keep ...
 *   const tiles2 = await GameAssets.sprites('zuujis-tiles'); tiles2.draw(ctx, 'path_ew', 0, x, y, { scale: 3 });   // draw(ctx, name, frame, x, y, opts)
 *
 *   // Bitmap font (white glyphs, tinted per colour). Lower case is drawn as upper case.
 *   const f = await GameAssets.font('zuujis-font');
 *   f.draw(ctx, 'SCORE 120', x, y, { scale: 2, color: '#ffd23f', align: 'left|center|right', shadow: '#000' });  f.width('TEXT', 2)
 *
 *   // 9-slice UI frames and bars from 'zuujis-ui' (8px cells, drawn scaled)
 *   const ui = await GameAssets.ui();
 *   ui.panel(ctx, 'panel', x, y, w, h, { scale: 3 });  ui.bar(ctx, 'bar_green', x, y, w, 0.65, { scale: 3 });
 *
 *   // Icons for DOM and canvas HUDs (dataURL-backed, so they can go in <img>, CSS or ctx.drawImage):
 *   const I = await GameAssets.icons();              // the 'zuujis-items' sheet; GameAssets.icons('zuujis-fx') for another
 *   I.img('heart', 2)    // <img> at 2x (32px)      I.url('coin', 3, frame)    I.canvas('icon_trophy', 2)
 *   I.draw(ctx, 'heart', x, y, { scale: 2, frame: 0 })                        // sync once the promise has resolved
 *   // Markup only: <div data-ga-icon="icon_trophy" data-ga-scale="2">🏆</div> is swapped for the icon when the page loads
 *   // (the emoji stays if the assets fail to load).
 *   // Several images from a pack in one go: const m = await GameAssets.images('kenney-boardgame', ['PNG/Dice/dieRed3.png'])  -> m[file]
 *
 *   // Pixel-art canvases: draw at native size (e.g. 16px cells) and let this scale them in half steps (1x, 1.5x, 2x...):
 *   GameAssets.fitPixelCanvas(canvas, { reserveY: 220 })   // sets CSS size + image-rendering; refits on resize; returns the scale
 *   // Logical-unit games: canvas.width = W / 2; ctx.scale(0.5, 0.5); ctx.imageSmoothingEnabled = false;
 *   //   GameAssets.fitPixelCanvas(canvas, { pixel: 2, width: W, height: H, reserveY: 190 })
 *
 *   // Kenney-style tile sheets (Tiny Battle/Dungeon/Town), addressed by tile index.
 *   const tiles = await GameAssets.tilesheet('kenney-tiny-battle');
 *   tiles.draw(ctx, index, x, y, { scale: 3, flip: false })   // tiles.cols, tiles.rows, tiles.tile
 *
 *   // Pixel effects (pack zuujis-pixel-effects, vfx/pixel/<category>/<effect>/): strips of frames, 15 fps.
 *   const fx = await GameAssets.vfx('explosions/large_fireball');
 *   fx.draw(ctx, timeSeconds, x, y, { scale: 1, loop: false })  // returns false once finished
 *
 *   // Audio (Web Audio, decoded once and cached)
 *   GameAssets.sfx.play('kenney-ui-audio', 'click1', { volume: 0.6 })
 *   GameAssets.music.*: kept for older games, plays nothing (games have no music; the site's radio does).
 *
 * Paths are built at runtime (never a bare quoted directory) so crawlers do not
 * mistake them for pages. Pixel sheets are drawn with smoothing off.
 */
(function (global) {
  'use strict';

  const BASE = ['', 'assets', ''].join('/');
  const cache = { json: {}, img: {}, buf: {} };
  let ac = null, master = null, manifest = null;

  const enc = p => p.split('/').map(encodeURIComponent).join('/');
  let files = null, filesP = null;
  // The library's index {path: hash}. Fetched fresh so a deploy is seen at once; the files are then asked for by hash.
  function ready() {
    return filesP || (filesP = fetch(BASE + 'files.json?t=' + Date.now(), { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : {})).then(j => { files = (j && j.files) || {}; return files; })
      .catch(() => { files = {}; return files; }));
  }
  // `/library/<key>/<file>`: a zuujis-cc0 library item added in the Studio (fixed content, served by this site).
  const LIB = /^\/library\/[0-9a-f]{16}\//;
  const url = p => LIB.test(p) ? p : BASE + enc(p) + (files && files[p] ? '?v=' + files[p] : '');
  const has = p => LIB.test(p) || !!(files && files[p]);

  function fetchJson(p) {
    return cache.json[p] || (cache.json[p] = ready().then(() => fetch(url(p))).then(r => {
      if (!r.ok) throw new Error('GameAssets: ' + p + ' -> ' + r.status);
      return r.json();
    }));
  }
  function image(p) {
    return cache.img[p] || (cache.img[p] = ready().then(() => new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('GameAssets: cannot load ' + p));
      i.src = url(p);
    })));
  }
  async function packImage(name, file) {
    const p = await pack(name);
    return image(p.dir + '/' + file);
  }
  async function load() {
    if (!manifest) manifest = await fetchJson('manifest.json');
    api.packs = manifest.packs;
    return manifest;
  }
  async function pack(name) {
    await load();
    const p = manifest.packs[name];
    if (!p) throw new Error('GameAssets: unknown pack ' + name);
    return p;
  }

  function put(ctx, img, sx, sy, sw, sh, x, y, o) {
    const s = (o && o.scale) || 1, flip = o && o.flip;
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    if (o && o.alpha != null) ctx.globalAlpha = o.alpha;
    if (flip) { ctx.translate(x + sw * s, y); ctx.scale(-1, 1); x = 0; y = 0; }
    ctx.drawImage(img, sx, sy, sw, sh, flip ? 0 : x, flip ? 0 : y, sw * s, sh * s);
    ctx.restore();
  }

  async function sprites(name) {
    const p = await pack(name);
    const img = await image(p.dir + '/' + p.image);
    const [cw, ch] = p.cell;
    return {
      img, cell: [cw, ch], names: Object.keys(p.sprites),
      frames: n => p.sprites[n].frames,
      row: n => p.sprites[n].row,
      draw(ctx, n, frame, x, y, o) {
        const s = p.sprites[n];
        if (!s) return;
        put(ctx, img, (frame % s.frames) * cw, s.row * ch, cw, ch, x, y, o);
      },
    };
  }

  async function tilesheet(name) {
    const p = await pack(name);
    const img = await image(p.dir + '/' + p.image);
    const t = p.tile;
    return {
      img, tile: t, cols: p.cols, rows: p.rows,
      draw(ctx, i, x, y, o) { put(ctx, img, (i % p.cols) * t, Math.floor(i / p.cols) * t, t, t, x, y, o); },
    };
  }

  async function vfx(path) {
    const dir = 'vfx/pixel/' + path;
    const [img, txt] = await Promise.all([
      image(dir + '/spritesheet.png'),
      cache.json[dir] || (cache.json[dir] = ready().then(() => fetch(url(dir + '/spritesheet.txt'))).then(r => r.text())),
    ]);
    const rects = String(txt).trim().split('\n').map(l => l.split('=')[1].trim().split(/\s+/).map(Number));
    const n = rects.length, fps = 15;
    return {
      img, frames: n, fps, w: rects[0][2], h: rects[0][3],
      draw(ctx, t, x, y, o) {                          // x,y = centre
        const loop = o && o.loop, f = Math.floor(t * fps);
        if (!loop && f >= n) return false;
        const r = rects[f % n], s = (o && o.scale) || 1;
        put(ctx, img, r[0], r[1], r[2], r[3], x - r[2] * s / 2, y - r[3] * s / 2, o);
        return true;
      },
    };
  }

  // ---- icons (dataURL-backed) ----
  const iconSets = {};
  function icons(sheetName) {
    sheetName = sheetName || 'zuujis-items';
    return iconSets[sheetName] || (iconSets[sheetName] = sprites(sheetName).then(sh => {
      const [cw, ch] = sh.cell, urls = {};
      function canvas(name, scale, frame) {
        const s = scale || 2, c = document.createElement('canvas');
        c.width = cw * s; c.height = ch * s;
        sh.draw(c.getContext('2d'), name, frame || 0, 0, 0, { scale: s });
        return c;
      }
      function url(name, scale, frame) {
        const k = name + '|' + (scale || 2) + '|' + (frame || 0);
        return urls[k] || (urls[k] = canvas(name, scale, frame).toDataURL());
      }
      function img(name, scale, frame) {
        const s = scale || 2, i = new Image();
        i.src = url(name, s, frame); i.width = cw * s; i.height = ch * s; i.alt = ''; i.draggable = false;
        i.className = 'ga-i'; i.style.imageRendering = 'pixelated'; i.style.verticalAlign = 'middle';
        return i;
      }
      return { sheet: sh, canvas, url, img, draw: (ctx, name, x, y, o) => sh.draw(ctx, name, (o && o.frame) || 0, x, y, o) };
    }));
  }
  async function images(packName, files) {
    const out = {};
    await Promise.all(files.map(f => packImage(packName, f).then(i => { out[f] = i; }, () => {})));
    return out;
  }
  function hydrate(root) {
    const els = (root || document).querySelectorAll('[data-ga-icon]');
    if (!els.length) return;
    icons().then(I => els.forEach(el => {
      try { el.replaceChildren(I.img(el.getAttribute('data-ga-icon'), +el.getAttribute('data-ga-scale') || 2)); } catch (_) {}
    })).catch(() => {});
  }
  if (global.document) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => hydrate()); else hydrate();
  }

  // ---- pixel canvas ----
  // For a game whose code works in logical units (say 420x520): set canvas.width/height to logical/pixel, ctx.scale(1/pixel),
  // then draw everything as before; sprites drawn at `pixel` times their size land 1:1 on canvas pixels. This picks the CSS size
  // so every art pixel is a whole number of screen pixels (half steps when pixel is 1).
  function fitPixelCanvas(canvas, o) {
    canvas.__gaOpts = o || {};
    if (canvas.__gaFit) return canvas.__gaFit();               // already wired: just refit with the new options
    const fit = () => {
      const o = canvas.__gaOpts, pixel = o.pixel || 1, lw = o.width || canvas.width * pixel, lh = o.height || canvas.height * pixel;
      const max = o.maxScale || 4, step = pixel === 1 ? 0.5 : 1;
      const r = Math.min((global.innerWidth - (o.reserveX || 0)) / lw, (global.innerHeight - (o.reserveY || 0)) / lh) * pixel;   // css px per art px
      const s = r >= 1 ? Math.min(max, Math.floor(r / step) * step) : Math.max(0.25, r);
      canvas.style.width = Math.round(canvas.width * s) + 'px'; canvas.style.height = Math.round(canvas.height * s) + 'px';
      canvas.style.imageRendering = 'pixelated';
      return s;
    };
    canvas.__gaFit = fit;
    global.addEventListener('resize', fit);
    return fit();
  }

  // ---- bitmap font ----
  const tint = {};
  async function font(name) {
    const p = await pack(name || 'zuujis-font');
    const img = await image(p.dir + '/' + p.image);
    const [cw, ch] = p.cell, cols = p.cols, chars = p.chars;
    const idx = c => { const i = chars.indexOf(c); return i >= 0 ? i : chars.indexOf(c.toUpperCase()); };
    function sheetFor(color) {
      const key = name + color;
      if (!tint[key]) {
        const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
        const x = c.getContext('2d');
        x.drawImage(img, 0, 0); x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
        tint[key] = c;
      }
      return tint[key];
    }
    function width(text, scale) { return String(text).length * cw * (scale || 1) - (scale || 1); }
    function draw(ctx, text, x, y, o) {
      o = o || {};
      const s = o.scale || 1, color = o.color || '#ffffff', t = String(text);
      if (o.align === 'center') x -= width(t, s) / 2; else if (o.align === 'right') x -= width(t, s);
      const passes = o.shadow ? [[s, s, o.shadow], [0, 0, color]] : [[0, 0, color]];
      ctx.save(); ctx.imageSmoothingEnabled = false;
      for (const [dx, dy, col] of passes) {
        const sh = sheetFor(col);
        for (let k = 0; k < t.length; k++) {
          const i = idx(t[k]); if (i < 0 || t[k] === ' ') continue;
          ctx.drawImage(sh, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch, Math.round(x + dx + k * cw * s), Math.round(y + dy), cw * s, ch * s);
        }
      }
      ctx.restore();
    }
    return { draw, width, cell: [cw, ch] };
  }

  // ---- 9-slice UI ----
  async function ui() {
    const sh = await sprites('zuujis-ui'), C = sh.cell[0];
    return {
      sheet: sh,
      // panel / button / slot styles are 9 frames (tl t tr l c r bl b br)
      panel(ctx, style, x, y, w, h, o) {
        const s = (o && o.scale) || 1, c = C * s;
        w = Math.max(w, 2 * c); h = Math.max(h, 2 * c);
        const xs = [x, x + c, x + w - c], ws = [c, w - 2 * c, c], ys = [y, y + c, y + h - c], hs = [c, h - 2 * c, c];
        for (let r = 0; r < 3; r++) for (let q = 0; q < 3; q++) {
          ctx.save(); ctx.imageSmoothingEnabled = false;
          const fr = r * 3 + q, n = sh.frames(style);
          ctx.drawImage(sh.img, (fr % n) * C, sh.row(style) * C, C, C, xs[q], ys[r], ws[q], hs[r]);
          ctx.restore();
        }
      },
      // bar styles are [left cap, middle, right cap]; 'bar_empty' is the track, value 0..1 fills from the left
      bar(ctx, style, x, y, w, value, o) {
        const s = (o && o.scale) || 1, c = C * s;
        const paint = st => {
          const row = sh.row(st) * C;
          ctx.drawImage(sh.img, 0, row, C, C, x, y, c, c);
          ctx.drawImage(sh.img, C, row, C, C, x + c, y, w - 2 * c, c);
          ctx.drawImage(sh.img, 2 * C, row, C, C, x + w - c, y, c, c);
        };
        ctx.save(); ctx.imageSmoothingEnabled = false;
        paint('bar_empty');
        const v = Math.max(0, Math.min(1, value == null ? 1 : value));
        if (v > 0) { ctx.beginPath(); ctx.rect(x, y, w * v, c); ctx.clip(); paint(style); }
        ctx.restore();
      },
    };
  }

  // ---- audio ----
  function audio() {
    if (!ac) {
      const AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return null;
      ac = new AC(); master = ac.createGain(); master.gain.value = 0.8; master.connect(ac.destination);
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  // Seconds of near-silence (under -50 dBFS) a sound starts with, less 3 ms, at most 0.25 s: played from there, so a
  // file that begins late (many Kenney "digital" sounds wait 60-170 ms) still sounds the moment the game asks for it.
  function leadOf(buf) {
    if (buf._lead != null) return buf._lead;
    const t = 0.00316, max = Math.floor(buf.sampleRate * 0.25);
    let first = max;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch), n = Math.min(d.length, first);
      for (let i = 0; i < n; i++) if (d[i] > t || d[i] < -t) { first = i; break; }
    }
    return (buf._lead = first >= max ? 0 : Math.max(0, first / buf.sampleRate - 0.003));
  }
  async function buffer(packName, file) {
    const p = await pack(packName);
    const key = p.dir + '/' + file;
    if (!cache.buf[key]) {
      cache.buf[key] = ready().then(() => fetch(url(key))).then(r => r.arrayBuffer()).then(b => new Promise((res, rej) => {
        const c = audio(); if (!c) return rej(new Error('no audio'));
        c.decodeAudioData(b, res, rej);
      }));
    }
    return cache.buf[key];
  }
  const sfx = {
    async play(packName, name, o) {
      o = o || {};
      const p = await pack(packName);
      const file = p.files.find(f => f === name || f.replace(/\.\w+$/, '') === name);
      if (!file) return null;
      const buf = await buffer(packName, file), c = audio();
      const src = c.createBufferSource(), g = c.createGain();
      src.buffer = buf; src.playbackRate.value = o.rate || 1; g.gain.value = o.volume == null ? 1 : o.volume;
      src.connect(g); g.connect(master); src.start(0, leadOf(buf));
      return src;
    },
    preload(packName, names) { return Promise.all(names.map(n => pack(packName).then(p => buffer(packName, p.files.find(f => f.replace(/\.\w+$/, '') === n || f === n))))); },
    volume(v) { audio(); master.gain.value = v; },
  };
  // Games have no music: music is the site's (Zuujis Radio on every page, which follows the player between games and sites).
  const musicApi = { async play() {}, stop() {}, volume() {} };

  const api = { url, has, ready, load, image, packImage, sprites, tilesheet, vfx, font, ui, icons, images, hydrate, fitPixelCanvas, sfx, music: musicApi, packs: null, audio };
  global.GameAssets = api;
})(window);
