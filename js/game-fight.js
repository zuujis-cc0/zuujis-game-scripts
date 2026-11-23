// game-fight.js v0.1.0 — 2D fighting-game engine (Street Fighter-style).
//
// Input-source-agnostic: every fighter is advanced from an `intent` object each fixed
// step, so human (GameVersusInput), CPU (Fight.ai) and netplay all share one code path.
//
//   intent = { dir: 1..9, lp, mp, hp, lk, mk, hk, special }
//     dir      numpad direction this frame (5 = neutral)
//     lp..hk   true ONLY on the frame the attack is pressed (edge)
//     special  'fireball' | 'dp' | 'tatsu' | 'super' | null  (motion already recognised)
//
// Pipeline per frame (fixed 60 Hz):
//   Fight.fighter.step(p1, intent1, world);
//   Fight.fighter.step(p2, intent2, world);
//   Fight.resolve(p1, p2, world); Fight.resolve(p2, p1, world);
//   Fight.projectiles.update(world); Fight.match.update(match, p1, p2);
//   // then draw: Fight.draw.fighter(ctx, p, world); Fight.draw.placeholder(...) fallback
//
(function (global) {
  'use strict';

  var FPS = 60;
  var GRAVITY = 0.85;
  var GROUND_MARGIN = 70;       // px from canvas bottom to the floor line

  // ── Move / frame data ──────────────────────────────────────────────
  // Boxes are relative to the fighter's facing-forward origin at the feet centre.
  // x grows "forward"; the engine mirrors by facing. y grows upward from feet.
  function box(x, y, w, h) { return { x: x, y: y, w: w, h: h }; }

  var MOVES = {
    // key: { startup, active, recovery, dmg, hit, block, push, hitbox, height, kind, knockdown }
    lp: { startup:3,  active:3,  recovery:7,  dmg:30, hit:12, block:7,  push:3,  hitbox:box(34, 96, 46, 26), height:'high', kind:'punch' },
    mp: { startup:6,  active:4,  recovery:13, dmg:55, hit:16, block:10, push:5,  hitbox:box(36, 92, 56, 30), height:'high', kind:'punch' },
    hp: { startup:9,  active:5,  recovery:21, dmg:85, hit:21, block:13, push:8,  hitbox:box(38, 88, 64, 34), height:'high', kind:'punch' },
    lk: { startup:4,  active:3,  recovery:9,  dmg:34, hit:13, block:8,  push:3,  hitbox:box(34, 44, 50, 28), height:'low',  kind:'kick' },
    mk: { startup:7,  active:4,  recovery:15, dmg:58, hit:17, block:11, push:6,  hitbox:box(38, 56, 62, 30), height:'mid',  kind:'kick' },
    hk: { startup:10, active:5,  recovery:24, dmg:90, hit:22, block:14, push:9,  hitbox:box(40, 60, 70, 36), height:'mid',  kind:'kick', knockdown:true },
    // Specials
    dp: { startup:4,  active:10, recovery:26, dmg:110, hit:26, block:16, push:6, hitbox:box(20, 70, 58, 110), height:'high', kind:'special', knockdown:true, rise:true, inv:6, meter:0 },
    tatsu:{startup:7, active:14, recovery:20, dmg:80, hit:18, block:12, push:7, hitbox:box(26, 70, 70, 60), height:'mid', kind:'special', airborne:true, meter:0 },
    super:{startup:6, active:20, recovery:30, dmg:240, hit:30, block:20, push:10, hitbox:box(24, 60, 90, 130), height:'high', kind:'super', knockdown:true, inv:14, cost:100 },
  };

  // ── Stage / world ──────────────────────────────────────────────────
  function createWorld(opts) {
    opts = opts || {};
    var W = opts.width || 900, H = opts.height || 480;
    return {
      w: W, h: H,
      floorY: H - GROUND_MARGIN,
      leftWall: 40, rightWall: W - 40,
      projectiles: [],
      fx: [],                 // transient hit sparks: {x,y,t,life,color,r}
      shake: 0,
    };
  }

  // ── Fighter ────────────────────────────────────────────────────────
  function createFighter(opts) {
    opts = opts || {};
    return {
      name: opts.name || 'Fighter',
      color: opts.color || '#e44',
      x: opts.x || 0, y: 0,            // y = height above floor (0 = grounded)
      startX: opts.x || 0, startFacing: opts.facing || 1,
      vx: 0, vy: 0,
      facing: opts.facing || 1,        // +1 right, -1 left
      w: 56, h: 152,                   // hurtbox (standing)
      maxHealth: opts.maxHealth || 1000,
      health: opts.maxHealth || 1000,
      meter: 0, maxMeter: 100,
      state: 'idle',                   // idle|walkF|walkB|crouch|jump|block|hitstun|blockstun|attack|ko|win
      stateTimer: 0,
      move: null, moveTimer: 0,        // active attack move key + elapsed frames
      hasHit: false,                   // attack already connected (prevents multi-hit)
      hitstun: 0, blockstun: 0,
      crouching: false, blocking: false, airborne: false,
      combo: 0, comboTimer: 0,
      invuln: 0,
      wins: 0,
      // sprite hookup (optional)
      sheet: opts.sheet || null, anim: opts.anim || null,
      animName: 'idle', animFrame: 0, animTick: 0,
    };
  }

  function grounded(f) { return f.y <= 0.01; }

  // Advance one fighter by a single fixed step.
  function step(f, intent, world) {
    intent = intent || { dir: 5 };
    if (f.state === 'ko') { _physics(f, world); return; }

    if (f.invuln > 0) f.invuln--;
    if (f.comboTimer > 0 && --f.comboTimer === 0) f.combo = 0;

    // ── Stun states lock out actions ──
    if (f.hitstun > 0) {
      f.state = 'hitstun'; f.hitstun--;
      _physics(f, world);
      if (f.hitstun === 0 && grounded(f)) f.state = 'idle';
      return;
    }
    if (f.blockstun > 0) {
      f.state = 'blockstun'; f.blockstun--;
      _physics(f, world);
      if (f.blockstun === 0) f.state = 'idle';
      return;
    }

    // ── Attack in progress ──
    if (f.move) {
      f.moveTimer++;
      var m = MOVES[f.move];
      var total = m.startup + m.active + m.recovery;
      // invuln window (reversals)
      if (m.inv && f.moveTimer <= m.inv) f.invuln = 1;
      // DP rises then falls
      if (m.rise && f.moveTimer === m.startup) f.vy = -13;
      _physics(f, world);
      if (f.moveTimer >= total) { f.move = null; f.moveTimer = 0; f.hasHit = false; f.state = grounded(f) ? 'idle' : 'jump'; }
      else { f.state = 'attack'; }
      return;
    }

    var fwd = intent.dir;
    var towardFoe = f.facing;           // forward direction in numpad x terms
    var holdingBack  = _dirHasX(fwd, -towardFoe);
    var holdingDown  = (fwd === 1 || fwd === 2 || fwd === 3);
    var holdingFwd   = _dirHasX(fwd, towardFoe);

    // ── Airborne ──
    if (!grounded(f)) {
      // air attacks
      var aAtk = _pickAttack(intent);
      if (aAtk && !f.move) _startMove(f, aAtk);
      _physics(f, world);
      f.state = 'jump';
      return;
    }

    // ── Specials (motion already validated upstream) ──
    if (intent.special) {
      var sp = intent.special;
      if (sp === 'super' && f.meter >= MOVES.super.cost) { f.meter -= MOVES.super.cost; _startMove(f, 'super'); return; }
      if (sp === 'fireball') { _spawnFireball(f, world); f.meter = Math.min(f.maxMeter, f.meter + 8); f.state='attack'; f.move='lp'; f.moveTimer=MOVES.lp.startup; return; }
      if (sp === 'dp')    { _startMove(f, 'dp');    return; }
      if (sp === 'tatsu') { _startMove(f, 'tatsu'); f.vx = f.facing * 4.5; f.vy = -6; return; }
    }

    // ── Normal attacks ──
    var atk = _pickAttack(intent);
    if (atk) { _startMove(f, atk); f.crouching = holdingDown; return; }

    // ── Movement / stance ──
    f.crouching = holdingDown;
    f.blocking  = holdingBack && !holdingDown;   // stand block (hold away)
    if (holdingDown && holdingBack) { f.blocking = true; }  // crouch block

    if (fwd === 8 || fwd === 7 || fwd === 9) {
      // jump
      f.vy = -15;
      f.vx = (fwd === 9 ? 1 : fwd === 7 ? -1 : 0) * 4.5;
      f.state = 'jump';
    } else if (f.crouching) {
      f.state = 'crouch'; f.vx = 0;
    } else if (f.blocking) {
      f.state = 'block'; f.vx = 0;
    } else if (holdingFwd) {
      f.vx = f.facing * 3.2; f.state = 'walkF';
    } else if (holdingBack) {
      f.vx = -f.facing * 2.6; f.state = 'walkB';
    } else {
      f.vx = 0; f.state = 'idle';
    }

    _physics(f, world);
  }

  function _dirHasX(dir, sign) {
    // sign +1 means "is this dir pointing right?", -1 "pointing left?"
    var right = (dir === 3 || dir === 6 || dir === 9);
    var left  = (dir === 1 || dir === 4 || dir === 7);
    return sign > 0 ? right : left;
  }

  function _pickAttack(intent) {
    // priority heavy→light feels responsive; pick the first pressed
    var order = ['hp','hk','mp','mk','lp','lk'];
    for (var i = 0; i < order.length; i++) if (intent[order[i]]) return order[i];
    return null;
  }

  function _startMove(f, key) {
    f.move = key; f.moveTimer = 0; f.hasHit = false; f.state = 'attack'; f.vx = 0;
  }

  function _physics(f, world) {
    f.x += f.vx;
    if (!grounded(f) || f.vy < 0) { f.y -= f.vy; f.vy += GRAVITY; }
    if (f.y < 0) { f.y = 0; f.vy = 0; if (f.state === 'jump') f.state = 'idle'; }
    // stage bounds (hurtbox half-width)
    var hw = f.w / 2;
    if (f.x - hw < world.leftWall)  f.x = world.leftWall + hw;
    if (f.x + hw > world.rightWall) f.x = world.rightWall - hw;
  }

  // ── Hit resolution ─────────────────────────────────────────────────
  // Returns true if `atk` hit/was-blocked by `def` this frame.
  function resolve(atk, def, world) {
    if (!atk.move || atk.hasHit) return false;
    var m = MOVES[atk.move];
    var local = atk.moveTimer - m.startup;
    if (local < 0 || local >= m.active) return false;     // not in active frames
    if (def.invuln > 0 || def.state === 'ko') return false;

    var hb = _worldBox(atk, m.hitbox);
    var hurt = _hurtBox(def);
    if (!_overlap(hb, hurt)) return false;

    atk.hasHit = true;

    // Blocking? must hold away and match height (low must be blocked crouching, overhead standing)
    var blockingDir = def.blocking;
    var heightOk = true;
    if (m.height === 'low')  heightOk = def.crouching;     // low → block low
    if (m.height === 'high') heightOk = true;              // high/mid blockable either
    var blocked = blockingDir && heightOk && grounded(def) && def.state !== 'attack';

    var cx = (atk.x + def.x) / 2, cy = world.floorY - (def.h * 0.6);
    if (blocked) {
      def.blockstun = m.block;
      var chip = Math.round(m.dmg * 0.08);
      def.health = Math.max(0, def.health - chip);
      def.vx = atk.facing * Math.min(m.push, 5);
      def.meter = Math.min(def.maxMeter, def.meter + 2);
      atk.meter = Math.min(atk.maxMeter, atk.meter + 3);
      _spark(world, cx, cy, '#8cf', 10);
    } else {
      // combo scaling
      atk.combo++; atk.comboTimer = 90;
      var scale = atk.combo <= 1 ? 1 : Math.max(0.3, 1 - (atk.combo - 1) * 0.12);
      var dmg = Math.round(m.dmg * scale);
      def.health = Math.max(0, def.health - dmg);
      def.hitstun = m.hit;
      def.move = null; def.moveTimer = 0; def.blocking = false;
      def.vx = atk.facing * m.push;
      if (m.knockdown || !grounded(def)) { def.vy = -8; def.vx = atk.facing * (m.push + 3); }
      atk.meter = Math.min(atk.maxMeter, atk.meter + 8);
      def.meter = Math.min(def.maxMeter, def.meter + 4);
      world.shake = Math.min(14, 4 + m.dmg / 12);
      _spark(world, cx, cy, m.kind === 'kick' ? '#fc6' : '#f55', 16);
    }
    return true;
  }

  function _worldBox(f, rel) {
    // mirror by facing; origin at feet centre
    var x = f.facing > 0 ? f.x + rel.x : f.x - rel.x - rel.w;
    var y = rel.y;            // height above feet
    return { x: x, y: y, w: rel.w, h: rel.h };
  }

  function _hurtBox(f) {
    var h = f.crouching ? f.h * 0.6 : f.h;
    return { x: f.x - f.w / 2, y: f.y, w: f.w, h: h };
  }

  // boxes use y as "height above floor"; overlap test in that space
  function _overlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // ── Projectiles ────────────────────────────────────────────────────
  function _spawnFireball(f, world) {
    world.projectiles.push({
      x: f.x + f.facing * 40, y: f.h * 0.55, vx: f.facing * 7,
      owner: f, r: 18, dmg: 60, hit: 18, life: 120, color: f.color,
    });
  }

  function updateProjectiles(world, p1, p2) {
    var ps = world.projectiles;
    for (var i = ps.length - 1; i >= 0; i--) {
      var p = ps[i];
      p.x += p.vx; p.life--;
      var foe = (p.owner === p1) ? p2 : p1;
      var hurt = _hurtBox(foe);
      var pb = { x: p.x - p.r, y: p.y - p.r, w: p.r * 2, h: p.r * 2 };
      if (foe.invuln <= 0 && foe.state !== 'ko' && _overlap(pb, hurt)) {
        var blocked = foe.blocking && grounded(foe);
        if (blocked) { foe.blockstun = 12; foe.health = Math.max(0, foe.health - 6); _spark(world, p.x, world.floorY - p.y, '#8cf', 10); }
        else { foe.hitstun = p.hit; foe.health = Math.max(0, foe.health - p.dmg); foe.vx = p.vx > 0 ? 6 : -6; _spark(world, p.x, world.floorY - p.y, p.color, 14); world.shake = 8; }
        ps.splice(i, 1); continue;
      }
      if (p.life <= 0 || p.x < world.leftWall - 40 || p.x > world.rightWall + 40) ps.splice(i, 1);
    }
  }

  function _spark(world, x, y, color, r) { world.fx.push({ x: x, y: y, t: 0, life: 14, color: color, r: r }); }

  function updateFx(world) {
    for (var i = world.fx.length - 1; i >= 0; i--) {
      var s = world.fx[i]; s.t++; if (s.t >= s.life) world.fx.splice(i, 1);
    }
    if (world.shake > 0) world.shake *= 0.8;
    if (world.shake < 0.3) world.shake = 0;
  }

  // Keep fighters facing each other while grounded & idle-ish.
  function updateFacing(a, b) {
    if (a.move || a.hitstun || a.blockstun) return;
    a.facing = (b.x >= a.x) ? 1 : -1;
  }

  // ── Match / rounds ─────────────────────────────────────────────────
  function createMatch(opts) {
    opts = opts || {};
    return {
      roundsToWin: opts.roundsToWin || 2,   // best of 3
      roundTime: (opts.roundTime || 60) * FPS,
      timer: (opts.roundTime || 60) * FPS,
      round: 1,
      phase: 'fight',          // 'fight' | 'roundEnd' | 'matchEnd'
      phaseTimer: 0,
      winner: null,            // round/match winner fighter ref
      matchWinner: null,
    };
  }

  function updateMatch(match, p1, p2) {
    if (match.phase === 'fight') {
      if (match.timer > 0) match.timer--;
      var ko1 = p1.health <= 0, ko2 = p2.health <= 0;
      var timeUp = match.timer <= 0;
      if (ko1 || ko2 || timeUp) {
        var w = null;
        if (ko1 && ko2) w = null;
        else if (ko1) w = p2;
        else if (ko2) w = p1;
        else w = (p1.health === p2.health) ? null : (p1.health > p2.health ? p1 : p2);
        if (w) w.wins++;
        if (ko1) p1.state = 'ko'; if (ko2) p2.state = 'ko';
        if (w) w.state = 'win';
        match.winner = w;
        match.phase = 'roundEnd'; match.phaseTimer = 3 * FPS;
      }
    } else if (match.phase === 'roundEnd') {
      if (--match.phaseTimer <= 0) {
        if (p1.wins >= match.roundsToWin || p2.wins >= match.roundsToWin) {
          match.matchWinner = (p1.wins > p2.wins) ? p1 : p2;
          match.phase = 'matchEnd';
        } else {
          match.round++;
          match.timer = match.roundTime;
          match.phase = 'fight';
          _resetForRound(p1); _resetForRound(p2);
        }
      }
    }
    return match.phase;
  }

  function _resetForRound(f) {
    f.health = f.maxHealth; f.x = f.startX; f.y = 0; f.vx = 0; f.vy = 0;
    f.facing = f.startFacing;
    f.state = 'idle'; f.move = null; f.moveTimer = 0; f.hitstun = 0; f.blockstun = 0;
    f.combo = 0; f.invuln = 30; f.meter = f.meter;
  }

  // ── Simple CPU AI ──────────────────────────────────────────────────
  // Produces an `intent` so the CPU shares the exact human input path.
  function createAi(level) {
    var L = { easy: 0.35, normal: 0.6, hard: 0.85 }[level] || 0.6;
    return { L: L, t: 0, cooldown: 0, decision: 5 };
  }

  function aiThink(ai, self, foe, world) {
    ai.t++;
    var intent = { dir: 5, lp:false, mp:false, hp:false, lk:false, mk:false, hk:false, special:null };
    if (self.hitstun || self.blockstun || self.move || self.state === 'ko') return intent;

    var dx = foe.x - self.x;
    var dist = Math.abs(dx);
    var toward = dx >= 0 ? 6 : 4;
    var away   = dx >= 0 ? 4 : 6;

    // Block incoming: if foe is attacking & close, hold away (probabilistically).
    if (foe.move && dist < 110 && Math.random() < ai.L) { intent.dir = away; return intent; }
    // Block fireballs
    for (var i = 0; i < world.projectiles.length; i++) {
      var p = world.projectiles[i];
      if (p.owner !== self && Math.abs(p.x - self.x) < 220 && Math.random() < ai.L) { intent.dir = away; return intent; }
    }

    // Re-pick a behaviour periodically
    if (ai.cooldown > 0) ai.cooldown--;

    if (dist > 230) {
      // approach or zone with fireball
      if (Math.random() < 0.012 * ai.L) { intent.dir = (toward === 6 ? 3 : 1); intent.special = 'fireball'; }
      else intent.dir = toward;
    } else if (dist > 90) {
      // approach, occasional dash-in poke
      intent.dir = toward;
      if (ai.cooldown === 0 && Math.random() < 0.05 * ai.L) { intent.mk = true; ai.cooldown = 25; }
    } else {
      // in range — attack / anti-air / special
      if (!grounded(foe) && Math.random() < ai.L) { intent.special = 'dp'; }
      else if (ai.cooldown === 0) {
        var r = Math.random();
        if (self.meter >= 100 && r < 0.15 * ai.L) intent.special = 'super';
        else if (r < 0.2) { intent.dir = (toward === 6 ? 3 : 1); intent.special = 'fireball'; }
        else if (r < 0.5) intent.lp = true;
        else if (r < 0.75) intent.mp = true;
        else intent.hk = true;
        ai.cooldown = 18 - Math.round(8 * ai.L);
      } else {
        intent.dir = (Math.random() < 0.5) ? away : 5;  // dance
      }
    }
    return intent;
  }

  // ── Drawing ────────────────────────────────────────────────────────
  // Sprite path: load a sheet + manifest, draw the current anim frame.
  // Placeholder path: draw a posed blocky humanoid — fully playable with no art.
  function drawFighter(ctx, f, world) {
    if (f.sheet && f.anim) { _drawSprite(ctx, f, world); return; }
    drawPlaceholder(ctx, f, world);
  }

  function _drawSprite(ctx, f, world) {
    var name = _animFor(f);
    var clip = f.anim[name] || f.anim.idle;
    if (!clip) { drawPlaceholder(ctx, f, world); return; }
    if (f.animName !== name) { f.animName = name; f.animFrame = 0; f.animTick = 0; }
    f.animTick++;
    var rate = clip.rate || 6;
    if (f.animTick >= rate) { f.animTick = 0; f.animFrame = (f.animFrame + 1) % clip.frames.length; }
    var fr = clip.frames[f.animFrame];
    var fy = world.floorY - f.y;
    // contact shadow on the floor (stays at floor even when airborne)
    ctx.save();
    ctx.globalAlpha = Math.max(0.08, 0.28 - f.y / 600);
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(f.x, world.floorY, 36, 9, 0, 0, Math.PI*2); ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.translate(f.x, fy);
    if (f.facing < 0) ctx.scale(-1, 1);
    ctx.drawImage(f.sheet, fr.x, fr.y, fr.w, fr.h, -fr.w/2, -fr.h, fr.w, fr.h);
    ctx.restore();
  }

  function _animFor(f) {
    switch (f.state) {
      case 'walkF': return 'walkF';
      case 'walkB': return 'walkB';
      case 'crouch': return 'crouch';
      case 'jump': return 'jump';
      case 'block': case 'blockstun': return 'block';
      case 'hitstun': return 'hit';
      case 'ko': return 'ko';
      case 'win': return 'win';
      case 'attack': return f.move || 'idle';
      default: return 'idle';
    }
  }

  function drawPlaceholder(ctx, f, world) {
    var fy = world.floorY - f.y;
    var crouch = f.crouching ? 0.65 : 1;
    var H = f.h * crouch;
    var col = f.color;
    var dark = _shade(col, 0.6);
    ctx.save();
    ctx.translate(f.x, fy);
    var dir = f.facing;

    // shadow
    ctx.globalAlpha = 0.25; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(0, 0, 34, 9, 0, 0, Math.PI*2); ctx.fill();
    ctx.globalAlpha = 1;

    // legs
    var legSpread = (f.state === 'walkF' || f.state === 'walkB') ? 14 : 10;
    ctx.strokeStyle = dark; ctx.lineWidth = 12; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, -H*0.45); ctx.lineTo(-legSpread, -2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -H*0.45); ctx.lineTo(legSpread, -2); ctx.stroke();

    // torso
    ctx.fillStyle = col;
    _rr(ctx, -16, -H, 32, H*0.6, 8); ctx.fill();

    // head
    ctx.fillStyle = _shade(col, 1.15);
    ctx.beginPath(); ctx.arc(dir*4, -H-12, 15, 0, Math.PI*2); ctx.fill();

    // arms — pose by state
    ctx.strokeStyle = col; ctx.lineWidth = 10;
    var shoulderY = -H*0.85;
    if (f.state === 'attack' && f.move) {
      var m = MOVES[f.move];
      var ext = (f.moveTimer >= m.startup && f.moveTimer < m.startup + m.active) ? 1 : 0.5;
      if (m.kind === 'kick' || m.kind === 'special' && f.move==='tatsu') {
        // kicking leg forward
        ctx.beginPath(); ctx.moveTo(0,-H*0.45); ctx.lineTo(dir*(40*ext+20), -H*0.3); ctx.stroke();
      } else {
        // punch arm forward
        ctx.beginPath(); ctx.moveTo(0, shoulderY); ctx.lineTo(dir*(48*ext+12), shoulderY+ (f.move==='dp'? -40: 6)); ctx.stroke();
      }
      // other arm guard
      ctx.beginPath(); ctx.moveTo(0, shoulderY); ctx.lineTo(-dir*10, shoulderY+20); ctx.stroke();
    } else if (f.state === 'block' || f.state === 'blockstun') {
      ctx.beginPath(); ctx.moveTo(0, shoulderY); ctx.lineTo(dir*14, shoulderY+18); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, shoulderY); ctx.lineTo(dir*14, shoulderY+34); ctx.stroke();
    } else if (f.state === 'hitstun') {
      ctx.beginPath(); ctx.moveTo(0, shoulderY); ctx.lineTo(-dir*22, shoulderY-10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, shoulderY); ctx.lineTo(-dir*18, shoulderY+18); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.moveTo(0, shoulderY); ctx.lineTo(dir*16, shoulderY+22); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, shoulderY); ctx.lineTo(-dir*8, shoulderY+22); ctx.stroke();
    }

    if (f.state === 'ko') { ctx.globalAlpha = 0.5; }
    ctx.restore();
  }

  function drawFx(ctx, world) {
    for (var i = 0; i < world.fx.length; i++) {
      var s = world.fx[i];
      var p = 1 - s.t / s.life;
      ctx.globalAlpha = p;
      ctx.fillStyle = s.color;
      var r = s.r * (1.2 - p*0.6);
      // starburst
      ctx.save(); ctx.translate(s.x, s.y);
      for (var a = 0; a < 6; a++) {
        ctx.rotate(Math.PI/3);
        ctx.fillRect(0, -r*0.18, r, r*0.36);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawProjectiles(ctx, world) {
    for (var i = 0; i < world.projectiles.length; i++) {
      var p = world.projectiles[i];
      var y = world.floorY - p.y;
      var g = ctx.createRadialGradient(p.x, y, 2, p.x, y, p.r);
      g.addColorStop(0, '#fff'); g.addColorStop(0.5, p.color); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(p.x, y, p.r, 0, Math.PI*2); ctx.fill();
    }
  }

  // health bar + meter + round pips + timer
  function drawHud(ctx, world, p1, p2, match) {
    var W = world.w;
    _bar(ctx, 30, 26, W/2 - 110, 22, p1.health / p1.maxHealth, false);
    _bar(ctx, W/2 + 80, 26, W/2 - 110, 22, p2.health / p2.maxHealth, true);
    _meter(ctx, 30, 54, 220, 10, p1.meter / p1.maxMeter, false);
    _meter(ctx, W - 250, 54, 220, 10, p2.meter / p2.maxMeter, true);

    ctx.fillStyle = '#fff'; ctx.font = 'bold 14px monospace';
    ctx.textAlign = 'left';  ctx.fillText(p1.name, 32, 20);
    ctx.textAlign = 'right'; ctx.fillText(p2.name, W - 32, 20);

    // timer
    var secs = Math.ceil(match.timer / FPS);
    ctx.textAlign = 'center'; ctx.font = 'bold 30px monospace';
    ctx.fillText(secs < 10 ? '0'+secs : ''+secs, W/2, 44);

    // round pips
    _pips(ctx, W/2 - 40, 56, p1.wins, match.roundsToWin, -1);
    _pips(ctx, W/2 + 40, 56, p2.wins, match.roundsToWin, 1);

    // combo counter
    if (p1.combo > 1) { ctx.textAlign='left'; ctx.fillStyle='#fc6'; ctx.font='bold 22px monospace'; ctx.fillText(p1.combo + ' HITS', 36, 100); }
    if (p2.combo > 1) { ctx.textAlign='right'; ctx.fillStyle='#fc6'; ctx.font='bold 22px monospace'; ctx.fillText(p2.combo + ' HITS', W-36, 100); }
  }

  function _bar(ctx, x, y, w, h, pct, flip) {
    pct = Math.max(0, Math.min(1, pct));
    ctx.fillStyle = '#222'; _rr(ctx, x, y, w, h, 4); ctx.fill();
    ctx.fillStyle = '#000'; ctx.fillRect(x+2, y+2, w-4, h-4);
    var fw = (w-4) * pct;
    var grd = ctx.createLinearGradient(0, y, 0, y+h);
    grd.addColorStop(0, pct>0.3?'#6f6':'#f55'); grd.addColorStop(1, pct>0.3?'#2a2':'#a22');
    ctx.fillStyle = grd;
    if (flip) ctx.fillRect(x+2 + (w-4-fw), y+2, fw, h-4);
    else ctx.fillRect(x+2, y+2, fw, h-4);
    ctx.strokeStyle = '#fff5'; ctx.lineWidth = 1.5; _rr(ctx, x, y, w, h, 4); ctx.stroke();
  }
  function _meter(ctx, x, y, w, h, pct, flip) {
    ctx.fillStyle = '#111'; ctx.fillRect(x, y, w, h);
    var fw = w * Math.max(0, Math.min(1, pct));
    ctx.fillStyle = pct >= 1 ? '#fd4' : '#48f';
    if (flip) ctx.fillRect(x + (w - fw), y, fw, h); else ctx.fillRect(x, y, fw, h);
    ctx.strokeStyle = '#fff4'; ctx.strokeRect(x, y, w, h);
  }
  function _pips(ctx, x, y, wins, need, dir) {
    for (var i = 0; i < need; i++) {
      ctx.beginPath(); ctx.arc(x + dir*(i*16), y, 6, 0, Math.PI*2);
      ctx.fillStyle = i < wins ? '#fd4' : '#444'; ctx.fill();
      ctx.strokeStyle = '#fff6'; ctx.stroke();
    }
  }

  function drawStageBg(ctx, world, theme) {
    theme = theme || {};
    var grd = ctx.createLinearGradient(0, 0, 0, world.h);
    grd.addColorStop(0, theme.top || '#1a1030');
    grd.addColorStop(1, theme.bottom || '#3a2050');
    ctx.fillStyle = grd; ctx.fillRect(0, 0, world.w, world.h);
    // floor
    ctx.fillStyle = theme.floor || '#241636';
    ctx.fillRect(0, world.floorY, world.w, world.h - world.floorY);
    ctx.strokeStyle = '#fff2'; ctx.beginPath();
    ctx.moveTo(0, world.floorY); ctx.lineTo(world.w, world.floorY); ctx.stroke();
  }

  // ── small helpers ──
  function _rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r, y); ctx.arcTo(x+w, y, x+w, y+h, r); ctx.arcTo(x+w, y+h, x, y+h, r);
    ctx.arcTo(x, y+h, x, y, r); ctx.arcTo(x, y, x+w, y, r); ctx.closePath();
  }
  function _shade(hex, f) {
    if (hex[0] !== '#') return hex;
    var r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    r = Math.min(255, Math.round(r*f)); g = Math.min(255, Math.round(g*f)); b = Math.min(255, Math.round(b*f));
    return 'rgb('+r+','+g+','+b+')';
  }

  // ── Sprite loading ─────────────────────────────────────────────────
  // manifest JSON shape: { sheet: 'url', anims: { idle:{rate,frames:[{x,y,w,h}]}, ... } }
  function loadSprite(manifestUrl) {
    return fetch(manifestUrl).then(function (r) { return r.json(); }).then(function (man) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () { resolve({ sheet: img, anim: man.anims }); };
        img.onerror = reject;
        img.src = man.sheet;
      });
    });
  }

  global.Fight = {
    FPS: FPS,
    world: { create: createWorld },
    fighter: { create: createFighter, step: step, grounded: grounded },
    moves: MOVES,
    resolve: resolve,
    projectiles: { update: updateProjectiles },
    fx: { update: updateFx },
    facing: { update: updateFacing },
    match: { create: createMatch, update: updateMatch },
    ai: { create: createAi, think: aiThink },
    draw: {
      stage: drawStageBg, fighter: drawFighter, placeholder: drawPlaceholder,
      projectiles: drawProjectiles, fx: drawFx, hud: drawHud,
    },
    sprite: { load: loadSprite },
  };

})(window);
