/**
 * game-racing.js v0.2.2 — Shared utilities for racing games on GameZone.
 *
 * Include after game-base.js:
 *   <script src="/js/game-racing.js"></script>
 *
 * ── Track themes ──────────────────────────────────────────────────────────────
 *   GameRacing.themes                         — built-in theme map
 *   GameRacing.themes.add(key, def)           — register a custom theme
 *   Built-in keys: asphalt, dirt, sand, ice, night, snow
 *
 * ── Track system (pseudo-3D OutRun-style) ────────────────────────────────────
 *   GameRacing.track.build(segments)          — parse segment array → trackData
 *     segment: { curve?, hill?, color?, length? }
 *   GameRacing.track.draw(ctx, cw, ch, trackData, camPos, opts)
 *     camPos: float position along track (0–trackData.length)
 *     opts: { theme, depth, fov, camHeight, camDepth, drawDist, fog }
 *   GameRacing.track.drawMinimap(ctx, x, y, w, h, trackData, racers, opts)
 *     opts: { bgColor, lineColor, playerColor, aiColor }
 *
 * ── Top-down track renderer ───────────────────────────────────────────────────
 *   GameRacing.topdown.drawRoad(ctx, cw, ch, camX, camY, trackPoints, opts)
 *     trackPoints: [{x,y}] world-space points
 *     opts: { theme, roadW, zoom }
 *   GameRacing.topdown.drawBackground(ctx, cw, ch, camX, camY, theme, frameCount)
 *
 * ── Car drawing ───────────────────────────────────────────────────────────────
 *   GameRacing.car.drawTop(ctx, x, y, angle, opts)
 *     opts: { color, w, h, team, number, shadow }
 *   GameRacing.car.drawSide(ctx, x, y, dir, opts)
 *     opts: { color, w, h, frame, boost }
 *   GameRacing.car.drawExhaust(ctx, x, y, angle, speed, frameCount)
 *
 * ── Physics ───────────────────────────────────────────────────────────────────
 *   GameRacing.physics.create(opts)           — create racer entity
 *     opts: { x, y, angle, maxSpeed, accel, brake, steer, grip, mass }
 *   GameRacing.physics.update(racer, input, opts)
 *     input: { throttle(0-1), brake(0-1), steerLeft(bool), steerRight(bool), boost(bool) }
 *     opts:  { surface, dt, worldW, worldH }
 *     surface: 'asphalt'|'dirt'|'sand'|'ice'|'snow'  — affects grip
 *     Mutates racer: x, y, angle, speed, drift, onRoad
 *
 * ── AI racers ─────────────────────────────────────────────────────────────────
 *   GameRacing.ai.create(racer, waypoints)    — attach AI to a racer
 *   GameRacing.ai.update(racer, racers, opts) — run one AI tick
 *     opts: { avoidRadius, rubberBand, playerSpeed }
 *
 * ── Race manager ──────────────────────────────────────────────────────────────
 *   GameRacing.race.create(opts)
 *     opts: { laps, racers, checkpoints, countdown }
 *     Returns race state object
 *   GameRacing.race.update(race, racers)      — update lap/checkpoint progress
 *   GameRacing.race.positions(race)           — sorted array [{racer, pos}]
 *   GameRacing.race.countdownStr(race, frameCount) — '3','2','1','GO!', or null
 *   GameRacing.race.formatTime(ms)            — '1:23.456'
 *
 * ── HUD ───────────────────────────────────────────────────────────────────────
 *   GameRacing.hud.draw(ctx, cw, ch, opts)
 *     opts: { speed, maxSpeed, gear, lap, laps, position, total,
 *             time, bestLap, accentColor, theme }
 *   GameRacing.hud.speedometer(ctx, cx, cy, r, speed, maxSpeed, opts)
 *     opts: { accentColor, showDigital }
 *   GameRacing.hud.raceInfo(ctx, cw, opts)
 *     opts: { position, total, lap, laps, accentColor }
 *
 * ── Effects ───────────────────────────────────────────────────────────────────
 *   GameRacing.fx.addSkid(marks, x, y, w, angle, alpha)
 *   GameRacing.fx.drawSkids(ctx, marks, camX, camY, zoom)
 *   GameRacing.fx.boostFlame(ctx, x, y, angle, frameCount, opts)
 *   GameRacing.fx.dustCloud(particles, x, y, color, count)
 *   GameRacing.fx.updateParticles(particles) — mutates array in place
 *   GameRacing.fx.drawParticles(ctx, particles, camX, camY, zoom)
 */
(function (global) {
  'use strict';

  // ── Shared helpers ────────────────────────────────────────────────
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function angleDiff(a, b) {
    let d = ((b - a) % (Math.PI * 2) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
    return d;
  }

  // ── Themes ────────────────────────────────────────────────────────
  const themes = {
    asphalt: {
      sky1: '#4a7ab5', sky2: '#8ab4d8',
      road1: '#3a3a3a', road2: '#424242',
      rumble1: '#cc2222', rumble2: '#eeeeee',
      lane: 'rgba(255,255,255,0.7)',
      grass1: '#3a8a2a', grass2: '#2a7a1a',
      fog: 'rgba(180,200,220,',
      ground: '#2a6a1a',
    },
    dirt: {
      sky1: '#c8803a', sky2: '#e8b060',
      road1: '#8b5e3c', road2: '#9a6b47',
      rumble1: '#c88840', rumble2: '#e8a850',
      lane: 'rgba(200,160,80,0.5)',
      grass1: '#a08030', grass2: '#907020',
      fog: 'rgba(200,160,100,',
      ground: '#806020',
    },
    sand: {
      sky1: '#e8c87a', sky2: '#f0d898',
      road1: '#c8b060', road2: '#d8c070',
      rumble1: '#e05a00', rumble2: '#f0d080',
      lane: 'rgba(255,220,100,0.4)',
      grass1: '#c0a040', grass2: '#b09030',
      fog: 'rgba(220,200,150,',
      ground: '#a08030',
    },
    ice: {
      sky1: '#78b8e0', sky2: '#b8e0f8',
      road1: '#98b8d0', road2: '#a8c8e0',
      rumble1: '#5590c0', rumble2: '#ddeeff',
      lane: 'rgba(200,230,255,0.6)',
      grass1: '#b8d8f0', grass2: '#a0c0e0',
      fog: 'rgba(180,220,240,',
      ground: '#90b0d0',
    },
    night: {
      sky1: '#050510', sky2: '#0a0a20',
      road1: '#222230', road2: '#2a2a3a',
      rumble1: '#880000', rumble2: '#444466',
      lane: 'rgba(255,255,200,0.5)',
      grass1: '#0a1a08', grass2: '#081408',
      fog: 'rgba(10,10,30,',
      ground: '#081008',
    },
    snow: {
      sky1: '#c0d8f0', sky2: '#e0eef8',
      road1: '#8898a8', road2: '#98a8b8',
      rumble1: '#cc4444', rumble2: '#ffffff',
      lane: 'rgba(255,255,255,0.8)',
      grass1: '#d0e0f0', grass2: '#c0d0e8',
      fog: 'rgba(200,220,240,',
      ground: '#c8d8e8',
    },
    add(key, def) { themes[key] = def; },
  };

  // ── Pseudo-3D Track ───────────────────────────────────────────────

  const SEGMENT_LENGTH = 200;
  const ROAD_WIDTH = 3.5; // road half-width in projection units (scale * ROAD_WIDTH * halfW = screen pixels)

  const track = {
    /**
     * Build track data from a segment definition array.
     * Each segment: { length?, curve?, hill?, colorAlt? }
     *   length:   segment length in units (default 200)
     *   curve:    lateral curvature, negative=left, positive=right (default 0)
     *   hill:     vertical slope (default 0)
     *   colorAlt: true to use alternate color band
     */
    build(segments) {
      const out = [];
      let z = 0;
      let x = 0;
      let y = 0;
      let curve = 0;
      let hill = 0;
      let alt = false;
      let segIdx = 0;

      for (const def of segments) {
        const len = def.length || SEGMENT_LENGTH;
        const count = Math.ceil(len / SEGMENT_LENGTH);
        for (let i = 0; i < count; i++) {
          alt = segIdx % 2 === 0;
          out.push({
            index: segIdx++,
            z: z,
            x: x,
            y: y,
            curve: def.curve || 0,
            hill: def.hill || 0,
            alt,
            fog: 0,
            clip: 0,
          });
          z += SEGMENT_LENGTH;
          x += (def.curve || 0) * SEGMENT_LENGTH * 0.001;
          y += (def.hill || 0) * SEGMENT_LENGTH * 0.001;
        }
      }

      return { segments: out, length: z, trackLen: out.length };
    },

    /**
     * Draw pseudo-3D road.
     * @param {CanvasRenderingContext2D} ctx
     * @param {number} cw  canvas width
     * @param {number} ch  canvas height
     * @param {object} trackData  from track.build()
     * @param {number} camPos  float position (0 to trackData.length)
     * @param {object} opts
     *   theme:     theme key (default 'asphalt')
     *   camHeight: camera height (default 1500)
     *   camDepth:  camera depth/FOV (default 0.84)
     *   drawDist:  segments to render (default 200)
     *   fog:       fog density 0–1 (default 0.5)
     *   speedPct:  0–1 for speed blur effect
     */
    draw(ctx, cw, ch, trackData, camPos, opts = {}) {
      const tc      = themes[opts.theme] || themes.asphalt;
      const camH    = opts.camHeight ?? 1500;
      const depth   = opts.camDepth  ?? 0.84;
      const drawD   = opts.drawDist  ?? 200;
      const fogDens = opts.fog       ?? 0.5;
      const segs    = trackData.segments;
      const segLen  = segs.length;

      // Sky
      const grad = ctx.createLinearGradient(0, 0, 0, ch * 0.5);
      grad.addColorStop(0, tc.sky1);
      grad.addColorStop(1, tc.sky2);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cw, ch * 0.5);

      // Ground
      ctx.fillStyle = tc.ground;
      ctx.fillRect(0, ch * 0.5, cw, ch * 0.5);

      const startPos = Math.floor(camPos / SEGMENT_LENGTH) % segLen;
      const camZ     = (camPos % SEGMENT_LENGTH) / SEGMENT_LENGTH;
      const halfW    = cw / 2;
      const halfH    = ch / 2;

      let cameraX = -(opts.lateralOffset ?? 0); // negative: player right → road shifts left
      let cameraY = 0;

      // Collect projected segments back-to-front
      const projected = [];
      for (let i = 0; i < drawD; i++) {
        const si  = (startPos + i) % segLen;
        const seg = segs[si];

        const segZ   = (i - camZ + 0.5) * SEGMENT_LENGTH;
        const scale  = depth / (segZ / (cw * depth));
        const roadW  = scale * ROAD_WIDTH * halfW;

        // World projection — camH raises the ground plane below the horizon
        const px = halfW + (seg.x - cameraX) * scale * cw;
        const py = halfH + camH * scale - (seg.y - cameraY) * scale * halfW;

        cameraX += seg.curve * 0.5 / (drawD * 0.5);
        cameraY += seg.hill  * 0.5 / (drawD * 0.5);

        const fogAmt = Math.min(1, (i / drawD) * fogDens * 2);
        projected.push({ seg, px, py, roadW, fogAmt, i });
      }

      // Draw back-to-front
      for (let i = projected.length - 1; i >= 0; i--) {
        const { seg, px, py, roadW, fogAmt } = projected[i];
        const next = projected[i + 1];
        if (!next) continue;

        const nx = next.px, ny = next.py, nw = next.roadW;
        const alt = seg.alt;
        const fogStr = tc.fog + fogAmt.toFixed(2) + ')';

        // Grass strip
        ctx.fillStyle = fogAmt > 0.01
          ? _blendFog(alt ? tc.grass1 : tc.grass2, fogAmt)
          : (alt ? tc.grass1 : tc.grass2);
        ctx.fillRect(0, ny, cw, py - ny);

        // Rumble strips
        const rumbleW = roadW * 0.15;
        ctx.fillStyle = _blendFog(alt ? tc.rumble1 : tc.rumble2, fogAmt);
        _trapezoid(ctx, px - roadW - rumbleW, ny, nx - nw - rumbleW * (nw / roadW), py,
                        px - roadW, ny, nx - nw, py);
        _trapezoid(ctx, px + roadW, ny, nx + nw, py,
                        px + roadW + rumbleW, ny, nx + nw + rumbleW * (nw / roadW), py);

        // Road surface
        ctx.fillStyle = _blendFog(alt ? tc.road1 : tc.road2, fogAmt);
        _trapezoid(ctx, px - roadW, ny, nx - nw, py, px + roadW, ny, nx + nw, py);

        // Center lane dash
        if (alt) {
          const lw = roadW * 0.02;
          ctx.fillStyle = tc.lane;
          _trapezoid(ctx, px - lw, ny, nx - lw * (nw / roadW), py,
                          px + lw, ny, nx + lw * (nw / roadW), py);
        }

      }
    },

    /**
     * Draw a minimap of the track with racer dots.
     */
    drawMinimap(ctx, x, y, w, h, trackData, racers, opts = {}) {
      const bg      = opts.bgColor     || 'rgba(0,0,0,0.6)';
      const lineC   = opts.lineColor   || '#888';
      const playerC = opts.playerColor || '#00ff88';
      const aiC     = opts.aiColor     || '#ff4444';
      const segs    = trackData.segments;
      const total   = trackData.length;
      const r       = Math.min(w, h) * 0.4;
      const cx      = x + w / 2;
      const cy      = y + h / 2;

      rr(ctx, x, y, w, h, 6);
      ctx.fillStyle = bg;
      ctx.fill();

      // Trace the track shape
      ctx.strokeStyle = lineC;
      ctx.lineWidth = 3;
      ctx.beginPath();
      let px2 = 0, py2 = 0;
      for (let i = 0; i < segs.length; i += Math.ceil(segs.length / 80)) {
        const seg  = segs[i];
        const frac = i / segs.length;
        const ang  = frac * Math.PI * 2 - Math.PI / 2;
        const ex   = cx + (Math.cos(ang) + seg.x * 0.0001) * r;
        const ey   = cy + (Math.sin(ang) + seg.y * 0.0001) * r;
        if (i === 0) ctx.moveTo(ex, ey); else ctx.lineTo(ex, ey);
      }
      ctx.closePath();
      ctx.stroke();

      // Racer dots
      if (racers) {
        for (const rac of racers) {
          const frac = ((rac.trackPos || 0) % total) / total;
          const ang  = frac * Math.PI * 2 - Math.PI / 2;
          const ex   = cx + Math.cos(ang) * r;
          const ey   = cy + Math.sin(ang) * r;
          ctx.fillStyle = rac.isPlayer ? playerC : aiC;
          ctx.beginPath(); ctx.arc(ex, ey, rac.isPlayer ? 4 : 3, 0, Math.PI * 2); ctx.fill();
        }
      }
    },

    /**
     * Project a sprite at a track position to screen coords for first-person view.
     * Call this after track.draw() for each opponent car, then draw the sprite yourself.
     *
     * @param {number} camPos      camera's current track position (same value passed to draw)
     * @param {number} spritePos   sprite's track position
     * @param {number} lateralX    -1..1 lateral offset (0 = road center)
     * @param {object} trackData   from track.build()
     * @param {number} cw          canvas width
     * @param {number} ch          canvas height
     * @param {object} opts        same opts as track.draw — camDepth, drawDist
     * @returns {{ screenX, screenY, scale, roadW, relDist }} or null if not visible
     *
     * Use scale to size the sprite: a car that's 0.5 road-widths wide is roadW * 0.5 px.
     * screenY is the horizon line — draw the car just below it (y = screenY - carH).
     */
    projectPos(camPos, spritePos, lateralX, trackData, cw, ch, opts = {}) {
      const segs     = trackData.segments;
      const total    = trackData.length;
      const depth    = opts.camDepth  ?? 0.84;
      const drawDist = opts.drawDist  ?? 200;
      const halfW    = cw / 2;
      const halfH    = ch / 2;

      // Relative distance ahead of camera (wraps around the track)
      let relDist = spritePos - camPos;
      if (relDist < 0) relDist += total;
      if (relDist <= 0 || relDist > drawDist * SEGMENT_LENGTH) return null;

      // Segment the sprite sits on
      const startSeg  = Math.floor(camPos / SEGMENT_LENGTH) % segs.length;
      const relSeg    = Math.floor(relDist / SEGMENT_LENGTH);
      const sprSegIdx = (startSeg + relSeg) % segs.length;
      const seg       = segs[sprSegIdx];

      // Depth (segZ) using the same formula as track.draw so scale matches the road
      const camZ = (camPos % SEGMENT_LENGTH) / SEGMENT_LENGTH;
      const segZ = (relSeg - camZ + 0.5) * SEGMENT_LENGTH;
      if (segZ <= 0) return null;

      const camH  = opts.camHeight ?? 1500;
      const scale = depth / (segZ / (cw * depth));
      const roadW = scale * ROAD_WIDTH * halfW;

      // Screen position — matches track.draw() projection formula
      const screenX = halfW + (seg.x ?? 0) * scale * cw * 0.5 + lateralX * roadW;
      const screenY = halfH  + camH * scale - (seg.y ?? 0) * scale * halfW;

      return { screenX, screenY, scale, roadW, relDist };
    },
  };

  function _blendFog(hexOrRgb, fogAmt) {
    if (fogAmt < 0.02) return hexOrRgb;
    return `rgba(180,200,220,${fogAmt.toFixed(2)})`;
  }

  function _trapezoid(ctx, x1, y1, x2, y2, x3, y1b, x4, y2b) {
    ctx.beginPath();
    ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.lineTo(x4, y2b); ctx.lineTo(x3, y1b);
    ctx.closePath();
    ctx.fill();
  }

  // ── Top-Down Road ─────────────────────────────────────────────────
  const topdown = {
    /**
     * Draw a top-down scrolling road from a list of world-space centerline points.
     * @param {object[]} trackPoints  [{x, y}] world-space
     * @param {number}   camX/camY   world camera center
     * @param {object}   opts
     *   roadW:  road half-width in world units (default 60)
     *   zoom:   pixels per world unit (default 1)
     *   theme:  theme key
     */
    drawRoad(ctx, cw, ch, camX, camY, trackPoints, opts = {}) {
      const tc    = themes[opts.theme] || themes.asphalt;
      const roadW = opts.roadW ?? 60;
      const zoom  = opts.zoom  ?? 1;
      const offX  = cw / 2 - camX * zoom;
      const offY  = ch / 2 - camY * zoom;

      if (trackPoints.length < 2) return;

      // Build path once — reuse for all three stroke layers
      ctx.lineCap  = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(trackPoints[0].x * zoom + offX, trackPoints[0].y * zoom + offY);
      for (let i = 1; i < trackPoints.length; i++) {
        ctx.lineTo(trackPoints[i].x * zoom + offX, trackPoints[i].y * zoom + offY);
      }

      // 1. Rumble border (widest, drawn first so road covers center)
      ctx.strokeStyle = tc.rumble1;
      ctx.lineWidth   = (roadW * 2 + 14) * zoom;
      ctx.stroke();

      // 2. Road surface
      ctx.strokeStyle = tc.road1;
      ctx.lineWidth   = roadW * 2 * zoom;
      ctx.stroke();

      // 3. Center line dashes
      ctx.strokeStyle = tc.lane;
      ctx.lineWidth   = 2 * zoom;
      ctx.setLineDash([20 * zoom, 20 * zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
    },

    drawBackground(ctx, cw, ch, camX, camY, themeName, frameCount) {
      const tc = themes[themeName] || themes.asphalt;
      const grad = ctx.createLinearGradient(0, 0, 0, ch);
      grad.addColorStop(0, tc.grass1);
      grad.addColorStop(1, tc.grass2);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, cw, ch);
    },
  };

  // ── Car Drawing ───────────────────────────────────────────────────
  const car = {
    /**
     * Draw a top-down car.
     * @param {number} angle  radians, 0 = pointing right
     * @param {object} opts
     *   color:   main body color
     *   w:       car width (default 20)
     *   h:       car height/length (default 36)
     *   number:  race number string
     *   shadow:  draw drop shadow
     *   boost:   show boost glow
     */
    drawTop(ctx, x, y, angle, opts = {}) {
      const color  = opts.color  || '#e03020';
      const cw2    = opts.w      || 20;
      const ch2    = opts.h      || 36;
      const num    = opts.number ?? '';
      const shadow = opts.shadow !== false;
      const boost  = opts.boost  || false;

      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle + Math.PI / 2);

      if (shadow) {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        rr(ctx, -cw2 / 2 + 3, -ch2 / 2 + 3, cw2, ch2, 5);
        ctx.fill();
      }

      if (boost) {
        ctx.shadowColor = '#00aaff';
        ctx.shadowBlur  = 18;
      }

      // Body
      ctx.fillStyle = color;
      rr(ctx, -cw2 / 2, -ch2 / 2, cw2, ch2, 5);
      ctx.fill();

      // Windshield
      ctx.fillStyle = 'rgba(180,230,255,0.75)';
      rr(ctx, -cw2 / 2 + 3, -ch2 / 2 + 4, cw2 - 6, ch2 * 0.32, 3);
      ctx.fill();

      // Rear window
      ctx.fillStyle = 'rgba(140,190,220,0.5)';
      rr(ctx, -cw2 / 2 + 3, ch2 / 2 - ch2 * 0.28 - 2, cw2 - 6, ch2 * 0.22, 2);
      ctx.fill();

      // Wheels (four corners)
      ctx.fillStyle = '#1a1a1a';
      const wx = cw2 / 2 + 2, wy = ch2 / 2 - 7;
      [[-wx, -wy], [wx, -wy], [-wx, wy], [wx, wy]].forEach(([wdx, wdy]) => {
        rr(ctx, wdx - 4, wdy - 5, 8, 10, 2);
        ctx.fill();
      });

      // Highlight stripe
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      rr(ctx, -cw2 / 2 + 2, -ch2 / 2 + 2, 5, ch2 - 4, 2);
      ctx.fill();

      // Race number
      if (num) {
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.round(cw2 * 0.55)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(num, 0, 4);
      }

      ctx.shadowBlur = 0;
      ctx.restore();
    },

    /**
     * Draw a side-view car (for pseudo-3D road rendering).
     * @param {number} dir   1=right, -1=left
     * @param {object} opts
     *   color:  body color
     *   w:      car width (default 48)
     *   h:      car height (default 28)
     *   frame:  animation frame 0–3 (wheel spin)
     *   boost:  bool
     */
    drawSide(ctx, x, y, dir, opts = {}) {
      const color = opts.color || '#e03020';
      const cw2   = opts.w    || 48;
      const ch2   = opts.h    || 28;
      const f     = opts.frame || 0;
      const boost = opts.boost || false;

      ctx.save();
      ctx.translate(x, y);
      if (dir < 0) { ctx.scale(-1, 1); }

      if (boost) {
        ctx.shadowColor = '#00aaff';
        ctx.shadowBlur  = 20;
        // Exhaust flame
        ctx.fillStyle = '#00aaff';
        ctx.beginPath();
        ctx.moveTo(-8, ch2 - 8);
        ctx.lineTo(-18 - Math.random() * 8, ch2 - 8 + Math.random() * 4 - 2);
        ctx.lineTo(-8, ch2 - 4);
        ctx.fill();
      }

      // Shadow under
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(cw2 / 2, ch2 + 2, cw2 * 0.5, 5, 0, 0, Math.PI * 2);
      ctx.fill();

      // Body lower
      ctx.fillStyle = color;
      rr(ctx, 0, ch2 * 0.4, cw2, ch2 * 0.6, 4);
      ctx.fill();

      // Cockpit / roof
      ctx.fillStyle = color;
      rr(ctx, cw2 * 0.2, 0, cw2 * 0.65, ch2 * 0.55, 6);
      ctx.fill();

      // Windshield
      ctx.fillStyle = 'rgba(180,230,255,0.8)';
      rr(ctx, cw2 * 0.48, ch2 * 0.04, cw2 * 0.28, ch2 * 0.38, 3);
      ctx.fill();

      // Rear window
      ctx.fillStyle = 'rgba(140,190,220,0.6)';
      rr(ctx, cw2 * 0.22, ch2 * 0.06, cw2 * 0.2, ch2 * 0.32, 3);
      ctx.fill();

      // Wheels
      ctx.fillStyle = '#1a1a1a';
      const wAngle = f * Math.PI / 2;
      [cw2 * 0.12, cw2 * 0.78].forEach(wx => {
        ctx.beginPath(); ctx.arc(wx, ch2 + 1, 9, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#444';
        ctx.beginPath(); ctx.arc(wx, ch2 + 1, 5, 0, Math.PI * 2); ctx.fill();
        // Spoke
        ctx.strokeStyle = '#666'; ctx.lineWidth = 1.5;
        ctx.save(); ctx.translate(wx, ch2 + 1); ctx.rotate(wAngle);
        ctx.beginPath(); ctx.moveTo(-5, 0); ctx.lineTo(5, 0);
        ctx.moveTo(0, -5); ctx.lineTo(0, 5);
        ctx.stroke(); ctx.restore();
        ctx.fillStyle = '#1a1a1a';
      });

      // Highlight
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      rr(ctx, cw2 * 0.22, 2, cw2 * 0.5, 5, 2);
      ctx.fill();

      ctx.shadowBlur = 0;
      ctx.restore();
    },

    /**
     * Draw exhaust puffs behind a car (top-down).
     * @param {number} angle  car heading angle
     * @param {number} speed  0–1 throttle, affects puff density
     */
    drawExhaust(ctx, x, y, angle, speed, frameCount) {
      if (speed < 0.1) return;
      const fc  = frameCount || 0;
      const pct = (Math.sin(fc * 0.4) + 1) / 2;
      const ox  = Math.cos(angle + Math.PI) * 20;
      const oy  = Math.sin(angle + Math.PI) * 20;
      ctx.fillStyle = `rgba(200,200,200,${(pct * 0.4 * speed).toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(x + ox, y + oy, 5 + pct * 4, 0, Math.PI * 2);
      ctx.fill();
    },
  };

  // ── Physics ───────────────────────────────────────────────────────

  // Surface grip multipliers
  const SURFACE_GRIP = {
    asphalt: 1.0,
    dirt:    0.65,
    sand:    0.5,
    ice:     0.25,
    snow:    0.35,
    grass:   0.55,
  };

  const physics = {
    /**
     * Create a new racer physics entity.
     */
    create(opts = {}) {
      return {
        x:            opts.x        || 0,
        y:            opts.y        || 0,
        angle:        opts.angle    || 0,
        speed:        0,
        vx:           0,
        vy:           0,
        drift:        0,
        onRoad:       true,
        trackPos:     0,
        lap:          0,
        maxSpeed:     opts.maxSpeed || 300,
        accel:        opts.accel    || 180,
        brakeF:       opts.brake    || 240,
        steerSpd:     opts.steer    || 2.2,
        grip:         opts.grip     || 1.0,
        mass:         opts.mass     || 1.0,
        boostMult:    1.4,   // upgrades.apply() increases this via 'turbo'
        surfaceBonus: 0,     // 0–1; reduces off-road grip penalty via 'suspension'
        frame:        0,
        fTimer:       0,
        ai:           null,
      };
    },

    /**
     * Update racer physics for one frame.
     * @param {object} racer   from physics.create()
     * @param {object} input   { throttle, brake, steerLeft, steerRight, boost }
     * @param {object} opts
     *   surface: 'asphalt'|'dirt'|'sand'|'ice'|'snow' (default 'asphalt')
     *   dt:      delta time in seconds (default 1/60)
     *   worldW:  wrap/clamp world width (optional)
     *   worldH:  wrap/clamp world height (optional)
     */
    update(racer, input = {}, opts = {}) {
      const dt        = opts.dt ?? (1 / 60);
      const baseGrip  = SURFACE_GRIP[opts.surface || 'asphalt'];
      const surfBonus = racer.surfaceBonus || 0;
      const surfaceK  = (baseGrip + (1 - baseGrip) * surfBonus) * racer.grip;
      const throttle  = clamp(input.throttle || 0, 0, 1);
      const brake     = clamp(input.brake    || 0, 0, 1);
      const boostPow  = input.boost ? (racer.boostMult || 1.4) : 1.0;

      // Steering
      const steerAmt = racer.steerSpd * surfaceK * dt;
      if (input.steerLeft)  racer.angle -= steerAmt;
      if (input.steerRight) racer.angle += steerAmt;

      // Acceleration / braking
      const maxSpd = racer.maxSpeed * boostPow;
      if (throttle > 0) {
        racer.speed = Math.min(racer.speed + racer.accel * throttle * dt, maxSpd);
      } else {
        racer.speed = Math.max(racer.speed - racer.accel * 0.5 * dt, 0);
      }
      if (brake > 0) {
        racer.speed = Math.max(racer.speed - racer.brakeF * brake * dt, 0);
      }

      // Drift — low grip causes sliding
      const driftFactor = 1 - surfaceK * 0.8;
      racer.drift = lerp(racer.drift, driftFactor * (input.steerLeft || input.steerRight ? 1 : 0), 0.1);

      // Movement
      const fwd = racer.speed * dt;
      racer.x  += Math.cos(racer.angle) * fwd;
      racer.y  += Math.sin(racer.angle) * fwd;

      // Optional world bounds clamp
      if (opts.worldW) racer.x = clamp(racer.x, 0, opts.worldW);
      if (opts.worldH) racer.y = clamp(racer.y, 0, opts.worldH);

      // Wheel animation
      racer.fTimer++;
      if (racer.fTimer >= Math.max(2, Math.round(8 - racer.speed / 50))) {
        racer.fTimer = 0;
        racer.frame  = (racer.frame + 1) % 4;
      }
    },
  };

  // ── AI Racers ─────────────────────────────────────────────────────
  const ai = {
    /**
     * Attach AI state to an existing racer entity.
     * @param {object[]} waypoints  [{x, y}] world-space route
     */
    create(racer, waypoints) {
      racer.ai = {
        waypoints: waypoints || [],
        wpIdx:     0,
        reaction:  Math.random() * 0.15, // slight reaction delay
        skill:     0.7 + Math.random() * 0.3,
      };
      return racer;
    },

    /**
     * Run AI for one tick — steers toward next waypoint, avoids others.
     * @param {object}   racer
     * @param {object[]} racers  all racers (for avoidance)
     * @param {object}   opts
     *   rubberBand:  0–1 speed penalty when far ahead (default 0.15)
     *   playerSpeed: player's current speed (for rubber-banding)
     */
    update(racer, racers, opts = {}) {
      if (!racer.ai) return;
      const aiState = racer.ai;
      const wps     = aiState.waypoints;
      if (!wps.length) return;

      const wp     = wps[aiState.wpIdx % wps.length];
      const dx     = wp.x - racer.x;
      const dy     = wp.y - racer.y;
      const dist   = Math.sqrt(dx * dx + dy * dy);
      const target = Math.atan2(dy, dx);
      const diff   = angleDiff(racer.angle, target);

      // Advance waypoint when close enough
      if (dist < 60) {
        aiState.wpIdx = (aiState.wpIdx + 1) % wps.length;
      }

      // Steer
      const steer = clamp(diff * aiState.skill * 3, -1, 1);
      const input = {
        throttle:   1.0,
        brake:      0,
        steerLeft:  steer < -0.05,
        steerRight: steer >  0.05,
        boost:      false,
      };

      // Slow down for sharp turns
      if (Math.abs(diff) > 0.6) {
        input.throttle = 0.5;
        if (Math.abs(diff) > 1.2) input.brake = 0.4;
      }

      // Rubber-band: slow down if far ahead of player
      if (opts.rubberBand && opts.playerSpeed !== undefined) {
        const gap = racer.speed - opts.playerSpeed;
        if (gap > 50) input.throttle *= Math.max(0.4, 1 - (opts.rubberBand || 0.15));
      }

      // Avoidance nudge
      for (const other of racers) {
        if (other === racer || !other.x) continue;
        const avx = other.x - racer.x;
        const avy = other.y - racer.y;
        const ad  = Math.sqrt(avx * avx + avy * avy);
        if (ad < (opts.avoidRadius || 40) && ad > 0) {
          const nudge = Math.atan2(avy, avx);
          const nd    = angleDiff(racer.angle, nudge);
          if (nd > 0) input.steerLeft  = true;
          else        input.steerRight = true;
        }
      }

      physics.update(racer, input, opts);
    },
  };

  // ── Race Manager ──────────────────────────────────────────────────
  const race = {
    /**
     * Create a race state object.
     * @param {object} opts
     *   laps:        total laps (default 3)
     *   racers:      array of racer objects
     *   checkpoints: [{x,y,r}] circular checkpoints in order
     *   countdown:   start countdown frames (default 180 = 3s at 60fps)
     */
    create(opts = {}) {
      const racers = opts.racers || [];
      for (const r2 of racers) {
        r2._lastCheckpoint = -1;
        r2._checkpointsDone = 0;
        r2.lap = 0;
        r2.raceTime = 0;
        r2.lapTimes = [];
        r2.lapStart = 0;
        r2.finished = false;
      }
      return {
        laps:        opts.laps        || 3,
        checkpoints: opts.checkpoints || [],
        racers,
        started:     false,
        finished:    false,
        countdownMax: opts.countdown  || 180,
        countdownT:  0,
        raceTimer:   0,
        finishOrder: [],
      };
    },

    /**
     * Call each frame. Updates lap counts, checkpoints, timer.
     */
    update(raceState, racers) {
      if (raceState.finished) return;

      raceState.countdownT++;
      if (!raceState.started) {
        if (raceState.countdownT >= raceState.countdownMax) raceState.started = true;
        return;
      }

      raceState.raceTimer++;
      const cps = raceState.checkpoints;
      if (!cps.length) return;

      for (const r2 of racers) {
        if (r2.finished) continue;
        r2.raceTime++;

        // Check next checkpoint
        const nextIdx = (r2._lastCheckpoint + 1) % cps.length;
        const cp      = cps[nextIdx];
        const dx      = r2.x - cp.x;
        const dy      = r2.y - cp.y;
        if (Math.sqrt(dx * dx + dy * dy) < (cp.r || 50)) {
          r2._lastCheckpoint = nextIdx;
          r2._checkpointsDone++;

          // Completed a full circuit?
          if (nextIdx === 0 && r2._checkpointsDone >= cps.length) {
            r2._checkpointsDone = 0;
            const lapMs = r2.raceTime - r2.lapStart;
            r2.lapTimes.push(lapMs);
            r2.lapStart = r2.raceTime;
            r2.lap++;

            if (r2.lap >= raceState.laps) {
              r2.finished = true;
              raceState.finishOrder.push(r2);
            }
          }
        }
      }

      // Race finished when all racers done or leader lapped
      if (raceState.finishOrder.length >= racers.length) {
        raceState.finished = true;
      }
    },

    /**
     * Return racers sorted by race position (most progress first).
     */
    positions(raceState) {
      return [...raceState.racers].sort((a, b) => {
        if (a.finished && !b.finished) return -1;
        if (!a.finished && b.finished) return  1;
        if (a.lap !== b.lap) return b.lap - a.lap;
        return b._checkpointsDone - a._checkpointsDone;
      });
    },

    /**
     * Returns the countdown display string, or null when race has started.
     * Call each frame with the current frameCount.
     */
    countdownStr(raceState, frameCount) {
      if (raceState.started) return null;
      const t   = raceState.countdownMax - raceState.countdownT;
      const sec = Math.ceil(t / 60);
      if (sec <= 0) return 'GO!';
      return String(Math.min(sec, 3));
    },

    /** Format milliseconds (at 60fps tick units) as M:SS.mmm */
    formatTime(ticks) {
      const ms  = Math.round(ticks * (1000 / 60));
      const m   = Math.floor(ms / 60000);
      const s   = Math.floor((ms % 60000) / 1000);
      const mss = ms % 1000;
      return `${m}:${String(s).padStart(2,'0')}.${String(mss).padStart(3,'0')}`;
    },
  };

  // ── HUD ───────────────────────────────────────────────────────────
  const hud = {
    /**
     * Draw a complete racing HUD overlay.
     * @param {object} opts
     *   speed:      current speed (number)
     *   maxSpeed:   racer max speed
     *   gear:       gear string e.g. '3'
     *   lap:        current lap (1-based)
     *   laps:       total laps
     *   position:   race position (1-based)
     *   total:      total racers
     *   time:       race ticks elapsed
     *   bestLap:    best lap ticks (or null)
     *   accentColor: e.g. '#00ff88'
     */
    draw(ctx, cw, ch, opts = {}) {
      const ac  = opts.accentColor || '#00ff88';
      const spd = opts.speed       || 0;
      const mxs = opts.maxSpeed    || 300;

      // Speedometer (bottom right)
      hud.speedometer(ctx, cw - 80, ch - 80, 60, spd, mxs, { accentColor: ac });

      // Lap / position (top left)
      hud.raceInfo(ctx, cw, {
        position:    opts.position || 1,
        total:       opts.total    || 1,
        lap:         opts.lap      || 1,
        laps:        opts.laps     || 3,
        accentColor: ac,
      });

      // Timer (top center)
      if (opts.time != null) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        rr(ctx, cw / 2 - 70, 10, 140, 32, 6);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 16px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(race.formatTime(opts.time), cw / 2, 26);
        if (opts.bestLap != null) {
          ctx.fillStyle = ac;
          ctx.font = '11px monospace';
          ctx.fillText('BEST ' + race.formatTime(opts.bestLap), cw / 2, 46);
        }
        ctx.textAlign = 'left';
      }

      // Gear indicator (bottom left)
      if (opts.gear != null) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        rr(ctx, 12, ch - 58, 44, 44, 8);
        ctx.fill();
        ctx.fillStyle = ac;
        ctx.font = 'bold 28px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(opts.gear, 34, ch - 36);
        ctx.fillStyle = '#888';
        ctx.font = '10px monospace';
        ctx.fillText('GEAR', 34, ch - 18);
        ctx.textAlign = 'left';
      }
    },

    /**
     * Draw an analog speedometer gauge.
     * @param {number} cx  center x
     * @param {number} cy  center y
     * @param {number} r   radius
     */
    speedometer(ctx, cx, cy, r, speed, maxSpeed, opts = {}) {
      const ac  = opts.accentColor || '#00ff88';
      const pct = clamp(speed / (maxSpeed || 1), 0, 1);

      // Background
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
      ctx.stroke();

      // Arc track
      const startAng = Math.PI * 0.75;
      const endAng   = Math.PI * 2.25;
      ctx.strokeStyle = '#333'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(cx, cy, r - 8, startAng, endAng); ctx.stroke();

      // Speed arc
      ctx.strokeStyle = ac; ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 8, startAng, startAng + (endAng - startAng) * pct);
      ctx.stroke();

      // Needle
      const needleAng = startAng + (endAng - startAng) * pct;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(needleAng) * (r - 12), cy + Math.sin(needleAng) * (r - 12));
      ctx.stroke();

      // Center cap
      ctx.fillStyle = '#555';
      ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();

      // Digital readout
      if (opts.showDigital !== false) {
        ctx.fillStyle = '#fff';
        ctx.font      = `bold ${Math.round(r * 0.3)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(Math.round(speed), cx, cy + r * 0.3);
        ctx.fillStyle = '#888';
        ctx.font = `${Math.round(r * 0.18)}px monospace`;
        ctx.fillText('km/h', cx, cy + r * 0.55);
        ctx.textAlign = 'left';
      }
    },

    /**
     * Draw race position and lap counter (top-left panel).
     */
    raceInfo(ctx, cw, opts = {}) {
      const ac  = opts.accentColor || '#00ff88';
      const pos = opts.position || 1;
      const tot = opts.total    || 1;
      const lap = opts.lap      || 1;
      const laps = opts.laps   || 3;

      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      rr(ctx, 10, 10, 110, 58, 8);
      ctx.fill();

      // Position
      ctx.fillStyle = ac;
      ctx.font = 'bold 28px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(pos, 20, 14);
      ctx.fillStyle = '#888';
      ctx.font = '14px monospace';
      ctx.fillText('/' + tot, 44, 24);

      // Lap
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 14px monospace';
      ctx.fillText('LAP', 20, 46);
      ctx.fillStyle = ac;
      ctx.fillText(` ${lap}/${laps}`, 46, 46);
      ctx.textBaseline = 'alphabetic';
    },
  };

  // ── Effects ───────────────────────────────────────────────────────
  const fx = {
    /**
     * Add a skid mark entry.
     * @param {object[]} marks  shared array, mutated in place
     */
    addSkid(marks, x, y, w, angle, alpha) {
      marks.push({ x, y, w: w || 3, angle: angle || 0, alpha: clamp(alpha || 0.5, 0, 1), life: 1 });
      if (marks.length > 400) marks.splice(0, 50);
    },

    /**
     * Draw and age all skid marks (top-down space).
     */
    drawSkids(ctx, marks, camX, camY, zoom) {
      zoom = zoom || 1;
      const offX = 0, offY = 0;
      for (const m of marks) {
        ctx.save();
        ctx.translate(m.x * zoom - (camX || 0) * zoom + offX,
                      m.y * zoom - (camY || 0) * zoom + offY);
        ctx.rotate(m.angle);
        ctx.fillStyle = `rgba(20,20,20,${(m.alpha * m.life).toFixed(2)})`;
        ctx.fillRect(-m.w * zoom / 2, -2 * zoom, m.w * zoom, 4 * zoom);
        ctx.restore();
        m.life -= 0.0005;
      }
      for (let i = marks.length - 1; i >= 0; i--) {
        if (marks[i].life <= 0) marks.splice(i, 1);
      }
    },

    /**
     * Draw a boost flame behind a car (top-down).
     * @param {number} angle  car heading
     */
    boostFlame(ctx, x, y, angle, frameCount, opts = {}) {
      const fc  = frameCount || 0;
      const col = opts.color || '#00aaff';
      const len = 18 + Math.sin(fc * 0.5) * 6;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle + Math.PI);
      ctx.shadowColor = col;
      ctx.shadowBlur  = 12;
      ctx.fillStyle   = col;
      ctx.beginPath();
      ctx.moveTo(-5, 0); ctx.lineTo(0, len); ctx.lineTo(5, 0);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(-2, 0); ctx.lineTo(0, len * 0.5); ctx.lineTo(2, 0);
      ctx.closePath();
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.restore();
    },

    /**
     * Add a dust/smoke cloud particle.
     */
    dustCloud(particles, x, y, color, count) {
      color = color || 'rgba(180,160,130,';
      for (let i = 0; i < (count || 4); i++) {
        const ang = Math.random() * Math.PI * 2;
        const spd = 0.5 + Math.random() * 1.5;
        particles.push({
          x, y,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          size: 6 + Math.random() * 8,
          life: 1,
          decay: 0.025 + Math.random() * 0.01,
          color,
        });
      }
    },

    /** Age and remove dead particles (mutates array). */
    updateParticles(particles) {
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x    += p.vx; p.y += p.vy;
        p.vx   *= 0.96; p.vy *= 0.96;
        p.size *= 1.02;
        p.life -= p.decay;
        if (p.life <= 0) particles.splice(i, 1);
      }
    },

    /** Draw particles in world space (with camera offset + zoom). */
    drawParticles(ctx, particles, camX, camY, zoom) {
      zoom = zoom || 1;
      for (const p of particles) {
        const sx = (p.x - (camX || 0)) * zoom;
        const sy = (p.y - (camY || 0)) * zoom;
        const alpha = Math.max(0, p.life).toFixed(2);
        ctx.fillStyle = p.color.startsWith('rgba')
          ? p.color.replace(/[\d.]+\)$/, alpha + ')')
          : `rgba(180,160,130,${alpha})`;
        ctx.beginPath();
        ctx.arc(sx, sy, p.size * zoom, 0, Math.PI * 2);
        ctx.fill();
      }
    },
  };

  // ── Upgrades ──────────────────────────────────────────────────────
  const upgrades = {
    /**
     * Upgrade catalog. Each entry:
     *   key:      stat key used in garage upgrades object
     *   label:    display name
     *   desc:     short description
     *   maxLevel: 5 for all built-ins
     *   costs:    [costToReachLvl1, ..., costToReachLvl5]
     *   effect:   { stat, mults[0..maxLevel] } — mults[0] = no upgrade (1.0 baseline)
     */
    catalog: [
      {
        key: 'engine', label: 'Engine', desc: 'Increases top speed',
        maxLevel: 5, costs: [150, 300, 600, 1200, 2500],
        effect: { stat: 'maxSpeed',     mults: [1, 1.05, 1.10, 1.15, 1.20, 1.25] },
      },
      {
        key: 'tires', label: 'Tires', desc: 'Better grip & cornering',
        maxLevel: 5, costs: [100, 250, 500, 1000, 2000],
        effect: { stat: 'grip',         mults: [1, 1.08, 1.16, 1.24, 1.32, 1.40] },
      },
      {
        key: 'brakes', label: 'Brakes', desc: 'Shorter stopping distance',
        maxLevel: 5, costs: [100, 200, 400, 800, 1500],
        effect: { stat: 'brakeF',       mults: [1, 1.07, 1.14, 1.21, 1.28, 1.35] },
      },
      {
        key: 'turbo', label: 'Turbo', desc: 'Stronger boost power',
        maxLevel: 5, costs: [200, 400, 800, 1600, 3000],
        effect: { stat: 'boostMult',    mults: [1.4, 1.50, 1.62, 1.74, 1.87, 2.00] },
      },
      {
        key: 'suspension', label: 'Suspension', desc: 'Less grip loss off-road',
        maxLevel: 5, costs: [150, 300, 600, 1200, 2500],
        // surfaceBonus: fraction of off-road grip penalty that is negated (0 = none, 1 = full immunity)
        effect: { stat: 'surfaceBonus', mults: [0, 0.20, 0.35, 0.50, 0.65, 0.80] },
      },
    ],

    /** Cost in coins to upgrade `key` from `currentLevel` → `currentLevel + 1`. */
    cost(key, currentLevel) {
      const def = upgrades.catalog.find(u => u.key === key);
      if (!def || currentLevel >= def.maxLevel) return Infinity;
      return def.costs[currentLevel];
    },

    /** True if `coins` is enough to upgrade `key` from `currentLevel`. */
    canAfford(key, currentLevel, coins) {
      return coins >= upgrades.cost(key, currentLevel);
    },

    /**
     * Bake garage upgrade levels into racer stats. Call once after physics.create().
     * @param {object} racer  from physics.create()
     * @param {object} ups    { engine: 2, tires: 1, ... }
     */
    apply(racer, ups = {}) {
      for (const def of upgrades.catalog) {
        const level = clamp(ups[def.key] || 0, 0, def.maxLevel);
        const mult  = def.effect.mults[level];
        switch (def.effect.stat) {
          case 'maxSpeed':     racer.maxSpeed     *= mult; break;
          case 'grip':         racer.grip         *= mult; break;
          case 'brakeF':       racer.brakeF       *= mult; break;
          case 'boostMult':    racer.boostMult     = mult; break;
          case 'surfaceBonus': racer.surfaceBonus  = mult; break;
        }
      }
      return racer;
    },

    /**
     * Draw the full-screen upgrade shop canvas overlay.
     * Returns an array of hit regions for click/tap handling.
     *
     * @param {object} garageState  from garage.get()
     * @param {object} opts
     *   accentColor: string  (default '#f5a623')
     * @returns {Array<{key, x, y, w, h}>}  clickable upgrade button regions
     */
    drawShop(ctx, cw, ch, garageState, opts = {}) {
      const ac      = opts.accentColor || '#f5a623';
      const ups     = garageState.upgrades || {};
      const coins   = garageState.coins    || 0;
      const cat     = upgrades.catalog;
      const cols    = Math.min(3, cat.length);
      const cardW   = Math.min(155, Math.floor((cw - 80) / cols));
      const cardH   = 118;
      const gapX    = 14;
      const totalW  = cardW * cols + gapX * (cols - 1);
      const startX  = (cw - totalW) / 2;
      const rows    = Math.ceil(cat.length / cols);
      const startY  = ch / 2 - (rows * (cardH + 12)) / 2 + 24;
      const hits    = [];

      // Backdrop
      ctx.fillStyle = 'rgba(0,0,0,0.80)';
      ctx.fillRect(0, 0, cw, ch);

      // Title + coin balance
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle    = '#fff';
      ctx.font         = 'bold 22px monospace';
      ctx.fillText('GARAGE', cw / 2, startY - 50);
      ctx.fillStyle = ac;
      ctx.font      = 'bold 15px monospace';
      ctx.fillText('🪙 ' + coins.toLocaleString() + ' coins', cw / 2, startY - 26);

      cat.forEach((def, i) => {
        const col   = i % cols;
        const row   = Math.floor(i / cols);
        const cx2   = startX + col * (cardW + gapX);
        const cy2   = startY + row * (cardH + 12);
        const level = clamp(ups[def.key] || 0, 0, def.maxLevel);
        const maxed = level >= def.maxLevel;
        const cost  = maxed ? 0 : def.costs[level];
        const can   = !maxed && coins >= cost;

        // Card
        ctx.fillStyle = 'rgba(18,18,32,0.96)';
        rr(ctx, cx2, cy2, cardW, cardH, 8); ctx.fill();
        ctx.strokeStyle = maxed ? '#ffd700' : (can ? ac : '#2a2a3a');
        ctx.lineWidth   = maxed || can ? 2 : 1;
        rr(ctx, cx2, cy2, cardW, cardH, 8); ctx.stroke();

        // Label
        ctx.fillStyle    = '#fff';
        ctx.font         = 'bold 13px monospace';
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(def.label, cx2 + cardW / 2, cy2 + 10);

        // Level pips
        const pipW = Math.floor((cardW - 24) / def.maxLevel) - 2;
        for (let p = 0; p < def.maxLevel; p++) {
          ctx.fillStyle = p < level ? ac : '#2a2a3a';
          rr(ctx, cx2 + 12 + p * (pipW + 2), cy2 + 30, pipW, 6, 2);
          ctx.fill();
        }

        // Desc
        ctx.fillStyle    = '#777';
        ctx.font         = '10px monospace';
        ctx.textBaseline = 'top';
        ctx.fillText(def.desc, cx2 + cardW / 2, cy2 + 46);

        // Level text
        ctx.fillStyle = '#aaa';
        ctx.font      = '10px monospace';
        ctx.fillText(`LV ${level} / ${def.maxLevel}`, cx2 + cardW / 2, cy2 + 60);

        // Upgrade button or MAXED badge
        const btnY = cy2 + cardH - 34;
        const btnH = 26;
        if (maxed) {
          ctx.fillStyle    = '#ffd700';
          ctx.font         = 'bold 11px monospace';
          ctx.textBaseline = 'middle';
          ctx.fillText('MAXED ★', cx2 + cardW / 2, btnY + btnH / 2);
        } else {
          ctx.fillStyle = can ? ac : '#222230';
          rr(ctx, cx2 + 8, btnY, cardW - 16, btnH, 5); ctx.fill();
          ctx.fillStyle    = can ? '#000' : '#444';
          ctx.font         = 'bold 11px monospace';
          ctx.textBaseline = 'middle';
          ctx.fillText('🪙 ' + cost.toLocaleString(), cx2 + cardW / 2, btnY + btnH / 2);
          hits.push({ key: def.key, x: cx2 + 8, y: btnY, w: cardW - 16, h: btnH });
        }
      });

      ctx.textAlign    = 'left';
      ctx.textBaseline = 'alphabetic';
      return hits;
    },
  };

  // ── Garage ────────────────────────────────────────────────────────
  const garage = (() => {
    let _slug     = '';
    let _coins    = 0;
    let _upgrades = {};
    let _dirty    = false;
    let _timer    = null;

    function lsKey(s)  { return `gz_garage_${s}`; }
    function isAuth()  { return !!(window.GAME_CONFIG?.user?.id); }
    function csrf()    { return window.GAME_CONFIG?.csrfToken || ''; }

    function lsSave() {
      try { localStorage.setItem(lsKey(_slug), JSON.stringify({ coins: _coins, upgrades: _upgrades })); } catch (_) {}
    }

    function lsLoad(s) {
      try { const r = localStorage.getItem(lsKey(s)); return r ? JSON.parse(r) : null; } catch (_) { return null; }
    }

    function scheduleSave() {
      _dirty = true;
      if (_timer) clearTimeout(_timer);
      _timer = setTimeout(() => obj.save(), 3000);
    }

    const obj = {
      /**
       * Load garage state for this game. Always call before using the garage.
       * Fetches from server for logged-in users; falls back to localStorage for guests.
       * @returns {Promise<{coins, upgrades}>}
       */
      async load(slug) {
        _slug = slug; _coins = 0; _upgrades = {}; _dirty = false;

        if (isAuth()) {
          try {
            const res = await fetch(`/garage/${slug}`);
            if (res.ok) {
              const data  = await res.json();
              _coins      = data.coins    || 0;
              _upgrades   = data.upgrades || {};
              lsSave();
              return obj.get();
            }
          } catch (_) {}
        }

        const cached = lsLoad(slug);
        if (cached) { _coins = cached.coins || 0; _upgrades = cached.upgrades || {}; }
        return obj.get();
      },

      /**
       * Save current state to localStorage + server (if logged in).
       * Called automatically 3 s after any mutation. Call manually after a race.
       * @returns {Promise<bool>}
       */
      async save() {
        if (!_slug) return false;
        lsSave();
        if (!isAuth()) return true;
        try {
          const res = await fetch(`/garage/${_slug}`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-TOKEN': csrf() },
            body:    JSON.stringify({ coins: _coins, upgrades: _upgrades }),
          });
          if (res.ok) _dirty = false;
          return res.ok;
        } catch (_) { return false; }
      },

      /** Return a snapshot of the current garage state. */
      get() { return { coins: _coins, upgrades: { ..._upgrades } }; },

      /** Add coins (non-negative). Schedules auto-save. */
      earn(amount) {
        _coins = Math.min(_coins + Math.max(0, Math.floor(amount)), 9_999_999);
        scheduleSave();
      },

      /**
       * Deduct coins. Returns false and makes no change if insufficient funds.
       */
      spend(amount) {
        if (_coins < amount) return false;
        _coins -= amount;
        scheduleSave();
        return true;
      },

      /**
       * Upgrade one stat to the next level. Deducts cost automatically.
       * @returns {bool} true if upgrade succeeded
       */
      upgrade(key) {
        const level = clamp(_upgrades[key] || 0, 0, 5);
        const cost  = upgrades.cost(key, level);
        if (!isFinite(cost) || !obj.spend(cost)) return false;
        _upgrades[key] = level + 1;
        scheduleSave();
        return true;
      },

      /**
       * Calculate race finish reward.
       * Call after a race to get how many coins the player should earn.
       * @param {number} position  1-based finish position
       * @param {number} total     total racers
       * @param {number} laps      laps completed
       * @returns {number} coins earned (not yet applied — call earn() yourself)
       */
      calcReward(position, total, laps) {
        const BASE = [500, 300, 200, 150, 100];
        const base = BASE[Math.min(position - 1, BASE.length - 1)] || 75;
        return base + (laps || 1) * 20;
      },

      /** True if a user account is logged in (coins will sync to server). */
      isLoggedIn: isAuth,
    };

    return obj;
  })();

  // ── Expose ────────────────────────────────────────────────────────
  global.GameRacing = { themes, track, topdown, car, physics, ai, race, hud, fx, upgrades, garage };

})(window);
