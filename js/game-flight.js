// game-flight.js v0.1.3 — real-world flight physics for 3D flight games
// Framework-agnostic: no THREE dependency. SI units internally (m, m/s, kg, N, rad);
// instruments() converts to aviation units (kt, ft, fpm).
// World frame: +x east, +y up, -z north. Body frame matches Three.js object space:
// forward = -z, up = +y, right = +x — so games can copy sim.state.quat straight
// onto an Object3D quaternion.
(function () {
  'use strict';

  const G = 9.80665;
  const RHO0 = 1.225;

  // ---------- vector / quaternion math ----------
  const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
  const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
  const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
  const scl = (a, s) => v3(a.x * s, a.y * s, a.z * s);
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const len = (a) => Math.sqrt(dot(a, a));
  const norm = (a) => { const l = len(a) || 1; return scl(a, 1 / l); };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const qIdent = () => ({ x: 0, y: 0, z: 0, w: 1 });
  function qMul(a, b) {
    return {
      w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
      x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
      y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
      z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    };
  }
  function qNorm(q) {
    const l = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) || 1;
    return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
  }
  function qAxis(axis, ang) {
    const h = ang / 2, s = Math.sin(h);
    return qNorm({ x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(h) });
  }
  function qRot(q, v) {
    const qv = v3(q.x, q.y, q.z);
    const t = scl(cross(qv, v), 2);
    return add(add(v, scl(t, q.w)), cross(qv, t));
  }
  const qConj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
  function cross(a, b) {
    return v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }
  // integrate body angular rates (wx, wy, wz in body frame) into orientation
  function qIntegrate(q, wx, wy, wz, dt) {
    const hw = { x: wx * dt / 2, y: wy * dt / 2, z: wz * dt / 2, w: 0 };
    const dq = qMul(q, hw);
    return qNorm({ x: q.x + dq.x, y: q.y + dq.y, z: q.z + dq.z, w: q.w + dq.w });
  }

  // ---------- units ----------
  const units = {
    MS2KT: 1.94384, KT2MS: 0.514444, M2FT: 3.28084, FT2M: 0.3048,
    ms2fpm: (v) => v * 196.85, fpm2ms: (v) => v / 196.85,
  };

  // ---------- ISA standard atmosphere ----------
  const atmosphere = {
    rho0: RHO0,
    temperature(h) { return h < 11000 ? 288.15 - 0.0065 * h : 216.65; },
    density(h) {
      if (h < 0) h = 0;
      if (h < 11000) return RHO0 * Math.pow(this.temperature(h) / 288.15, 4.2559);
      return 0.3639 * Math.exp(-(h - 11000) / 6341.6);
    },
    speedOfSound(h) { return Math.sqrt(1.4 * 287.05 * this.temperature(h)); },
  };

  // ---------- real-world aircraft database ----------
  // massKg = typical operating weight (between empty and MTOW). All `real` stats are
  // published figures and shown in menus; stall/climb/ceiling behavior is NOT scripted —
  // it emerges from mass, wing area, clMax, power and the ISA model above.
  const aircraft = {
    cub: {
      name: 'Piper J-3 Cub', type: 'prop', icon: '🟡', color: '#f2c41d', accent: '#222222',
      massKg: 500, wingAreaM2: 16.58, spanM: 10.74, lengthM: 6.83,
      powerW: 48500, propEff: 0.75,
      cd0: 0.038, clMax: 1.7, alpha0: -0.04, oswald: 0.75,
      flaps: { clBonus: 0, cdPenalty: 0 },
      gear: { retractable: false, cd: 0.012, height: 1.3 },
      rates: { roll: 0.9, pitch: 0.7, yaw: 0.6 },
      limits: { vneKt: 122, gMax: 3.8 },
      real: { engine: 'Continental A-65 · 65 hp', maxSpeedKt: 76, cruiseKt: 65, stallKt: 33, ceilingFt: 11500, climbFpm: 450, rangeNm: 191, year: 1938 },
    },
    c172: {
      name: 'Cessna 172 Skyhawk', type: 'prop', icon: '🛩️', color: '#f5f5f0', accent: '#c0392b',
      massKg: 1043, wingAreaM2: 16.2, spanM: 11.0, lengthM: 8.28,
      powerW: 134000, propEff: 0.78,
      cd0: 0.032, clMax: 1.6, alpha0: -0.035, oswald: 0.75,
      flaps: { clBonus: 0.55, cdPenalty: 0.035 },
      gear: { retractable: false, cd: 0.011, height: 1.6 },
      rates: { roll: 1.0, pitch: 0.6, yaw: 0.5 },
      limits: { vneKt: 163, gMax: 3.8 },
      real: { engine: 'Lycoming IO-360 · 180 hp', maxSpeedKt: 163, cruiseKt: 122, stallKt: 48, ceilingFt: 14000, climbFpm: 730, rangeNm: 640, year: 1956 },
    },
    spitfire: {
      name: 'Spitfire Mk IX', type: 'prop', icon: '🛦', color: '#5b6e4e', accent: '#8a9a7b',
      massKg: 3400, wingAreaM2: 22.48, spanM: 11.23, lengthM: 9.47,
      powerW: 1167000, propEff: 0.8,
      cd0: 0.021, clMax: 1.7, alpha0: -0.03, oswald: 0.85,
      flaps: { clBonus: 0.5, cdPenalty: 0.06 },
      gear: { retractable: true, cd: 0.022, height: 2.0 },
      rates: { roll: 1.6, pitch: 1.1, yaw: 0.7 },
      limits: { vneKt: 450, gMax: 8 },
      real: { engine: 'RR Merlin 66 · 1,565 hp', maxSpeedKt: 354, cruiseKt: 278, stallKt: 64, ceilingFt: 43000, climbFpm: 3950, rangeNm: 380, year: 1942 },
    },
    f16: {
      name: 'F-16 Fighting Falcon', type: 'jet', icon: '✈️', color: '#7d8794', accent: '#4b5563',
      massKg: 12000, wingAreaM2: 27.87, spanM: 9.96, lengthM: 15.06,
      thrustN: 76300, abThrustN: 127000, spoolTau: 1.2,
      cd0: 0.018, clMax: 1.6, alpha0: -0.017, oswald: 0.8,
      flaps: { clBonus: 0.35, cdPenalty: 0.03 },
      gear: { retractable: true, cd: 0.02, height: 2.3 },
      rates: { roll: 4.2, pitch: 1.6, yaw: 0.6 },
      limits: { vneKt: 800, machMax: 2.0, gMax: 9 },
      real: { engine: 'GE F110 · 29,000 lbf (AB)', maxSpeedKt: 1147, cruiseKt: 495, stallKt: 128, ceilingFt: 50000, climbFpm: 50000, rangeNm: 2280, year: 1978 },
    },
    a320: {
      name: 'Airbus A320', type: 'jet', icon: '🛫', color: '#f2f4f7', accent: '#1d4ed8',
      massKg: 64000, wingAreaM2: 122.6, spanM: 35.8, lengthM: 37.57,
      thrustN: 240000, spoolTau: 3.0,
      cd0: 0.024, clMax: 1.45, alpha0: -0.035, oswald: 0.78,
      flaps: { clBonus: 1.0, cdPenalty: 0.055 },
      gear: { retractable: true, cd: 0.018, height: 3.6 },
      rates: { roll: 0.55, pitch: 0.35, yaw: 0.3 },
      limits: { vneKt: 350, machMax: 0.82, gMax: 2.5 },
      real: { engine: '2× CFM56-5B · 27,000 lbf', maxSpeedKt: 470, cruiseKt: 447, stallKt: 118, ceilingFt: 39800, climbFpm: 2400, rangeNm: 3300, year: 1987 },
    },
    b747: {
      name: 'Boeing 747-400', type: 'jet', icon: '🛬', color: '#f4f6f8', accent: '#0f4c81',
      massKg: 285000, wingAreaM2: 541, spanM: 64.4, lengthM: 70.66,
      thrustN: 1009000, spoolTau: 3.5,
      cd0: 0.022, clMax: 1.45, alpha0: -0.035, oswald: 0.78,
      flaps: { clBonus: 0.9, cdPenalty: 0.05 },
      gear: { retractable: true, cd: 0.016, height: 5.3 },
      rates: { roll: 0.4, pitch: 0.28, yaw: 0.25 },
      limits: { vneKt: 365, machMax: 0.92, gMax: 2.5 },
      real: { engine: '4× PW4056 · 56,750 lbf', maxSpeedKt: 507, cruiseKt: 493, stallKt: 148, ceilingFt: 45100, climbFpm: 2000, rangeNm: 7260, year: 1988 },
    },
  };

  function list() {
    return Object.keys(aircraft).map((key) => Object.assign({ key }, aircraft[key]));
  }

  // register(key, def) — add a new aircraft (or override a built-in) at runtime.
  // Lets games define planes in external JSON (manifest folders) instead of code.
  // Requires massKg, wingAreaM2, spanM, lengthM and an engine (powerW or thrustN);
  // everything else falls back to sensible defaults. Returns the merged entry.
  function register(key, def) {
    const base = {
      type: 'prop', icon: '✈️', color: '#cccccc', accent: '#555555',
      propEff: 0.78, cd0: 0.03, clMax: 1.5, alpha0: -0.03, oswald: 0.78,
      flaps: { clBonus: 0, cdPenalty: 0 },
      gear: { retractable: false, cd: 0.012, height: 1.6 },
      rates: { roll: 1, pitch: 0.6, yaw: 0.5 },
      limits: { vneKt: 200, gMax: 4 },
      real: {},
    };
    const cur = aircraft[key] || {};
    const merged = Object.assign({}, base, cur, def);
    for (const k of ['flaps', 'gear', 'rates', 'limits', 'real'])
      merged[k] = Object.assign({}, base[k], cur[k] || {}, def[k] || {});
    if (!merged.massKg || !merged.wingAreaM2 || !merged.spanM || !merged.lengthM
      || !(merged.powerW || merged.thrustN)) {
      throw new Error('GameFlight.register(' + key + '): needs massKg, wingAreaM2, spanM, lengthM and powerW or thrustN');
    }
    aircraft[key] = merged;
    return merged;
  }

  // ---------- simulation ----------
  // opts: { x, y, z, headingDeg, speedKt, onGround, gearDown, flaps,
  //         getGroundY(x,z)->m, assists, wind:{x,z} }
  function createSim(key, opts = {}) {
    const ac = aircraft[key];
    if (!ac) throw new Error('GameFlight: unknown aircraft ' + key);

    const AR = (ac.spanM * ac.spanM) / ac.wingAreaM2;
    const clSlope = (2 * Math.PI * AR) / (AR + 2); // per rad, finite-wing corrected
    const clMaxClean = ac.clMax;
    // 1-g stall speed at sea level for the configured mass (used for control scaling)
    const vStall = Math.sqrt((2 * ac.massKg * G) / (RHO0 * ac.wingAreaM2 * clMaxClean));

    const getGroundY = opts.getGroundY || (() => 0);

    const sim = {
      aircraft: ac, key, AR, clSlope, vStall,
      state: null, controls: null, lastTouchdown: null,
      wind: { x: opts.wind ? opts.wind.x : 0, z: opts.wind ? opts.wind.z : 0 },
      assists: !!opts.assists,
      reset, step, setControls, instruments, setWind,
    };

    function reset(o = {}) {
      const heading = ((o.headingDeg !== undefined ? o.headingDeg : opts.headingDeg) || 0) * Math.PI / 180;
      const q = qAxis(v3(0, 1, 0), -heading);
      const spd = (o.speedKt !== undefined ? o.speedKt : opts.speedKt || 0) * units.KT2MS;
      const fwd = qRot(q, v3(0, 0, -1));
      sim.state = {
        pos: v3(o.x !== undefined ? o.x : opts.x || 0,
                o.y !== undefined ? o.y : opts.y || 0,
                o.z !== undefined ? o.z : opts.z || 0),
        vel: scl(fwd, spd),
        quat: q,
        onGround: (o.onGround !== undefined ? o.onGround : opts.onGround) !== false,
        crashed: false, failure: null, stalled: false, scraping: false,
        gForce: 1, alpha: 0, beta: 0, thrustFrac: 0, thrustN: 0,
        overspeedT: 0, time: 0,
      };
      sim.controls = {
        pitch: 0, roll: 0, yaw: 0, throttle: 0, afterburner: false,
        flaps: (o.flaps !== undefined ? o.flaps : opts.flaps) || 0,
        gear: (o.gearDown !== undefined ? o.gearDown : opts.gearDown) !== false,
        brakes: 0,
      };
      sim.lastTouchdown = null;
      if (sim.state.onGround) {
        const gh = getGroundY(sim.state.pos.x, sim.state.pos.z);
        sim.state.pos.y = gh + ac.gear.height;
      }
      return sim;
    }

    function setControls(c) { Object.assign(sim.controls, c); }
    function setWind(x, z) { sim.wind.x = x; sim.wind.z = z; }

    function step(dt) {
      if (sim.state.crashed) return;
      dt = clamp(dt, 0, 0.05);
      let t = dt;
      while (t > 0) { const h = Math.min(t, 0.02); substep(h); t -= h; }
    }

    function substep(dt) {
      const s = sim.state, c = sim.controls;
      s.time += dt;

      // --- atmosphere & airflow ---
      const rho = atmosphere.density(Math.max(0, s.pos.y));
      const sigma = rho / RHO0;
      const airVel = v3(s.vel.x - sim.wind.x, s.vel.y, s.vel.z - sim.wind.z);
      const v = Math.max(len(airVel), 0.01);
      const velDir = norm(airVel);

      const fwd = qRot(s.quat, v3(0, 0, -1));
      const up = qRot(s.quat, v3(0, 1, 0));

      // velocity in body frame → angle of attack & sideslip
      const vb = qRot(qConj(s.quat), airVel);
      const vfwd = Math.max(-vb.z, 1);
      const alpha = Math.atan2(-vb.y, vfwd);
      const beta = Math.atan2(vb.x, vfwd);
      s.alpha = alpha; s.beta = beta;

      // --- lift & stall (real CLmax → real stall speed) ---
      const clMaxEff = clMaxClean + c.flaps * ac.flaps.clBonus;
      const alphaStall = clMaxEff / clSlope + ac.alpha0;
      let cl = clSlope * (alpha - ac.alpha0);
      s.stalled = false;
      if (alpha > alphaStall) {
        s.stalled = true;
        const past = alpha - alphaStall;
        cl = Math.max(clMaxEff * (1 - past * (sim.assists ? 1.5 : 3)), clMaxEff * 0.45);
      } else if (cl < -clMaxEff * 0.75) {
        cl = -clMaxEff * 0.75;
      }

      const q = 0.5 * rho * v * v;
      const liftN = q * ac.wingAreaM2 * cl;
      // lift acts perpendicular to airflow, in the aircraft's plane of symmetry
      let liftDir = sub(up, scl(velDir, dot(up, velDir)));
      liftDir = len(liftDir) > 0.01 ? norm(liftDir) : up;

      // --- drag (parasite + induced + config) ---
      let cd = ac.cd0 + (cl * cl) / (Math.PI * AR * ac.oswald)
        + c.flaps * ac.flaps.cdPenalty
        + (c.gear ? ac.gear.cd : 0)
        + (s.stalled ? 0.05 : 0);
      // transonic wave drag rise near the aircraft's real Mach limit
      const mach = v / atmosphere.speedOfSound(Math.max(0, s.pos.y));
      const machLim = ac.limits.machMax || 0.65;
      if (mach > machLim * 0.92) cd += Math.pow((mach - machLim * 0.92) * 6, 2);
      const dragN = q * ac.wingAreaM2 * cd;

      // --- thrust (spool lag, density lapse) ---
      const target = clamp(c.throttle, 0, 1);
      const tau = ac.spoolTau || 0.3;
      s.thrustFrac += (target - s.thrustFrac) * Math.min(1, dt / tau * 2.2);
      let thrust;
      if (ac.type === 'prop') {
        const pAvail = ac.powerW * s.thrustFrac * Math.max(0.2, sigma);
        thrust = (ac.propEff * pAvail) / Math.max(v, 22);
      } else {
        let maxT = ac.thrustN;
        if (c.afterburner && ac.abThrustN) maxT = ac.abThrustN;
        thrust = maxT * s.thrustFrac * Math.pow(Math.max(0.05, sigma), 0.7);
      }
      s.thrustN = thrust;

      // --- sum forces ---
      let F = scl(fwd, thrust);
      F = add(F, scl(velDir, -dragN));
      F = add(F, scl(liftDir, liftN));
      // sideslip damping (fuselage side force)
      F = add(F, scl(qRot(s.quat, v3(1, 0, 0)), -beta * q * ac.wingAreaM2 * 0.35));
      F = add(F, v3(0, -ac.massKg * G, 0));

      const acc = scl(F, 1 / ac.massKg);
      s.gForce = (liftN / (ac.massKg * G)) || 0;
      if (s.onGround) s.gForce = 1;

      s.vel = add(s.vel, scl(acc, dt));
      s.pos = add(s.pos, scl(s.vel, dt));

      // --- rotation: control authority scales with airspeed ---
      const eff = clamp(v / (vStall * 1.25), 0, 1.4) ** 2 / 1.4;
      const stab = sim.assists ? 2.4 : 1.4;
      const trimAlpha = 0.035 + c.flaps * 0.01;

      let pitchUp = c.pitch * ac.rates.pitch * eff
        + (trimAlpha - alpha) * stab * eff * 0.5;
      let rollRight = c.roll * ac.rates.roll * eff;
      let yawRight = c.yaw * ac.rates.yaw * eff + beta * 1.6 * eff; // weathervane

      if (s.stalled) {
        pitchUp -= (alpha - alphaStall) * 2.5;            // nose drops
        rollRight += Math.sin(s.time * 7) * 0.35;          // buffet wobble
      }
      if (sim.assists) yawRight += Math.sin(qRollOf(s.quat)) * 0.15; // auto-rudder
      if (sim.assists && !s.onGround) {
        // Assisted flying aids, so a newcomer can let go of the controls without falling out of the sky.
        const bank = qRollOf(s.quat), gamma = Math.asin(clamp(s.vel.y / Math.max(len(s.vel), 1), -1, 1));
        // wing leveller: release roll and the wings come back level; bank stops at 60 degrees
        if (Math.abs(c.roll) < 0.15) rollRight -= bank * 1.6 * eff;
        if (Math.abs(bank) > 1.05 && c.roll * bank > 0) rollRight -= c.roll * ac.rates.roll * eff;
        // path hold: release pitch and the plane settles into a shallow climb (it sinks only if it is too slow to climb)
        const climb = 0.035 + 0.03 * clamp((c.throttle - 0.6) / 0.4, 0, 1);   // steeper with more power
        if (Math.abs(c.pitch) < 0.15) pitchUp += (climb - gamma) * 1.8 * eff;
        // stall protection: pull authority fades out as the wing nears its critical angle
        const margin = alphaStall - alpha;
        if (pitchUp > 0 && margin < 0.07) pitchUp *= Math.max(0, margin / 0.07);
      }

      if (s.onGround) {
        // nosewheel steering, wings forced level
        yawRight = c.yaw * (0.9 - clamp(v / 70, 0, 0.78));
        rollRight = -qRollOf(s.quat) * 3;
        const pitchDeg = Math.asin(clamp(fwd.y, -1, 1));
        if (pitchDeg < 0 && c.pitch <= 0) pitchUp = -pitchDeg * 3; // settle level
      }

      // body rates: ω = (pitchUp, -yawRight, -rollRight) — see frame note at top
      s.quat = qIntegrate(s.quat, pitchUp, -yawRight, -rollRight, dt);

      // --- structural limits (real Vne / G limits) ---
      const ias = v * Math.sqrt(sigma) * units.MS2KT;
      const overspeed = ias > ac.limits.vneKt || (ac.limits.machMax && mach > ac.limits.machMax);
      s.overspeedT = overspeed ? s.overspeedT + dt : 0;
      if (!sim.assists) {
        if (s.overspeedT > 3) return crash('airframe failure — exceeded Vne');
        if (Math.abs(s.gForce) > ac.limits.gMax * 1.5) return crash('airframe failure — over-G');
      }

      // --- ground contact ---
      const gh = getGroundY(s.pos.x, s.pos.z);
      const gearH = c.gear ? ac.gear.height : ac.gear.height * 0.45;
      if (s.pos.y - gearH <= gh) {
        const vs = s.vel.y;
        const rollDeg = Math.abs(qRollOf(s.quat)) * 180 / Math.PI;
        const pitchD = Math.asin(clamp(fwd.y, -1, 1)) * 180 / Math.PI;
        if (!s.onGround) {
          // touchdown — judge it
          const hard = c.gear ? -4.0 : -1.2;
          if (vs < hard || rollDeg > 25 || pitchD < -11 || pitchD > 18) {
            return crash(vs < hard ? 'hard impact' : 'lost control on touchdown');
          }
          if (!c.gear) s.scraping = true;
          sim.lastTouchdown = {
            vsiFpm: units.ms2fpm(vs), iasKt: ias, rollDeg,
            x: s.pos.x, z: s.pos.z, gearDown: c.gear, time: s.time,
          };
        }
        s.onGround = true;
        s.pos.y = gh + gearH;
        if (s.vel.y < 0) s.vel.y = 0;
        // rolling friction + brakes (belly scrape decelerates hard)
        const hv = v3(s.vel.x, 0, s.vel.z);
        const hs = len(hv);
        if (hs > 0.02) {
          const mu = s.scraping ? 0.5 : 0.025 + 0.45 * c.brakes;
          const dec = Math.min(mu * G * dt, hs);
          const slowed = scl(norm(hv), hs - dec);
          s.vel.x = slowed.x; s.vel.z = slowed.z;
          // tires pull velocity toward heading
          const fh = norm(v3(fwd.x, 0, fwd.z));
          const k = clamp(dt * (3.5 - hs / 30), 0, 1);
          const blended = norm(add(scl(norm(slowed), 1 - k), scl(fh, k)));
          const ns = len(v3(s.vel.x, 0, s.vel.z));
          s.vel.x = blended.x * ns; s.vel.z = blended.z * ns;
        } else { s.vel.x = 0; s.vel.z = 0; if (s.scraping) s.scraping = false; }
      } else if (s.onGround && s.pos.y - gearH > gh + 0.15) {
        s.onGround = false; s.scraping = false;
      }

      function crash(why) { s.crashed = true; s.failure = why; }
    }

    function qRollOf(q) {
      const right = qRot(q, v3(1, 0, 0));
      const up = qRot(q, v3(0, 1, 0));
      return Math.atan2(-right.y, up.y);
    }

    function instruments() {
      const s = sim.state, c = sim.controls;
      const rho = atmosphere.density(Math.max(0, s.pos.y));
      const sigma = rho / RHO0;
      const airVel = v3(s.vel.x - sim.wind.x, s.vel.y, s.vel.z - sim.wind.z);
      const tas = len(airVel);
      const fwd = qRot(s.quat, v3(0, 0, -1));
      const gh = getGroundY(s.pos.x, s.pos.z);
      let heading = Math.atan2(fwd.x, -fwd.z) * 180 / Math.PI;
      if (heading < 0) heading += 360;
      const machLim = ac.limits.machMax;
      const mach = tas / atmosphere.speedOfSound(Math.max(0, s.pos.y));
      const ias = tas * Math.sqrt(sigma) * units.MS2KT;
      return {
        iasKt: ias, tasKt: tas * units.MS2KT, mach,
        altFt: s.pos.y * units.M2FT,
        aglFt: (s.pos.y - gh) * units.M2FT,
        vsiFpm: units.ms2fpm(s.vel.y),
        headingDeg: heading,
        pitchDeg: Math.asin(clamp(fwd.y, -1, 1)) * 180 / Math.PI,
        rollDeg: qRollOf(s.quat) * 180 / Math.PI,
        alphaDeg: s.alpha * 180 / Math.PI,
        gForce: s.onGround ? 1 : s.gForce,
        stalled: s.stalled,
        overspeed: ias > ac.limits.vneKt || (machLim ? mach > machLim : false),
        throttle: c.throttle, flaps: c.flaps, gear: c.gear, brakes: c.brakes,
        afterburner: c.afterburner && !!ac.abThrustN,
        onGround: s.onGround, crashed: s.crashed, failure: s.failure,
        scraping: s.scraping,
        windKt: len(v3(sim.wind.x, 0, sim.wind.z)) * units.MS2KT,
        windFromDeg: (Math.atan2(-sim.wind.x, sim.wind.z) * 180 / Math.PI + 360) % 360,
        stallKtNow: Math.sqrt((2 * ac.massKg * G) /
          (rho * ac.wingAreaM2 * (clMaxClean + c.flaps * ac.flaps.clBonus))) * Math.sqrt(sigma) * units.MS2KT,
      };
    }

    reset();
    return sim;
  }

  window.GameFlight = {
    version: '0.1.1',
    units, atmosphere, aircraft, list, register, createSim,
    math: { v3, add, sub, scl, dot, cross, len, norm, clamp, qIdent, qMul, qAxis, qRot, qConj },
  };
})();
