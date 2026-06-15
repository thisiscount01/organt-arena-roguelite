/*
 * champMotion.js — 챔피언 모션 상태머신 (owner: 모션 애니메이터)
 * window.ChampMotion.drawChampion(ctx, p, now, opts) 단일 진입점.
 *
 * 계약(프론트 owner와 합의):
 *  - app.js가 z-order 레이어3에서 호출. ctx는 카메라/쉐이크 적용 완료, p.x/p.y는 월드=화면 좌표.
 *  - p: { champion, x, y, facing(rad=조준각), tier:1|2|3, level, hp, maxHp, dead, invuln,
 *         attackAnim:{ type:'swing'|'cast'|'shoot'|'dash', startedAt(ms), aimAngle(rad), duration(s) } | null }
 *  - now: 클라 추정 서버시간(ms). opts: { isSelf, color(직업색) }
 *  - 서버 권위: 진행도 prog = (now-startedAt)/(duration*1000). 자체 타이머 없음(순수 함수).
 *  - 공격 모션 기준각 = attackAnim.aimAngle(= 서버 부채꼴 판정 방향). 평상시 회전 = p.facing.
 *  - 안전장치: prog>=1 또는 attackAnim=null 이면 아이들로 렌더(무기 튐 방지).
 *  - 본 모듈은 본체+무기+조준회전+공격모션+Tier1~3 치장 + HP/이름/별 라벨까지 그린다(폴백과 동일 책임).
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

  // ── 캔버스 프리미티브(자체 정의: app.js보다 먼저 로드되므로 의존 불가) ──
  function dot(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
  function tri(ctx, ax, ay, bx, by, cx, cy) { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill(); }
  function ball(ctx, x, y, r, hi, c) {
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
    g.addColorStop(0, hi); g.addColorStop(1, c);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  function star(ctx, x, y, r, inner) {
    inner = inner || 0.45;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r * inner : r;
      const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }
  function rrect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ── 직업 색/치수 메타 ──
  const META = {
    warrior:  { name: '전사', body: '#2C4A7C', accent: '#4A7FBF', r: 22, aura: '#4A90E2' },
    mage:     { name: '마법사', body: '#4A1080', accent: '#8B44CC', r: 18, aura: '#9B59B6' },
    archer:   { name: '궁수', body: '#2E7D32', accent: '#4CAF50', r: 18, aura: '#27AE60' },
    assassin: { name: '암살자', body: '#2D1B4E', accent: '#7B3FA0', r: 16, aura: '#E91E63' },
  };

  // 무기 색 (Tier별)
  const SWORD = ['#9E9E9E', '#5BA3F5', '#FFD700'];
  const DAGGER = ['#708090', '#CC44FF', '#FF00CC'];
  const BOW = ['#8D6E63', '#4CAF50', '#00E5FF'];
  const ORB = ['#9B59B6', '#CC44FF', '#FFFFFF'];

  // 스윙 가시 호 반각(rad). 서버 판정 arc(±arc/2)의 시각 대응 — 전사 넓은 부채꼴.
  const SWING_HALF = 1.05; // ≈60°

  // ───────────────────────── 진입점 ─────────────────────────
  function drawChampion(ctx, p, now, opts) {
    opts = opts || {};
    const meta = META[p.champion] || META.warrior;
    const aimIdle = p.facing || 0;

    // 공격 진행도(서버 권위, attackAnim.duration=초). prog>=1 이면 idle.
    let atype = null, prog = 1, aimAtk = aimIdle;
    if (p.attackAnim) {
      const a = p.attackAnim;
      prog = (now - a.startedAt) / (Math.max(0.001, a.duration) * 1000);
      if (prog >= 0 && prog < 1) { atype = a.type; aimAtk = (a.aimAngle != null) ? a.aimAngle : aimIdle; }
    }
    // 스킬 시전(서버 권위, castAnim.duration=ms). 캐스트는 평타보다 포즈 우선.
    let cast = null;
    if (p.castAnim) {
      const c = p.castAnim;
      const cp = (now - c.startedAt) / Math.max(1, c.duration);
      if (cp >= 0 && cp < 1) cast = computeCast(c.type, cp, (c.aimAngle != null ? c.aimAngle : aimIdle));
    }
    // 대시(서버 dashUntil 연속이동). 고스트 복사본도 dashUntil 상속 → 동일 변형.
    const dashing = !p.dead && ((p.dashUntil && now < p.dashUntil) || p.dashing);

    const aim = cast ? cast.aim : (atype ? aimAtk : aimIdle);
    const breathe = Math.sin(now * 0.004 + p.x * 0.01) * 0.7;

    ctx.save();
    ctx.translate(p.x, p.y);

    if (p.dead) ctx.globalAlpha = 0.22;
    else if (p.invuln && !dashing) ctx.globalAlpha = 0.45 + 0.35 * Math.sin(now * 0.03);

    // 발 그림자(지면 고정 — 변형 전)
    ctx.save(); ctx.globalAlpha *= 0.5; ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.beginPath(); ctx.ellipse(0, meta.r + 0, meta.r * 0.85, meta.r * 0.32, 0, 0, TAU); ctx.fill(); ctx.restore();

    // ── 몸 변형 레이어: 대시 기울기/스쿼시 + 캐스트 포즈 ──
    ctx.save();
    if (dashing) {
      ctx.rotate(Math.cos(aim) * 0.20);                              // 진행 수평방향 기울기
      ctx.rotate(aim); ctx.scale(1.22, 0.84); ctx.rotate(-aim);      // 진행축 스트레치(질주감)
    }
    if (cast) {
      ctx.translate(Math.cos(cast.aim) * cast.push, Math.sin(cast.aim) * cast.push - cast.rise);
      if (cast.sx !== 1 || cast.sy !== 1) { ctx.rotate(cast.aim); ctx.scale(cast.sx, cast.sy); ctx.rotate(-cast.aim); }
    }

    // 치장 오라(본체 뒤)
    drawAuraBack(ctx, p, meta, now);

    // 직업 본체 + 무기 + 모션
    (DRAW[p.champion] || DRAW.warrior)(ctx, p, meta, now, aim, aimIdle, atype, prog, breathe, opts);

    // 치장 오라(본체 앞 — Tier3 파티클)
    drawAuraFront(ctx, p, meta, now);

    // 스킬 시전 제스처(채널링 무기/손 + 코어 플레어)
    if (cast) drawCastGesture(ctx, cast, meta);
    ctx.restore();

    // 본인 표시 링
    if (opts.isSelf && !p.dead) {
      ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, meta.r, 16, 0.12 * Math.PI, 0.88 * Math.PI); ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // 라벨(월드 좌표)
    drawLabel(ctx, p, meta, opts);
  }

  // ───────────────────────── 스킬 시전 모션 ─────────────────────────
  const CAST_COL = {
    dash_strike: '#FF66AA', aoe_field: '#88FF44', nova: '#FFAA33',
    projectile_barrage: '#66CCFF', buff: '#FFD24A', summon: '#B980FF', chain: '#7CF0FF',
  };
  // cp: 0~1 진행도. 반환: push(아임 +전진), rise(위로), sx/sy(스쿼시), arm(-1 모음/치켜듦~+1 펼침/뻗음), flare(0~1 절정), col
  function computeCast(type, cp, aim) {
    let push = 0, rise = 0, sx = 1, sy = 1, arm = 0, flare = 0;
    const wp = cp < 0.32 ? ease.outQuad(cp / 0.32) : 1;              // windup 0~1
    const rp = cp < 0.32 ? 0 : (cp - 0.32) / 0.68;                   // release 0~1
    const st = rp < 0.34 ? ease.outQuad(rp / 0.34) : 1;
    const settle = rp < 0.34 ? 0 : ease.outBack((rp - 0.34) / 0.66);
    switch (type) {
      case 'dash_strike':                                            // 깊은 런지 → 찌름
        push = lerp(lerp(-5, 18, st), 0, settle);
        sx = lerp(lerp(1, 1.18, st), 1, settle); sy = lerp(lerp(1, 0.86, st), 1, settle);
        arm = lerp(-1, 1, st); flare = st * (1 - settle); break;
      case 'nova':                                                   // 모으기(수축) → 폭발(팽창)
        sx = sy = cp < 0.32 ? lerp(1, 0.82, wp) : lerp(0.82, 1.16, ease.outBack(rp));
        arm = cp < 0.32 ? -wp : lerp(-1, 1, ease.outQuad(rp)); flare = rp; break;
      case 'aoe_field':                                              // 양손 들기 → 내리꽂기
        rise = cp < 0.32 ? lerp(0, 9, wp) : lerp(9, -3, ease.outQuad(rp));
        arm = cp < 0.32 ? -wp : lerp(-1, 1, ease.outQuad(rp)); flare = rp; break;
      case 'buff': {                                                 // 포효 + 몸 팽창
        const g = ease.outBack(Math.min(cp / 0.45, 1));
        sx = sy = lerp(1, 1.13, g); rise = Math.sin(cp * Math.PI) * 5;
        arm = lerp(-1, -0.3, wp); flare = Math.sin(cp * Math.PI); break;
      }
      case 'projectile_barrage':                                     // 연속 발사 반동 펄스
        push = -Math.abs(Math.sin(cp * Math.PI * 6)) * 5; arm = 0.7; flare = Math.abs(Math.sin(cp * Math.PI * 6)); break;
      case 'summon':                                                 // 지면 향해 손 뻗기 → 반동
        rise = cp < 0.32 ? -lerp(0, 5, wp) : lerp(-5, 0, ease.outBack(rp));
        push = lerp(0, 7, wp) * (1 - rp); arm = lerp(-0.3, 1, wp); flare = wp * (1 - rp); break;
      case 'chain':                                                  // 무기로 호 그리며 겨냥
        arm = Math.sin(cp * Math.PI); flare = Math.sin(cp * Math.PI); break;
      default:
        arm = Math.sin(cp * Math.PI); flare = Math.sin(cp * Math.PI);
    }
    return { type, cp, aim, push, rise, sx, sy, arm, flare, col: CAST_COL[type] || '#FFFFFF' };
  }
  function drawCastGesture(ctx, cast, meta) {
    const col = cast.col, r = meta.r;
    ctx.save(); ctx.rotate(cast.aim);
    const reach = r + 6 + 14 * (0.5 + 0.5 * cast.arm);              // 손/무기 뻗는 거리
    const spread = (cast.type === 'nova' || cast.type === 'aoe_field') ? 0.45 + 0.55 * (0.5 + 0.5 * cast.arm) : 0.14;
    ctx.globalAlpha = 0.85; ctx.shadowColor = col; ctx.shadowBlur = 8 + 12 * cast.flare;
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(r * 0.4, 0); ctx.lineTo(Math.cos(spread) * reach, Math.sin(spread) * reach); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(r * 0.4, 0); ctx.lineTo(Math.cos(spread) * reach, -Math.sin(spread) * reach); ctx.stroke();
    // 채널 코어(절정에 밝아짐)
    ctx.fillStyle = '#FFFFFF'; ctx.globalAlpha = 0.55 + 0.45 * cast.flare;
    ctx.beginPath(); ctx.arc(r * 0.4 + reach * 0.35, 0, 2 + 5 * cast.flare, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // ───────────────────────── 치장(Tier) ─────────────────────────
  function drawAuraBack(ctx, p, meta, now) {
    if (p.tier >= 2) {
      ctx.save();
      ctx.shadowColor = meta.aura; ctx.shadowBlur = 10;
      ctx.strokeStyle = meta.aura; ctx.lineWidth = 2; ctx.globalAlpha = 0.55 + 0.15 * Math.sin(now * 0.005);
      ctx.beginPath(); ctx.arc(0, 0, meta.r + 3, 0, TAU); ctx.stroke();
      ctx.restore();
    }
  }
  function drawAuraFront(ctx, p, meta, now) {
    if (p.tier >= 3) {
      ctx.save(); ctx.globalAlpha = 0.95;
      for (let i = 0; i < 8; i++) {
        const a = now * 0.0028 + i / 8 * TAU;
        const rr = meta.r + 7 + Math.sin(now * 0.006 + i) * 3;
        ctx.fillStyle = i % 2 ? meta.aura : '#FFFFFF';
        ctx.shadowColor = meta.aura; ctx.shadowBlur = 6;
        dot(ctx, Math.cos(a) * rr, Math.sin(a) * rr, 2.3);
      }
      ctx.restore();
    }
  }

  // ───────────────────────── 무기 ─────────────────────────
  // 검: ang 방향(0=오른쪽). 손잡이→날 길이 38px. 스윙 잔상 옵션.
  function drawSword(ctx, ang, tier, ghostAlpha) {
    ctx.save(); ctx.rotate(ang + Math.PI / 2); // 로컬 +Y가 칼끝
    if (ghostAlpha) ctx.globalAlpha *= ghostAlpha;
    const col = SWORD[tier - 1] || SWORD[0];
    if (tier >= 2) { ctx.shadowColor = tier >= 3 ? '#FF8800' : '#2266CC'; ctx.shadowBlur = tier >= 3 ? 10 : 6; }
    // 손잡이
    ctx.fillStyle = '#6B3A1F'; ctx.fillRect(-2.5, -6, 5, 9);
    ctx.fillStyle = '#8B5A2B'; ctx.fillRect(-5, -2, 10, 3); // 가드
    // 검날
    ctx.fillStyle = col; ctx.fillRect(-2.5, 3, 5, 33); tri(ctx, -2.5, 36, 2.5, 36, 0, 44);
    // 중앙 홈
    ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(-0.6, 4, 1.2, 30);
    if (tier >= 3) { ctx.fillStyle = '#FFD700'; ctx.fillRect(-5, 16, 3, 3); ctx.fillRect(2, 16, 3, 3); }
    ctx.restore();
  }
  function drawDagger(ctx, ang, tier, len) {
    ctx.save(); ctx.rotate(ang + Math.PI / 2);
    const col = DAGGER[tier - 1] || DAGGER[0];
    if (tier >= 2) { ctx.shadowColor = '#AA22FF'; ctx.shadowBlur = 8; }
    ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 4); ctx.lineTo(0, len); ctx.stroke();
    ctx.fillStyle = col; tri(ctx, -3, len, 3, len, 0, len + 5);
    ctx.fillStyle = '#3a2a1a'; ctx.fillRect(-2, 0, 4, 5); // 손잡이
    ctx.restore();
  }

  // ───────────────────────── 직업별 렌더 ─────────────────────────
  const DRAW = {
    // 전사 — 스윙: 앤티시페이션(뒤로 코일) → 스윙(easeOutQuad) → outBack 팔로스루
    warrior(ctx, p, meta, now, aim, aimIdle, atype, prog, breathe, opts) {
      // 스윙 중 몸 전진 러지
      let lunge = 0, sw = 0, swinging = false, coil = 1;
      if (atype === 'swing') {
        if (prog < 0.30) {                                                   // windup: -60°보다 더 깊게 당김(앤티시페이션)
          const a = ease.outQuad(prog / 0.30);
          sw = lerp(0, -SWING_HALF - 0.16, a);
          coil = 1 - 0.06 * a;                                               // 살짝 웅크림
          lunge = -2.5 * a;                                                  // 뒤로 무게 이동
        } else if (prog < 0.60) {                                            // 스윙
          swinging = true; sw = lerp(-SWING_HALF - 0.16, SWING_HALF, ease.outQuad((prog - 0.30) / 0.30));
          lunge = Math.sin((prog - 0.30) / 0.30 * Math.PI) * 6;
        } else {                                                            // 팔로스루(outBack: 살짝 지나쳤다 정착)
          const a = (prog - 0.60) / 0.40;
          sw = lerp(SWING_HALF, 0, ease.outBack(a));
          coil = 1 + 0.04 * (1 - a);
        }
      }
      const cx = Math.cos(aim) * lunge, cy = Math.sin(aim) * lunge + breathe;

      // 슬래시 잔상(스윙 구간) — 본체 뒤에 먼저
      if (swinging) {
        const ghosts = [0.12, 0.24];
        for (let k = 0; k < ghosts.length; k++) {
          const gAng = aim + lerp(sw, -SWING_HALF, ghosts[k] * 2.2);
          ctx.save(); ctx.translate(cx, cy);
          drawSword(ctx, gAng, p.tier, 0.18 - k * 0.06);
          ctx.restore();
        }
        // 호 잔광
        ctx.save(); ctx.translate(cx, cy);
        ctx.strokeStyle = 'rgba(138,180,248,0.35)'; ctx.lineWidth = 4; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(0, 0, 40, aim - SWING_HALF, aim + sw); ctx.stroke();
        ctx.restore();
      }

      ctx.save(); ctx.translate(cx, cy); ctx.scale(2 - coil, coil); // 코일 스쿼시/스트레치
      // 몸통
      ball(ctx, 0, 0, 22, meta.accent, meta.body);
      ctx.strokeStyle = meta.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 22, 0, TAU); ctx.stroke();
      // 가슴 십자
      ctx.beginPath(); ctx.moveTo(-10, 0); ctx.lineTo(10, 0); ctx.moveTo(0, -10); ctx.lineTo(0, 10); ctx.stroke();
      // 어깨 장식(치장)
      ctx.fillStyle = '#1E3A6A'; dot(ctx, -18, 4, 6); dot(ctx, 18, 4, 6);
      // 투구
      ctx.fillStyle = '#1E3A6A'; ctx.beginPath(); ctx.arc(0, -6, 16, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#111'; ctx.fillRect(-8, -8, 16, 5);
      ctx.fillStyle = '#1E3A6A'; tri(ctx, -16, -22, -10, -14, -18, -12); tri(ctx, 16, -22, 10, -14, 18, -12);
      if (p.tier >= 3) { ctx.fillStyle = '#FFD700'; star(ctx, 0, -18, 4); } // 투구 보석
      ctx.restore();

      // 검(모션 각 = aim + sw)
      ctx.save(); ctx.translate(cx, cy);
      drawSword(ctx, aim + sw, p.tier);
      ctx.restore();
    },

    // 마법사 — 캐스팅: 차징(구 확대) → 발사(반동) → 복귀
    mage(ctx, p, meta, now, aim, aimIdle, atype, prog, breathe, opts) {
      let orbR = 7, recoil = 0, flash = 0;
      if (atype === 'cast') {
        if (prog < 0.5) {                                  // 차징: 지팡이 살짝 당기며 구 확대(앤티시페이션)
          const a = ease.outQuad(prog / 0.5);
          orbR = lerp(7, 12, a); recoil = lerp(0, -3, a);
        } else {                                           // 발사: 반동 스냅(outCirc) → outBack 정착
          const a = (prog - 0.5) / 0.5;
          orbR = lerp(12, 7, ease.outQuad(a));
          recoil = lerp(-3, 6, ease.outCirc(Math.min(a / 0.4, 1)));
          recoil = lerp(recoil, 0, a < 0.4 ? 0 : ease.outBack((a - 0.4) / 0.6));
          flash = prog < 0.62 ? 1 - (prog - 0.5) / 0.12 : 0;
        }
      }
      // 로브 자락
      ctx.save(); ctx.translate(0, breathe);
      ctx.fillStyle = meta.body; tri(ctx, -12, 10, 12, 10, 0, 28);
      ball(ctx, 0, 0, 18, meta.accent, meta.body);
      ctx.strokeStyle = meta.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 18, 0, TAU); ctx.stroke();
      // 모자
      ctx.fillStyle = '#2A0850'; tri(ctx, 0, -30, -14, -16, 14, -16); ctx.fillRect(-16, -18, 32, 4);
      if (p.tier >= 3) { ctx.fillStyle = '#FFD700'; star(ctx, 0, -30, 5); }
      ctx.restore();

      // 지팡이 + 마법구
      ctx.save(); ctx.rotate(aim);
      ctx.strokeStyle = '#6B3A1F'; ctx.lineWidth = 4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(40 + recoil, 0); ctx.stroke();
      const oc = ORB[p.tier - 1] || ORB[0];
      ctx.save(); ctx.shadowColor = '#AA22FF'; ctx.shadowBlur = (p.tier >= 2 ? 12 : 7) + flash * 14;
      ctx.fillStyle = oc; dot(ctx, 40 + recoil, 0, orbR);
      if (flash > 0) { ctx.globalAlpha = flash * 0.8; ctx.fillStyle = '#FFFFFF'; dot(ctx, 40 + recoil, 0, orbR + 5 * flash); }
      ctx.restore();
      if (p.tier >= 3) {
        ctx.strokeStyle = '#CC88FF'; ctx.lineWidth = 1.5;
        for (let i = 0; i < 6; i++) { const a = now * 0.005 + i / 6 * TAU; ctx.beginPath(); ctx.moveTo(40 + recoil, 0); ctx.lineTo(40 + recoil + Math.cos(a) * 12, Math.sin(a) * 12); ctx.stroke(); }
      }
      ctx.restore();
    },

    // 궁수 — 발사: 당기기 → 발사(반동)
    archer(ctx, p, meta, now, aim, aimIdle, atype, prog, breathe, opts) {
      let pull = 0, recoil = 0, released = false;
      if (atype === 'shoot') {
        if (prog < 0.5) {                                  // 당기기(앤티시페이션: 시위 깊게 당김)
          pull = lerp(0, 8, ease.outQuad(prog / 0.5));
        } else {                                           // 발사 반동(outCirc 스냅) → outBack 정착
          released = true;
          const a = (prog - 0.5) / 0.5;
          recoil = lerp(10, 0, ease.outCirc(Math.min(a / 0.55, 1)));
          recoil = lerp(recoil, 0, a < 0.55 ? 0 : ease.outBack((a - 0.55) / 0.45));
        }
      }
      ctx.save(); ctx.translate(0, breathe);
      // 망토
      ctx.fillStyle = meta.body; ctx.beginPath(); ctx.arc(0, 0, 22, 0, Math.PI); ctx.fill();
      ball(ctx, 0, 0, 18, meta.accent, meta.body);
      // 후드
      ctx.fillStyle = '#1B5E20'; ctx.beginPath(); ctx.arc(0, -2, 16, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#FFD700'; ctx.fillRect(-5, -4, 3, 3); ctx.fillRect(2, -4, 3, 3);
      ctx.restore();

      // 활(반동으로 뒤로 밀림)
      ctx.save(); ctx.rotate(aim); ctx.translate(-recoil, 0);
      const bc = BOW[p.tier - 1] || BOW[0];
      ctx.save(); if (p.tier >= 2) { ctx.shadowColor = bc; ctx.shadowBlur = p.tier >= 3 ? 12 : 8; }
      ctx.strokeStyle = bc; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(18, 0, 18, -1.25, 1.25); ctx.stroke(); ctx.restore();
      // 시위(당김 표현)
      ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1.5;
      const tx = 18 + Math.cos(1.25) * 18, ty = Math.sin(1.25) * 18;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(6 - pull, 0); ctx.lineTo(tx, -ty); ctx.stroke();
      // 장전 화살(발사 전만)
      if (!released) {
        ctx.strokeStyle = bc; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(6 - pull, 0); ctx.lineTo(30 - pull, 0); ctx.stroke();
        ctx.fillStyle = bc; tri(ctx, 30 - pull, -3, 30 - pull, 3, 36 - pull, 0);
      }
      if (p.tier >= 3) { // 잎사귀 궤도(치장)
        for (let i = 0; i < 3; i++) { const a = now * 0.004 + i / 3 * TAU; ctx.fillStyle = '#7CFC9A'; ctx.globalAlpha = 0.8; dot(ctx, 10 + Math.cos(a) * 26, Math.sin(a) * 26, 2.4); }
      }
      ctx.restore();
    },

    // 암살자 — 대시: 대시 잔상 → 연속 스탭(3회 교차)
    assassin(ctx, p, meta, now, aim, aimIdle, atype, prog, breathe, opts) {
      // 대시 잔상(전반)
      if (atype === 'dash' && prog < 0.5) {
        const dp = prog / 0.5;
        for (let i = 1; i <= 4; i++) {
          const off = -i * 11 * (1 - dp * 0.4);
          ctx.save(); ctx.globalAlpha = (0.30 - i * 0.06) * (1 - dp);
          ball(ctx, Math.cos(aim) * off, Math.sin(aim) * off + breathe, 16, meta.accent, meta.body);
          ctx.restore();
        }
      }
      // 앤티시페이션(웅크림)→대시(스트레치)
      let aScale = 1;
      if (atype === 'dash') {
        if (prog < 0.12) aScale = lerp(1, 0.86, ease.outQuad(prog / 0.12));
        else if (prog < 0.45) aScale = lerp(1.14, 1, ease.outQuad((prog - 0.12) / 0.33));
      }
      ctx.save(); ctx.translate(0, breathe); ctx.scale(2 - aScale, aScale);
      // Tier3 그림자 클론(지연 복사)
      if (p.tier >= 3) { ctx.save(); ctx.globalAlpha = 0.35; ball(ctx, -Math.cos(aim) * 6, -Math.sin(aim) * 6, 14, meta.body, meta.body); ctx.restore(); }
      // 몸통
      ball(ctx, 0, 0, 16, meta.accent, meta.body);
      ctx.strokeStyle = meta.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 16, 0, TAU); ctx.stroke();
      // 마스크
      ctx.fillStyle = '#1A0A30'; ctx.beginPath(); ctx.arc(0, -2, 16, Math.PI, 0); ctx.fill();
      ctx.fillStyle = '#FF3399'; ctx.fillRect(-6, -4, 4, 3); ctx.fillRect(2, -4, 4, 3);
      ctx.restore();

      // 단검 ×2 — 스탭 구간 교차 스윙(3회)
      let spread = 0.42, stabbing = false;
      if (atype === 'dash' && prog >= 0.45) {
        const sp = (prog - 0.45) / 0.55;
        spread = 0.42 + Math.sin(sp * Math.PI * 3) * 0.75; // 3회 교차
        stabbing = true;
      }
      if (stabbing) { // 베기 잔광
        ctx.save();
        ctx.strokeStyle = 'rgba(204,68,255,0.4)'; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(0, 0, 26, aim - spread * 0.5, aim + spread * 0.5); ctx.stroke();
        ctx.restore();
      }
      drawDagger(ctx, aim - spread * 0.45, p.tier, 22);
      drawDagger(ctx, aim + spread * 0.45, p.tier, 18);
    },
  };

  // ───────────────────────── 라벨(HP/별/이름) ─────────────────────────
  function drawLabel(ctx, p, meta, opts) {
    const w = Math.max(40, meta.r * 1.8), h = 5, x = p.x - w / 2, y = p.y + meta.r + 8;
    const ratio = clamp(p.hp / Math.max(1, p.maxHp), 0, 1);
    ctx.fillStyle = '#333'; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = ratio > 0.5 ? '#44DD44' : ratio > 0.25 ? '#FFCC00' : '#FF4444';
    ctx.fillRect(x, y, w * ratio, h);
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h);
    // Tier 별
    const t = clamp(p.tier || 1, 1, 3);
    ctx.fillStyle = t >= 3 ? '#FFD700' : t >= 2 ? '#4A90E2' : '#888888';
    ctx.font = '10px Arial'; ctx.textAlign = 'center';
    ctx.fillText('★'.repeat(t) + '☆'.repeat(3 - t), p.x, y + 16);
    // 이름
    ctx.fillStyle = opts.isSelf ? '#FFFFFF' : '#cfcfe6'; ctx.font = 'bold 11px Arial';
    ctx.fillText(p.name || meta.name, p.x, p.y - meta.r - 12);
    ctx.textAlign = 'left';
  }

  function init() { /* lazy 자원 없음 — 호출 안 해도 무방 */ }

  window.ChampMotion = { drawChampion, init };
})();
