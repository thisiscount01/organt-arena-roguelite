/*
 * enemyMotion.js — 적 공격 모션 상태머신 (owner: 모션 애니메이터)
 * window.EnemyMotion.drawEnemy(ctx, e, now, opts) 단일 진입점. (champMotion.js와 대칭)
 *
 * 계약(server.js owner + 프론트 owner와 합의):
 *  - app.js가 z-order 레이어2에서 호출. ctx는 카메라/쉐이크 적용 완료, e.x/e.y는 월드 좌표.
 *  - e.state: 'move'|'windup'|'strike'|'recover'|'charge'
 *  - e.attackAnim: null | { type:'melee'|'ranged'|'boss_charge'|'boss_shock'|'boss_spread',
 *        startedAt(서버ms), windup(ms), strike(ms, startedAt기준 타격 절대오프셋, ≥windup),
 *        duration(ms, 전체), aimAngle(rad, startedAt에 확정·strike까지 불변) }
 *  - 진행도(서버 권위): t = now - startedAt (ms). 데미지/투사체는 서버가 strike 시점에만 발생.
 *  - 모션 타격 프레임(strike)이 서버 strike와 일치하도록 same 타임라인으로 보간.
 *  - 역할 경계: 나=적 본체/무기 변형(움츠림·돌진·차징·내려치기) + 본체 텔레그래프(외곽 경고).
 *    VFX=바닥 예고 링/입자(별 레이어). 본 모듈은 바닥 링을 그리지 않는다.
 *  - 본체 외형은 design-spec 2장 기준(app.js 폴백과 동일 룩) + 모션 레이어.
 */
(function () {
  'use strict';
  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = {
    outQuad: t => 1 - (1 - t) * (1 - t),
    inQuad: t => t * t,
    outBack: t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    outCirc: t => Math.sqrt(1 - Math.pow(t - 1, 2)),
    inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  };
  function dot(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
  function tri(ctx, ax, ay, bx, by, cx, cy) { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill(); }
  function ball(ctx, x, y, r, hi, c) {
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
    g.addColorStop(0, hi); g.addColorStop(1, c);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  function eyes(ctx, lx, ly, gap, r) {
    ctx.fillStyle = '#fff'; dot(ctx, lx, ly, r); dot(ctx, lx + gap, ly, r);
    ctx.fillStyle = '#111'; dot(ctx, lx, ly, r * 0.5); dot(ctx, lx + gap, ly, r * 0.5);
  }
  function wing(ctx, dir, r) {
    ctx.beginPath(); ctx.moveTo(dir * r * 0.5, 0);
    ctx.quadraticCurveTo(dir * r * 1.9, -r * 0.7, dir * r * 1.4, r * 0.5);
    ctx.quadraticCurveTo(dir * r * 1.1, r * 0.1, dir * r * 0.5, 0); ctx.fill();
  }

  const META = {
    slime:      { c: '#44CC44', hi: '#88FF88', dk: '#228822' },
    goblin:     { c: '#CC9933', hi: '#E6C266', dk: '#883322' },
    bat:        { c: '#6633AA', hi: '#9966DD', dk: '#44228A' },
    skeleton:   { c: '#E8E8D0', hi: '#FFFFFF', dk: '#9A9A82', eye: '#FF3030' },
    slinger:    { c: '#9A845C', hi: '#C8B488', dk: '#5E4F34', eye: '#FFDD44' },
    orc:        { c: '#4A7A4A', hi: '#6FA86F', dk: '#2E4E2E' },
    splitslime: { c: '#3FB6C8', hi: '#88EEFF', dk: '#1E6E7E' },
    darkmage:   { c: '#3A1366', hi: '#9B00FF', dk: '#1A0833', eye: '#FF44FF' },
    healerimp:  { c: '#5ED98C', hi: '#AFFFD0', dk: '#2E8A55' },
    shieldorc:  { c: '#5A6A7A', hi: '#8497A8', dk: '#36424E' },
    giant:      { c: '#CC4400', hi: '#FF8844', dk: '#7A2800', fuse: '#FFD700' },
    boss:       { c: '#880000', hi: '#FF4444', dk: '#440000' },
  };
  const ELITE_TINT = { swift: '#FFE24A', steel: '#7FB4FF', thorn: '#FF5C5C', elite: '#FFD700' };
  function BOSS_THEME(wave) {
    if (wave >= 20) return { body: 'hue', edge: '#FFFFFF' };
    if (wave >= 15) return { body: '#005500', edge: '#44FF88' };
    if (wave >= 10) return { body: '#000088', edge: '#44AAFF' };
    return { body: '#880000', edge: '#FFD700' };
  }
  // 원거리 차징 색
  const CHARGE_COL = { skeleton: '#FFD0D0', slinger: '#D8C088', darkmage: '#CC66FF', healerimp: '#AFFFD0', boss: '#FF88AA' };

  // ───────────── 모션 파라미터 계산(서버 attackAnim 타임라인) ─────────────
  // 반환: off(아임 방향 +전진/-후퇴 px), sx/sy(스쿼시), wpn(-1 준비~+1 타격), glow(0~1 텔레그래프),
  //       charge(0~1 원거리 응집), aim(rad), type
  function motionOf(e, now) {
    const a = e.attackAnim;
    const aimDefault = (e.facing != null) ? e.facing : 0;
    if (!a) return { off: 0, sx: 1, sy: 1, wpn: 0, glow: 0, charge: 0, aim: aimDefault, type: null };
    const dur = Math.max(1, a.duration), w = Math.max(1, Math.min(a.windup, dur - 1));
    const t = clamp(now - a.startedAt, 0, dur);
    const aim = (a.aimAngle != null) ? a.aimAngle : aimDefault;
    const type = a.type;
    let off = 0, sx = 1, sy = 1, wpn = 0, glow = 0, charge = 0;

    if (t < w) {
      // ── windup(앤티시페이션) ──
      const wp = ease.outQuad(t / w);
      glow = wp;
      if (type === 'melee' || type === 'boss_charge') { off = -lerp(0, type === 'boss_charge' ? 10 : 7, wp); sx = 1 + 0.10 * wp; sy = 1 - 0.12 * wp; wpn = -wp; }
      else if (type === 'ranged') { off = -lerp(0, 3, wp); charge = wp; sy = 1 + 0.05 * wp; }
      else if (type === 'boss_shock') { sx = sy = 1 + 0.18 * wp; }
      else if (type === 'boss_spread') { off = -lerp(0, 6, wp); sy = 1 + 0.08 * wp; charge = wp; }
      else { off = -lerp(0, 6, wp); wpn = -wp; }
    } else {
      // ── strike→recover(타격·팔로스루) ──
      const ap = (t - w) / Math.max(1, dur - w);     // 0..1
      const st = ap < 0.30 ? ease.outQuad(ap / 0.30) : 1;            // 타격 도달
      const settle = ap < 0.30 ? 0 : ease.outBack((ap - 0.30) / 0.70); // 복귀(살짝 오버슈트)
      glow = clamp(0.6 - ap * 0.9, 0, 0.6);
      if (type === 'melee') {
        off = lerp(lerp(-7, 13, st), 0, settle);
        sx = lerp(lerp(1.10, 0.90, st), 1, settle); sy = lerp(lerp(0.88, 1.16, st), 1, settle);
        wpn = lerp(lerp(-1, 1, st), 0, settle);
      } else if (type === 'boss_charge') {
        off = lerp(lerp(-10, 28, st), 0, settle * 0.85);
        sx = lerp(lerp(1.12, 0.88, st), 1, settle); sy = lerp(lerp(0.86, 1.18, st), 1, settle);
        wpn = lerp(lerp(-1, 1, st), 0, settle);
      } else if (type === 'ranged') {
        off = -lerp(9, 0, ease.outCirc(Math.min(ap / 0.6, 1)));      // 반동 후퇴
        charge = clamp(1 - ap * 2.2, 0, 1);
      } else if (type === 'boss_shock') {
        const burst = ap < 0.22 ? ease.outQuad(ap / 0.22) : 1;
        sx = sy = ap < 0.22 ? lerp(1.18, 1.38, burst) : lerp(1.38, 1.0, ease.outBack(Math.min((ap - 0.22) / 0.78, 1)));
      } else if (type === 'boss_spread') {
        off = -lerp(10, 0, ease.outCirc(Math.min(ap / 0.5, 1)));
        charge = clamp(1 - ap * 2.5, 0, 1);
      } else {
        off = lerp(10, 0, settle || st); wpn = lerp(lerp(-1, 1, st), 0, settle);
      }
    }
    return { off, sx, sy, wpn, glow, charge, aim, type };
  }

  // ───────────── 진입점 ─────────────
  function drawEnemy(ctx, e, now, opts) {
    opts = opts || {};
    const m = META[e.type] || META.slime;
    const r = e.r || 16;
    const mo = motionOf(e, now);
    const ox = Math.cos(mo.aim) * mo.off, oy = Math.sin(mo.aim) * mo.off;
    const tilt = clamp((e.vx || 0) / 160, -1, 1) * (e.type === 'goblin' ? 0.26 : 0.17);

    // 본체 텔레그래프(외곽 경고) — 바닥 링은 VFX 담당, 여기선 본체 외곽만.
    if (mo.glow > 0.02 && !e.dead) {
      ctx.save(); ctx.translate(e.x, e.y);
      const warn = mo.type === 'ranged' || mo.type === 'boss_spread' ? '#FF8844' : '#FF3030';
      ctx.globalAlpha = 0.30 + 0.45 * mo.glow;
      ctx.strokeStyle = warn; ctx.lineWidth = 2 + 2 * mo.glow; ctx.shadowColor = warn; ctx.shadowBlur = 8 + 10 * mo.glow;
      ctx.beginPath(); ctx.arc(0, 0, r + 4 + 3 * mo.glow, 0, TAU); ctx.stroke();
      // 타격 방향 셰브론(근접)
      if (mo.type === 'melee' || mo.type === 'boss_charge') {
        ctx.rotate(mo.aim); ctx.globalAlpha = 0.5 + 0.5 * mo.glow; ctx.fillStyle = warn;
        const d = r + 10 + 6 * mo.glow; tri(ctx, d, -5, d, 5, d + 8, 0);
      }
      ctx.restore();
    }

    ctx.save();
    ctx.translate(e.x + ox, e.y + oy);
    if (e.dead) ctx.globalAlpha = 0.3;

    // 엘리트 오라
    if (e.elite) {
      ctx.save();
      ctx.shadowColor = ELITE_TINT[e.elite] || '#fff'; ctx.shadowBlur = 16;
      ctx.strokeStyle = ELITE_TINT[e.elite] || '#fff'; ctx.lineWidth = 2; ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.arc(0, 0, r + 4, 0, TAU); ctx.stroke();
      ctx.restore();
    }

    ctx.rotate(tilt);
    ctx.save();
    ctx.scale(mo.sx, mo.sy);                          // 모션 스쿼시(본체 자체 idle 스쿼시와 합성)
    (BODY[e.type] || BODY.slime)(ctx, e, m, now, r);
    ctx.restore();

    // 무기/차징 오버레이(아임 기준)
    drawWeapon(ctx, e, m, r, mo, now);

    ctx.restore();

    // 피격 플래시
    if (e.flash) {
      ctx.save(); ctx.translate(e.x + ox, e.y + oy); ctx.globalAlpha = 0.7;
      ctx.fillStyle = '#FFFFFF'; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.restore();
    }
    // 빙결
    if (e.frozen) {
      ctx.save(); ctx.translate(e.x + ox, e.y + oy); ctx.fillStyle = 'rgba(136,204,255,0.35)';
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.restore();
    }
    // 체력바(보스는 상단 전용바라 생략)
    drawHp(ctx, e, r);
  }

  function drawHp(ctx, e, r) {
    if (e.boss) return;
    if (e.hp == null || e.maxHp == null || e.hp >= e.maxHp) return;
    const w = r * 2.2, h = 4, x = e.x - w / 2, y = e.y - r - 9;
    ctx.fillStyle = '#222'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#FF4444'; ctx.fillRect(x, y, w * clamp(e.hp / e.maxHp, 0, 1), h);
  }

  // ───────────── 무기/차징 오버레이 ─────────────
  function drawWeapon(ctx, e, m, r, mo, now) {
    const wpn = mo.wpn;
    if (e.type === 'goblin') {
      // 몽둥이 내려치기: wpn -1(치켜듦)→+1(타격)
      ctx.save(); ctx.rotate(mo.aim);
      const sw = lerp(-0.9, 0.7, (wpn + 1) / 2);
      ctx.rotate(sw);
      ctx.strokeStyle = '#8B4513'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(r * 0.5, 0); ctx.lineTo(r * 1.5, 0); ctx.stroke();
      ctx.fillStyle = '#A0522D'; dot(ctx, r * 1.5, 0, 4);
      ctx.restore();
    } else if (e.type === 'orc' || e.type === 'shieldorc') {
      // 도끼 오버헤드 찍기
      ctx.save(); ctx.rotate(mo.aim);
      const sw = lerp(-1.0, 0.6, (wpn + 1) / 2);
      ctx.rotate(sw);
      ctx.strokeStyle = '#888'; ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(r * 0.6, 0); ctx.lineTo(r * 1.5, 0); ctx.stroke();
      ctx.fillStyle = '#aaa'; tri(ctx, r * 1.45, -8, r * 1.75, 0, r * 1.45, 8);
      ctx.restore();
    }
    // 원거리 차징 구(아임 방향 본체 앞)
    if (mo.charge > 0.02) {
      const col = CHARGE_COL[e.type] || CHARGE_COL.darkmage;
      ctx.save(); ctx.rotate(mo.aim);
      ctx.shadowColor = col; ctx.shadowBlur = 8 + 12 * mo.charge;
      ctx.globalAlpha = 0.55 + 0.45 * mo.charge; ctx.fillStyle = col;
      dot(ctx, r + 6, 0, 3 + 7 * mo.charge);
      // 응집 광선
      ctx.globalAlpha = 0.5 * mo.charge; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) { const a = now * 0.01 + i / 4 * TAU; const rr = 8 + 8 * mo.charge; ctx.beginPath(); ctx.moveTo(r + 6 + Math.cos(a) * rr, Math.sin(a) * rr); ctx.lineTo(r + 6, 0); ctx.stroke(); }
      ctx.restore();
    }
  }

  // ───────────── 적 본체(12종, design-spec 2장 룩) ─────────────
  const BODY = {
    slime(ctx, e, m, now, r) {
      const sq = 0.85 + 0.12 * Math.sin(now * 0.006 + e.id);
      ctx.save(); ctx.scale(1, sq);
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r);
      g.addColorStop(0, m.hi); g.addColorStop(1, (e.hp / e.maxHp < 0.3) ? '#668844' : m.c);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
      ctx.restore();
      eyes(ctx, -r * 0.32, -r * 0.18, r * 0.32, r * 0.25);
    },
    goblin(ctx, e, m, now, r) {
      ctx.fillStyle = m.c;
      tri(ctx, -r * 0.7, -r * 1.1, -r * 0.2, -r * 0.5, -r * 1.0, -r * 0.4);
      tri(ctx, r * 0.7, -r * 1.1, r * 0.2, -r * 0.5, r * 1.0, -r * 0.4);
      ball(ctx, 0, 0, r, m.hi, m.c);
      ctx.fillStyle = '#fff'; tri(ctx, -r * 0.25, r * 0.45, -r * 0.05, r * 0.45, -r * 0.15, r * 0.78);
      tri(ctx, r * 0.25, r * 0.45, r * 0.05, r * 0.45, r * 0.15, r * 0.78);
      ctx.fillStyle = '#FFFF00'; dot(ctx, -r * 0.32, -r * 0.1, r * 0.16); dot(ctx, r * 0.32, -r * 0.1, r * 0.16);
    },
    bat(ctx, e, m, now, r) {
      const flap = Math.sin(now * 0.02 + e.id);
      ctx.fillStyle = m.dk;
      ctx.save(); ctx.scale(1, 0.6 + 0.5 * Math.abs(flap)); wing(ctx, -1, r); wing(ctx, 1, r); ctx.restore();
      ball(ctx, 0, 0, r, m.hi, m.c);
      ctx.fillStyle = '#FF0000'; dot(ctx, -r * 0.3, -r * 0.1, r * 0.18); dot(ctx, r * 0.3, -r * 0.1, r * 0.18);
    },
    skeleton(ctx, e, m, now, r) {
      ball(ctx, 0, -r * 0.1, r * 0.92, m.hi, m.c);
      ctx.fillStyle = m.dk; ctx.beginPath(); ctx.arc(0, r * 0.35, r * 0.55, 0, Math.PI); ctx.fill();
      const charging = e.state === 'windup' || e.state === 'charge';
      ctx.save(); ctx.shadowColor = m.eye; ctx.shadowBlur = charging ? 16 : 6; ctx.fillStyle = m.eye;
      dot(ctx, -r * 0.32, -r * 0.15, r * 0.2); dot(ctx, r * 0.32, -r * 0.15, r * 0.2); ctx.restore();
      ctx.strokeStyle = m.c; ctx.lineWidth = 2;
      for (let i = 0; i < 3; i++) { const y = r * 0.55 + i * 5; ctx.beginPath(); ctx.moveTo(-r * 0.4, y); ctx.lineTo(r * 0.4, y); ctx.stroke(); }
    },
    slinger(ctx, e, m, now, r) {
      ctx.fillStyle = m.dk; ctx.beginPath(); ctx.arc(0, 0, r * 1.05, Math.PI * 0.1, Math.PI * 0.9); ctx.fill();
      ball(ctx, 0, 0, r, m.hi, m.c);
      ctx.fillStyle = m.eye; dot(ctx, -r * 0.3, -r * 0.05, r * 0.15); dot(ctx, r * 0.3, -r * 0.05, r * 0.15);
      ctx.strokeStyle = '#5E4F34'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
      const sw = Math.sin(now * 0.02 + e.id) * 0.5;
      ctx.beginPath(); ctx.moveTo(r * 0.7, 0); ctx.lineTo(r * 1.3, r * (0.4 + sw)); ctx.stroke();
      ctx.fillStyle = '#777'; dot(ctx, r * 1.3, r * (0.4 + sw), 3);
    },
    orc(ctx, e, m, now, r) {
      const bnc = 1 + 0.04 * Math.sin(now * 0.005 + e.id);
      ctx.save(); ctx.scale(1.12, bnc);
      ctx.fillStyle = m.dk; ball(ctx, -r * 0.85, -r * 0.3, r * 0.5, m.dk, m.dk); ball(ctx, r * 0.85, -r * 0.3, r * 0.5, m.dk, m.dk);
      ball(ctx, 0, 0, r, m.hi, m.c);
      ctx.restore();
      ctx.fillStyle = '#fff'; tri(ctx, -r * 0.28, r * 0.4, -r * 0.1, r * 0.4, -r * 0.2, r * 0.72);
      tri(ctx, r * 0.28, r * 0.4, r * 0.1, r * 0.4, r * 0.2, r * 0.72);
      ctx.fillStyle = '#FFEE66'; dot(ctx, -r * 0.3, -r * 0.1, r * 0.14); dot(ctx, r * 0.3, -r * 0.1, r * 0.14);
    },
    splitslime(ctx, e, m, now, r) {
      const sq = 0.85 + 0.14 * Math.sin(now * 0.008 + e.id);
      ctx.save(); ctx.scale(1, sq);
      ball(ctx, 0, 0, r, m.hi, m.c);
      ctx.strokeStyle = m.dk; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, -r * 0.7); ctx.lineTo(0, r * 0.7); ctx.moveTo(-r * 0.6, 0); ctx.lineTo(r * 0.6, 0); ctx.stroke();
      ctx.restore();
      eyes(ctx, -r * 0.3, -r * 0.18, r * 0.3, r * 0.22);
    },
    darkmage(ctx, e, m, now, r) {
      ctx.fillStyle = m.dk; tri(ctx, -r, -r * 0.2, -r * 0.3, -r * 0.6, -r * 0.3, r * 0.2);
      tri(ctx, r, -r * 0.2, r * 0.3, -r * 0.6, r * 0.3, r * 0.2);
      ctx.beginPath(); ctx.moveTo(-r * 0.7, r * 0.3); ctx.lineTo(0, r * 1.3); ctx.lineTo(r * 0.7, r * 0.3); ctx.closePath(); ctx.fill();
      ball(ctx, 0, 0, r, m.hi, m.c);
      ctx.fillStyle = m.dk; tri(ctx, 0, -r * 1.5, -r * 0.7, -r * 0.6, r * 0.7, -r * 0.6);
      const charging = e.state === 'windup' || e.state === 'charge';
      ctx.save(); ctx.shadowColor = m.eye; ctx.shadowBlur = charging ? 16 : 10; ctx.fillStyle = m.eye;
      dot(ctx, -r * 0.3, -r * 0.05, r * 0.16); dot(ctx, r * 0.3, -r * 0.05, r * 0.16); ctx.restore();
    },
    healerimp(ctx, e, m, now, r) {
      ball(ctx, 0, 0, r, m.hi, m.c);
      ctx.fillStyle = m.dk; tri(ctx, -r * 0.5, -r * 0.8, -r * 0.2, -r * 0.5, -r * 0.7, -r * 0.4);
      tri(ctx, r * 0.5, -r * 0.8, r * 0.2, -r * 0.5, r * 0.7, -r * 0.4);
      ctx.fillStyle = '#fff'; dot(ctx, -r * 0.3, -r * 0.1, r * 0.14); dot(ctx, r * 0.3, -r * 0.1, r * 0.14);
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.006 + e.id);
      ctx.save(); ctx.globalAlpha = 0.5 + 0.4 * pulse; ctx.fillStyle = '#AFFFD0';
      ctx.fillRect(-2, -r - 12, 4, 9); ctx.fillRect(-5, -r - 9, 10, 4); ctx.restore();
    },
    shieldorc(ctx, e, m, now, r) {
      ctx.save(); ctx.scale(1.1, 1); ball(ctx, 0, 0, r, m.hi, m.c); ctx.restore();
      ctx.fillStyle = '#fff'; tri(ctx, -r * 0.26, r * 0.4, -r * 0.08, r * 0.4, -r * 0.18, r * 0.68);
      tri(ctx, r * 0.26, r * 0.4, r * 0.08, r * 0.4, r * 0.18, r * 0.68);
      ctx.fillStyle = '#FFEE66'; dot(ctx, -r * 0.28, -r * 0.1, r * 0.13); dot(ctx, r * 0.28, -r * 0.1, r * 0.13);
      ctx.save(); ctx.rotate(e.facing || 0);
      const g = ctx.createLinearGradient(r * 0.6, 0, r * 1.3, 0); g.addColorStop(0, '#9bb0c5'); g.addColorStop(1, '#5a6a7a');
      ctx.fillStyle = g; ctx.strokeStyle = '#cdddee'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.ellipse(r * 1.05, 0, r * 0.34, r * 0.95, 0, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.restore();
    },
    giant(ctx, e, m, now, r) {
      ctx.fillStyle = m.c; ctx.beginPath();
      for (let i = 0; i <= 16; i++) { const a = i / 16 * TAU; const rr = r * (1 + 0.06 * (i % 2 ? 1 : -1)); const px = Math.cos(a) * rr, py = Math.sin(a) * rr; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = m.hi; ctx.lineWidth = 2; ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.moveTo(-r * 0.5, -r * 0.3); ctx.lineTo(0, 0); ctx.lineTo(-r * 0.2, r * 0.5); ctx.moveTo(0, 0); ctx.lineTo(r * 0.5, r * 0.2); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#FFFF00'; dot(ctx, -r * 0.28, -r * 0.1, r * 0.13); dot(ctx, r * 0.28, -r * 0.1, r * 0.13);
      const flick = 0.8 + 0.4 * Math.sin(now * 0.03);
      ctx.strokeStyle = m.fuse; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(0, -r - 12 * flick); ctx.stroke();
      ctx.save(); ctx.shadowColor = '#FF8800'; ctx.shadowBlur = 10; ctx.fillStyle = '#FFCC00'; dot(ctx, 0, -r - 12 * flick, 3); ctx.restore();
    },
    boss(ctx, e, m, now, r) {
      const theme = BOSS_THEME(e._wave || e.wave || 5);
      let body = theme.body;
      if (body === 'hue') { const h = (now * 0.06) % 360; body = 'hsl(' + h + ',70%,45%)'; }
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r);
      g.addColorStop(0, '#ffffff44'); g.addColorStop(0.3, body); g.addColorStop(1, '#000000aa');
      ctx.fillStyle = g; ctx.strokeStyle = theme.edge; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#FFD700';
      for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + (i - 2) * 0.42; const cx = Math.cos(a) * r * 0.7, cy = Math.sin(a) * r * 0.7 - r * 0.55; tri(ctx, cx - 5, cy + 7, cx + 5, cy + 7, cx, cy - 7); }
      ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 2; ctx.beginPath();
      for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * (TAU * 2 / 5); const px = Math.cos(a) * r * 0.5, py = Math.sin(a) * r * 0.5; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
      ctx.closePath(); ctx.stroke();
      ctx.save(); ctx.shadowColor = '#CC44FF'; ctx.shadowBlur = 14; ctx.fillStyle = '#E0B0FF';
      dot(ctx, -r * 0.32, 0, r * 0.16); dot(ctx, r * 0.32, 0, r * 0.16); ctx.restore();
    },
  };

  function init() { /* lazy 자원 없음 */ }
  window.EnemyMotion = { drawEnemy, init };
})();
