/* effects.js — Arena Wave VFX / particle layer (owner: VFX)
 * Exposes window.Effects. Renders z-order layer 5 (slash arcs, projectile trails,
 * hit flash, death bursts, status auras, augment auras) + layer 6 damage numbers.
 * Body/weapon/map/HP-bars are NOT drawn here (frontend + champMotion own those).
 *
 * Public API (superset — supports both integration styles):
 *   Effects.spawn(type, data)        // one server event -> VFX
 *   Effects.ingest(events, state)    // batch: spawn each + cache latest snapshot
 *   Effects.setState(state)          // feed latest snapshot (projectile trails / ongoing status auras)
 *   Effects.update(dt)               // dt in seconds; advance particles (called every frame, even during hitstop)
 *   Effects.render(ctx, now)         // layer 5; world coords (1280x720). Caller applies shake.
 *   Effects.renderDamageNumbers(ctx) // layer 6; floating combat text
 *   Effects.getScreenShake()         // -> {x,y} pixel offset (caller applies via ctx.translate)
 *   Effects.getHitStop()             // -> ms remaining (>0 => caller may freeze sim)
 *   Effects.reset()                  // clear all (call on restart)
 */
(function () {
  'use strict';

  // ───────────────────────────── utils ─────────────────────────────
  var TAU = Math.PI * 2;
  function rand(a, b) { return a + Math.random() * (b - a); }
  function irand(a, b) { return (a + Math.random() * (b - a + 1)) | 0; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function hx(h) {
    h = ('' + h).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgba(h, a) { var c = hx(h); return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a + ')'; }
  function mix(h1, h2, t) {
    var a = hx(h1), b = hx(h2);
    return 'rgb(' + Math.round(lerp(a[0], b[0], t)) + ',' + Math.round(lerp(a[1], b[1], t)) + ',' + Math.round(lerp(a[2], b[2], t)) + ')';
  }

  var ease = {
    outQuad: function (t) { return 1 - (1 - t) * (1 - t); },
    outBack: function (t) { var c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    outCirc: function (t) { return Math.sqrt(1 - Math.pow(t - 1, 2)); },
    outCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
    inOutSine: function (t) { return -(Math.cos(Math.PI * t) - 1) / 2; },
    linear: function (t) { return t; }
  };

  // ───────────────────────────── design tokens ─────────────────────────────
  var COL = {
    WHITE: '#FFFFFF', GOLD: '#FFD700', GOLD_DK: '#AA8800',
    ALLY_L: '#88CCFF', ALLY_M: '#4A90E2', ALLY_D: '#1A4A8A',
    ENEMY_L: '#FF8844', ENEMY_M: '#FF4444', ENEMY_D: '#8B0000',
    HEAL: '#44FF88', CRIT: '#FFD700'
  };
  // class -> aura/effect color (design-spec 3-9)
  var CLASS_COL = { warrior: '#4A90E2', mage: '#9B59B6', archer: '#27AE60', assassin: '#E91E63' };
  // skill-type accent colors (match app.js SKILL_TYPE_COLOR so cast VFX = skill-bar icon)
  var SKILL_COL = { dash_strike: '#FF66AA', aoe_field: '#88FF44', nova: '#FFAA33', projectile_barrage: '#66CCFF', buff: '#FFD700', summon: '#9B6BFF', chain: '#33E0E0' };
  // augment type map: augId -> 'hp' | 'speed' | 'atk' | 'class'
  var AUG_TYPE = {
    steelheart:'hp', regen:'hp', immortal:'hp', thornarmor:'hp', vamp:'hp',
    w_shield:'hp', w_unbreak:'hp', m_ward:'hp',
    boots:'speed', w_rally:'speed', s_speed:'speed',
    sharp:'atk', frenzy:'atk', critup:'atk', execute:'atk', berserk:'atk',
    flame:'atk', m_focus:'atk', m_swift:'atk', w_exec:'atk', w_crush:'atk'
  };
  // melee visual params (must match server CHAMPIONS so motion dir == hit dir)
  var MELEE = {
    warrior: { arc: 1.92, range: 84, col: '#4A90E2', light: '#88CCFF', w: 9 },
    assassin: { arc: 1.40, range: 66, col: '#CC44FF', light: '#FF66DD', w: 5 }
  };
  // enemy palette {main, light, dark} for hit-particles + death bursts
  var EVIS = {
    slime: { m: '#44CC44', l: '#88FF88', d: '#228822' },
    goblin: { m: '#CC9933', l: '#F0C060', d: '#883322' },
    bat: { m: '#6633AA', l: '#9966DD', d: '#44228A' },
    skeleton: { m: '#E8E8D0', l: '#FFFFFF', d: '#9A9A80' },
    slinger: { m: '#CC9933', l: '#F0C060', d: '#7A5A1A' },
    orc: { m: '#4A7A4A', l: '#6FB36F', d: '#336633' },
    splitslime: { m: '#44CC44', l: '#88FF88', d: '#228822' },
    darkmage: { m: '#9B00FF', l: '#CC66FF', d: '#220044' },
    healerimp: { m: '#66DD88', l: '#AAFFCC', d: '#338855' },
    shieldorc: { m: '#5A6A8A', l: '#8FA0C8', d: '#33405A' },
    giant: { m: '#CC4400', l: '#FF6600', d: '#8B2200' },
    boss: { m: '#880000', l: '#FFD700', d: '#440000' }
  };
  function evis(t) { return EVIS[t] || { m: '#CCCCCC', l: '#FFFFFF', d: '#888888' }; }

  // ───────────────────────────── pools / state ─────────────────────────────
  var T = 0;            // internal clock (ms)
  var parts = [];       // generic particles
  var pool = [];        // free particle objects
  var rings = [];       // expanding rings/shockwaves
  var arcs = [];        // slash arcs
  var auras = [];       // timed status auras (fallback when no live state)
  var dmgs = [];        // damage numbers
  var banners = [];     // big centered text (BOSS DEFEATED)
  var flash = { a: 0, col: '#FFFFFF' }; // fullscreen flash
  var trauma = 0;       // screen-shake trauma 0..1
  var hitStopMs = 0;
  var lastState = null; // latest snapshot for projectile trails + ongoing auras
  var projTrails = {};  // id -> { pts:[{x,y}], seen:T, kind, tier, owner }
  // self-advance guard: works whether the host calls update() or only render()
  var extUpdated = false, lastClock = 0;
  var hasPerf = (typeof performance !== 'undefined' && performance && performance.now);
  function nowMs() { return hasPerf ? performance.now() : T + 16; }
  // enemy windup telegraph ramp tracking + one-shot strike flash
  var windupMap = {};   // enemyId -> { start:T (my clock) }
  var strikeSeen = {};  // "id:startedAt" -> true (so each strike flashes once)
  var hitVig = 0;       // player-hit red vignette intensity 0..1
  var castFx = [];      // transient skill-cast flourishes (rune rings, cores, pillars, muzzles)
  var lightning = [];   // chain bolts {pts, t, life, col}
  var dashTrails = [];  // active dash trackers {pid, endT, lx, ly, col, prime}
  var orbTrails = [];   // flying orb arcs { sx,sy,tx,ty,cx,cy,t,life,trail[] }
  // multiplayer overcrowding control: hard cap on live particles (4p + simultaneous skills).
  var PART_CAP = 480;
  // player down/revive tracking (state-driven; no event dependency)
  var reviveTrack = {};   // pid -> {start, end} server-ms window for the countdown ring
  var wasDead = {};       // pid -> bool (death/revive transition detection)
  var reviveBurstAt = {}; // pid -> T (dedupe revive flash vs player_revived event)
  var wispAt = {};        // pid -> T (throttle soul-wisp emission)

  function P() { // acquire a particle (with hard cap — evict oldest when full)
    if (parts.length >= PART_CAP) pool.push(parts.shift());
    var p = pool.pop();
    if (!p) p = {};
    p.t = 0; p.life = 1; p.x = 0; p.y = 0; p.vx = 0; p.vy = 0;
    p.grav = 0; p.drag = 0; p.r0 = 3; p.r1 = 0; p.col = '#fff'; p.col2 = null;
    p.glow = 0; p.shape = 'dot'; p.rot = 0; p.vrot = 0; p.a0 = 1; p.fade = 1;
    p.w = 0; p.h = 0;
    parts.push(p);
    return p;
  }
  function kill(arr, i) { var o = arr[i]; arr[i] = arr[arr.length - 1]; arr.pop(); return o; }

  // ───────────────────────────── emit helpers ─────────────────────────────
  function burst(x, y, n, opt) {
    opt = opt || {};
    // soft budget: thin out new bursts as we approach the cap so no single moment floods
    if (parts.length > PART_CAP * 0.75) n = Math.ceil(n * 0.5);
    var a0 = opt.a0 == null ? 0 : opt.a0;          // base angle
    var spread = opt.spread == null ? TAU : opt.spread;
    var sp0 = opt.sp0 == null ? 60 : opt.sp0, sp1 = opt.sp1 == null ? 140 : opt.sp1;
    for (var i = 0; i < n; i++) {
      var ang = (spread >= TAU) ? rand(0, TAU) : a0 + rand(-spread / 2, spread / 2);
      var sp = rand(sp0, sp1);
      var p = P();
      p.x = x; p.y = y;
      p.vx = Math.cos(ang) * sp; p.vy = Math.sin(ang) * sp;
      p.life = opt.life == null ? rand(0.3, 0.5) : opt.life * rand(0.85, 1.0);
      p.r0 = opt.r0 == null ? rand(3, 5) : opt.r0; p.r1 = opt.r1 == null ? 0 : opt.r1;
      p.col = opt.col || '#fff'; p.col2 = opt.col2 || null;
      p.glow = opt.glow || 0; p.shape = opt.shape || 'dot';
      p.grav = opt.grav || 0; p.drag = opt.drag == null ? 1.6 : opt.drag;
      p.rot = rand(0, TAU); p.vrot = opt.vrot == null ? rand(-8, 8) : rand(-opt.vrot, opt.vrot);
      p.a0 = opt.alpha == null ? 1 : opt.alpha; p.fade = opt.fade || 1;
      p.w = opt.pw || 0; p.h = opt.ph || 0;
    }
  }
  function ring(x, y, opt) {
    rings.push({
      x: x, y: y, t: 0, life: opt.life || 0.4,
      r0: opt.r0 || 10, r1: opt.r1 || 80, w0: opt.w0 || 4, w1: opt.w1 == null ? 1 : opt.w1,
      col: opt.col || '#fff', glow: opt.glow || 0, ease: opt.ease || ease.outCirc,
      a0: opt.alpha == null ? 0.8 : opt.alpha, fill: !!opt.fill
    });
  }

  // ───────────────────────────── status auras ─────────────────────────────
  // drawn from live state every frame (follows enemy); fallback to timed auras list.
  function drawStatusAura(ctx, x, y, r, kind, tt) {
    var s = tt / 1000;
    if (kind === 'burn') {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      var orbit = r + 8;
      for (var i = 0; i < 6; i++) {
        var ang = (s * 1.5 * TAU) + i / 6 * TAU;
        var fx = x + Math.cos(ang) * orbit;
        var fy = y + Math.sin(ang) * orbit + Math.sin(s * 9 + i) * 4 - 2;
        var fr = 3 + Math.sin(s * 12 + i * 2) * 1;
        ctx.fillStyle = mix('#FFAA00', '#FF6600', (i % 3) / 2);
        ctx.shadowBlur = 8; ctx.shadowColor = '#FF6600';
        ctx.beginPath(); ctx.arc(fx, fy, Math.max(0.5, fr), 0, TAU); ctx.fill();
      }
      ctx.restore();
    } else if (kind === 'freeze') {
      // NOTE: app.js draws the solid blue freeze tint on the enemy body; here we add
      // only the decorative ice crystals (avoid double-filling the body).
      var br = 0.95 + Math.sin(s * TAU) * 0.05;
      ctx.save();
      ctx.strokeStyle = '#CCFFFF'; ctx.lineWidth = 2; ctx.shadowBlur = 6; ctx.shadowColor = '#88CCFF';
      for (var k = 0; k < 4; k++) {
        var a = k / 4 * TAU + s * 0.4;
        var ex = x + Math.cos(a) * (r + 10) * br, ey = y + Math.sin(a) * (r + 10) * br;
        var mx = x + Math.cos(a) * (r + 2), my = y + Math.sin(a) * (r + 2);
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(ex, ey);
        ctx.lineTo(ex + Math.cos(a + 0.8) * 6, ey + Math.sin(a + 0.8) * 6); ctx.moveTo(ex, ey);
        ctx.lineTo(ex + Math.cos(a - 0.8) * 6, ey + Math.sin(a - 0.8) * 6); ctx.stroke();
      }
      ctx.restore();
    } else if (kind === 'poison') {
      ctx.save(); ctx.fillStyle = '#88FF44'; ctx.shadowBlur = 6; ctx.shadowColor = '#66CC22';
      for (var j = 0; j < 4; j++) {
        var ph = (s * 2 + j * 0.25) % 1;
        var px = x + Math.sin((j * 1.7) + s * 2) * (r * 0.5);
        var py = y - ph * 50 + 4;
        ctx.globalAlpha = (1 - ph) * 0.9;
        ctx.beginPath(); ctx.arc(px, py, 4, 0, TAU); ctx.fill();
      }
      ctx.restore();
    } else if (kind === 'stun') {
      ctx.save(); ctx.fillStyle = COL.GOLD; ctx.shadowBlur = 6; ctx.shadowColor = COL.GOLD_DK;
      for (var m = 0; m < 3; m++) {
        var sa = s * 2 * TAU + m / 3 * TAU;
        star(ctx, x + Math.cos(sa) * (r + 12), y - r - 6 + Math.sin(sa) * 4, 5, 2.2);
      }
      ctx.restore();
    }
  }
  function star(ctx, cx, cy, ro, ri) {
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var rr = i % 2 ? ri : ro, a = -Math.PI / 2 + i * Math.PI / 5;
      var px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }

  // ───────────────────────────── slash arcs ─────────────────────────────
  function slash(x, y, ang, cls, kind) {
    var m = MELEE[cls] || MELEE.warrior;
    arcs.push({ x: x, y: y, ang: ang, arc: m.arc, range: m.range, col: m.col, light: m.light, w: m.w, t: 0, life: 0.18, cls: cls, kind: kind });
    // leading-edge sparks along the swing tip
    burst(x + Math.cos(ang) * m.range, y + Math.sin(ang) * m.range, 6,
      { a0: ang, spread: m.arc, sp0: 80, sp1: 200, life: 0.28, r0: 2.5, r1: 0, col: m.light, glow: 8, drag: 2.2 });
    if (kind === 'dash') {
      // dash motion line particles (champion silhouette is drawn by champMotion; we add streak)
      burst(x, y, 8, { a0: ang + Math.PI, spread: 0.5, sp0: 40, sp1: 120, life: 0.25, r0: 2, r1: 0, col: '#CC44FF', glow: 6, drag: 2 });
    }
  }
  function drawArc(ctx, a) {
    var p = a.t / a.life; if (p > 1) p = 1;
    var sweep = ease.outQuad(p);
    var cur = a.ang - a.arc / 2 + a.arc * sweep;        // current blade angle
    // trailing copies for motion blur
    var copies = [[0, 0.85], [-0.10, 0.45], [-0.20, 0.22], [-0.30, 0.10]];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var c = 0; c < copies.length; c++) {
      var off = copies[c][0], al = copies[c][1] * (1 - p);
      if (al <= 0.01) continue;
      var sp = clamp(sweep + off, 0, 1);
      var aa = a.ang - a.arc / 2 + a.arc * sp;
      var span = a.arc * 0.22; // crescent angular width
      var rOut = a.range, rIn = a.range - (a.w + 18);
      var g = ctx.createLinearGradient(
        a.x + Math.cos(aa) * rIn, a.y + Math.sin(aa) * rIn,
        a.x + Math.cos(aa) * rOut, a.y + Math.sin(aa) * rOut);
      g.addColorStop(0, rgba(a.light, al));
      g.addColorStop(1, rgba(a.col, al * 0.15));
      ctx.fillStyle = g;
      ctx.shadowBlur = 12; ctx.shadowColor = a.col;
      ctx.beginPath();
      ctx.arc(a.x, a.y, rOut, aa - span, aa + span);
      ctx.arc(a.x, a.y, rIn, aa + span, aa - span, true);
      ctx.closePath(); ctx.fill();
    }
    // bright leading edge
    ctx.strokeStyle = rgba('#FFFFFF', (1 - p) * 0.9);
    ctx.lineWidth = a.w * (1 - p * 0.6); ctx.lineCap = 'round';
    ctx.shadowBlur = 14; ctx.shadowColor = a.col;
    ctx.beginPath();
    ctx.arc(a.x, a.y, a.range - a.w * 0.5, cur - a.arc * 0.12, cur + a.arc * 0.12);
    ctx.stroke();
    if (a.kind === 'dash') { // assassin cross flick
      ctx.strokeStyle = rgba(a.light, (1 - p) * 0.8); ctx.lineWidth = 2.5;
      var cx = a.x + Math.cos(a.ang) * a.range * 0.7, cy = a.y + Math.sin(a.ang) * a.range * 0.7;
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(a.ang + 0.6) * 14, cy - Math.sin(a.ang + 0.6) * 14);
      ctx.lineTo(cx + Math.cos(a.ang + 0.6) * 14, cy + Math.sin(a.ang + 0.6) * 14);
      ctx.moveTo(cx - Math.cos(a.ang - 0.6) * 14, cy - Math.sin(a.ang - 0.6) * 14);
      ctx.lineTo(cx + Math.cos(a.ang - 0.6) * 14, cy + Math.sin(a.ang - 0.6) * 14);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ───────────────────────────── projectile trails (state path) ─────────────────────────────
  function updateProjTrails() {
    if (!lastState || !lastState.projectiles) return;
    var live = lastState.projectiles, seen = {};
    for (var i = 0; i < live.length; i++) {
      var pr = live[i]; seen[pr.id] = 1;
      var tr = projTrails[pr.id];
      if (!tr) { tr = projTrails[pr.id] = { pts: [], kind: pr.kind, tier: pr.tier, owner: pr.owner, angle: pr.angle }; }
      tr.kind = pr.kind; tr.tier = pr.tier; tr.owner = pr.owner; tr.angle = pr.angle; tr.seen = T;
      tr.pts.push({ x: pr.x, y: pr.y });
      if (tr.pts.length > 9) tr.pts.shift();
    }
    for (var id in projTrails) { if (!seen[id]) { delete projTrails[id]; } }
  }
  function projStyle(kind, tier, owner) {
    if (owner === 'enemy') {
      if (kind === 'bone') return { body: '#E8E8D0', glow: '#FFFFFF', gb: 6, r: 7, rect: true };
      if (kind === 'darkbolt') return { body: '#220044', glow: '#9B00FF', gb: 15, r: 10 };
      return { body: COL.ENEMY_M, glow: COL.ENEMY_L, gb: 10, r: 8 };
    }
    if (kind === 'magic') return { body: '#FFFFFF', glow: '#BB66FF', gb: 16, r: 8 };
    if (kind === 'arrow') {
      var c = tier >= 3 ? '#00E5FF' : tier === 2 ? '#4CAF50' : '#8B6914';
      return { body: c, glow: c, gb: tier >= 2 ? 10 : 0, r: 6, arrow: true };
    }
    return { body: COL.ALLY_L, glow: COL.ALLY_M, gb: 10, r: 7 };
  }
  function drawProjectiles(ctx) {
    if (!lastState || !lastState.projectiles) return;
    var live = lastState.projectiles;
    ctx.save();
    for (var i = 0; i < live.length; i++) {
      var pr = live[i], st = projStyle(pr.kind, pr.tier, pr.owner), tr = projTrails[pr.id];
      // trail
      if (tr && tr.pts.length > 1) {
        for (var j = 0; j < tr.pts.length - 1; j++) {
          var f = j / tr.pts.length;
          ctx.globalAlpha = f * 0.6;
          ctx.fillStyle = st.glow;
          ctx.beginPath(); ctx.arc(tr.pts[j].x, tr.pts[j].y, st.r * (0.3 + f * 0.7), 0, TAU); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = st.gb; ctx.shadowColor = st.glow;
      if (st.arrow) {
        ctx.save(); ctx.translate(pr.x, pr.y); ctx.rotate(pr.angle);
        ctx.strokeStyle = st.body; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(6, 0); ctx.stroke();
        ctx.fillStyle = st.body; ctx.beginPath();
        ctx.moveTo(12, 0); ctx.lineTo(4, -4); ctx.lineTo(4, 4); ctx.closePath(); ctx.fill();
        ctx.restore();
      } else if (st.rect) {
        ctx.save(); ctx.translate(pr.x, pr.y); ctx.rotate(T / 120 + pr.id);
        ctx.fillStyle = st.body; ctx.fillRect(-2.5, -6, 5, 12); ctx.restore();
      } else {
        ctx.fillStyle = st.body; ctx.beginPath(); ctx.arc(pr.x, pr.y, st.r, 0, TAU); ctx.fill();
        if (st.glow !== st.body) { ctx.fillStyle = rgba(st.glow, 0.5); ctx.beginPath(); ctx.arc(pr.x, pr.y, st.r * 0.55, 0, TAU); ctx.fill(); }
      }
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  // ───────────────────────────── death profiles (design-spec 3-7) ─────────────────────────────
  function death(x, y, type, boss) {
    var v = evis(type);
    if (boss || type === 'boss') {
      flash.a = 0.5; flash.col = '#FFFFFF';
      ring(x, y, { r0: 10, r1: 160, w0: 8, w1: 1, life: 0.9, col: v.l, glow: 16, alpha: 0.9 });
      ring(x, y, { r0: 10, r1: 110, w0: 6, w1: 1, life: 0.7, col: v.m, glow: 12, alpha: 0.7 });
      burst(x, y, 40, { sp0: 80, sp1: 300, life: 1.5, r0: 7, r1: 0, col: v.m, col2: v.l, glow: 10, drag: 1.1 });
      burst(x, y, 16, { sp0: 60, sp1: 180, life: 1.3, r0: 5, r1: 0, col: COL.GOLD, glow: 12, drag: 1.2 });
      banners.push({ text: 'BOSS DEFEATED!', t: 0, life: 2.4, size: 48, col: COL.GOLD });
      trauma = Math.min(1, trauma + 0.5);
      return;
    }
    switch (type) {
      case 'slime': case 'splitslime':
        burst(x, y, 12, { sp0: 60, sp1: 120, life: 0.6, r0: 5, r1: 1, col: v.m, col2: v.l, glow: 4, drag: 2.2 }); break;
      case 'goblin': case 'slinger':
        burst(x, y, 8, { sp0: 80, sp1: 150, life: 0.5, r0: 5, r1: 0, col: v.m, glow: 2, shape: 'shard', pw: 7, ph: 5, vrot: 12 });
        burst(x, y - 6, 2, { sp0: 60, sp1: 100, life: 0.5, r0: 4, col: '#FFFFFF', shape: 'tri', pw: 5, ph: 7 }); break;
      case 'skeleton':
        burst(x, y, 8, { sp0: 70, sp1: 150, life: 0.5, r0: 5, col: v.l, shape: 'shard', pw: 3, ph: 10, vrot: 14, grav: 120 });
        burst(x, y - 4, 2, { a0: -Math.PI / 2, spread: 0.6, sp0: 30, sp1: 60, life: 0.5, r0: 3, col: '#FF3030', glow: 10 }); break;
      case 'orc': case 'shieldorc':
        ring(x, y, { r0: 40, r1: 70, w0: 5, w1: 1, life: 0.7, col: v.d, glow: 6, alpha: 0.6 });
        burst(x, y, 16, { sp0: 70, sp1: 150, life: 0.7, r0: 6, r1: 0, col: v.d, glow: 2, drag: 1.6 });
        burst(x, y, 4, { sp0: 60, sp1: 140, life: 0.6, r0: 4, col: '#CC0000', glow: 6 }); break;
      case 'bat':
        burst(x, y, 10, { a0: -Math.PI / 2, spread: 2.2, sp0: 30, sp1: 90, life: 0.8, r0: 4, col: v.m, grav: -40, drag: 1.2 });
        burst(x, y, 2, { sp0: 40, sp1: 80, life: 0.8, r0: 5, col: v.d, shape: 'shard', pw: 10, ph: 4, grav: 160, vrot: 8 }); break;
      case 'darkmage':
        rings.push({ x: x, y: y, t: 0, life: 0.6, r0: 28, r1: 0, w0: 3, w1: 3, col: '#9B00FF', glow: 12, ease: ease.linear, a0: 0.7, fill: false });
        burst(x, y, 12, { sp0: 60, sp1: 160, life: 0.8, r0: 6, r1: 1, col: '#9B00FF', col2: '#CC66FF', glow: 12, drag: 1.4 }); break;
      case 'giant':
        flash.a = Math.max(flash.a, 0.25); flash.col = '#FF6600';
        ring(x, y, { r0: 10, r1: 100, w0: 8, w1: 1, life: 0.5, col: '#FF6600', glow: 14, alpha: 0.9 });
        ring(x, y, { r0: 40, r1: 100, w0: 3, w1: 1, life: 0.7, col: '#FF4400', glow: 8, alpha: 0.5 });
        burst(x, y, 24, { sp0: 120, sp1: 240, life: 1.2, r0: 9, r1: 0, col: '#FF6600', col2: '#CC4400', glow: 10, drag: 1.1 });
        trauma = Math.min(1, trauma + 0.4); break;
      default:
        burst(x, y, 12, { sp0: 60, sp1: 140, life: 0.6, r0: 5, r1: 0, col: v.m, col2: v.l, glow: 4, drag: 1.8 });
    }
  }

  // ───────────────────────────── event dispatch ─────────────────────────────
  function dmgNumber(x, y, text, kind) {
    var d = { x: x + rand(-6, 6), y: y - 14, t: 0, life: 1.0, text: text, vx: rand(-12, 12), vy: -42, kind: kind, pop: kind === 'crit' ? 0 : 1 };
    dmgs.push(d);
  }

  function spawn(type, d) {
    if (!d) d = {};
    switch (type) {
      case 'attack': {
        // melee slash arc (origin from player pos in d.x/d.y; champion via d.champion)
        var cls = d.champion;
        var kind = d.kind || (d.animType);
        if ((kind === 'swing' || kind === 'dash') && d.x != null) slash(d.x, d.y, d.aimAngle || 0, cls || (kind === 'dash' ? 'assassin' : 'warrior'), kind);
        else if ((kind === 'cast' || kind === 'shoot') && d.x != null) {
          var mc = cls === 'mage' ? '#BB66FF' : '#88FF88';
          burst(d.x + Math.cos(d.aimAngle || 0) * 22, d.y + Math.sin(d.aimAngle || 0) * 22, 6,
            { a0: d.aimAngle || 0, spread: 0.8, sp0: 40, sp1: 120, life: 0.22, r0: 3, r1: 0, col: mc, glow: 10, drag: 2 });
        }
        break;
      }
      case 'hit': {
        var v = d.target != null && lastState ? enemyVisById(d.target) : null;
        var pcol = v ? v.l : COL.WHITE;
        // white flash on enemy is drawn by frontend (snapshot.flash); we add directional spark + dmg number
        var idir = (d.dir == null ? 0 : d.dir);
        burst(d.x, d.y, 6, { a0: idir, spread: Math.PI / 3, sp0: 100, sp1: 160, life: 0.3, r0: 3, r1: 5, col: pcol, glow: 4, drag: 2 });
        if (d.dmg != null) dmgNumber(d.x, d.y, '' + d.dmg, d.crit ? 'crit' : 'normal');
        if (d.crit) burst(d.x, d.y, 5, { sp0: 80, sp1: 160, life: 0.4, r0: 2.5, col: COL.GOLD, glow: 10, drag: 2 });
        break;
      }
      case 'player_hit': {
        // app owns the damage number + screen shake; Effects adds ONLY the red
        // vignette pulse + impact sparks (no number, no shake — avoids double).
        var sev = clamp((d.dmg || 8) / 28, 0.35, 1);   // bigger hit => stronger pulse
        hitVig = Math.max(hitVig, 0.45 + sev * 0.35);
        if (d.x != null) {
          burst(d.x, d.y, 9, { sp0: 70, sp1: 180, life: 0.34, r0: 3, r1: 0, col: COL.ENEMY_M, col2: COL.ENEMY_L, glow: 5, drag: 2.2 });
          // 3 inward impact streaks from random edge directions toward the player
          for (var si = 0; si < 3; si++) {
            var ea = rand(0, TAU), pp = P();
            pp.x = d.x + Math.cos(ea) * 46; pp.y = d.y + Math.sin(ea) * 46;
            pp.vx = -Math.cos(ea) * 150; pp.vy = -Math.sin(ea) * 150;
            pp.life = 0.22; pp.r0 = 3.5; pp.r1 = 0; pp.col = COL.ENEMY_L; pp.glow = 6; pp.drag = 1.4; pp.shape = 'dot'; pp.a0 = 0.9;
          }
        }
        break;
      }
      case 'heal':
        if (d.amt != null) dmgNumber(d.x, d.y, '+' + d.amt, 'heal');
        burst(d.x, d.y, 6, { a0: -Math.PI / 2, spread: 1.2, sp0: 30, sp1: 70, life: 0.6, r0: 3, col: COL.HEAL, glow: 8, grav: -30, drag: 1.4 }); break;
      case 'death': death(d.x, d.y, d.enemyType, d.boss); break;
      case 'explosion':
        ring(d.x, d.y, { r0: 8, r1: d.r || (d.small ? 40 : 100), w0: d.small ? 4 : 7, w1: 1, life: d.small ? 0.35 : 0.5, col: '#FF6600', glow: 12, alpha: 0.85 });
        burst(d.x, d.y, d.small ? 10 : 20, { sp0: 80, sp1: d.small ? 160 : 240, life: d.small ? 0.5 : 0.9, r0: d.small ? 4 : 8, r1: 0, col: '#FF6600', col2: '#CC4400', glow: 10, drag: 1.2 });
        break;
      case 'status': {
        var ex = d.x, ey = d.y, er = d.r || 16;
        if ((ex == null || ey == null) && lastState && d.target != null) { var e = enemyById(d.target); if (e) { ex = e.x; ey = e.y; er = e.r; } }
        if (ex != null) {
          auras.push({ x: ex, y: ey, r: er, kind: d.kind, t: 0, life: d.kind === 'freeze' ? 1.2 : d.kind === 'poison' ? 2.0 : 1.5, target: d.target });
          var ac = d.kind === 'burn' ? '#FF6600' : d.kind === 'freeze' ? '#88CCFF' : d.kind === 'poison' ? '#88FF44' : COL.GOLD;
          burst(ex, ey, 8, { sp0: 40, sp1: 100, life: 0.4, r0: 3, r1: 0, col: ac, glow: 8, drag: 2 });
        }
        break;
      }
      case 'knockback':
        if (d.x != null) {
          var ka = Math.atan2(d.dy || 0, d.dx || 0);
          burst(d.x, d.y, 7, { a0: ka, spread: Math.PI / 2.5, sp0: 90, sp1: 180, life: 0.3, r0: 3, r1: 0, col: '#FFFFFF', glow: 4, drag: 2.4 });
        }
        break;
      case 'augment_aura': {
        var ax = d.x, ay = d.y;
        if ((ax == null || ay == null) && lastState && d.id != null) { var pp = playerById(d.id); if (pp) { ax = pp.x; ay = pp.y; } }
        if (ax == null) break;
        var augKind = AUG_TYPE[d.augId] || 'class';
        if (augKind === 'hp') {
          // HP: 초록 링 + 상승 파티클
          ring(ax, ay, { r0: 20, r1: 108, w0: 5, w1: 1, life: 0.55, col: '#44FF88', glow: 18, alpha: 0.9, ease: ease.outCirc });
          ring(ax, ay, { r0: 8, r1: 48, w0: 3, w1: 0, life: 0.30, col: '#AAFFCC', glow: 10, alpha: 0.8, ease: ease.outCirc });
          burst(ax, ay, 18, { a0: -Math.PI/2, spread: 2.1, sp0: 38, sp1: 95, life: 0.9, r0: 4, r1: 0, col: '#44FF88', col2: '#CCFFDD', glow: 10, grav: -65, drag: 1.3 });
        } else if (augKind === 'speed') {
          // 이속: 양방향 수평 폭발 + 청록 링
          flash.a = Math.max(flash.a, 0.07); flash.col = '#44CCFF';
          ring(ax, ay, { r0: 10, r1: 78, w0: 3, w1: 0, life: 0.32, col: '#44CCFF', glow: 14, alpha: 0.85, ease: ease.outCirc });
          burst(ax, ay, 18, { a0: 0, spread: 0.55, sp0: 85, sp1: 220, life: 0.38, r0: 3.5, r1: 0, col: '#44CCFF', col2: '#FFFFFF', glow: 10, drag: 1.8 });
          burst(ax, ay, 18, { a0: Math.PI, spread: 0.55, sp0: 85, sp1: 220, life: 0.38, r0: 3.5, r1: 0, col: '#44CCFF', col2: '#FFFFFF', glow: 10, drag: 1.8 });
        } else if (augKind === 'atk') {
          // 공격: 금빛 flash + 방사형 스타버스트
          flash.a = Math.max(flash.a, 0.13); flash.col = COL.GOLD;
          ring(ax, ay, { r0: 14, r1: 98, w0: 6, w1: 1, life: 0.45, col: COL.GOLD, glow: 22, alpha: 0.95, ease: ease.outCirc });
          burst(ax, ay, 22, { sp0: 100, sp1: 260, life: 0.55, r0: 5, r1: 0, col: COL.GOLD, col2: '#FFEEAA', glow: 14, drag: 1.3 });
          burst(ax, ay, 8, { sp0: 55, sp1: 135, life: 0.8, r0: 4, col: '#FFD700', glow: 12, shape: 'tri', pw: 6, ph: 6, vrot: 10, drag: 1.4 });
        } else {
          // class 전용 (기존 연출 유지)
          var cc = CLASS_COL[d.champion] || COL.GOLD;
          ring(ax, ay, { r0: 30, r1: 120, w0: 4, w1: 1, life: 0.6, col: cc, glow: 14, alpha: 0.8, ease: ease.outCirc });
          burst(ax, ay, 16, { sp0: 120, sp1: 120, life: 0.6, r0: 4, r1: 1, col: cc, glow: 10, drag: 1.0 });
          burst(ax, ay, 6, { sp0: 60, sp1: 140, life: 0.8, r0: 4, col: COL.GOLD, glow: 12, shape: 'tri', pw: 6, ph: 6, vrot: 10, drag: 1.4 });
        }
        break;
      }
      case 'levelup': {
        var lx = d.x, ly = d.y;
        if ((lx == null || ly == null) && lastState && d.id != null) { var lp = playerById(d.id); if (lp) { lx = lp.x; ly = lp.y; } }
        if (lx == null) break;
        ring(lx, ly, { r0: 20, r1: 90, w0: 4, w1: 1, life: 0.6, col: COL.GOLD, glow: 14, alpha: 0.8 });
        burst(lx, ly, 14, { a0: -Math.PI / 2, spread: 1.6, sp0: 60, sp1: 160, life: 0.8, r0: 4, col: COL.GOLD, glow: 10, grav: -60, drag: 1.2 });
        break;
      }
      case 'skill_cast': {
        var stp = d.skillType || d.type;
        var acc = SKILL_COL[stp] || '#5BE7D6';
        var cls = CLASS_COL[d.champion] || acc;
        var sx = d.x, sy = d.y, aim = d.aimAngle || 0, dur = d.duration || 220;
        var fx = Math.cos(aim), fy = Math.sin(aim);
        switch (stp) {
          case 'dash_strike':
            // follow the casting player's real position for a streaking trail
            if (d.pid != null) dashTrails.push({ pid: d.pid, endT: T + dur, lx: sx, ly: sy, col: acc });
            slash(sx, sy, aim, d.champion || 'warrior', 'swing');
            castFx.push({ kind: 'rune', x: sx, y: sy, t: 0, life: 0.3, r0: 8, r1: 46, col: acc, glow: 12, spin: 1 });
            burst(sx, sy, 10, { a0: aim + Math.PI, spread: 0.7, sp0: 60, sp1: 160, life: 0.3, r0: 2.5, r1: 0, col: acc, glow: 8, drag: 2 });
            break;
          case 'nova':
            flash.a = Math.max(flash.a, 0.18); flash.col = acc;
            castFx.push({ kind: 'core', x: sx, y: sy, t: 0, life: 0.25, col: acc });
            ring(sx, sy, { r0: 14, r1: 150, w0: 7, w1: 1, life: 0.5, col: acc, glow: 16, alpha: 0.9, ease: ease.outCirc });
            ring(sx, sy, { r0: 14, r1: 110, w0: 5, w1: 1, life: 0.4, col: cls, glow: 12, alpha: 0.7, ease: ease.outCirc });
            burst(sx, sy, 28, { sp0: 120, sp1: 300, life: 0.7, r0: 6, r1: 0, col: acc, col2: cls, glow: 10, drag: 1.2 });
            break;
          case 'aoe_field':
            // cast-moment flourish only; app.js drawFields renders the persistent field
            castFx.push({ kind: 'rune', x: sx, y: sy, t: 0, life: 0.6, r0: 20, r1: 95, col: acc, glow: 12, spin: 1 });
            ring(sx, sy, { r0: 10, r1: 95, w0: 5, w1: 1, life: 0.45, col: acc, glow: 12, alpha: 0.85, ease: ease.outCirc });
            burst(sx, sy, 18, { a0: -Math.PI / 2, spread: 1.6, sp0: 50, sp1: 130, life: 0.7, r0: 4, r1: 0, col: acc, glow: 8, grav: -40, drag: 1.3 });
            break;
          case 'projectile_barrage':
            castFx.push({ kind: 'muzzle', x: sx + fx * 22, y: sy + fy * 22, ang: aim, t: 0, life: 0.18, col: acc });
            burst(sx + fx * 24, sy + fy * 24, 14, { a0: aim, spread: 0.9, sp0: 120, sp1: 280, life: 0.3, r0: 2.5, r1: 0, col: acc, glow: 10, drag: 1.8 });
            break;
          case 'buff':
            castFx.push({ kind: 'pillar', x: sx, y: sy, t: 0, life: 0.6, col: acc });
            ring(sx, sy, { r0: 14, r1: 60, w0: 4, w1: 1, life: 0.5, col: acc, glow: 12, alpha: 0.8, ease: ease.outCirc });
            burst(sx, sy, 16, { a0: -Math.PI / 2, spread: 1.0, sp0: 60, sp1: 140, life: 0.9, r0: 3, r1: 0, col: acc, glow: 10, grav: -70, drag: 1.2 });
            burst(sx, sy, 6, { sp0: 60, sp1: 130, life: 0.8, r0: 4, col: COL.GOLD, glow: 12, shape: 'tri', pw: 6, ph: 6, vrot: 10, drag: 1.4 });
            break;
          case 'summon':
            castFx.push({ kind: 'rune', x: sx, y: sy, t: 0, life: 0.6, r0: 8, r1: 64, col: acc, glow: 12, spin: -1 });
            castFx.push({ kind: 'pillar', x: sx, y: sy, t: 0, life: 0.5, col: acc });
            burst(sx, sy, 12, { sp0: 40, sp1: 110, life: 0.7, r0: 3, r1: 0, col: acc, glow: 8, grav: -20, drag: 1.4 });
            break;
          case 'chain':
            castFx.push({ kind: 'core', x: sx, y: sy, t: 0, life: 0.2, col: acc });
            burst(sx, sy, 8, { sp0: 60, sp1: 160, life: 0.3, r0: 2.5, r1: 0, col: acc, glow: 10, drag: 2 });
            break;
          default:
            ring(sx, sy, { r0: 8, r1: 80, w0: 3, w1: 1, life: 0.35, col: acc, glow: 8, alpha: 0.7 });
            burst(sx, sy, 10, { sp0: 80, sp1: 200, life: 0.4, r0: 3, r1: 0, col: acc, glow: 6, drag: 1.6 });
        }
        break;
      }
      case 'chain_link':
        if (d.x1 != null) pushLightning(d.x1, d.y1, d.x2, d.y2, SKILL_COL.chain);
        break;
      case 'player_revived': {
        // explicit revive trigger (deduped vs the state-driven transition path)
        var rp = (d.pid != null && lastState) ? playerById(d.pid) : null;
        reviveBurst(d.pid != null ? d.pid : 'p', d.x, d.y, rp ? rp.champion : d.champion);
        break;
      }
      case 'orb_grant': {
        if (d.x != null && d.y != null) {
          burst(d.x, d.y, 6, { sp0: 35, sp1: 90, life: 0.5, r0: 3.5, r1: 0, col: '#BB77FF', col2: '#FFFFFF', glow: 8, grav: -30, drag: 1.6 });
          // arc flight to HUD slot
          if (d.tx != null && d.ty != null) {
            var ocx = (d.x + d.tx) / 2;
            var ocy = Math.min(d.y, d.ty) - 110;
            orbTrails.push({ sx: d.x, sy: d.y, tx: d.tx, ty: d.ty, cx: ocx, cy: ocy, t: 0, life: 0.45, trail: [] });
          }
        }
        break;
      }
      case 'orb_threshold': {
        // 오브 임계치 도달: 플레이어 위치에서 보라 폭발 + 링
        var op = (d.pid != null && lastState) ? playerById(d.pid) : null;
        var ox = op ? op.x : d.x, oy = op ? op.y : d.y;
        if (ox == null) break;
        ring(ox, oy, { r0: 18, r1: 120, w0: 6, w1: 1, life: 0.55, col: '#BB44FF', glow: 20, alpha: 0.9, ease: ease.outCirc });
        ring(ox, oy, { r0: 8,  r1: 55,  w0: 3, w1: 0, life: 0.32, col: '#FFFFFF', glow: 10, alpha: 0.75, ease: ease.outCirc });
        burst(ox, oy, 24, { sp0: 90, sp1: 240, life: 0.75, r0: 5, r1: 0, col: '#CC55FF', col2: '#FF99FF', glow: 14, drag: 1.3 });
        burst(ox, oy, 8, { sp0: 40, sp1: 100, life: 1.0, r0: 4, r1: 0, col: COL.GOLD, glow: 12, grav: -40, drag: 1.5 });
        flash.a = Math.max(flash.a, 0.13); flash.col = '#9933FF';
        break;
      }
      case 'hitstop': hitStopMs = Math.max(hitStopMs, d.ms || 0); break;
      case 'shake': trauma = Math.min(1, trauma + (d.mag || 2) * 0.06); break;
      case 'explosion_big': break;
      default: break; // ignore unknown
    }
  }

  // state lookups
  function enemyById(id) { if (!lastState) return null; var es = lastState.enemies || []; for (var i = 0; i < es.length; i++) if (es[i].id === id) return es[i]; return null; }
  function enemyVisById(id) { var e = enemyById(id); return e ? evis(e.type) : null; }
  function playerById(id) { if (!lastState) return null; var ps = lastState.players || []; for (var i = 0; i < ps.length; i++) if (ps[i].id === id) return ps[i]; return null; }

  // ───────────────────────────── update ─────────────────────────────
  function update(dt) { step(dt); extUpdated = true; }
  function step(dt) {
    if (!(dt > 0)) dt = 0.016;
    if (dt > 0.1) dt = 0.1;
    T += dt * 1000;
    hitStopMs = Math.max(0, hitStopMs - dt * 1000);
    trauma = Math.max(0, trauma - dt * 1.6);
    flash.a = Math.max(0, flash.a - dt * 2.2);
    hitVig = Math.max(0, hitVig - dt * 2.4);

    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.t += dt;
      if (p.t >= p.life) { pool.push(kill(parts, i)); continue; }
      var dr = Math.exp(-p.drag * dt);
      p.vx *= dr; p.vy *= dr;
      p.vy += p.grav * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.rot += p.vrot * dt;
    }
    for (var r = rings.length - 1; r >= 0; r--) { rings[r].t += dt; if (rings[r].t >= rings[r].life) kill(rings, r); }
    for (var a = arcs.length - 1; a >= 0; a--) { arcs[a].t += dt; if (arcs[a].t >= arcs[a].life) kill(arcs, a); }
    for (var u = auras.length - 1; u >= 0; u--) { auras[u].t += dt; if (auras[u].t >= auras[u].life) kill(auras, u); }
    for (var dd = dmgs.length - 1; dd >= 0; dd--) {
      var n = dmgs[dd]; n.t += dt;
      if (n.t >= n.life) { kill(dmgs, dd); continue; }
      var dr2 = Math.exp(-2.5 * dt); n.vx *= dr2;
      n.x += n.vx * dt; n.y += n.vy * dt; n.vy += 30 * dt;
      if (n.pop < 1) n.pop = Math.min(1, n.pop + dt / 0.1);
    }
    for (var b = banners.length - 1; b >= 0; b--) { banners[b].t += dt; if (banners[b].t >= banners[b].life) kill(banners, b); }
    for (var cf = castFx.length - 1; cf >= 0; cf--) { castFx[cf].t += dt; if (castFx[cf].t >= castFx[cf].life) kill(castFx, cf); }
    for (var lg = lightning.length - 1; lg >= 0; lg--) { lightning[lg].t += dt; if (lightning[lg].t >= lightning[lg].life) kill(lightning, lg); }
    stepDashTrails(dt);
    // orb arc flight update
    for (var oi = orbTrails.length - 1; oi >= 0; oi--) {
      var ob = orbTrails[oi];
      // cancelling: fade-out 80ms 후 splice (취소 롤백 경로)
      if (ob.cancelling) {
        if (T - ob.cancelStart >= 80) { orbTrails.splice(oi, 1); }
        continue;
      }
      ob.t += dt;
      var otp = Math.min(1, ob.t / ob.life);
      var obx = (1-otp)*(1-otp)*ob.sx + 2*(1-otp)*otp*ob.cx + otp*otp*ob.tx;
      var oby = (1-otp)*(1-otp)*ob.sy + 2*(1-otp)*otp*ob.cy + otp*otp*ob.ty;
      ob.trail.push({ x: obx, y: oby, age: 0 });
      for (var tj2 = 0; tj2 < ob.trail.length; tj2++) ob.trail[tj2].age += dt;
      if (ob.trail.length > 10) ob.trail.shift();
      if (ob.t >= ob.life) {
        burst(ob.tx, ob.ty, 10, { sp0: 20, sp1: 65, life: 0.38, r0: 3, r1: 0, col: '#BB77FF', col2: '#FFFFFF', glow: 14, drag: 2.0 });
        ring(ob.tx, ob.ty, { r0: 4, r1: 32, w0: 3, w1: 0, life: 0.27, col: '#CC88FF', glow: 14, alpha: 1.0, ease: ease.outCirc });
        orbTrails.splice(oi, 1);
      }
    }
    // NOTE: projectile bodies/trails are drawn by app.js (drawProjectile L4) — Effects no longer renders them (avoids double).
  }

  // ───────────────────────────── skill VFX: dash trails / lightning / cast flourishes ─────────────────────────────
  // Real-dash trail: follow the casting player's live position for the dash duration and
  // lay down afterimage streak + speed lines (the body silhouette is the motion animator's).
  function stepDashTrails(dt) {
    for (var i = dashTrails.length - 1; i >= 0; i--) {
      var d = dashTrails[i];
      var pl = lastState ? playerById(d.pid) : null;
      var cx = pl ? pl.x : d.lx, cy = pl ? pl.y : d.ly;
      var dx = cx - d.lx, dy = cy - d.ly, dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 2) {
        var ang = Math.atan2(dy, dx), steps = Math.min(6, Math.max(1, Math.floor(dist / 10)));
        for (var s = 1; s <= steps; s++) {
          var f = s / steps, ix = d.lx + dx * f, iy = d.ly + dy * f;
          var q = P(); q.x = ix; q.y = iy; q.life = 0.28; q.r0 = 5; q.r1 = 0; q.col = d.col; q.glow = 8; q.drag = 0; q.a0 = 0.5;
          if (s % 2 === 0) { var sp = P(); sp.x = ix; sp.y = iy; sp.vx = -Math.cos(ang) * 60; sp.vy = -Math.sin(ang) * 60; sp.life = 0.22; sp.col = '#FFFFFF'; sp.glow = 6; sp.drag = 1; sp.shape = 'shard'; sp.w = 14; sp.h = 2; sp.rot = ang; sp.a0 = 0.7; }
        }
        d.lx = cx; d.ly = cy;
      }
      if (T >= d.endT) {
        ring(cx, cy, { r0: 6, r1: 42, w0: 5, w1: 1, life: 0.25, col: d.col, glow: 10, alpha: 0.8, ease: ease.outCubic });
        burst(cx, cy, 10, { sp0: 60, sp1: 160, life: 0.35, r0: 3, r1: 0, col: d.col, col2: '#FFFFFF', glow: 8, drag: 1.6 });
        kill(dashTrails, i);
      }
    }
  }

  function pushLightning(x1, y1, x2, y2, col) {
    col = col || SKILL_COL.chain;
    var dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
    var nx = -dy / len, ny = dx / len, segN = Math.max(4, Math.min(10, Math.floor(len / 22)));
    var pts = [{ x: x1, y: y1 }];
    for (var i = 1; i < segN; i++) {
      var f = i / segN, amp = rand(-1, 1) * Math.min(18, len * 0.12);
      pts.push({ x: x1 + dx * f + nx * amp, y: y1 + dy * f + ny * amp });
    }
    pts.push({ x: x2, y: y2 });
    var branch = null;
    if (len > 80 && Math.random() < 0.6) {
      var bp = pts[Math.floor(segN * 0.5)], ba = Math.atan2(dy, dx) + rand(-0.9, 0.9), bl = rand(20, 40);
      branch = [{ x: bp.x, y: bp.y }, { x: bp.x + Math.cos(ba) * bl, y: bp.y + Math.sin(ba) * bl }];
    }
    lightning.push({ pts: pts, branch: branch, t: 0, life: 0.26, col: col });
    burst(x1, y1, 4, { sp0: 40, sp1: 110, life: 0.25, r0: 2.5, col: col, glow: 8, drag: 2 });
    burst(x2, y2, 6, { sp0: 50, sp1: 140, life: 0.3, r0: 3, col: col, glow: 10, drag: 2 });
  }
  function strokePts(ctx, pts, w, col, al) {
    ctx.strokeStyle = rgba(col, al); ctx.lineWidth = w; ctx.shadowBlur = 14; ctx.shadowColor = col;
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
    ctx.stroke();
  }
  function drawLightning(ctx) {
    if (!lightning.length) return;
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (var i = 0; i < lightning.length; i++) {
      var L = lightning[i], a = 1 - L.t / L.life;
      strokePts(ctx, L.pts, 5, L.col, a * 0.35);
      strokePts(ctx, L.pts, 2, '#FFFFFF', a * 0.9);
      if (L.branch) strokePts(ctx, L.branch, 1.5, L.col, a * 0.6);
    }
    ctx.restore(); ctx.shadowBlur = 0;
  }

  function polyRing(ctx, cx, cy, r, n, rot) {
    ctx.beginPath();
    for (var i = 0; i <= n; i++) { var a = rot + i / n * TAU, px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r; if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
    ctx.stroke();
  }
  function drawCastFx(ctx) {
    if (!castFx.length) return;
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < castFx.length; i++) {
      var c = castFx[i], p = c.t / c.life, a = 1 - p;
      if (c.kind === 'rune') {
        var rr = lerp(c.r0, c.r1, ease.outCubic(p)), spin = (c.spin || 1) * T / 600;
        ctx.globalAlpha = a; ctx.strokeStyle = rgba(c.col, 0.85); ctx.lineWidth = 2; ctx.shadowBlur = c.glow || 10; ctx.shadowColor = c.col;
        polyRing(ctx, c.x, c.y, rr, 7, spin);
        polyRing(ctx, c.x, c.y, rr * 0.66, 5, -spin * 1.4);
        for (var k = 0; k < 7; k++) { var ang = spin + k / 7 * TAU; ctx.beginPath(); ctx.moveTo(c.x + Math.cos(ang) * rr * 0.9, c.y + Math.sin(ang) * rr * 0.9); ctx.lineTo(c.x + Math.cos(ang) * rr, c.y + Math.sin(ang) * rr); ctx.stroke(); }
        ctx.globalAlpha = 1;
      } else if (c.kind === 'core') {
        var cr = lerp(4, 26, ease.outCubic(p));
        ctx.fillStyle = rgba('#FFFFFF', a); ctx.shadowBlur = 20; ctx.shadowColor = c.col;
        ctx.beginPath(); ctx.arc(c.x, c.y, cr, 0, TAU); ctx.fill();
        ctx.fillStyle = rgba(c.col, a * 0.6); ctx.beginPath(); ctx.arc(c.x, c.y, cr * 1.6, 0, TAU); ctx.fill();
      } else if (c.kind === 'pillar') {
        var h = lerp(20, 90, ease.outCubic(p)), w = 18 * (1 - p * 0.5);
        var g = ctx.createLinearGradient(c.x, c.y, c.x, c.y - h);
        g.addColorStop(0, rgba(c.col, a * 0.7)); g.addColorStop(1, rgba(c.col, 0));
        ctx.fillStyle = g; ctx.shadowBlur = 12; ctx.shadowColor = c.col;
        ctx.fillRect(c.x - w / 2, c.y - h, w, h);
      } else if (c.kind === 'muzzle') {
        var ml = lerp(28, 10, p);
        ctx.fillStyle = rgba(c.col, a * 0.85); ctx.shadowBlur = 12; ctx.shadowColor = c.col;
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.arc(c.x, c.y, ml, c.ang - 0.5, c.ang + 0.5); ctx.closePath(); ctx.fill();
      }
    }
    ctx.restore(); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }

  // persistent self-buff aura (app.js draws no buff aura — non-duplicative). Reads players[].buffs.
  function drawBuffAuras(ctx) {
    if (!lastState || !lastState.players) return;
    var ps = lastState.players, s = T / 1000;
    for (var i = 0; i < ps.length; i++) {
      var pl = ps[i];
      if (pl.dead || !pl.buffs || !pl.buffs.length) continue;
      var pulse = 0.55 + 0.45 * Math.sin(s * 4);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = rgba('#FFD700', 0.22 + 0.25 * pulse); ctx.lineWidth = 2; ctx.shadowBlur = 10; ctx.shadowColor = '#FFAA00';
      ctx.beginPath(); ctx.arc(pl.x, pl.y, 26 + 2 * pulse, 0, TAU); ctx.stroke();
      var motes = Math.min(6, 2 + pl.buffs.length);
      ctx.fillStyle = '#FFD700';
      for (var k = 0; k < motes; k++) { var a = s * 2 + k / motes * TAU; ctx.beginPath(); ctx.arc(pl.x + Math.cos(a) * 30, pl.y + Math.sin(a) * 30, 2.4, 0, TAU); ctx.fill(); }
      ctx.restore();
    }
    ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }

  // ───────────────────────────── downed allies / revive (state-driven) ─────────────────────────────
  // app.js draws the dead body translucent; here we add the ground marker, soul wisp,
  // revive countdown ring, respawn flash and invuln shimmer. Everything is derived from
  // players[].dead/reviving/reviveAt + snapshot.t (server clock) — no event wiring required.
  function reviveBurst(pid, x, y, champ) {
    if (reviveBurstAt[pid] && T - reviveBurstAt[pid] < 800) return; // dedupe (transition + event)
    reviveBurstAt[pid] = T;
    var cc = CLASS_COL[champ] || '#88CCFF';
    flash.a = Math.max(flash.a, 0.12); flash.col = '#CFE8FF';
    ring(x, y, { r0: 8, r1: 90, w0: 6, w1: 1, life: 0.5, col: cc, glow: 16, alpha: 0.9, ease: ease.outCirc });
    ring(x, y, { r0: 8, r1: 60, w0: 4, w1: 1, life: 0.4, col: '#FFFFFF', glow: 12, alpha: 0.8, ease: ease.outCirc });
    burst(x, y, 22, { a0: -Math.PI / 2, spread: 2.4, sp0: 70, sp1: 200, life: 0.8, r0: 5, r1: 0, col: cc, col2: '#FFFFFF', glow: 10, grav: -50, drag: 1.2 });
    castFx.push({ kind: 'pillar', x: x, y: y, t: 0, life: 0.5, col: cc });
  }
  function deathBurstAlly(x, y) {
    // ally death reads distinct from enemy death: cool blue collapse, no blood
    ring(x, y, { r0: 6, r1: 46, w0: 4, w1: 1, life: 0.4, col: '#5577AA', glow: 6, alpha: 0.6 });
    burst(x, y, 12, { sp0: 50, sp1: 130, life: 0.6, r0: 5, r1: 0, col: '#7FA8D8', col2: '#3A5A8A', glow: 6, drag: 1.6 });
  }
  function drawDownMarker(ctx, x, y, faded) {
    var s = T / 1000;
    ctx.save();
    ctx.globalAlpha = faded ? 0.35 : 0.6;
    ctx.strokeStyle = '#9AA6C0'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(x, y + 6, 20, 8, 0, 0, TAU); ctx.stroke();
    ctx.globalAlpha = faded ? 0.25 : 0.4;
    ctx.beginPath(); ctx.moveTo(x - 9, y - 3); ctx.lineTo(x + 9, y + 9); ctx.moveTo(x + 9, y - 3); ctx.lineTo(x - 9, y + 9); ctx.stroke();
    ctx.restore();
    // soul wisp rising (throttled so 4 corpses don't spam particles)
    var pidThrottleOk = true; // throttle handled by caller via wispAt; emit a faint one occasionally
    if (Math.sin(s * 3 + x) > 0.96) {
      var q = P(); q.x = x + rand(-8, 8); q.y = y; q.vx = rand(-6, 6); q.vy = rand(-26, -16);
      q.life = 1.0; q.r0 = 3; q.r1 = 0; q.col = '#BFE0FF'; q.glow = 8; q.drag = 0.6; q.a0 = 0.5;
    }
  }
  function drawReviveRing(ctx, x, y, frac, remainMs) {
    var imminent = remainMs >= 0 && remainMs < 1000;
    var blink = imminent ? (0.5 + 0.5 * Math.sin(T / 60)) : 1;
    var col = imminent ? mix('#88CCFF', '#FFD700', 0.5 + 0.5 * Math.sin(T / 80)) : '#88CCFF';
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    var R = 26;
    // track
    ctx.globalAlpha = 0.18; ctx.strokeStyle = '#88CCFF'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.stroke();
    // fill (0 -> 360 as revive approaches)
    ctx.globalAlpha = 0.85 * blink; ctx.strokeStyle = col; ctx.lineWidth = 3.5;
    ctx.shadowBlur = imminent ? 12 : 6; ctx.shadowColor = col;
    ctx.beginPath(); ctx.arc(x, y, R, -Math.PI / 2, -Math.PI / 2 + clamp(frac, 0, 1) * TAU); ctx.stroke();
    ctx.restore(); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }
  function drawInvulnShimmer(ctx, x, y) {
    var pulse = 0.5 + 0.5 * Math.sin(T / 90);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.18 + 0.18 * pulse; ctx.strokeStyle = '#CFE8FF'; ctx.lineWidth = 2; ctx.shadowBlur = 8; ctx.shadowColor = '#88CCFF';
    ctx.beginPath(); ctx.arc(x, y, 24 + 2 * pulse, 0, TAU); ctx.stroke();
    ctx.restore(); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
  }
  function drawPlayerStates(ctx) {
    if (!lastState || !lastState.players) return;
    var ps = lastState.players, srvT = lastState.t || 0, present = {};
    for (var i = 0; i < ps.length; i++) {
      var pl = ps[i]; present[pl.id] = 1;
      // transitions (only after we've established a baseline for this pid)
      var known = wasDead.hasOwnProperty(pl.id);
      if (known && !wasDead[pl.id] && pl.dead) deathBurstAlly(pl.x, pl.y);
      if (known && wasDead[pl.id] && !pl.dead) reviveBurst(pl.id, pl.x, pl.y, pl.champion);
      wasDead[pl.id] = !!pl.dead;
      if (pl.dead) {
        if (pl.reviving && pl.reviveAt > 0) {
          drawDownMarker(ctx, pl.x, pl.y, false);
          var tr = reviveTrack[pl.id];
          if (!tr || tr.end !== pl.reviveAt) tr = reviveTrack[pl.id] = { start: srvT, end: pl.reviveAt };
          var span = Math.max(1, tr.end - tr.start);
          var frac = clamp((srvT - tr.start) / span, 0, 1);
          drawReviveRing(ctx, pl.x, pl.y, frac, tr.end - srvT);
        } else {
          // solo / no-revive (reviveAt 0): plain down marker, no countdown
          drawDownMarker(ctx, pl.x, pl.y, true);
          if (reviveTrack[pl.id]) delete reviveTrack[pl.id];
        }
      } else {
        if (reviveTrack[pl.id]) delete reviveTrack[pl.id];
        if (pl.invuln) drawInvulnShimmer(ctx, pl.x, pl.y);
      }
    }
    for (var id in wasDead) if (!present[id]) { delete wasDead[id]; delete reviveTrack[id]; delete reviveBurstAt[id]; }
  }

  // ───────────────────────────── enemy / boss telegraphs (state-driven) ─────────────────────────────
  // Ground warning that reads BEFORE the hit lands. We draw the floor mark / charge
  // glow; the motion animator deforms the enemy body. Ramps with the windup phase
  // and snaps to a bright flash on strike. Needs latest snapshot via setState/render(state).
  function drawTelegraphs(ctx) {
    if (!lastState) return;
    var es = lastState.enemies || [], i, present = {};
    for (i = 0; i < es.length; i++) {
      var e = es[i];
      if (e.state !== 'windup' && e.state !== 'strike') continue;
      present[e.id] = 1;
      var aa = e.attackAnim || {};
      var wms = (aa.windup || 400);
      var w = windupMap[e.id];
      if (!w) w = windupMap[e.id] = { start: T };
      var inten = clamp((T - w.start) / wms, 0, 1);
      var ranged = aa.type === 'ranged';
      var aim = aa.aimAngle == null ? e.facing || 0 : aa.aimAngle;
      var pulse = 0.55 + 0.45 * Math.sin(T / 70);

      // one-shot strike flash (keyed per attack instance)
      var key = e.id + ':' + (aa.startedAt || 0);
      if (e.state === 'strike' && !strikeSeen[key]) {
        strikeSeen[key] = true;
        if (ranged) {
          burst(e.x, e.y, 8, { a0: aim, spread: 0.5, sp0: 120, sp1: 220, life: 0.3, r0: 3, r1: 0, col: COL.ENEMY_L, glow: 10, drag: 1.8 });
        } else {
          var rr = e.r + 34;
          ring(e.x, e.y, { r0: e.r * 0.5, r1: rr, w0: 6, w1: 1, life: 0.22, col: COL.ENEMY_L, glow: 12, alpha: 0.85, ease: ease.outCubic });
          burst(e.x + Math.cos(aim) * rr * 0.6, e.y + Math.sin(aim) * rr * 0.6, 7,
            { a0: aim, spread: 1.0, sp0: 100, sp1: 200, life: 0.28, r0: 3, r1: 0, col: COL.ENEMY_L, glow: 10, drag: 1.8 });
        }
      }

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      if (ranged) {
        // charging core + aim line
        var cb = 4 + inten * 16;
        ctx.shadowBlur = cb; ctx.shadowColor = COL.ENEMY_M;
        ctx.fillStyle = rgba(COL.ENEMY_L, 0.25 + 0.45 * inten);
        ctx.beginPath(); ctx.arc(e.x, e.y, 4 + inten * 7, 0, TAU); ctx.fill();
        ctx.strokeStyle = rgba(COL.ENEMY_M, 0.15 + 0.35 * inten * pulse);
        ctx.lineWidth = 2; ctx.setLineDash([6, 8]);
        ctx.beginPath(); ctx.moveTo(e.x, e.y);
        ctx.lineTo(e.x + Math.cos(aim) * 60, e.y + Math.sin(aim) * 60); ctx.stroke();
        ctx.setLineDash([]);
        // convergence sparks as it nears release
        if (inten > 0.6) burst(e.x + Math.cos(rand(0, TAU)) * 22, e.y + Math.sin(rand(0, TAU)) * 22, 1,
          { a0: 0, spread: TAU, sp0: 10, sp1: 30, life: 0.25, r0: 2, r1: 0, col: COL.ENEMY_L, glow: 6, drag: 2 });
      } else {
        // melee fan facing the locked aim — fills toward strike
        var arc = 1.25, reach = e.r + 30;
        var a0 = aim - arc / 2, a1 = aim + arc / 2;
        var g = ctx.createLinearGradient(e.x, e.y, e.x + Math.cos(aim) * reach, e.y + Math.sin(aim) * reach);
        g.addColorStop(0, rgba(COL.ENEMY_M, (0.10 + 0.40 * inten) * (0.7 + 0.3 * pulse)));
        g.addColorStop(1, rgba(COL.ENEMY_D, 0.02));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.moveTo(e.x, e.y);
        ctx.arc(e.x, e.y, reach, a0, a1); ctx.closePath(); ctx.fill();
        // leading rim brightens with intensity
        ctx.strokeStyle = rgba(COL.ENEMY_L, 0.25 + 0.55 * inten);
        ctx.lineWidth = 1 + 2 * inten; ctx.shadowBlur = 8; ctx.shadowColor = COL.ENEMY_M;
        ctx.beginPath(); ctx.arc(e.x, e.y, reach, a0, a1); ctx.stroke();
      }
      ctx.restore();
    }
    // boss ground telegraph
    if (lastState.boss && lastState.boss.telegraph) {
      var tg = lastState.boss.telegraph, bp = 0.55 + 0.45 * Math.sin(T / 60);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.shadowBlur = 14; ctx.shadowColor = COL.ENEMY_M;
      if (tg.shape === 'cone') {
        var ca = 0.42, b0 = tg.angle - ca, b1 = tg.angle + ca;
        var bg = ctx.createLinearGradient(tg.x, tg.y, tg.x + Math.cos(tg.angle) * tg.range, tg.y + Math.sin(tg.angle) * tg.range);
        bg.addColorStop(0, rgba('#FF2200', 0.30 * bp)); bg.addColorStop(1, rgba('#FF2200', 0.03));
        ctx.fillStyle = bg;
        ctx.beginPath(); ctx.moveTo(tg.x, tg.y); ctx.arc(tg.x, tg.y, tg.range, b0, b1); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = rgba(COL.ENEMY_L, 0.5 + 0.4 * bp); ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(tg.x, tg.y, tg.range, b0, b1); ctx.stroke();
      } else { // circle
        ctx.fillStyle = rgba('#FF2200', 0.16 * bp);
        ctx.beginPath(); ctx.arc(tg.x, tg.y, tg.range, 0, TAU); ctx.fill();
        ctx.strokeStyle = rgba(COL.ENEMY_M, 0.5 + 0.4 * bp); ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(tg.x, tg.y, tg.range, 0, TAU); ctx.stroke();
      }
      ctx.restore();
    }
    // prune stale windup ramps + strike keys
    for (var id in windupMap) { if (!present[id]) delete windupMap[id]; }
    if (es.length === 0) strikeSeen = {};
  }

  // ───────────────────────────── render (layer 5) ─────────────────────────────
  function drawParticle(ctx, p) {
    var t = p.t / p.life;
    var alpha = p.a0 * Math.pow(1 - t, p.fade);
    if (alpha <= 0.01) return;
    var rr = lerp(p.r0, p.r1, t);
    var col = p.col2 ? mix(p.col, p.col2, t) : p.col;
    ctx.globalAlpha = alpha;
    if (p.glow) { ctx.shadowBlur = p.glow; ctx.shadowColor = col; } else ctx.shadowBlur = 0;
    if (p.shape === 'dot') {
      ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.4, rr), 0, TAU); ctx.fill();
    } else if (p.shape === 'shard') {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = col;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    } else if (p.shape === 'tri') {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(0, -p.h / 2); ctx.lineTo(p.w / 2, p.h / 2); ctx.lineTo(-p.w / 2, p.h / 2); ctx.closePath(); ctx.fill(); ctx.restore();
    }
  }

  function render(ctx, now, state) {
    if (state) lastState = state;        // optional: pass snapshot straight to render()
    // If the host doesn't drive update() (e.g. only render() is wired), advance
    // the simulation here from wall-clock time. If update() was called this frame,
    // skip self-stepping so we never double-advance.
    var c = nowMs();
    if (!extUpdated) { step(lastClock ? (c - lastClock) / 1000 : 0.016); }
    extUpdated = false; lastClock = c;
    ctx.save();
    // enemy/boss windup telegraphs (under everything else so they read as ground)
    drawTelegraphs(ctx);
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    // persistent self-buff auras + skill cast flourishes (ground/origin, under particles).
    // (projectile bodies are drawn by app.js — Effects does not, to avoid double render.)
    drawPlayerStates(ctx);   // downed-ally marker / revive countdown / invuln shimmer
    drawBuffAuras(ctx);
    drawCastFx(ctx);
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    // expanding rings / shockwaves
    for (var r = 0; r < rings.length; r++) {
      var R = rings[r], pr = R.t / R.life, e = R.ease(pr);
      var rad = lerp(R.r0, R.r1, e), w = lerp(R.w0, R.w1, pr), al = R.a0 * (1 - pr);
      ctx.globalAlpha = al; ctx.shadowBlur = R.glow; ctx.shadowColor = R.col;
      ctx.beginPath(); ctx.arc(R.x, R.y, Math.max(0.5, rad), 0, TAU);
      if (R.fill) { ctx.fillStyle = rgba(R.col, al); ctx.fill(); }
      else { ctx.strokeStyle = R.col; ctx.lineWidth = Math.max(0.5, w); ctx.stroke(); }
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    // slash arcs
    for (var a = 0; a < arcs.length; a++) drawArc(ctx, arcs[a]);
    // particles
    for (var i = 0; i < parts.length; i++) drawParticle(ctx, parts[i]);
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    // orb arc flight render
    ctx.save();
    for (var oi = 0; oi < orbTrails.length; oi++) {
      var ob = orbTrails[oi];
      // cancelling: 80ms 내 fade-out (alpha 1→0)
      var orbAlpha = 1.0;
      if (ob.cancelling) {
        var cancelElapsed = T - ob.cancelStart;
        orbAlpha = Math.max(0, 1 - cancelElapsed / 80);
      }
      var otp = Math.min(1, ob.t / ob.life);
      var obx = (1-otp)*(1-otp)*ob.sx + 2*(1-otp)*otp*ob.cx + otp*otp*ob.tx;
      var oby = (1-otp)*(1-otp)*ob.sy + 2*(1-otp)*otp*ob.cy + otp*otp*ob.ty;
      // 잔상 trail
      for (var tj = 0; tj < ob.trail.length; tj++) {
        var trAlpha = Math.max(0, (0.55 - ob.trail[tj].age * 2.2) * orbAlpha);
        if (trAlpha < 0.01) continue;
        ctx.globalAlpha = trAlpha;
        ctx.shadowBlur = 7; ctx.shadowColor = '#BB77FF';
        ctx.fillStyle = '#BB77FF';
        ctx.beginPath(); ctx.arc(ob.trail[tj].x, ob.trail[tj].y, 2.5, 0, TAU); ctx.fill();
      }
      // 오브 본체
      ctx.globalAlpha = orbAlpha;
      ctx.shadowBlur = 18; ctx.shadowColor = '#CC88FF';
      ctx.fillStyle = '#EE99FF';
      ctx.beginPath(); ctx.arc(obx, oby, 5.5, 0, TAU); ctx.fill();
      ctx.shadowBlur = 8; ctx.shadowColor = '#FFFFFF';
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath(); ctx.arc(obx, oby, 2.5, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    ctx.restore();
    // chain lightning (bright, drawn over particles)
    drawLightning(ctx);
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    // ongoing status auras — live state first (follows enemy), else timed fallback
    if (lastState && lastState.enemies) {
      var es = lastState.enemies;
      for (var k = 0; k < es.length; k++) {
        var en = es[k];
        if (en.burn) drawStatusAura(ctx, en.x, en.y, en.r, 'burn', T);
        if (en.poison) drawStatusAura(ctx, en.x, en.y, en.r, 'poison', T);
        if (en.frozen) drawStatusAura(ctx, en.x, en.y, en.r, 'freeze', T);
      }
    } else {
      for (var u = 0; u < auras.length; u++) {
        var au = auras[u]; var e2 = au.target != null ? enemyById(au.target) : null;
        var ax = e2 ? e2.x : au.x, ay = e2 ? e2.y : au.y, ar = e2 ? e2.r : au.r;
        drawStatusAura(ctx, ax, ay, ar, au.kind, T);
      }
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    // fullscreen flash (boss/giant)
    if (flash.a > 0.01) { ctx.fillStyle = rgba(flash.col, flash.a); ctx.fillRect(0, 0, 1280, 720); }
    // player-hit red vignette pulse — oversized so host shake offset never reveals an edge gap
    if (hitVig > 0.01) {
      var ic = ease.outCubic(clamp(hitVig, 0, 1));
      var rg = ctx.createRadialGradient(640, 360, 280, 640, 360, 760);
      rg.addColorStop(0, 'rgba(255,40,40,0)');
      rg.addColorStop(0.7, rgba('#FF2A2A', 0.06 * ic));
      rg.addColorStop(1, rgba('#CC0000', 0.55 * ic));
      ctx.fillStyle = rg; ctx.fillRect(-24, -24, 1328, 768);
    }
    // boss banner
    for (var bn = 0; bn < banners.length; bn++) {
      var B = banners[bn], bp = B.t / B.life, ba = bp > 0.7 ? (1 - bp) / 0.3 : Math.min(1, bp / 0.1);
      ctx.globalAlpha = clamp(ba, 0, 1);
      ctx.font = 'bold ' + B.size + 'px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.shadowBlur = 20; ctx.shadowColor = B.col; ctx.fillStyle = B.col;
      ctx.fillText(B.text, 640, 360);
    }
    ctx.restore();
  }

  // ───────────────────────────── render damage numbers (layer 6) ─────────────────────────────
  function renderDamageNumbers(ctx) {
    ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (var i = 0; i < dmgs.length; i++) {
      var n = dmgs[i], t = n.t / n.life;
      var alpha = t < 0.6 ? 1 : (1 - (t - 0.6) / 0.4);
      ctx.globalAlpha = clamp(alpha, 0, 1);
      var col, size, glow;
      if (n.kind === 'crit') { col = COL.CRIT; size = 20 * lerp(1.3, 1.0, n.pop); glow = 6; }
      else if (n.kind === 'ally') { col = COL.ENEMY_M; size = 14; glow = 0; }
      else if (n.kind === 'heal') { col = COL.HEAL; size = 14; glow = 4; }
      else { col = COL.WHITE; size = 14; glow = 0; }
      ctx.font = 'bold ' + size + 'px Arial';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = glow; ctx.shadowColor = col;
      ctx.strokeText(n.text, n.x, n.y);
      ctx.fillStyle = col; ctx.fillText(n.text, n.x, n.y);
      ctx.shadowBlur = 0;
    }
    ctx.restore();
  }

  // ───────────────────────────── accessors / lifecycle ─────────────────────────────
  function getScreenShake() {
    if (trauma <= 0) return { x: 0, y: 0 };
    var amt = trauma * trauma, max = 14;
    return { x: (Math.random() * 2 - 1) * max * amt, y: (Math.random() * 2 - 1) * max * amt };
  }
  function getHitStop() { return hitStopMs; }
  function setState(s) { lastState = s || null; }
  function ingest(events, state) {
    if (state) lastState = state;
    if (events && events.length) for (var i = 0; i < events.length; i++) {
      var ev = events[i]; if (ev && ev.type) spawn(ev.type, ev);
    }
  }
  function reset() {
    while (parts.length) pool.push(parts.pop());
    rings.length = 0; arcs.length = 0; auras.length = 0; dmgs.length = 0; banners.length = 0;
    trauma = 0; hitStopMs = 0; flash.a = 0; lastState = null; projTrails = {};
    windupMap = {}; strikeSeen = {}; hitVig = 0;
    castFx.length = 0; lightning.length = 0; dashTrails.length = 0; orbTrails.length = 0;
    reviveTrack = {}; wasDead = {}; reviveBurstAt = {}; wispAt = {};
  }

  window.Effects = {
    init: function () { /* no-op; lazy */ },
    spawn: spawn,
    ingest: ingest,
    setState: setState,
    update: update,
    render: render,
    renderDamageNumbers: renderDamageNumbers,
    getScreenShake: getScreenShake,
    getHitStop: getHitStop,
    getHitVignette: function () { return hitVig; },
    reset: reset,
    _stats: function () { return { parts: parts.length, rings: rings.length, arcs: arcs.length, dmgs: dmgs.length, castFx: castFx.length, lightning: lightning.length, dashTrails: dashTrails.length, orbTrails: orbTrails.length, pool: pool.length }; }
  };
})();
