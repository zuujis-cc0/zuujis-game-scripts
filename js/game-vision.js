/* game-vision.js v0.2.0 -> GameVision
 *
 * A painted, isometric little world for showing a vision: a place you can pan and zoom around, with glowing notes to
 * tap, a guided tour, seasons, day and night, people and vehicles going about, and buildings rising into place. Drawn
 * with the shared library's painted art (public/assets/painted: 70 kinds of building, most at three levels, seasonal
 * trees, vehicles, six walking people, icons), so improving that art improves every vision. Needs game-assets.js
 * first; uses game-sfx.js if it is there. Used by the Studio's vision starters (studio/templates/vision-*.html).
 *
 *   const world = GameVision.create(canvas, {
 *     map: [                                   // one character per plot; rows go down-left, columns down-right
 *       '~~~...tt',                            //   .  grass        =  road / path      ~  water     (space) nothing
 *       '~~.==A==',                            //   t  a tree or two   T  woods   o  fruit trees   *  flowering bushes
 *       '~..=.B.t',                            //   any other letter: a place from `places`
 *     ],
 *     places: { A: { art: 'greenhouse', level: 3, title: 'Glass farm', text: 'Food grown...', icon: 'food',
 *                    stats: [['Food', '+40%']], hidden: false } },
 *     season: 'summer', time: 0,               // time: 0 day .. 1 night
 *     grid: false,                             // true outlines every plot, handy while laying out a map
 *     people: 10, vehicles: 3,                 // walkers and vehicles on the roads
 *     onPick(place) {},                        // a place was tapped
 *   });
 *   world.focus('A', { zoom: 1.4, duration: 1 })  world.reset()  world.show('B')  world.hide('B')  world.setLevel('A', 2)
 *   world.setSeason('winter')  world.setTime(0.8)  world.setPeople(20)  world.setVehicles(4)  world.setTrees(0.5)
 *   world.setHaze(0.6)  world.place('A')  world.places  world.tourOrder()
 *
 *   GameVision.ui(world, { title, subtitle, icon, accent })   // title card, note cards, tour, seasons, day/night, zoom
 *   GameVision.story(world, chapters, { title, subtitle, icon, accent })   // a walkthrough, chapter by chapter
 *
 * Building art: painted/buildings/<art>-<level>.webp (index.json gives each picture's lot corners, which are mapped
 * onto the plot's diamond with a vertical shear so walls stay upright, as From the Ground Up does).
 */
(function (global) {
  'use strict';

  const TW = 192, TH = 96;                     // a plot's diamond in world units
  const SIDE = 34;                             // the island's earth edge below the front plots
  const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
  const TREES = ['oak', 'maple', 'birch', 'pine'];
  const VEHICLES = ['bus', 'cargo-bike', 'tram', 'truck', 'cargo-bike', 'tractor'];
  const GROUND = {                             // grass colours per season: base and a lighter fleck
    spring: ['#86c75a', '#9bd66e'], summer: ['#79b84c', '#8cc95c'], autumn: ['#a9a64e', '#c2b45e'], winter: ['#e6edf2', '#f6f9fb'],
  };
  const sfx = (name, o) => { try { if (global.GameSfx) global.GameSfx.play(name, o); } catch (e) {} };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const back = t => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
  const hash = (a, b = 0) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };

  // ── Art: images from the shared library, darkened for night and frosted for winter, cached ──
  const imgs = {}, tints = {}, metas = {};
  let loading = null;
  function load() {
    if (loading) return loading;
    const A = global.GameAssets;
    const json = p => A.ready().then(() => fetch(A.url(p))).then(r => (r.ok ? r.json() : {})).catch(() => ({}));
    loading = Promise.all([json('painted/buildings/index.json'), json('painted/props/index.json'), json('painted/people/index.json')])
      .then(([b, p, h]) => { metas.buildings = b; metas.props = p; metas.people = h; });
    return loading;
  }
  function image(path) {
    let im = imgs[path];
    if (!im) {
      im = imgs[path] = new Image();
      global.GameAssets.ready().then(() => { im.src = global.GameAssets.url(path); });
    }
    return im.complete && im.naturalWidth ? im : null;
  }
  function picture(path, night, cold) {
    const im = image(path);
    if (!im) return null;
    const step = Math.round(clamp(night, 0, 1) * 12);
    if (!step && !cold) return im;
    const k = path + '@' + step + (cold ? 'w' : '');
    if (tints[k]) return tints[k];
    const c = document.createElement('canvas');
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    const x = c.getContext('2d');
    x.drawImage(im, 0, 0);
    if (cold) {
      x.globalCompositeOperation = 'saturation'; x.fillStyle = 'rgba(128,128,128,.45)'; x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'source-atop'; x.fillStyle = 'rgba(230,240,250,.25)'; x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'destination-in'; x.drawImage(im, 0, 0);
    }
    if (step) { x.globalCompositeOperation = 'source-atop'; x.fillStyle = `rgba(12,18,40,${0.62 * step / 12})`; x.fillRect(0, 0, c.width, c.height); }
    return (tints[k] = c);
  }
  // The building picture for a kind and level: that level's, else the nearest level below, else any.
  function buildingKey(art, level) {
    const m = metas.buildings || {};
    for (let l = level || 1; l >= 1; l--) if (m[art + '-' + l]) return art + '-' + l;
    for (let l = 2; l <= 5; l++) if (m[art + '-' + l]) return art + '-' + l;
    return null;
  }

  // ── The world ──
  function create(canvas, cfg) {
    cfg = cfg || {};
    const g = canvas.getContext('2d');
    const map = (cfg.map || ['.']).map(r => r.split(''));
    const rows = map.length, cols = Math.max(...map.map(r => r.length));
    const at = (c, r) => (map[r] && map[r][c]) || ' ';
    const iso = (c, r) => [(c - r) * TW / 2, (c + r) * TH / 2];
    const isRoad = (c, r) => at(c, r) === '=';
    const isLand = (c, r) => at(c, r) !== ' ' && at(c, r) !== '~';

    const world = {
      places: [], season: cfg.season || 'summer', time: cfg.time || 0, haze: cfg.haze || 0,
      treeShare: 1, cam: { x: 0, y: 0, z: 1 }, onPick: cfg.onPick || null, onChange: null,
    };
    let W = 0, H = 0, dpr = 1, t = 0, ground = null, groundKey = '', tween = null;

    // Places, trees, bushes, lamps from the map.
    const trees = [], lamps = [], bushes = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const ch = at(c, r), [x, y] = iso(c, r);
      if (ch === 't' || ch === 'T' || ch === 'o') {
        const n = ch === 'T' ? 3 : ch === 'o' ? 2 : 1 + (hash(c, r) < 0.4 ? 1 : 0);
        for (let i = 0; i < n; i++) {
          const a = hash(c * 3 + i, r * 7), b = hash(r * 5 + i, c * 11);
          trees.push({ x: x + (a - 0.5) * TW * 0.45, y: y + (b - 0.5) * TH * 0.45, kind: ch === 'o' ? 'fruit-tree' : TREES[(hash(c + i, r) * TREES.length) | 0], h: TH * (0.95 + hash(i, c + r) * 0.4), rank: hash(c * 13 + i, r * 17), flip: hash(c, r + i) < 0.5 });
        }
      } else if (ch === '*') {
        for (let i = 0; i < 2; i++) bushes.push({ x: x + (hash(c + i, r) - 0.5) * TW * 0.4, y: y + (hash(r + i, c) - 0.5) * TH * 0.4, kind: i ? 'hedge' : 'bush', h: TH * 0.5 });
      } else if (ch === '=') {
        if (hash(c * 2.3, r * 1.7) < 0.3) lamps.push({ x: x + TW * 0.2, y: y - TH * 0.2 });
      } else if (cfg.places && cfg.places[ch]) {
        const p = Object.assign({ id: ch, level: 1 }, cfg.places[ch]);
        p.c = c; p.r = r; p.x = x; p.y = y;
        p.shown = p.hidden ? 0 : 1; p.target = p.shown; p.from = p.level;
        world.places.push(p);
      }
    }
    world.place = id => world.places.find(p => p.id === id);
    world.tourOrder = () => world.places.filter(p => p.title && p.target).sort((a, b) => (a.tour || 99) - (b.tour || 99) || a.y - b.y);

    // Walkers and vehicles move from plot to plot along the roads (or over grass when there are no roads).
    const roadCells = [], landCells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { if (isRoad(c, r)) roadCells.push([c, r]); if (isLand(c, r) && at(c, r) === '.') landCells.push([c, r]); }
    const walkable = roadCells.length ? isRoad : (c, r) => at(c, r) === '.' || isRoad(c, r);
    const cells = roadCells.length ? roadCells : landCells;
    function agent(kind, i) {
      const [c, r] = cells[(hash(i, kind.length) * cells.length) | 0] || [0, 0];
      return { kind, c, r, tc: c, tr: r, p: 1, row: i % 6, speed: kind === 'person' ? 0.45 + hash(i) * 0.25 : 1.1, lane: (hash(i, 3) - 0.5) * 0.3, dist: 0 };
    }
    let walkers = [], cars = [];
    world.setPeople = n => { walkers = cells.length ? Array.from({ length: n }, (_, i) => walkers[i] || agent('person', i)) : []; };
    world.setVehicles = n => { cars = roadCells.length ? Array.from({ length: n }, (_, i) => cars[i] || Object.assign(agent(VEHICLES[i % VEHICLES.length], i + 50), { lane: -0.22 })) : []; };
    world.setPeople(cfg.people == null ? 8 : cfg.people);
    world.setVehicles(cfg.vehicles == null ? 2 : cfg.vehicles);
    function stepAgent(a, dt) {
      a.p += dt * a.speed; a.dist += dt * a.speed;
      if (a.p < 1) return;
      a.c = a.tc; a.r = a.tr; a.p = 0;
      const back = [a.c - (a.dc || 0), a.r - (a.dr || 0)];
      let next = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dc, dr]) => walkable(a.c + dc, a.r + dr));
      if (next.length > 1) next = next.filter(([dc, dr]) => a.c + dc !== back[0] || a.r + dr !== back[1]);
      if (!next.length) { a.p = 1; a.tc = a.c; a.tr = a.r; return; }
      const [dc, dr] = next[(Math.random() * next.length) | 0];
      a.dc = dc; a.dr = dr; a.tc = a.c + dc; a.tr = a.r + dr;
    }
    function agentPos(a) {
      const [x0, y0] = iso(a.c, a.r), [x1, y1] = iso(a.tc, a.tr), k = a.p;
      const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
      const off = a.lane * TW * 0.5;              // keep to one side of the path
      return [x0 + dx * k - dy / len * off * 0.5, y0 + dy * k + dx / len * off * 0.5, dx, dy];
    }

    // Weather and clouds.
    const flakes = Array.from({ length: 90 }, (_, i) => ({ x: hash(i, 1), y: hash(i, 2), s: 0.5 + hash(i, 3), w: hash(i, 4) * 6.28 }));
    const clouds = Array.from({ length: 5 }, (_, i) => ({ u: hash(i, 9), v: hash(i, 8), s: 0.7 + hash(i, 7) * 0.8 }));

    // ── Camera ──
    const bounds = () => {
      const xs = [], ys = [];
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (at(c, r) !== ' ') { const [x, y] = iso(c, r); xs.push(x); ys.push(y); }
      return { x0: Math.min(...xs) - TW / 2, x1: Math.max(...xs) + TW / 2, y0: Math.min(...ys) - TH * 2.5, y1: Math.max(...ys) + TH / 2 + SIDE };
    };
    const B = bounds();
    const fitZoom = () => Math.min(W / (B.x1 - B.x0), H / (B.y1 - B.y0)) * 0.92;
    world.reset = (duration = 0.8) => world.moveTo((B.x0 + B.x1) / 2, (B.y0 + B.y1) / 2, fitZoom(), duration);
    world.moveTo = (x, y, z, duration = 0.8) => {
      if (!duration) { Object.assign(world.cam, { x, y, z }); tween = null; return; }
      tween = { from: { ...world.cam }, to: { x, y, z }, t: 0, d: duration };
    };
    world.focus = (id, o = {}) => {
      const p = typeof id === 'string' ? world.place(id) : null;
      const [x, y] = p ? [p.x, p.y - TH * 0.7] : iso(id[0], id[1]);
      const z = (o.zoom || 1.5) * fitZoom();
      // o.dx/o.dy: screen pixels to keep the point off-centre (clear of a card covering part of the screen)
      world.moveTo(x - (o.dx || 0) / z, y - (o.dy || 0) / z, z, o.duration == null ? 1 : o.duration);
    };
    function clampCam() {
      const z = world.cam.z;
      world.cam.x = clamp(world.cam.x, B.x0, B.x1); world.cam.y = clamp(world.cam.y, B.y0, B.y1);
      world.cam.z = clamp(z, fitZoom() * 0.6, fitZoom() * 4);
    }

    // ── Changes ──
    world.show = id => { const p = world.place(id); if (p && !p.target) { p.target = 1; p.rise = 0; sfx('confirm', { volume: 0.5 }); } };
    world.hide = id => { const p = world.place(id); if (p) p.target = 0; };
    world.setLevel = (id, level) => { const p = world.place(id); if (p && p.level !== level) { p.from = p.level; p.level = level; p.morph = 0; } };
    world.setSeason = s => { world.season = SEASONS.includes(s) ? s : 'summer'; };
    world.setTime = v => { world.timeTarget = clamp(v, 0, 1); };
    world.setTrees = share => { world.treeShare = clamp(share, 0, 1); };
    world.setHaze = v => { world.hazeTarget = clamp(v, 0, 1); };

    // ── Input: drag to pan, wheel or pinch to zoom, tap to pick ──
    const pointers = new Map();
    let dragged = 0, pinch = 0;
    const toWorld = (sx, sy) => [(sx - W / 2) / world.cam.z + world.cam.x, (sy - H / 2) / world.cam.z + world.cam.y];
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId); pointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); dragged = 0; tween = null;
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a.x - b.x, a.y - b.y); }
    });
    canvas.addEventListener('pointermove', e => {
      const p = pointers.get(e.pointerId); if (!p) return;
      if (pointers.size === 2) {
        p.x = e.clientX; p.y = e.clientY;
        const [a, b] = [...pointers.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) world.cam.z *= d / pinch; pinch = d; dragged = 99; clampCam(); return;
      }
      const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
      dragged += Math.abs(dx) + Math.abs(dy);
      world.cam.x -= dx / world.cam.z; world.cam.y -= dy / world.cam.z; clampCam();
    });
    const up = e => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId); pinch = 0;
      if (dragged < 8 && !pointers.size) pick(e.clientX, e.clientY);
    };
    canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('wheel', e => {
      e.preventDefault(); tween = null;
      const [wx, wy] = toWorld(e.clientX, e.clientY), k = Math.exp(-e.deltaY * 0.0015);
      world.cam.z *= k; clampCam();
      const [nx, ny] = toWorld(e.clientX, e.clientY); world.cam.x += wx - nx; world.cam.y += wy - ny; clampCam();
    }, { passive: false });
    addEventListener('keydown', e => {
      if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
      const step = 60 / world.cam.z;
      if (e.code === 'ArrowLeft') world.cam.x -= step; else if (e.code === 'ArrowRight') world.cam.x += step;
      else if (e.code === 'ArrowUp') world.cam.y -= step; else if (e.code === 'ArrowDown') world.cam.y += step;
      else if (e.key === '+' || e.key === '=') world.cam.z *= 1.15; else if (e.key === '-') world.cam.z /= 1.15;
      else return;
      tween = null; clampCam();
    });
    world.zoomBy = k => { const c = world.cam; world.moveTo(c.x, c.y, clamp(c.z * k, fitZoom() * 0.6, fitZoom() * 4), 0.3); };
    // Moving without a mouse (a gamepad's sticks): pan by screen pixels, zoom at once.
    world.panBy = (dx, dy) => { tween = null; world.cam.x += dx / world.cam.z; world.cam.y += dy / world.cam.z; clampCam(); };
    world.zoomNow = k => { tween = null; world.cam.z = clamp(world.cam.z * k, fitZoom() * 0.6, fitZoom() * 4); clampCam(); };

    let markers = [];                            // where each note's marker was drawn, for tapping
    function pick(sx, sy) {
      let best = null;
      for (const m of markers) { const d = Math.hypot(m.x - sx, m.y - sy); if (d < 30 && (!best || d < best.d)) best = { d, p: m.p }; }
      if (!best) {
        const [wx, wy] = toWorld(sx, sy);
        for (const p of [...world.places].sort((a, b) => b.y - a.y)) {
          if (!p.target || !p.box) continue;
          const b = p.box;
          if (wx > b[0] && wx < b[2] && wy > b[1] && wy < b[3]) { best = { p }; break; }
        }
      }
      if (best && world.onPick) { sfx('select', { volume: 0.5 }); world.onPick(best.p); }
    }

    // ── Drawing ──
    function fit() {
      dpr = Math.min(global.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      W = r.width || global.innerWidth; H = r.height || global.innerHeight;
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    }
    addEventListener('resize', fit); fit();

    const night = () => world.time;
    const cold = () => world.season === 'winter';
    function baseTransform() { const z = world.cam.z * dpr; g.setTransform(z, 0, 0, z, W / 2 * dpr - world.cam.x * z, H / 2 * dpr - world.cam.y * z); }

    // The ground is drawn once into its own canvas per season (plots, roads, water banks, the island's earth edge).
    function buildGround() {
      const key = world.season;
      if (ground && groundKey === key) return;
      groundKey = key;
      const w = B.x1 - B.x0, h = B.y1 - B.y0 + TH * 3;
      const k = 1.5;                              // drawn at 1.5x for a crisp zoom
      ground = document.createElement('canvas'); ground.width = Math.ceil(w * k); ground.height = Math.ceil(h * k);
      const x = ground.getContext('2d');
      x.setTransform(k, 0, 0, k, -B.x0 * k, -(B.y0 + TH * 2.5) * k + TH * 2.5 * k);
      ground.ox = B.x0; ground.oy = B.y0; ground.k = k;
      x.setTransform(k, 0, 0, k, -B.x0 * k, -B.y0 * k);
      const [g0, g1] = GROUND[world.season];
      const dia = (cx, cy, s = 1) => { x.beginPath(); x.moveTo(cx, cy - TH / 2 * s); x.lineTo(cx + TW / 2 * s, cy); x.lineTo(cx, cy + TH / 2 * s); x.lineTo(cx - TW / 2 * s, cy); x.closePath(); };
      // earth edges first, so plots cover their tops
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const ch = at(c, r); if (ch === ' ') continue;
        const [cx, cy] = iso(c, r), water = ch === '~';
        const side = (ax, ay, bx, by, col) => { x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.lineTo(bx, by + SIDE); x.lineTo(ax, ay + SIDE); x.closePath(); x.fillStyle = col; x.fill(); };
        if (at(c, r + 1) === ' ') side(cx - TW / 2, cy, cx, cy + TH / 2, water ? '#2f6f99' : '#8a5a36');
        if (at(c + 1, r) === ' ') side(cx, cy + TH / 2, cx + TW / 2, cy, water ? '#25587a' : '#6e4529');
        if (at(c, r + 1) === ' ' || at(c + 1, r) === ' ') {   // strata lines in the earth
          x.strokeStyle = 'rgba(0,0,0,.12)'; x.lineWidth = 2;
          for (const f of [0.35, 0.7]) {
            x.beginPath();
            if (at(c, r + 1) === ' ') { x.moveTo(cx - TW / 2, cy + SIDE * f); x.lineTo(cx, cy + TH / 2 + SIDE * f); }
            if (at(c + 1, r) === ' ') { x.moveTo(cx, cy + TH / 2 + SIDE * f); x.lineTo(cx + TW / 2, cy + SIDE * f); }
            x.stroke();
          }
        }
      }
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const ch = at(c, r); if (ch === ' ') continue;
        const [cx, cy] = iso(c, r);
        dia(cx, cy, 1.01);
        if (ch === '~') x.fillStyle = world.season === 'winter' ? '#a9cfe6' : '#4f9fd1';
        else x.fillStyle = hash(c, r) < 0.5 ? g0 : g1;
        x.fill();
        if (ch !== '~') {                         // flecks of grass, flowers in spring, snow in winter
          for (let i = 0; i < 14; i++) {
            const a = hash(c * 31 + i, r), b = hash(r * 17 + i, c);
            const px = cx + (a - b) * TW / 2 * 0.9, py = cy + (a + b - 1) * TH / 2 * 0.9;
            x.fillStyle = world.season === 'spring' && i % 5 === 0 ? ['#fff', '#f9a8d4', '#fde047'][i % 3] : 'rgba(0,0,0,.07)';
            x.fillRect(px, py, 3, 2);
          }
        }
        if (ch === '~') {                          // a sandy bank where water meets land
          x.strokeStyle = world.season === 'winter' ? '#dfe9f0' : '#e9d8a6'; x.lineWidth = 7; x.lineCap = 'round';
          const edge = (ax, ay, bx, by) => { x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke(); };
          if (isLand(c - 1, r)) edge(cx - TW / 2, cy, cx, cy - TH / 2);
          if (isLand(c, r - 1)) edge(cx, cy - TH / 2, cx + TW / 2, cy);
          if (isLand(c + 1, r)) edge(cx + TW / 2, cy, cx, cy + TH / 2);
          if (isLand(c, r + 1)) edge(cx, cy + TH / 2, cx - TW / 2, cy);
        }
      }
      // roads: a paved band between neighbouring road plots
      x.lineCap = 'round'; x.lineJoin = 'round';
      for (const [w, col] of [[TH * 0.62, '#b8ad97'], [TH * 0.5, world.season === 'winter' ? '#eef2f5' : '#d9cfb9']]) {
        x.strokeStyle = col; x.lineWidth = w;
        for (const [c, r] of roadCells) {
          const [cx, cy] = iso(c, r);
          x.beginPath(); x.moveTo(cx, cy); x.lineTo(cx + 0.01, cy); x.stroke();
          for (const [dc, dr] of [[1, 0], [0, 1]]) if (isRoad(c + dc, r + dr)) { const [nx, ny] = iso(c + dc, r + dr); x.beginPath(); x.moveTo(cx, cy); x.lineTo(nx, ny); x.stroke(); }
        }
      }
      x.setLineDash([10, 12]); x.strokeStyle = 'rgba(255,255,255,.55)'; x.lineWidth = 2;
      for (const [c, r] of roadCells) for (const [dc, dr] of [[1, 0], [0, 1]]) if (isRoad(c + dc, r + dr)) {
        const [cx, cy] = iso(c, r), [nx, ny] = iso(c + dc, r + dr); x.beginPath(); x.moveTo(cx, cy); x.lineTo(nx, ny); x.stroke();
      }
      x.setLineDash([]);
    }

    // Draw a picture standing on (x, y): h tall in world units (or o.w wide), its ground at o.feet of its height.
    function stand(path, x, y, h, o = {}) {
      const src = picture(path, night(), cold() && !o.noFrost);
      if (!src) return false;
      const k = o.w ? o.w / src.width : h / src.height;
      g.save(); baseTransform(); g.translate(x, y); g.scale(o.flip ? -k : k, k * (o.sy || 1));
      if (o.alpha != null) g.globalAlpha = o.alpha;
      g.drawImage(src, -src.width / 2, -src.height * (1 - (o.feet || 0)));
      g.restore();
      return true;
    }
    // A building on its plot: its picture's measured lot corners mapped onto the plot's corners (walls upright).
    function building(p, key, alpha, rise) {
      const m = (metas.buildings || {})[key];
      const src = m && picture('painted/buildings/' + key + '.webp', night(), cold());
      if (!src) {                                   // not loaded yet, or no such art: a simple block
        g.save(); baseTransform(); g.globalAlpha = alpha * 0.6; g.fillStyle = '#cbd5e1';
        g.fillRect(p.x - TW * 0.3, p.y - TH * 0.9 * rise, TW * 0.6, TH * 0.9 * rise); g.restore();
        p.box = [p.x - TW / 2, p.y - TH, p.x + TW / 2, p.y + TH / 2];
        return;
      }
      const [, , xL, yL, xF, yF, xR, yR] = m, s = 0.96, w = src.width, h = src.height;
      const PL = [p.x - TW / 2 * s, p.y], PF = [p.x, p.y + TH / 2 * s], PR = [p.x + TW / 2 * s, p.y];
      // The painted lots were seen from a slightly turned camera, so their front corner is not in the middle. Each
      // half of the picture (left of the front corner, right of it) gets its own mapping, so all three lot corners
      // land exactly on the plot's corners while walls stay upright; the halves meet exactly at the front corner.
      // d (the vertical scale) comes from the three corners together and is shared by both halves.
      const det = xL * (yF - yR) - yL * (xF - xR) + (xF * yR - xR * yF);
      const d = (xL * (PF[1] - PR[1]) - PL[1] * (xF - xR) + (xF * PR[1] - xR * PF[1])) / det;
      const a1 = (PF[0] - PL[0]) / (xF - xL), e1 = PL[0] - a1 * xL, b1 = (PF[1] - PL[1] - d * (yF - yL)) / (xF - xL), f1 = PL[1] - b1 * xL - d * yL;
      const a2 = (PR[0] - PF[0]) / (xR - xF), e2 = PF[0] - a2 * xF, b2 = (PR[1] - PF[1] - d * (yR - yF)) / (xR - xF), f2 = PF[1] - b2 * xF - d * yF;
      g.save(); baseTransform();
      if (rise < 1) { g.translate(PF[0], PF[1]); g.scale(1, Math.max(0.001, rise)); g.translate(-PF[0], -PF[1]); }
      g.globalAlpha = alpha;
      const base = g.getTransform();
      g.transform(a1, b1, 0, d, e1, f1); g.drawImage(src, 0, 0, xF + 1, h, 0, 0, xF + 1, h);
      g.setTransform(base);
      g.transform(a2, b2, 0, d, e2, f2); g.drawImage(src, xF, 0, w - xF, h, xF, 0, w - xF, h);
      g.restore();
      const top = b2 * xF + f2;                     // the picture's top edge above the front corner
      p.top = p.y + (top - p.y) * rise; p.box = [PL[0], p.top, PR[0], PF[1]];
    }

    function render(dt) {
      buildGround();
      const n = night();
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // sky
      const sky = g.createLinearGradient(0, 0, 0, H);
      const mix = (a, b) => a.map((v, i) => Math.round(v + (b[i] - v) * n));
      const top = mix([166, 212, 245], [10, 18, 44]), bot = mix([232, 244, 252], [32, 44, 82]);
      sky.addColorStop(0, `rgb(${top})`); sky.addColorStop(1, `rgb(${bot})`);
      g.fillStyle = sky; g.fillRect(0, 0, W, H);
      if (n > 0.3) {                                // stars
        g.fillStyle = `rgba(255,255,255,${(n - 0.3) * 1.2})`;
        for (let i = 0; i < 70; i++) g.fillRect(hash(i, 5) * W, hash(i, 6) * H * 0.6, 1.5, 1.5);
      }
      baseTransform();
      g.drawImage(ground, ground.ox, ground.oy, ground.width / ground.k, ground.height / ground.k);
      if (n) {                                      // the ground at night
        g.save(); g.globalCompositeOperation = 'source-atop'; g.restore();
        g.fillStyle = `rgba(12,18,40,${0.6 * n})`;
        g.globalCompositeOperation = 'source-atop';
      }
      g.globalCompositeOperation = 'source-over';
      if (n) { g.save(); g.globalAlpha = 0.6 * n; g.drawImage(nightGround(), ground.ox, ground.oy, ground.width / ground.k, ground.height / ground.k); g.restore(); }
      if (cfg.grid) {                               // grid: true outlines every plot (handy while laying out a map)
        g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1.5 / world.cam.z;
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (at(c, r) !== ' ') {
          const [cx, cy] = iso(c, r); g.beginPath(); g.moveTo(cx, cy - TH / 2); g.lineTo(cx + TW / 2, cy); g.lineTo(cx, cy + TH / 2); g.lineTo(cx - TW / 2, cy); g.closePath(); g.stroke();
        }
      }
      // water shimmer
      g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 2;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (at(c, r) === '~' && world.season !== 'winter') {
        const [cx, cy] = iso(c, r), ph = Math.sin(t * 1.5 + c + r * 1.3);
        g.beginPath(); g.moveTo(cx - 24 + ph * 8, cy - 6 + ph * 3); g.lineTo(cx + 2 + ph * 8, cy + 3 + ph * 3); g.stroke();
      }
      // cloud shadows
      for (const cl of clouds) {
        const cx = B.x0 + ((cl.u * (B.x1 - B.x0) + t * 12) % (B.x1 - B.x0 + 400)) - 200, cy = B.y0 + TH * 2 + cl.v * (B.y1 - B.y0 - TH * 2);
        const rg = g.createRadialGradient(cx, cy, 0, cx, cy, 160 * cl.s);
        rg.addColorStop(0, `rgba(20,30,40,${0.12 * (1 - n)})`); rg.addColorStop(1, 'rgba(20,30,40,0)');
        g.fillStyle = rg; g.beginPath(); g.ellipse(cx, cy, 160 * cl.s, 80 * cl.s, 0, 0, Math.PI * 2); g.fill();
      }

      // lots are flat on the ground: drawn before anything that stands
      for (const p of world.places) if (p.shown > 0.001 || p.target) lot(p, Math.min(1, Math.max(p.shown, p.target ? 0.05 : 0) * 3));
      // everything standing, back to front
      const things = [];
      for (const p of world.places) if (p.shown > 0.001 || p.target) things.push({ y: p.y + TH * 0.25, draw: () => drawPlace(p, dt) });
      const season = world.season;
      for (const tr of trees) if (tr.rank <= world.treeShare) things.push({ y: tr.y, draw: () => stand(`painted/props/${tr.kind}-${season}.webp`, tr.x, tr.y, tr.h, { flip: tr.flip, feet: 0.03, noFrost: true }) });
      for (const b of bushes) things.push({ y: b.y, draw: () => stand(`painted/props/${b.kind}-${season}.webp`, b.x, b.y, b.h, { feet: 0.05, noFrost: true }) });
      for (const l of lamps) things.push({ y: l.y, draw: () => stand('painted/props/streetlamp.webp', l.x, l.y, TH * 1.05, { feet: 0.02 }) });
      for (const a of walkers) {
        stepAgent(a, dt);
        const [x, y, dx, dy] = agentPos(a), toward = dy >= 0, sheet = toward ? 'walk' : 'away', flip = toward ? dx < 0 : dx > 0;
        things.push({ y, draw: () => person(sheet, a.row, Math.floor(a.dist * 9) % 6, x, y, flip) });
      }
      for (const a of cars) {
        stepAgent(a, dt);
        const [x, y, dx, dy] = agentPos(a), toward = dy >= 0;
        things.push({ y, draw: () => stand(`painted/props/${a.kind}${toward ? '' : '-away'}.webp`, x, y, 0, { w: a.kind === 'bus' || a.kind === 'tram' ? TW * 0.5 : TW * 0.3, flip: toward ? dx < 0 : dx > 0, feet: 0.06 }) });
      }
      things.sort((a, b) => a.y - b.y);
      for (const th of things) th.draw();

      // night lights
      if (n > 0.05) {
        baseTransform(); g.globalCompositeOperation = 'lighter';
        const glow = (x, y, r, a) => { const rg = g.createRadialGradient(x, y, 0, x, y, r); rg.addColorStop(0, `rgba(255,190,110,${a})`); rg.addColorStop(1, 'rgba(255,190,110,0)'); g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2); };
        for (const l of lamps) { glow(l.x, l.y - TH * 0.95, 26, 0.55 * n); glow(l.x, l.y, 60, 0.2 * n); }
        for (const p of world.places) if (p.shown > 0.5) glow(p.x, p.y, TW * 0.55, 0.16 * n);
        g.globalCompositeOperation = 'source-over';
      }
      // haze (an unhealthy sky), then the weather
      const hz = world.haze;
      if (hz > 0.01) { g.setTransform(dpr, 0, 0, dpr, 0, 0); const hg = g.createLinearGradient(0, 0, 0, H); hg.addColorStop(0, `rgba(150,128,100,${0.55 * hz})`); hg.addColorStop(1, `rgba(150,128,100,${0.15 * hz})`); g.fillStyle = hg; g.fillRect(0, 0, W, H); }
      weather(dt);
      notesMarkers();
    }
    let nightCanvas = null, nightKey = '';
    function nightGround() {                         // the ground canvas darkened, made once per season
      if (nightCanvas && nightKey === groundKey) return nightCanvas;
      nightKey = groundKey;
      nightCanvas = document.createElement('canvas'); nightCanvas.width = ground.width; nightCanvas.height = ground.height;
      const x = nightCanvas.getContext('2d'); x.drawImage(ground, 0, 0);
      x.globalCompositeOperation = 'source-atop'; x.fillStyle = 'rgb(12,18,40)'; x.fillRect(0, 0, ground.width, ground.height);
      return nightCanvas;
    }
    function person(sheet, row, frame, x, y, flip) {
      const m = (metas.people || {})[sheet];
      const src = m && picture('painted/people/' + sheet + '.webp', night(), false);
      if (!src) return;
      const h = TH * 0.42, k = h / m.ch, feet = m.feet[row][frame];
      g.save(); baseTransform(); g.translate(x, y); g.scale(flip ? -k : k, k);
      g.drawImage(src, frame * m.cw, row * m.ch, m.cw, m.ch, -m.cw / 2, -feet, m.cw, m.ch);
      g.restore();
    }
    // A place's lot: a paved (or green) pad on its plot, so every building clearly sits in its own grid square.
    const GREEN_LOTS = /park|garden|meadow|allotments|orchard|compost|reedbed|wetland|fish|hydro|sewage/;
    function lot(p, alpha) {
      const green = GREEN_LOTS.test(p.art || ''), s = 0.9;
      g.save(); baseTransform(); g.globalAlpha = alpha;
      g.beginPath(); g.moveTo(p.x, p.y - TH / 2 * s); g.lineTo(p.x + TW / 2 * s, p.y); g.lineTo(p.x, p.y + TH / 2 * s); g.lineTo(p.x - TW / 2 * s, p.y); g.closePath();
      g.fillStyle = green ? (world.season === 'winter' ? '#dfe7ec' : '#6fa94b') : (world.season === 'winter' ? '#eef2f5' : '#d8cdb5');
      g.fill(); g.lineWidth = 3; g.strokeStyle = green ? 'rgba(40,80,30,.25)' : 'rgba(120,105,80,.45)'; g.stroke();
      g.restore();
    }
    function drawPlace(p, dt) {
      // fade/rise toward the target, and cross-fade between levels
      if (p.target && p.shown < 1) { p.shown = Math.min(1, p.shown + dt / 0.9); if (p.rise != null && p.rise === 0) puff(p); p.rise = p.shown; }
      if (!p.target && p.shown > 0) p.shown = Math.max(0, p.shown - dt / 0.5);
      if (p.morph != null && p.morph < 1) p.morph = Math.min(1, p.morph + dt / 0.8);
      const rise = p.target ? back(p.shown) : 1, alpha = p.target ? Math.min(1, p.shown * 2) : p.shown;
      const now = buildingKey(p.art, p.level);
      if (p.morph != null && p.morph < 1) {
        building(p, buildingKey(p.art, p.from), alpha * (1 - p.morph), rise);
        building(p, now, alpha * ease(p.morph), rise * (0.85 + 0.15 * back(p.morph)));
      } else building(p, now, alpha, rise);
    }
    const puffs = [];
    function puff(p) { puffs.push({ x: p.x, y: p.y + TH * 0.2, t: 0 }); sfx('thud', { volume: 0.35 }); }

    function weather(dt) {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      // dust where a building rose
      for (const f of puffs) {
        f.t += dt;
        const src = picture('painted/fx/smoke.webp', 0, false);
        if (src) {
          const frame = Math.min(7, Math.floor(f.t * 10)), sx = (f.x - world.cam.x) * world.cam.z + W / 2, sy = (f.y - world.cam.y) * world.cam.z + H / 2, s = 192 * world.cam.z * 0.9;
          g.globalAlpha = 1 - f.t / 0.8; g.drawImage(src, frame * 192, 0, 192, 192, sx - s / 2, sy - s * 0.75, s, s); g.globalAlpha = 1;
        }
      }
      for (let i = puffs.length - 1; i >= 0; i--) if (puffs[i].t > 0.8) puffs.splice(i, 1);
      const s = world.season, wx = Math.sin(t * 0.4) * 0.03;
      if (s === 'summer' && cfg.weather !== 'rain') return;
      for (const f of flakes) {
        if (s === 'winter') { f.y += dt * 0.05 * f.s; f.x += dt * (wx + Math.sin(t + f.w) * 0.01); g.fillStyle = 'rgba(255,255,255,.9)'; g.beginPath(); g.arc(f.x * W, f.y * H, 1.5 + f.s * 1.5, 0, 6.3); g.fill(); }
        else if (cfg.weather === 'rain') { f.y += dt * 0.9 * f.s; g.strokeStyle = 'rgba(200,220,255,.5)'; g.beginPath(); g.moveTo(f.x * W, f.y * H); g.lineTo(f.x * W - 3, f.y * H + 14); g.stroke(); }
        else {                                      // autumn leaves, spring petals
          f.y += dt * 0.035 * f.s; f.x += dt * (0.02 + Math.sin(t * 2 + f.w) * 0.03);
          g.save(); g.translate(f.x * W, f.y * H); g.rotate(t * 2 + f.w);
          g.fillStyle = s === 'autumn' ? ['#d97706', '#b45309', '#f59e0b'][(f.w * 3) | 0 % 3] : '#fbcfe8';
          g.fillRect(-3, -1.5, 6, 3); g.restore();
          if ((f.w * 10 | 0) % 3) continue;
        }
        if (f.y > 1.05) { f.y = -0.05; f.x = Math.random(); } if (f.x > 1.05) f.x = -0.05; if (f.x < -0.05) f.x = 1.05;
      }
    }

    // Notes: a glowing, numbered marker above every place with a title.
    function notesMarkers() {
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      markers = [];
      const order = world.tourOrder();
      order.forEach((p, i) => {
        if (p.shown < 0.9 || p.noMarker) return;
        const sx = (p.x - world.cam.x) * world.cam.z + W / 2, sy = ((p.top || p.y - TH) - world.cam.y) * world.cam.z + H / 2 - 18 + Math.sin(t * 2.4 + i) * 3;
        markers.push({ x: sx, y: sy, p });
        const pulse = (t * 0.8 + i * 0.17) % 1, accent = cfg.accent || '#8b5cf6';
        g.strokeStyle = accent; g.globalAlpha = 1 - pulse; g.lineWidth = 3;
        g.beginPath(); g.arc(sx, sy, 16 + pulse * 16, 0, 6.3); g.stroke(); g.globalAlpha = 1;
        g.fillStyle = '#fff'; g.beginPath(); g.arc(sx, sy, 17, 0, 6.3); g.fill();
        g.lineWidth = 3; g.strokeStyle = world.active === p ? '#f59e0b' : accent; g.stroke();
        const ic = p.icon && image(`painted/icons/${p.icon}.webp`);
        if (ic) g.drawImage(ic, sx - 13, sy - 13, 26, 26);
        else { g.fillStyle = accent; g.font = '700 15px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(p.emoji || String(i + 1), sx, sy + 1); }
      });
    }

    let last = performance.now();
    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
      if (tween) {
        tween.t += dt / tween.d; const k = ease(Math.min(1, tween.t));
        for (const key of ['x', 'y', 'z']) world.cam[key] = tween.from[key] + (tween.to[key] - tween.from[key]) * k;
        if (tween.t >= 1) tween = null;
      }
      if (world.timeTarget != null) world.time += (world.timeTarget - world.time) * Math.min(1, dt * 2.5);
      if (world.hazeTarget != null) world.haze += (world.hazeTarget - world.haze) * Math.min(1, dt * 2);
      render(dt);
      requestAnimationFrame(frame);
    }
    world.ready = load().then(() => {
      for (const p of world.places) for (let l = 1; l <= 3; l++) { const k = buildingKey(p.art, l); if (k) image('painted/buildings/' + k + '.webp'); }
      world.reset(0);
      requestAnimationFrame(frame);
      return world;
    });
    addEventListener('resize', () => { if (!tween) clampCam(); });
    return world;
  }

  // ── UI: title card, note card, toolbar (seasons, day/night, tour, zoom) ──
  const CSS = `
  .gv-ui{--gv-accent:#8b5cf6;font-family:'Instrument Sans',system-ui,sans-serif;color:#0f172a}
  .gv-panel{background:rgba(255,255,255,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-radius:18px;box-shadow:0 12px 40px rgba(15,23,42,.25)}
  .gv-title{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:linear-gradient(rgba(15,23,42,.15),rgba(15,23,42,.45));z-index:20;transition:opacity .5s}
  .gv-title.gone{opacity:0;pointer-events:none}
  .gv-title .gv-panel{max-width:min(520px,90vw);padding:30px 32px;text-align:center}
  .gv-title .icon{font-size:44px;line-height:1}
  .gv-title h1{margin:10px 0 6px;font-size:clamp(26px,5vw,38px);line-height:1.1}
  .gv-title p{margin:0 0 22px;color:#475569;font-size:16px;line-height:1.5}
  .gv-btn{border:0;border-radius:999px;padding:11px 20px;font:600 15px inherit;font-family:inherit;cursor:pointer;background:#e2e8f0;color:#0f172a}
  .gv-btn.main{background:var(--gv-accent);color:#fff}
  .gv-btn:hover{filter:brightness(1.07)}
  .gv-card{position:fixed;right:16px;top:16px;bottom:84px;width:min(380px,calc(100vw - 32px));z-index:10;display:flex;flex-direction:column;overflow:hidden;transform:translateX(120%);transition:transform .35s cubic-bezier(.2,.8,.2,1)}
  .gv-card.open{transform:none}
  .gv-card .head{display:flex;gap:12px;align-items:center;padding:18px 18px 8px}
  .gv-card .head img{width:44px;height:44px}
  .gv-card .head .emoji{font-size:34px}
  .gv-card h2{margin:0;font-size:22px;line-height:1.15;flex:1}
  .gv-card .x{border:0;background:#f1f5f9;border-radius:50%;width:34px;height:34px;font-size:18px;cursor:pointer}
  .gv-card .art{margin:4px 18px;height:150px;border-radius:12px;background:linear-gradient(#e0f2fe,#f0fdf4);display:flex;align-items:center;justify-content:center}
  .gv-card .art img{max-width:92%;max-height:140px}
  .gv-card .body{padding:8px 18px;overflow:auto;flex:1;font-size:15px;line-height:1.55;color:#334155}
  .gv-card .body p{margin:0 0 10px}
  .gv-card .stats{display:grid;grid-template-columns:1fr auto;gap:6px 12px;margin:6px 0 4px;padding:10px 12px;background:#f8fafc;border-radius:12px;font-size:14px}
  .gv-card .stats b{color:var(--gv-accent);text-align:right}
  .gv-card .foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 18px;border-top:1px solid #e2e8f0}
  .gv-card .foot span{color:#64748b;font-size:14px}
  .gv-bar{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:10;display:flex;gap:4px;padding:6px;align-items:center;max-width:calc(100vw - 20px);overflow-x:auto}
  .gv-bar button{border:0;background:transparent;border-radius:12px;min-width:44px;height:44px;padding:0 8px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;font:600 14px inherit;font-family:inherit;color:#0f172a}
  .gv-bar button img{width:28px;height:28px}
  .gv-bar button.on{background:color-mix(in srgb,var(--gv-accent) 18%,transparent)}
  .gv-bar button:hover{background:#f1f5f9}
  .gv-bar .sep{width:1px;height:28px;background:#e2e8f0;margin:0 4px}
  .gv-story{position:fixed;left:50%;bottom:76px;transform:translateX(-50%);width:min(640px,calc(100vw - 24px));z-index:10;padding:18px 20px 14px}
  .gv-story .step{font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--gv-accent)}
  .gv-story h2{margin:4px 0 6px;font-size:22px}
  .gv-story p{margin:0;color:#334155;font-size:15px;line-height:1.55}
  .gv-story .nav{display:flex;align-items:center;justify-content:space-between;margin-top:12px;gap:10px}
  .gv-dots{display:flex;gap:6px}.gv-dots i{width:8px;height:8px;border-radius:50%;background:#cbd5e1}.gv-dots i.on{background:var(--gv-accent);width:22px;border-radius:4px}
  @media (max-width:640px){.gv-card{top:auto;bottom:76px;height:min(62vh,520px);transform:translateY(130%)}.gv-card.open{transform:none}.gv-story{bottom:72px}}
  #gsfx-btn{top:calc(10px + env(safe-area-inset-top))!important;bottom:auto!important;left:calc(10px + env(safe-area-inset-left))!important;right:auto!important}
  @media (max-width:420px){.gv-bar{gap:0;padding:4px}.gv-bar button{min-width:36px;height:40px;padding:0 3px}.gv-bar button img{width:25px;height:25px}.gv-bar .sep{margin:0 2px}.gv-bar .lbl{display:none}}
  .gv-bar{margin-bottom:env(safe-area-inset-bottom)}.gv-card,.gv-story{margin-bottom:env(safe-area-inset-bottom)}.gv-card{margin-right:env(safe-area-inset-right)}
  @media (max-height:420px){.gv-title .gv-panel{padding:14px 20px}.gv-title .icon{font-size:28px}.gv-title h1{font-size:22px;margin:4px 0}.gv-title p{font-size:14px;margin:0 0 12px;line-height:1.4}
    .gv-card{top:8px;bottom:58px;width:min(330px,calc(100vw - 32px))}.gv-card .head{padding:10px 14px 4px}.gv-card .head img{width:32px;height:32px}.gv-card h2{font-size:18px}.gv-card .art{height:70px;margin:2px 14px}.gv-card .art img{max-height:62px}.gv-card .body{padding:6px 14px;font-size:14px}.gv-card .foot{padding:8px 14px}
    .gv-bar{bottom:6px;padding:3px}.gv-bar button{height:38px;min-width:38px}.gv-bar button img{width:24px;height:24px}
    .gv-story{bottom:52px;padding:10px 14px 8px}.gv-story h2{font-size:18px;margin:2px 0 4px}.gv-story p{font-size:14px;line-height:1.4}.gv-story .nav{margin-top:6px}}
  `;
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const iconUrl = name => global.GameAssets.url(`painted/icons/${name}.webp`);
  function root(opts) {
    if (!document.getElementById('gv-css')) { const s = el('style'); s.id = 'gv-css'; s.textContent = CSS; document.head.append(s); }
    const r = el('div', 'gv-ui'); r.style.setProperty('--gv-accent', opts.accent || '#8b5cf6'); document.body.append(r); return r;
  }
  function titleCard(r, opts, buttons) {
    const card = el('div', 'gv-title', `<div class="gv-panel"><div class="icon">${esc(opts.icon || '')}</div><h1>${esc(opts.title || '')}</h1><p>${esc(opts.subtitle || '')}</p><div class="btns"></div></div>`);
    const row = card.querySelector('.btns'); row.style.cssText = 'display:flex;gap:10px;justify-content:center;flex-wrap:wrap';
    for (const [label, main, fn] of buttons) { const b = el('button', 'gv-btn' + (main ? ' main' : ''), esc(label)); b.onclick = () => { card.classList.add('gone'); sfx('click', { volume: 0.5 }); fn(); }; row.append(b); }
    r.append(card); return card;
  }

  function ui(world, opts = {}) {
    const r = root(opts);
    const card = el('div', 'gv-card gv-panel'); r.append(card);
    let touring = false, idx = -1;
    function open(p) {
      world.active = p;
      const order = world.tourOrder(); idx = order.indexOf(p);
      const key = buildingKey(p.art, p.level);
      card.innerHTML = `<div class="head">${p.icon ? `<img alt="" src="${iconUrl(p.icon)}">` : `<span class="emoji">${esc(p.emoji || '')}</span>`}<h2>${esc(p.title)}</h2><button class="x" aria-label="Close">✕</button></div>` +
        (key ? `<div class="art"><img alt="" src="${global.GameAssets.url('painted/buildings/' + key + '.webp')}"></div>` : '') +
        `<div class="body">${String(p.text || '').split(/\n\s*\n/).map(t => `<p>${esc(t)}</p>`).join('')}` +
        (p.stats ? `<div class="stats">${p.stats.map(([a, b]) => `<span>${esc(a)}</span><b>${esc(b)}</b>`).join('')}</div>` : '') + '</div>' +
        `<div class="foot"><button class="gv-btn" data-go="-1">‹ Back</button><span>${idx + 1} of ${order.length}</span><button class="gv-btn main" data-go="1">${idx === order.length - 1 ? 'Finish' : 'Next ›'}</button></div>`;
      card.querySelector('.x').onclick = close;
      card.querySelectorAll('[data-go]').forEach(b => { b.onclick = () => go(+b.dataset.go); });
      card.classList.add('open');
      // keep the place in the open part of the screen: left of the card, or above it on a phone
      const wide = innerWidth > 640, cw = card.offsetWidth + 16, ch = card.offsetHeight + 76;
      world.focus(p.id, { zoom: opts.zoom || 1.6, dx: wide ? -cw / 2 : 0, dy: wide ? 0 : -ch / 2 + 20 });
    }
    function close() { card.classList.remove('open'); world.active = null; touring = false; }
    function go(step) {
      const order = world.tourOrder(), n = idx + step;
      if (n >= order.length) { close(); world.reset(); sfx('success', { volume: 0.5 }); return; }
      if (n < 0) return;
      sfx('whoosh', { volume: 0.4 }); open(order[n]);
    }
    world.onPick = p => { if (p.title) open(p); };
    const tour = () => { touring = true; idx = -1; go(1); };

    const bar = el('div', 'gv-bar gv-panel'); r.append(bar);
    const btn = (html, title, fn) => { const b = el('button', '', html); b.title = title; b.setAttribute('aria-label', title); b.onclick = () => { sfx('click', { volume: 0.4 }); fn(b); }; bar.append(b); return b; };
    btn(`<img alt="" src="${iconUrl('play')}"><span class="lbl">Tour</span>`, 'Take the tour', tour);
    bar.append(el('span', 'sep'));
    const seasonBtns = SEASONS.map(s => btn(`<img alt="" src="${iconUrl(s)}">`, s[0].toUpperCase() + s.slice(1), () => { world.setSeason(s); mark(); }));
    const mark = () => seasonBtns.forEach((b, i) => b.classList.toggle('on', SEASONS[i] === world.season));
    mark();
    bar.append(el('span', 'sep'));
    const dn = btn(`<img alt="" src="${iconUrl(world.time > 0.5 ? 'night' : 'day')}">`, 'Day or night', b => { const nightNow = (world.timeTarget != null ? world.timeTarget : world.time) < 0.5; world.setTime(nightNow ? 1 : 0); b.querySelector('img').src = iconUrl(nightNow ? 'night' : 'day'); });
    bar.append(el('span', 'sep'));
    btn('−', 'Zoom out', () => world.zoomBy(1 / 1.3));
    btn('+', 'Zoom in', () => world.zoomBy(1.3));
    btn('⤢', 'See everything', () => world.reset());
    const title = opts.title ? titleCard(r, opts, [['Take the tour', true, tour], ['Explore', false, () => {}]]) : null;
    // Keys (and a gamepad through game-pad.js): Enter or Space takes the tour and moves to the next place, Page Up the one
    // before, Escape closes the card, N switches day and night, S the season.
    addEventListener('keydown', e => {
      if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
      if (e.code === 'Enter' || e.code === 'Space' || e.code === 'PageDown') {
        e.preventDefault();
        if (title && !title.classList.contains('gone')) { title.classList.add('gone'); tour(); } else if (world.active) go(1); else tour();
      } else if (e.code === 'PageUp') { if (world.active) go(-1); }
      else if (e.code === 'Escape') { if (title && !title.classList.contains('gone')) title.classList.add('gone'); else if (world.active) close(); else world.reset(); }
      else if (e.code === 'KeyN') dn.click();
      else if (e.code === 'KeyS') { world.setSeason(SEASONS[(SEASONS.indexOf(world.season) + 1) % SEASONS.length]); mark(); }
    });
    padSticks(world);
    return { open, close, tour, card, bar, dayNight: dn };
  }

  // ── Story: chapters that change the world step by step ──
  // chapters: [{ title, text, show: ['A'], hide: [], levels: { A: 2 }, season, time, haze, trees, people, focus: 'A' | [c, r] | null, zoom }]
  // A gamepad's sticks and triggers (read through game-pad.js when the page loads it): the left stick pans, the right
  // stick turns and tilts a 3D world, the triggers zoom.
  function padSticks(world) {
    if (!global.GamePad || world._pad) return;
    world._pad = true;
    (function tick() {
      const s = global.GamePad.stick();
      if ((s.lx || s.ly) && world.panBy) world.panBy(s.lx * 14, s.ly * 14);
      if ((s.rx || s.ry) && world.orbitBy) world.orbitBy(s.rx * 0.035, -s.ry * 0.02);
      const z = s.rt - s.lt;
      if (Math.abs(z) > 0.1 && world.zoomNow) world.zoomNow(1 + z * 0.025);
      requestAnimationFrame(tick);
    })();
  }

  function story(world, chapters, opts = {}) {
    const r = root(opts);
    const box = el('div', 'gv-story gv-panel'); r.append(box);
    const bar = el('div', 'gv-bar gv-panel'); r.append(bar);
    const initial = world.places.map(p => [p.id, p.target, p.level]);
    let at = -1, auto = null;
    function stateAt(i) {                          // replay chapters 0..i from the start, so Back works
      const s = { shown: {}, levels: {}, season: world.season, time: 0, haze: 0, trees: 1, people: null, vehicles: null };
      for (const [id, shown, level] of initial) { s.shown[id] = shown; s.levels[id] = level; }
      for (let k = 0; k <= i; k++) {
        const ch = chapters[k];
        for (const id of ch.show || []) s.shown[id] = 1;
        for (const id of ch.hide || []) s.shown[id] = 0;
        Object.assign(s.levels, ch.levels || {});
        for (const key of ['season', 'time', 'haze', 'trees', 'people', 'vehicles']) if (ch[key] != null) s[key] = ch[key];
      }
      return s;
    }
    function go(i) {
      i = clamp(i, 0, chapters.length - 1); if (i === at) return;
      at = i; const ch = chapters[i], s = stateAt(i);
      for (const p of world.places) {
        if (s.shown[p.id] && !p.target) world.show(p.id); else if (!s.shown[p.id] && p.target) world.hide(p.id);
        if (s.levels[p.id] !== p.level) world.setLevel(p.id, s.levels[p.id]);
      }
      world.setSeason(s.season); world.setTime(s.time); world.setHaze(s.haze); world.setTrees(s.trees);
      if (s.people != null) world.setPeople(s.people);
      if (s.vehicles != null) world.setVehicles(s.vehicles);
      if (ch.focus) world.focus(ch.focus, { zoom: ch.zoom || 1.5, duration: 1.2 }); else world.reset(1.2);
      sfx('whoosh', { volume: 0.4 });
      box.innerHTML = `<div class="step">${esc(ch.step || `Step ${i + 1} of ${chapters.length}`)}</div><h2>${esc(ch.title)}</h2><p>${esc(ch.text || '')}</p>` +
        `<div class="nav"><button class="gv-btn" data-go="-1" ${i ? '' : 'disabled'}>‹ Back</button><div class="gv-dots">${chapters.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div><button class="gv-btn main" data-go="1">${i === chapters.length - 1 ? 'Start again' : 'Next ›'}</button></div>`;
      box.querySelectorAll('[data-go]').forEach(b => { b.onclick = () => { stop(); if (+b.dataset.go > 0 && at === chapters.length - 1) go(0); else go(at + +b.dataset.go); }; });
    }
    const stop = () => { if (auto) { clearInterval(auto); auto = null; playBtn.innerHTML = `<img alt="" src="${iconUrl('play')}"> Play`; } };
    const playBtn = el('button', '', `<img alt="" src="${iconUrl('play')}"> Play`); bar.append(playBtn);
    playBtn.onclick = () => {
      if (auto) return stop();
      playBtn.innerHTML = `<img alt="" src="${iconUrl('pause')}"> Pause`;
      if (at === chapters.length - 1) go(0);
      auto = setInterval(() => { if (at >= chapters.length - 1) stop(); else go(at + 1); }, opts.every || 6500);
    };
    bar.append(el('span', 'sep'));
    for (const [h, title, fn] of [['−', 'Zoom out', () => world.zoomBy(1 / 1.3)], ['+', 'Zoom in', () => world.zoomBy(1.3)], ['⤢', 'See everything', () => world.reset()]]) {
      const b = el('button', '', h); b.title = title; b.setAttribute('aria-label', title); b.onclick = fn; bar.append(b);
    }
    world.onPick = () => {};
    const begin = () => go(0);
    const title = opts.title ? titleCard(r, opts, [['Begin', true, begin]]) : null;
    if (!title) world.ready.then(begin);
    // Keys (and a gamepad through game-pad.js): Right, Space, Enter or Page Down for the next chapter, Left or Page Up back.
    // While the title card shows, the first of them begins the story.
    addEventListener('keydown', e => {
      const next = e.code === 'ArrowRight' || e.code === 'Space' || e.code === 'Enter' || e.code === 'PageDown', back = e.code === 'ArrowLeft' || e.code === 'PageUp';
      if (!next && !back) return;
      e.preventDefault();
      if (title && !title.classList.contains('gone')) { if (next) { title.classList.add('gone'); begin(); } return; }
      stop(); go(at + (next ? 1 : -1));
    });
    padSticks(world);
    return { go, play: () => playBtn.click(), get chapter() { return at; } };
  }

  global.GameVision = { version: '0.2.0', create, ui, story, TW, TH };
})(window);
