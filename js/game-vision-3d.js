/* game-vision-3d.js v0.2.0 -> GameVision.create3d (ES module)
 *
 * The 3D twin of game-vision.js: the same vision (MAP + PLACES, see game-vision.js) as a little low-poly world you
 * can turn, tilt and zoom. Every building kind has a model made here from simple shapes (glass farms, solar fields,
 * turbines that turn, homes with solar roofs, market stalls, civic halls, workshops, parks, reed beds, ...) that grows
 * with its level; trees, people, vehicles, seasons (snow, autumn leaves, blossom), day and night (lit windows and
 * street lamps) and haze. The world has the 2D world's methods, so GameVision.ui and GameVision.story drive it too.
 *
 *   <script type="importmap">{ "imports": { "three": "/js/three.module.min.js", "three/addons/": "/js/three-addons/" } }</script>
 *   <script src="/js/game-assets.js"></script> <script src="/js/game-sfx.js"></script> <script src="/js/game-vision.js"></script>
 *   <script type="module">
 *     import '/js/game-vision-3d.js';
 *     const world = GameVision.create3d(canvas, { map: MAP, places: PLACES, season: 'summer', people: 14, vehicles: 3 });
 *     GameVision.ui(world, VISION);
 *   </script>
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';

const P = 4;                                    // a plot is 4 x 4 units
const SEASONS = ['spring', 'summer', 'autumn', 'winter'];
const GREEN_LOTS = /park|garden|meadow|allotments|orchard|compost|reedbed|wetland|fish|hydro|sewage/;   // lots that are beds, not paving
const GRASS = { spring: 0x84c35a, summer: 0x74b44a, autumn: 0xa9a24c, winter: 0xe9eff3 };
const CANOPY = { spring: [0x8fd16a, 0xf5b5d0], summer: [0x4f9a3a, 0x3f8a33], autumn: [0xd98a2b, 0xc2571f], winter: null };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const back = t => { const c = 1.6; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
const hash = (a, b = 0) => { const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); };
const sfx = (name, o) => { try { if (window.GameSfx) window.GameSfx.play(name, o); } catch (e) {} };

// ── Materials, shared by colour ──
const mats = {};
function mat(color, o = {}) {
  const k = color + JSON.stringify(o);
  return mats[k] || (mats[k] = new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.85, metalness: 0.02 }, o)));
}
const WINDOW = new THREE.MeshStandardMaterial({ color: 0x9cc7e6, roughness: 0.25, metalness: 0.1, emissive: 0xffc070, emissiveIntensity: 0 });
const GLASS = new THREE.MeshStandardMaterial({ color: 0xa8dcf2, roughness: 0.05, metalness: 0.25, transparent: true, opacity: 0.55, depthWrite: false });
const FRAME = new THREE.LineBasicMaterial({ color: 0xf8fafc });
// A glass block with white frames along its edges.
function glassBox(g, w, h, d, x, y, z) {
  const geo = new THREE.BoxGeometry(w, h, d), m = new THREE.Mesh(geo, GLASS);
  m.position.set(x, y + h / 2, z); g.add(m);
  const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), FRAME); e.position.copy(m.position); g.add(e);
  return m;
}
const LAMP = new THREE.MeshStandardMaterial({ color: 0xfff3c4, emissive: 0xffc46b, emissiveIntensity: 0.1 });
const PANEL = new THREE.MeshStandardMaterial({ color: 0x1e3a8a, roughness: 0.3, metalness: 0.5 });
const roofMats = [];                            // roofs turn white in winter
function roofMat(color) { const m = mat(color); m.userData.base = m.userData.base || new THREE.Color(color); if (!roofMats.includes(m)) roofMats.push(m); return m; }

// ── Shape helpers: every model is built from these ──
function box(g, w, h, d, m, x = 0, y = 0, z = 0, ry = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), typeof m === 'number' ? mat(m) : m);
  mesh.position.set(x, y + h / 2, z); mesh.rotation.y = ry; mesh.castShadow = mesh.receiveShadow = true; g.add(mesh); return mesh;
}
function cyl(g, rt, rb, h, m, x = 0, y = 0, z = 0, seg = 12) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), typeof m === 'number' ? mat(m) : m);
  mesh.position.set(x, y + h / 2, z); mesh.castShadow = mesh.receiveShadow = true; g.add(mesh); return mesh;
}
function ball(g, r, m, x = 0, y = 0, z = 0, detail = 0) {
  const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(r, detail), typeof m === 'number' ? mat(m, { flatShading: true }) : m);
  mesh.position.set(x, y, z); mesh.castShadow = true; g.add(mesh); return mesh;
}
// A gable roof (a triangular prism) of width w (across the ridge), height h, length d.
function roof(g, w, h, d, color, x, y, z, ry = 0) {
  const s = new THREE.Shape(); s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false }); geo.translate(0, 0, -d / 2);
  const mesh = new THREE.Mesh(geo, roofMat(color)); mesh.position.set(x, y, z); mesh.rotation.y = ry; mesh.castShadow = true; g.add(mesh); return mesh;
}
// Windows in a grid on the +z face of a w x h block whose base is at (x, y, z).
function windows(g, w, h, x, y, z, cols, rowsN, face = 1) {
  for (let i = 0; i < cols; i++) for (let j = 0; j < rowsN; j++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w / cols * 0.5, h / rowsN * 0.45, 0.04), WINDOW);
    m.position.set(x - w / 2 + (i + 0.5) * w / cols, y + (j + 0.5) * h / rowsN, z + face * 0.01); g.add(m);
  }
}
function solarPanels(g, w, d, x, y, z, tilt = 0.5) {
  for (let i = 0; i < Math.max(1, Math.round(w / 0.7)); i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.04, d), PANEL);
    p.position.set(x - w / 2 + 0.35 + i * 0.7, y + 0.2, z); p.rotation.z = tilt; p.castShadow = true; g.add(p);
  }
}
function tree(g, kind, x, z, h, season) {
  const t = new THREE.Group(); t.position.set(x, 0, z); g.add(t);
  cyl(t, 0.07 * h, 0.1 * h, h * 0.45, 0x7a5232, 0, 0, 0, 6);
  const c = CANOPY[season];
  if (kind === 'pine') {
    for (let i = 0; i < 3; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(h * (0.42 - i * 0.1), h * 0.45, 7), mat(season === 'winter' ? 0x4c7a5a : 0x2f6b3d, { flatShading: true }));
      cone.position.y = h * (0.45 + i * 0.22); cone.castShadow = true; t.add(cone);
      if (season === 'winter') { const cap = cone.clone(); cap.material = mat(0xffffff, { flatShading: true }); cap.scale.setScalar(0.55); cap.position.y += h * 0.1; t.add(cap); }
    }
  } else if (c) {
    const col = kind === 'fruit-tree' && season === 'spring' ? c[1] : kind === 'birch' && season !== 'autumn' ? 0x9fd06c : c[(hash(x, z) * 2) | 0];
    ball(t, h * 0.38, col, 0, h * 0.72, 0, 1);
    ball(t, h * 0.26, col, h * 0.2, h * 0.6, h * 0.1, 1);
    if (kind === 'fruit-tree' && season !== 'winter') for (let i = 0; i < 6; i++) ball(t, h * 0.05, season === 'autumn' ? 0xf59e0b : 0xdc2626, Math.cos(i) * h * 0.3, h * (0.6 + hash(i) * 0.25), Math.sin(i) * h * 0.3);
  } else {                                       // winter: bare branches
    for (let i = 0; i < 4; i++) { const b = cyl(t, 0.015 * h, 0.03 * h, h * 0.4, 0x6b4a2e, 0, h * 0.4, 0, 5); b.rotation.z = Math.cos(i * 1.6) * 0.6; b.rotation.x = Math.sin(i * 1.6) * 0.6; }
  }
  t.userData.kind = kind; t.userData.h = h;
  return t;
}

// ── Building models, by the painted art's kind ──
const HOUSE_COLS = [0xe8d5b5, 0xd9a273, 0xf2e8d8, 0xc98e6a, 0xe6c9a0];
const ROOF_COLS = [0xb4532a, 0x8c3b22, 0x6b7280, 0x9a4a2c];
function houses(level, eco, seed) {
  const g = new THREE.Group(), n = 1 + level;
  for (let i = 0; i < Math.min(4, n); i++) {
    const w = 1.2, d = 1.4, h = 0.9 + (level >= 3 ? 0.5 : 0), x = -1.35 + i * (2.7 / Math.max(1, Math.min(4, n) - 1 || 1)), z = (i % 2 ? 0.5 : -0.4);
    box(g, w, h, d, HOUSE_COLS[(seed + i) % HOUSE_COLS.length], x, 0, z);
    roof(g, w + 0.15, 0.55, d + 0.15, ROOF_COLS[(seed + i) % ROOF_COLS.length], x, h, z, Math.PI / 2);
    windows(g, w * 0.8, h * 0.8, x, 0.1, z + d / 2, 2, level >= 3 ? 2 : 1);
    if (eco) solarPanels(g, 0.9, 0.5, x, h + 0.12, z + 0.25, 0);
    box(g, 0.3, 0.45, 0.04, 0x6b3f22, x + 0.35, 0, z + d / 2 + 0.01);
  }
  if (eco) for (let i = 0; i < 3; i++) ball(g, 0.25, 0x5aa83f, -1.5 + i * 1.5, 0.2, 1.55, 0);
  return g;
}
function flats(level, color, green) {
  const g = new THREE.Group(), h = 1.6 + level * 1.1;
  box(g, 2.8, h, 2.2, color, 0, 0, 0);
  windows(g, 2.6, h - 0.3, 0, 0.15, 1.1, 6, 2 + level);
  box(g, 2.9, 0.12, 2.3, 0x64748b, 0, h, 0);
  if (green) for (let i = 0; i < 5; i++) ball(g, 0.25, 0x4f9a3a, -1.1 + i * 0.55, h + 0.25, (i % 2) * 0.6 - 0.3);
  return g;
}
function greenhouse(level) {
  const g = new THREE.Group(), n = level + 1, len = 3.2 / n;
  for (let i = 0; i < n; i++) {                  // glass houses side by side: low wall, glass walls, glass gable roof
    const x = -1.6 + len * (i + 0.5);
    box(g, len * 0.94, 0.25, 2.6, 0xe7e5e4, x, 0, 0);
    glassBox(g, len * 0.94, 0.75, 2.6, x, 0.25, 0);
    const s = new THREE.Shape(); s.moveTo(-len * 0.47, 0); s.lineTo(len * 0.47, 0); s.lineTo(0, 0.55); s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: 2.6, bevelEnabled: false }); geo.translate(0, 0, -1.3);
    const r = new THREE.Mesh(geo, GLASS); r.position.set(x, 1, 0); g.add(r);
    const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), FRAME); e.position.copy(r.position); g.add(e);
    for (let k = 0; k < 4; k++) for (let row = -1; row <= 1; row += 2) ball(g, 0.14, k % 2 ? 0x4c9a3c : 0x65b345, x - len * 0.3 + k * len * 0.2, 0.42, row * 0.6, 0);
  }
  box(g, 3.4, 0.06, 3, 0xc8b89a, 0, 0, 0);
  return g;
}
function verticalFarm(level) {
  const g = new THREE.Group(), floors = 3 + level * 2;
  for (let i = 0; i < floors; i++) {
    glassBox(g, 2, 0.55, 2, 0, 0.03 + i * 0.6, 0);
    box(g, 1.8, 0.08, 1.8, 0xe5e7eb, 0, i * 0.6, 0);
    for (let k = 0; k < 4; k++) ball(g, 0.16, 0x4c9a3c, -0.6 + k * 0.4, 0.2 + i * 0.6, 0, 0);
  }
  box(g, 2.1, 0.1, 2.1, 0x94a3b8, 0, floors * 0.6, 0);
  return g;
}
function solarField(level) {
  const g = new THREE.Group(), rowsN = 1 + level;
  for (let r = 0; r < rowsN; r++) {
    const z = -1.4 + r * (2.8 / Math.max(1, rowsN - 1));
    for (let i = 0; i < 4; i++) {
      cyl(g, 0.03, 0.03, 0.35, 0x9ca3af, -1.2 + i * 0.8, 0, z, 5);
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.04, 0.5), PANEL);
      p.position.set(-1.2 + i * 0.8, 0.42, z); p.rotation.x = -0.5; p.castShadow = true; g.add(p);
    }
  }
  return g;
}
function turbine(level, g = new THREE.Group()) {
  const n = level >= 3 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : (i ? 0.9 : -0.9), h = 3.6 + level * 0.7;
    cyl(g, 0.07, 0.16, h, 0xf1f5f9, x, 0, 0, 10);
    box(g, 0.2, 0.2, 0.45, 0xe2e8f0, x, h - 0.1, 0.05);
    const rotor = new THREE.Group(); rotor.position.set(x, h + 0.02, 0.32); g.add(rotor);
    for (let b = 0; b < 3; b++) {
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.6 + level * 0.2, 0.03), mat(0xffffff));
      blade.geometry.translate(0, (1.6 + level * 0.2) / 2, 0); blade.rotation.z = b * Math.PI * 2 / 3; blade.castShadow = true; rotor.add(blade);
    }
    (g.userData.spin = g.userData.spin || []).push(rotor);
  }
  return g;
}
function waterTower(level) {
  const g = new THREE.Group(), h = 1.6 + level * 0.4;
  for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]]) cyl(g, 0.05, 0.07, h, 0x8b5e3c, x, 0, z, 6);
  cyl(g, 0.8, 0.8, 1, 0x9ca3af, 0, h, 0, 16);
  const top = new THREE.Mesh(new THREE.ConeGeometry(0.85, 0.4, 16), roofMat(0x6b7280)); top.position.y = h + 1.2; g.add(top);
  return g;
}
function market(level) {
  const g = new THREE.Group(), cols = [0xdc2626, 0x2563eb, 0xf59e0b, 0x16a34a, 0x9333ea];
  const n = 2 + level;
  for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2, x = Math.cos(a) * 1.1, z = Math.sin(a) * 1.1;
    box(g, 0.7, 0.45, 0.5, 0x8b5e3c, x, 0, z, -a);
    for (const [dx, dz] of [[-0.3, -0.2], [0.3, -0.2], [-0.3, 0.2], [0.3, 0.2]]) cyl(g, 0.02, 0.02, 0.85, 0x6b4a2e, x + dx, 0, z + dz, 4);
    const aw = roof(g, 0.8, 0.25, 0.6, cols[i % cols.length], x, 0.85, z, -a + Math.PI / 2);
    for (let k = 0; k < 3; k++) ball(g, 0.07, [0xef4444, 0xf59e0b, 0x84cc16][k], x - 0.2 + k * 0.2, 0.5, z, 0);
    aw.rotation.y = -a;
  }
  cyl(g, 0.3, 0.35, 0.35, 0x94a3b8, 0, 0, 0, 12);
  return g;
}
function civic(level, color, accent, tower) {
  const g = new THREE.Group(), h = 1.3 + level * 0.45;
  box(g, 3, h, 2.2, color, 0, 0, -0.2);
  windows(g, 2.8, h - 0.35, 0, 0.2, 0.9, 7, 2);
  box(g, 3.1, 0.12, 2.3, accent, 0, h, -0.2);
  box(g, 1.2, 0.18, 0.6, accent, 0, h * 0.62, 1.15);
  for (let i = 0; i < 4; i++) cyl(g, 0.06, 0.06, h * 0.62, 0xf8fafc, -0.45 + i * 0.3, 0, 1.3, 8);
  if (tower) { box(g, 0.7, h + 1.2, 0.7, color, 1.05, 0, -0.8); roof(g, 0.85, 0.6, 0.85, accent, 1.05, h + 1.2, -0.8); }
  if (level >= 2) solarPanels(g, 1.6, 0.9, -0.5, h + 0.1, -0.4, 0.3);
  return g;
}
function workshop(level, color, chimney) {
  const g = new THREE.Group(), n = 1 + level;
  box(g, 3, 1.1, 2.2, color, 0, 0, 0);
  for (let i = 0; i < n; i++) {               // a sawtooth roof
    const w = 3 / n, x = -1.5 + w * (i + 0.5);
    roof(g, 2.2, 0.5, w, 0x64748b, x, 1.1, 0, 0).scale.set(1, 1, 1);
  }
  box(g, 0.9, 0.75, 0.05, 0x475569, -0.6, 0, 1.1);
  windows(g, 1.2, 0.6, 0.8, 0.3, 1.1, 3, 1);
  if (chimney) { cyl(g, 0.15, 0.2, 2.2, 0xa8a29e, 1.2, 0, -0.7, 10); g.userData.smoke = new THREE.Vector3(1.2, 2.3, -0.7); }
  return g;
}
function park(level) {
  const g = new THREE.Group();
  const path = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.05, 24), mat(0xd6c9ad)); path.rotation.x = -Math.PI / 2; path.position.y = 0.02; path.receiveShadow = true; g.add(path);
  cyl(g, 0.45, 0.5, 0.25, 0x94a3b8, 0, 0, 0, 16);
  const water = cyl(g, 0.38, 0.38, 0.26, mat(0x60a5fa, { roughness: 0.1 }), 0, 0, 0, 16); water.position.y = 0.02;
  for (let i = 0; i < 2 + level; i++) { const a = i * 2.1 + 0.5; box(g, 0.5, 0.18, 0.16, 0x8b5e3c, Math.cos(a) * 1.35, 0, Math.sin(a) * 1.35, -a); }
  return g;
}
function wetland(level) {
  const g = new THREE.Group();
  const pond = new THREE.Mesh(new THREE.CircleGeometry(1.6, 24), mat(0x3b82c4, { roughness: 0.15 })); pond.rotation.x = -Math.PI / 2; pond.position.y = 0.03; g.add(pond);
  for (let i = 0; i < 18 + level * 10; i++) {
    const a = hash(i, 2) * Math.PI * 2, r = 0.3 + hash(i, 3) * 1.3;
    cyl(g, 0.015, 0.025, 0.35 + hash(i) * 0.4, i % 4 ? 0x5f8f3a : 0x8b6b3a, Math.cos(a) * r, 0, Math.sin(a) * r, 4);
  }
  box(g, 1.8, 0.06, 0.3, 0x9a7a55, 0, 0.12, 0, 0.5);
  return g;
}
function beds(level, plant, extra) {
  const g = new THREE.Group(), rowsN = 2 + level;
  for (let r = 0; r < rowsN; r++) {
    const z = -1.4 + r * (2.8 / (rowsN - 1));
    box(g, 3, 0.15, 0.45, 0x6b4a2e, 0, 0, z);
    for (let i = 0; i < 7; i++) ball(g, 0.13, plant, -1.3 + i * 0.43, 0.25, z, 0);
  }
  if (extra === 'hives') for (let i = 0; i < 2 + level; i++) { box(g, 0.3, 0.35, 0.3, 0xfbbf24, -1.3 + i * 0.7, 0, 1.75); }
  if (extra === 'flowers') for (let i = 0; i < 40; i++) ball(g, 0.06, [0xf472b6, 0xfde047, 0xa78bfa, 0xffffff][i % 4], (hash(i) - 0.5) * 3.4, 0.08, (hash(i, 1) - 0.5) * 3.4);
  return g;
}
function shed(level, color) {
  const g = new THREE.Group();
  box(g, 2.6, 1 + level * 0.3, 1.8, color, 0, 0, -0.4);
  roof(g, 2.0, 0.7, 2.8, 0x7c2d12, 0, 1 + level * 0.3, -0.4, Math.PI / 2);
  box(g, 0.8, 0.8, 0.05, 0x5b3a1e, 0, 0, 0.51);
  for (let i = 0; i < level + 1; i++) cyl(g, 0.35, 0.35, 1.4 + level * 0.3, 0xcbd5e1, -1.2 + i * 0.8, 0, 1.2, 12);
  return g;
}
function battery(level) {
  const g = new THREE.Group();
  for (let i = 0; i < 1 + level; i++) { box(g, 1.2, 0.6, 0.55, [0x16a34a, 0x0ea5e9, 0xf8fafc][i % 3], -0.7 + (i % 2) * 1.4, 0, -1 + Math.floor(i / 2) * 0.8); }
  return g;
}
const BUILDERS = {
  homes: (l, s) => houses(l, false, s), cottage: (l, s) => houses(Math.max(1, l - 1), false, s), homestead: (l, s) => houses(1, false, s),
  eco_homes: (l, s) => houses(l, true, s), shared_house: (l, s) => houses(l, true, s), city_homes_a: (l, s) => houses(3, false, s),
  city_homes_b: (l, s) => houses(3, false, s + 1), city_homes_c: (l, s) => houses(3, true, s + 2),
  city_flats_a: l => flats(l, 0xd6b38c, false), city_flats_b: l => flats(l, 0xb9c4cf, true), student_halls: l => flats(l, 0xc99a7c, false),
  city_offices_a: l => flats(l + 1, 0x9fb5c8, false), city_offices_b: l => flats(l + 1, 0xa8b3bf, true), shop_homes: l => flats(l, 0xe0c5a0, false),
  homes_arcade: l => flats(l, 0xe7c8a0, true), living_wall: l => flats(l, 0x6fa85a, true),
  greenhouse: greenhouse, vertical_farm: verticalFarm, solar: solarField, wind: l => turbine(l), water_tower: waterTower,
  market: market, school: l => civic(l, 0xe9c46a, 0x2a9d8f, true), city_school: l => civic(l, 0xe9c46a, 0x2a9d8f, true),
  library: l => civic(l, 0xd4b896, 0x7c3aed, false), clinic: l => civic(l, 0xf1f5f9, 0xdc2626, false),
  community_centre: l => civic(l, 0xf4a261, 0x264653, true), community_lab: l => civic(l, 0xe2e8f0, 0x0ea5e9, false),
  city_university_a: l => civic(l + 1, 0xc8a37a, 0x1e3a8a, true), city_university_b: l => civic(l + 1, 0xd6c3a5, 0x1e3a8a, true),
  fire_station: l => civic(l, 0xdc2626, 0x7f1d1d, true), police: l => civic(l, 0x1e40af, 0x0f172a, false), bank: l => civic(l, 0xe5e7eb, 0x92400e, false),
  arcade: l => civic(l, 0xf9a8d4, 0x7c3aed, false), test_ground: l => civic(l, 0xcbd5e1, 0xf59e0b, false),
  park: park, cleanup_garden: park, rain_garden: l => wetland(l), reedbed: wetland, floating_wetland: wetland, fish: wetland,
  allotments: l => beds(l, 0x5aa83f), orchard: l => beds(l, 0x3f8a33), bee_meadow: l => beds(l, 0x7fbf4f, 'flowers'),
  mushroom: l => shed(l, 0x8b6b4a), barn: l => shed(l, 0xa0522d), pantry: l => shed(l, 0xc9a27c), cold_store: l => shed(l, 0xdbe4ec),
  bakery: l => workshop(l, 0xe8c39e, true), recycler: l => workshop(l, 0x84a98c, true), repair_shop: l => workshop(l, 0xb08968, false),
  timber_yard: l => workshop(l, 0xa47148, false), brickworks: l => workshop(l, 0xb5523b, true), salvage_yard: l => workshop(l, 0x8d99ae, false),
  compost: l => beds(l, 0x6b4a2e), digester: l => shed(l, 0x9ca3af), biochar_kiln: l => workshop(l, 0x6b7280, true), boiler: l => workshop(l, 0x94a3b8, true),
  chp: l => workshop(l, 0x94a3b8, true), sewage_plant: l => wetland(l), waterworks: l => workshop(l, 0x7dd3fc, false), bus_depot: l => workshop(l, 0x16a34a, false),
  battery: battery, hydro: l => wetland(l), hempcrete: l => workshop(l, 0xd9c7a0, false), depaving_yard: l => workshop(l, 0x9ca3af, false),
};
function model(art, level, seed) {
  const b = BUILDERS[art] || (l => civic(l, [0xe2c9a6, 0xc9d6df, 0xe7d3c3][seed % 3], 0x64748b, seed % 2 === 0));
  return b(clamp(level || 1, 1, 3), seed);
}

// ── The world ──
export function create3d(canvas, cfg = {}) {
  const map = (cfg.map || ['.']).map(r => r.split(''));
  const rows = map.length, cols = Math.max(...map.map(r => r.length));
  const at = (c, r) => (map[r] && map[r][c]) || ' ';
  const isRoad = (c, r) => at(c, r) === '=';
  const isLand = (c, r) => at(c, r) !== ' ' && at(c, r) !== '~';
  const pos = (c, r) => new THREE.Vector3((c - cols / 2) * P, 0, (r - rows / 2) * P);

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.5, 600);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minPolarAngle = 0.35; controls.maxPolarAngle = 1.2;
  const span = Math.max(cols, rows) * P;
  controls.minDistance = 6; controls.maxDistance = span * 2.2;
  controls.screenSpacePanning = false;

  const hemi = new THREE.HemisphereLight(0xdff1ff, 0x5b7c3a, 1.1); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
  sun.position.set(span * 0.5, span * 0.9, span * 0.3); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -span * 0.8, right: span * 0.8, top: span * 0.8, bottom: -span * 0.8, near: 1, far: span * 3 });
  sun.shadow.bias = -0.0005; scene.add(sun);
  scene.fog = new THREE.Fog(0xbfe3f7, span * 1.6, span * 4);

  const world = {
    places: [], season: SEASONS.includes(cfg.season) ? cfg.season : 'summer', time: cfg.time || 0, haze: cfg.haze || 0, treeShare: 1,
    onPick: cfg.onPick || null, active: null, scene, camera, renderer, controls, THREE,
  };

  // Land: a block per plot (grass top, earth sides), water lower, roads on top.
  const land = new THREE.Group(); scene.add(land);
  const earth = mat(0x8a5a36), grassMats = [], waterMat = mat(0x3f93c9, { roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.92 });
  const roadMat = mat(0xd9cfb9), lampHeads = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const ch = at(c, r); if (ch === ' ') continue;
    const p = pos(c, r);
    if (ch === '~') {
      const b = new THREE.Mesh(new THREE.BoxGeometry(P, 1.6, P), [earth, earth, waterMat, earth, earth, earth]);
      b.position.set(p.x, -1.15, p.z); b.receiveShadow = true; land.add(b);
    } else {
      const gm = mat(GRASS.summer).clone(); grassMats.push(gm);
      gm.userData.shade = hash(c, r) * 0.06 - 0.03;
      const b = new THREE.Mesh(new THREE.BoxGeometry(P, 1.8, P), [earth, earth, gm, earth, earth, earth]);
      b.position.set(p.x, -0.9, p.z); b.receiveShadow = true; land.add(b);
    }
    if (isRoad(c, r)) {
      const road = box(land, 1.7, 0.04, 1.7, roadMat, p.x, 0, p.z); road.castShadow = false;
      for (const [dc, dr] of [[1, 0], [0, 1]]) if (isRoad(c + dc, r + dr)) { const q = pos(c + dc, r + dr); const s = box(land, dc ? P : 1.7, 0.04, dr ? P : 1.7, roadMat, (p.x + q.x) / 2, 0, (p.z + q.z) / 2); s.castShadow = false; }
      if (hash(c * 2.3, r * 1.7) < 0.3) {          // a street lamp
        cyl(land, 0.04, 0.05, 1.4, 0x334155, p.x + 0.95, 0, p.z - 0.95, 6);
        const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), LAMP); head.position.set(p.x + 0.95, 1.45, p.z - 0.95); land.add(head);
        lampHeads.push(head.position.clone());
      }
    }
  }

  // Places and trees.
  const plants = new THREE.Group(); scene.add(plants);
  const trees = [];
  function plantTrees() {
    plants.clear(); trees.length = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const ch = at(c, r); if (!'tTo*'.includes(ch) || ch === ' ') continue;
      const p = pos(c, r), n = ch === 'T' ? 3 : ch === 'o' ? 2 : ch === '*' ? 2 : 1 + (hash(c, r) < 0.4 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const x = p.x + (hash(c * 3 + i, r * 7) - 0.5) * P * 0.6, z = p.z + (hash(r * 5 + i, c * 11) - 0.5) * P * 0.6;
        const kind = ch === 'o' ? 'fruit-tree' : ['oak', 'maple', 'birch', 'pine'][(hash(c + i, r) * 4) | 0];
        const tr = ch === '*' ? bush(x, z) : tree(plants, kind, x, z, 1.6 + hash(i, c + r) * 1.1, world.season);
        tr.userData.rank = hash(c * 13 + i, r * 17); trees.push(tr);
      }
    }
    applyTrees();
  }
  function bush(x, z) { const g = new THREE.Group(); g.position.set(x, 0, z); plants.add(g); ball(g, 0.35, world.season === 'winter' ? 0x9ca3af : world.season === 'autumn' ? 0xb45309 : 0x4f9a3a, 0, 0.25, 0, 1); if (world.season === 'spring') for (let i = 0; i < 5; i++) ball(g, 0.06, 0xf9a8d4, Math.cos(i) * 0.3, 0.45, Math.sin(i) * 0.3); return g; }
  const applyTrees = () => { for (const t of trees) t.visible = t.userData.rank <= world.treeShare; };

  const builtGroup = new THREE.Group(); scene.add(builtGroup);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const ch = at(c, r);
    if (!cfg.places || !cfg.places[ch]) continue;
    const p = Object.assign({ id: ch, level: 1 }, cfg.places[ch]);
    p.c = c; p.r = r; p.pos = pos(c, r);
    p.shown = p.hidden ? 0 : 1; p.target = p.shown;
    p.group = new THREE.Group(); p.group.position.copy(p.pos); builtGroup.add(p.group);
    p.seed = (c * 7 + r * 3) % 5;
    build(p);
    world.places.push(p);
  }
  function build(p) {
    if (p.model) p.group.remove(p.model);
    if (!p.lot) {                                  // the plot's lot: paving, or a green bed for gardens and farms
      const green = GREEN_LOTS.test(p.art || '');
      p.lot = box(p.group, P * 0.94, 0.08, P * 0.94, green ? 0x6fae4a : 0xd8cdb5, 0, 0, 0);
      p.lot.castShadow = false;
      const kerb = box(p.group, P * 0.97, 0.05, P * 0.97, green ? 0x5b8f3c : 0xb9ae96, 0, 0, 0); kerb.castShadow = false;
    }
    const m = model(p.art, p.level, p.seed);
    m.rotation.y = p.turn || 0;
    // fit the model to its plot: centred, its footprint filling about 85% of the lot (same scale at every level, so
    // a level-up grows the building rather than shrinking it to fit)
    const bb = new THREE.Box3().setFromObject(m), size = bb.getSize(new THREE.Vector3()), mid = bb.getCenter(new THREE.Vector3());
    if (p.fit == null) p.fit = clamp(P * 0.85 / Math.max(size.x, size.z, 0.5), 0.8, 1.4);
    p.model = new THREE.Group(); p.model.add(m);
    m.position.set(-mid.x, 0.08 / p.fit, -mid.z); p.model.scale.setScalar(p.fit);
    if (m.userData.spin) p.model.userData.spin = m.userData.spin;
    p.model.traverse(o => { o.userData.place = p; });
    p.group.add(p.model);
    p.height = Math.max(1, (bb.max.y + 0.08) * p.fit);
  }
  world.place = id => world.places.find(p => p.id === id);
  world.tourOrder = () => world.places.filter(p => p.title && p.target).sort((a, b) => (a.tour || 99) - (b.tour || 99) || (a.c + a.r) - (b.c + b.r));

  // People and vehicles walk the roads (or the grass when there are none).
  const roadCells = [], grassCells = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { if (isRoad(c, r)) roadCells.push([c, r]); else if (at(c, r) === '.') grassCells.push([c, r]); }
  const cells = roadCells.length ? roadCells : grassCells, walkable = roadCells.length ? isRoad : (c, r) => at(c, r) === '.';
  const movers = new THREE.Group(); scene.add(movers);
  const SKIN = [0x8d5524, 0xc68642, 0xe0ac69, 0xf1c27d, 0x6b4226], SHIRT = [0xdc2626, 0x2563eb, 0xf59e0b, 0x16a34a, 0x9333ea, 0x0d9488, 0xdb2777];
  function figure(i) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.22, 3, 8), mat(SHIRT[i % SHIRT.length])); body.position.y = 0.3; body.castShadow = true; g.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.08, 10, 8), mat(SKIN[i % SKIN.length])); head.position.y = 0.56; head.castShadow = true; g.add(head);
    return g;
  }
  function vehicle(i) {
    const g = new THREE.Group(), col = [0x16a34a, 0xf8fafc, 0xf59e0b, 0x2563eb][i % 4], bus = i % 3 === 0;
    box(g, bus ? 1.3 : 0.75, bus ? 0.55 : 0.35, 0.45, col, 0, 0.1, 0);
    box(g, bus ? 1.1 : 0.4, 0.18, 0.47, WINDOW, bus ? 0 : -0.05, bus ? 0.4 : 0.35, 0);
    for (const [x, z] of [[-0.3, -0.24], [0.3, -0.24], [-0.3, 0.24], [0.3, 0.24]]) { const w = cyl(g, 0.11, 0.11, 0.08, 0x1f2937, x * (bus ? 1.5 : 1), 0.0, z, 10); w.rotation.x = Math.PI / 2; w.position.y = 0.11; }
    return g;
  }
  function agent(kind, i) {
    const [c, r] = cells[(hash(i, kind.length) * cells.length) | 0] || [0, 0];
    const mesh = kind === 'person' ? figure(i) : vehicle(i); movers.add(mesh);
    return { kind, c, r, tc: c, tr: r, p: 1, speed: kind === 'person' ? 0.35 + hash(i) * 0.2 : 0.9, lane: kind === 'person' ? (hash(i, 3) - 0.5) * 0.5 + 0.55 : -0.35, mesh, dist: 0 };
  }
  let walkers = [], cars = [];
  const fitAgents = (list, n, kind, base) => {
    while (list.length > n) movers.remove(list.pop().mesh);
    while (list.length < n && cells.length && (kind === 'person' || roadCells.length)) list.push(agent(kind, list.length + base));
    return list;
  };
  world.setPeople = n => { walkers = fitAgents(walkers, n, 'person', 0); };
  world.setVehicles = n => { cars = fitAgents(cars, n, 'car', 50); };
  world.setPeople(cfg.people == null ? 10 : cfg.people); world.setVehicles(cfg.vehicles == null ? 2 : cfg.vehicles);
  function stepAgent(a, dt) {
    a.p += dt * a.speed; a.dist += dt * a.speed;
    if (a.p >= 1) {
      a.c = a.tc; a.r = a.tr; a.p = 0;
      let next = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dc, dr]) => walkable(a.c + dc, a.r + dr));
      if (next.length > 1) next = next.filter(([dc, dr]) => dc !== -(a.dc || 0) || dr !== -(a.dr || 0));
      if (!next.length) { a.p = 1; return; }
      [a.dc, a.dr] = next[(Math.random() * next.length) | 0]; a.tc = a.c + a.dc; a.tr = a.r + a.dr;
    }
    const p0 = pos(a.c, a.r), p1 = pos(a.tc, a.tr), dir = p1.clone().sub(p0), len = dir.length() || 1;
    const side = new THREE.Vector3(-dir.z / len, 0, dir.x / len).multiplyScalar(a.lane);
    a.mesh.position.copy(p0).addScaledVector(dir, a.p).add(side);
    a.mesh.position.y = a.kind === 'person' ? Math.abs(Math.sin(a.dist * 18)) * 0.04 : 0;
    if (len > 0.01) a.mesh.rotation.y = Math.atan2(-dir.z, dir.x);
  }

  // Night glows (sprites), weather (points), stars.
  const glowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); const g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,200,120,1)'); g.addColorStop(1, 'rgba(255,200,120,0)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
  const glowMat = new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
  for (const h of lampHeads) { const s = new THREE.Sprite(glowMat); s.position.copy(h); s.scale.setScalar(1.6); scene.add(s); }
  const N = 600, wpos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { wpos[i * 3] = (hash(i, 1) - 0.5) * span * 1.2; wpos[i * 3 + 1] = hash(i, 2) * 14; wpos[i * 3 + 2] = (hash(i, 3) - 0.5) * span * 1.2; }
  const wgeo = new THREE.BufferGeometry(); wgeo.setAttribute('position', new THREE.BufferAttribute(wpos, 3));
  const wmat = new THREE.PointsMaterial({ size: 0.12, color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });
  const weather = new THREE.Points(wgeo, wmat); scene.add(weather);
  const spos = new Float32Array(400 * 3);
  for (let i = 0; i < 400; i++) { const a = hash(i, 7) * Math.PI * 2, e = 0.15 + hash(i, 8) * 1.2, d = 250; spos[i * 3] = Math.cos(a) * Math.cos(e) * d; spos[i * 3 + 1] = Math.sin(e) * d; spos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * d; }
  const sgeo = new THREE.BufferGeometry(); sgeo.setAttribute('position', new THREE.BufferAttribute(spos, 3));
  const stars = new THREE.Points(sgeo, new THREE.PointsMaterial({ size: 1.2, color: 0xffffff, transparent: true, opacity: 0, fog: false, sizeAttenuation: false })); scene.add(stars);

  // ── Seasons, time, haze ──
  function applySeason() {
    const s = world.season;
    for (const gm of grassMats) { gm.color.setHex(GRASS[s]); gm.color.offsetHSL(0, 0, gm.userData.shade); }
    waterMat.color.setHex(s === 'winter' ? 0xb7d7ea : 0x3f93c9); waterMat.roughness = s === 'winter' ? 0.6 : 0.15;
    roadMat.color.setHex(s === 'winter' ? 0xf1f5f9 : 0xd9cfb9);
    for (const m of roofMats) m.color.copy(m.userData.base).lerp(new THREE.Color(0xffffff), s === 'winter' ? 0.75 : 0);
    wmat.color.setHex(s === 'autumn' ? 0xd97706 : s === 'spring' ? 0xfbcfe8 : 0xffffff);
    wmat.size = s === 'winter' ? 0.12 : 0.16;
    weather.visible = s !== 'summer' || cfg.weather === 'rain';
    plantTrees();
  }
  world.setSeason = s => { world.season = SEASONS.includes(s) ? s : 'summer'; applySeason(); };
  world.setTime = v => { world.timeTarget = clamp(v, 0, 1); };
  world.setHaze = v => { world.hazeTarget = clamp(v, 0, 1); };
  world.setTrees = share => { world.treeShare = clamp(share, 0, 1); applyTrees(); };
  const DAY = new THREE.Color(0xbfe3f7), NIGHT = new THREE.Color(0x0b1430), HAZE = new THREE.Color(0xb39f86);
  function applyLight() {
    const n = world.time, hz = world.haze;
    const sky = DAY.clone().lerp(NIGHT, n).lerp(HAZE, hz * 0.6);
    scene.background = sky; scene.fog.color.copy(sky);
    scene.fog.near = span * (1.6 - hz * 1.3); scene.fog.far = span * (4 - hz * 2.6);
    sun.intensity = 2.2 * (1 - n * 0.9) * (1 - hz * 0.35); sun.color.setHex(n > 0.5 ? 0x9fb4ff : 0xfff1d6);
    hemi.intensity = 1.1 * (1 - n * 0.7);
    WINDOW.emissiveIntensity = n * 1.4; LAMP.emissiveIntensity = 0.1 + n * 2.2; glowMat.opacity = n * 0.9;
    stars.material.opacity = Math.max(0, n - 0.3) * 1.3;
  }

  // ── Changes ──
  world.show = id => { const p = world.place(id); if (p && !p.target) { p.target = 1; p.shown = 0; sfx('confirm', { volume: 0.5 }); } };
  world.hide = id => { const p = world.place(id); if (p) p.target = 0; };
  world.setLevel = (id, level) => { const p = world.place(id); if (p && p.level !== level) { p.level = level; p.morph = 0; } };

  // ── Camera ──
  let tween = null;
  const center = new THREE.Vector3(0, 0, 0);
  function home() { const d = span * 1.25; return { target: center.clone(), pos: new THREE.Vector3(d * 0.62, d * 0.72, d * 0.62) }; }
  world.moveTo = (target, posn, duration = 1) => {
    if (!duration) { controls.target.copy(target); camera.position.copy(posn); tween = null; return; }
    tween = { t: 0, d: duration, t0: controls.target.clone(), p0: camera.position.clone(), t1: target.clone(), p1: posn.clone() };
  };
  world.reset = (duration = 1) => { const h = home(); world.moveTo(h.target, h.pos, duration); };
  world.focus = (id, o = {}) => {
    const p = typeof id === 'string' ? world.place(id) : null;
    const target = p ? p.pos.clone().setY(p.height * 0.45) : pos(id[0], id[1]);
    const dirv = camera.position.clone().sub(controls.target).normalize();
    const dist = clamp(span * 0.9 / (o.zoom || 1.5), 7, span * 1.6);
    // keep the place clear of a card: shift the view by o.dx/o.dy screen pixels
    const h = canvas.clientHeight || innerHeight, unit = 2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / h;
    const right = new THREE.Vector3().crossVectors(dirv, camera.up).normalize().negate();
    const upv = new THREE.Vector3().crossVectors(right, dirv).normalize();
    const shift = right.multiplyScalar(-(o.dx || 0) * unit).add(upv.multiplyScalar((o.dy || 0) * unit));
    const t = target.clone().add(shift);
    world.moveTo(t, t.clone().addScaledVector(dirv, dist), o.duration == null ? 1.1 : o.duration);
  };
  world.zoomBy = k => { const t = controls.target.clone(), d = camera.position.clone().sub(t); world.moveTo(t, t.clone().addScaledVector(d, 1 / k), 0.35); };
  controls.addEventListener('start', () => { tween = null; });
  // Moving without a mouse (keys, a gamepad's sticks): pan across the ground, turn and tilt round the target, zoom.
  world.panBy = (dx, dy) => {
    tween = null;
    const d = camera.position.distanceTo(controls.target) * 0.0016, fwd = controls.target.clone().sub(camera.position).setY(0).normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x), move = right.multiplyScalar(dx * d).addScaledVector(fwd, -dy * d);
    const half = span * 0.6; move.x = clamp(controls.target.x + move.x, -half, half) - controls.target.x; move.z = clamp(controls.target.z + move.z, -half, half) - controls.target.z;
    controls.target.add(move); camera.position.add(move);
  };
  world.orbitBy = (turn, tilt) => {
    tween = null;
    const off = camera.position.clone().sub(controls.target), sph = new THREE.Spherical().setFromVector3(off);
    sph.theta -= turn; sph.phi = clamp(sph.phi + tilt, controls.minPolarAngle, controls.maxPolarAngle);
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(sph));
  };
  world.zoomNow = k => {
    tween = null;
    const off = camera.position.clone().sub(controls.target), len = clamp(off.length() / k, controls.minDistance, controls.maxDistance);
    camera.position.copy(controls.target).add(off.setLength(len));
  };
  addEventListener('keydown', e => {
    if (/INPUT|TEXTAREA|SELECT/.test((e.target && e.target.tagName) || '')) return;
    if (e.code === 'ArrowLeft') world.panBy(-60, 0); else if (e.code === 'ArrowRight') world.panBy(60, 0);
    else if (e.code === 'ArrowUp') world.panBy(0, -60); else if (e.code === 'ArrowDown') world.panBy(0, 60);
    else if (e.key === '+' || e.key === '=') world.zoomNow(1.15); else if (e.key === '-') world.zoomNow(1 / 1.15);
    else if (e.code === 'KeyQ') world.orbitBy(-0.2, 0); else if (e.code === 'KeyE') world.orbitBy(0.2, 0);
  });

  // ── Markers (HTML, so they stay sharp and tappable) and picking ──
  const layer = document.createElement('div');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;overflow:hidden';
  document.body.append(layer);
  const accent = cfg.accent || '#8b5cf6';
  const markCss = document.createElement('style');
  markCss.textContent = `.gv3-m{position:absolute;width:38px;height:38px;margin:-19px 0 0 -19px;border-radius:50%;background:#fff;border:3px solid ${accent};box-shadow:0 4px 14px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;pointer-events:auto;cursor:pointer;font:700 15px system-ui;color:${accent};transition:transform .15s}
  .gv3-m:hover{transform:scale(1.12)}.gv3-m.on{border-color:#f59e0b}.gv3-m img{width:26px;height:26px}
  .gv3-m::after{content:'';position:absolute;inset:-3px;border-radius:50%;border:3px solid ${accent};animation:gv3p 1.6s infinite}
  @keyframes gv3p{from{transform:scale(1);opacity:.8}to{transform:scale(1.9);opacity:0}}`;
  document.head.append(markCss);
  function markerFor(p, i) {
    if (p.el) return p.el;
    const el = p.el = document.createElement('button'); el.className = 'gv3-m'; el.setAttribute('aria-label', p.title);
    if (p.icon && window.GameAssets) { const im = document.createElement('img'); im.alt = ''; window.GameAssets.ready().then(() => { im.src = window.GameAssets.url(`painted/icons/${p.icon}.webp`); }); el.append(im); } else el.textContent = p.emoji || String(i + 1);
    el.onclick = () => { sfx('select', { volume: 0.5 }); if (world.onPick) world.onPick(p); };
    layer.append(el); return el;
  }
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  let downAt = null;
  canvas.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointerup', e => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
    const r = canvas.getBoundingClientRect();
    mouse.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObject(builtGroup, true).find(h => h.object.userData.place);
    if (hit && world.onPick) { sfx('select', { volume: 0.5 }); world.onPick(hit.object.userData.place); }
  });

  // ── Loop ──
  function fit() {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  addEventListener('resize', fit); fit();
  let last = performance.now(), t = 0;
  const v = new THREE.Vector3();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
    if (tween) {
      tween.t += dt / tween.d; const k = ease(Math.min(1, tween.t));
      controls.target.lerpVectors(tween.t0, tween.t1, k); camera.position.lerpVectors(tween.p0, tween.p1, k);
      if (tween.t >= 1) tween = null;
    }
    controls.update();
    if (world.timeTarget != null) world.time += (world.timeTarget - world.time) * Math.min(1, dt * 2.5);
    if (world.hazeTarget != null) world.haze += (world.hazeTarget - world.haze) * Math.min(1, dt * 2);
    applyLight();
    for (const p of world.places) {
      if (p.target && p.shown < 1) p.shown = Math.min(1, p.shown + dt / 0.9);
      if (!p.target && p.shown > 0) p.shown = Math.max(0, p.shown - dt / 0.5);
      if (p.morph != null && p.morph < 1) { if (p.morph === 0) build(p); p.morph = Math.min(1, p.morph + dt / 0.7); }
      const s = p.target ? back(p.shown) : p.shown, m = p.morph != null && p.morph < 1 ? 0.6 + 0.4 * back(p.morph) : 1;
      p.group.scale.set(1, Math.max(0.001, s * m), 1); p.group.visible = p.shown > 0.001;
      if (p.model.userData.spin) for (const r of p.model.userData.spin) r.rotation.z -= dt * 1.6;
    }
    for (const a of walkers) stepAgent(a, dt);
    for (const a of cars) stepAgent(a, dt);
    if (weather.visible) {
      const arr = wgeo.attributes.position.array, fall = world.season === 'winter' ? 1.2 : cfg.weather === 'rain' && world.season === 'summer' ? 9 : 0.9;
      for (let i = 0; i < N; i++) { arr[i * 3 + 1] -= dt * fall * (0.6 + hash(i) * 0.8); arr[i * 3] += Math.sin(t + i) * dt * 0.3; if (arr[i * 3 + 1] < 0) arr[i * 3 + 1] = 14; }
      wgeo.attributes.position.needsUpdate = true;
    }
    // markers follow their places on screen
    const order = world.tourOrder(), w = canvas.clientWidth, h = canvas.clientHeight;
    for (const p of world.places) if (p.el) p.el.style.display = 'none';
    order.forEach((p, i) => {
      if (p.shown < 0.9 || p.noMarker) return;
      const el = markerFor(p, i);
      v.copy(p.pos).setY(p.height + 0.7 + Math.sin(t * 2.4 + i) * 0.08).project(camera);
      if (v.z > 1) return;
      el.style.display = 'flex'; el.style.left = ((v.x + 1) / 2 * w) + 'px'; el.style.top = ((1 - v.y) / 2 * h) + 'px';
      el.classList.toggle('on', world.active === p);
    });
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  applySeason();
  world.reset(0);
  world.ready = Promise.resolve(world);
  requestAnimationFrame(frame);
  return world;
}

window.GameVision = window.GameVision || {};
window.GameVision.create3d = create3d;
export default create3d;
