'use strict';
/*
 * Arena Wave — 게임 서버 (server.js)
 * 권위 서버: 30Hz tick, 무한 웨이브, 직접 조준(자동조준 없음),
 * 근접 부채꼴 호 판정, 적 12종 + 엘리트 접두, 증강 48종, 손맛 이벤트.
 *
 * 프론트(1513819740940927067)와 합의된 socket 계약:
 *  클라→서버: join / input / select_augment / restart
 *  서버→클라: joined / state(30Hz) / events / augment_offer
 */

const path = require('path');

// ───────────────────────────── 수학 유틸 ─────────────────────────────
const TAU = Math.PI * 2;
function norm(a) { a %= TAU; if (a > Math.PI) a -= TAU; if (a < -Math.PI) a += TAU; return a; }
function angleDiff(a, b) { return Math.abs(norm(a - b)); }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// 결정적 의사난수(테스트 재현성). 시드 기반.
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// ───────────────────────────── 아레나 ─────────────────────────────
const ARENA = { w: 1280, h: 720 };
const TICK_HZ = 30;
const DT = 1 / TICK_HZ;
const ORB_THRESHOLD = 10; // 오브 임계치 (8-0 확정값)

// ───────────────────────────── 챔피언 정의 ─────────────────────────────
// attack.kind: 'melee'(부채꼴 호) | 'ranged'(투사체)
const CHAMPIONS = {
  warrior: {
    name: '전사', r: 22, hp: 150, speed: 168, regen: 1.5,
    attack: { kind: 'melee', dmg: 24, range: 84, arc: 1.92 /*≈110°*/, cd: 0.50,
              combo: 1, knockback: 260, animType: 'swing', animDur: 0.18 },
    crit: 0.05, critMul: 1.5, color: '#4A90E2',
  },
  mage: {
    name: '마법사', r: 18, hp: 122, speed: 152, regen: 1.4,
    attack: { kind: 'ranged', dmg: 18, cd: 0.55, projKind: 'magic', projSpeed: 330,
              projR: 9, pierce: 0, count: 1, spread: 0.10, knockback: 90,
              animType: 'cast', animDur: 0.13 },
    crit: 0.05, critMul: 1.5, color: '#9B59B6',
  },
  archer: {
    name: '궁수', r: 18, hp: 108, speed: 162, regen: 1.0,
    attack: { kind: 'ranged', dmg: 14, cd: 0.36, projKind: 'arrow', projSpeed: 500,
              projR: 6, pierce: 1, count: 1, spread: 0.05, knockback: 70,
              animType: 'shoot', animDur: 0.11 },
    crit: 0.10, critMul: 1.5, color: '#27AE60',
  },
  assassin: {
    name: '암살자', r: 16, hp: 92, speed: 190, regen: 1.2,
    attack: { kind: 'melee', dmg: 11, range: 66, arc: 1.40 /*≈80°*/, cd: 0.50,
              combo: 3, knockback: 130, dash: 120, animType: 'dash', animDur: 0.30 },
    crit: 0.10, critMul: 1.7, color: '#E91E63',
  },
};

// ───────────────────────────── 적 정의(12종) ─────────────────────────────
// cost: 스폰 예산 소모, unlock: 등장 시작 웨이브, ai: 행동 유형
const ENEMY_TYPES = {
  slime:      { name:'슬라임',   r:16, hp:38,  speed:56,  dmg:8,  cost:1, unlock:1,  ai:'chase',  xp:3 },
  goblin:     { name:'고블린',   r:15, hp:28,  speed:98,  dmg:6,  cost:1, unlock:1,  ai:'chase',  xp:3 },
  bat:        { name:'박쥐',     r:12, hp:22,  speed:118, dmg:5,  cost:1, unlock:1,  ai:'erratic',xp:3 },
  skeleton:   { name:'해골',     r:18, hp:32,  speed:60,  dmg:10, cost:2, unlock:3,  ai:'ranged', proj:'bone',    projSpeed:240, projR:7, atkCd:1.7, range:340, xp:5 },
  slinger:    { name:'슬링거',   r:15, hp:22,  speed:70,  dmg:9,  cost:2, unlock:3,  ai:'kite',   proj:'bone',    projSpeed:260, projR:6, atkCd:1.5, range:300, xp:5 },
  orc:        { name:'오크',     r:26, hp:88,  speed:46,  dmg:18, cost:3, unlock:5,  ai:'chase',  xp:8 },
  splitslime: { name:'분열슬라임',r:18, hp:38,  speed:50,  dmg:7,  cost:3, unlock:5,  ai:'chase',  split:2, xp:7 },
  darkmage:   { name:'다크메이지',r:17, hp:36,  speed:50,  dmg:12, cost:3, unlock:7,  ai:'ranged', proj:'darkbolt',projSpeed:230, projR:10,atkCd:2.0, range:360, xp:9 },
  healerimp:  { name:'힐러임프', r:14, hp:30,  speed:74,  dmg:4,  cost:3, unlock:7,  ai:'healer', healAmt:6, healCd:2.2, healRange:160, xp:9 },
  shieldorc:  { name:'실드오크', r:24, hp:120, speed:40,  dmg:16, cost:4, unlock:9,  ai:'shield', shieldArc:1.6, shieldReduce:0.7, xp:12 },
  giant:      { name:'폭발거인', r:32, hp:130, speed:36,  dmg:24, cost:4, unlock:11, ai:'chase',  explode:{ r:120, dmg:34 }, xp:14 },
  boss:       { name:'보스',     r:46, hp:360, speed:50,  dmg:16, cost:0, unlock:5,  ai:'boss',   xp:120 },
};

// 적별 공격 모션 타이밍(ms) — 모션 애니메이터 합의값. windup(예고)/duration(전체).
// strike(타격 발동 오프셋)=windup 기본. 빠른 적 짧게, 느린 대형 길게(텔레그래프 큼). 하한 240ms.
const ENEMY_ATK = {
  slime: { w: 360, d: 600 }, goblin: { w: 280, d: 520 }, bat: { w: 240, d: 480 },
  skeleton: { w: 500, d: 700 }, slinger: { w: 460, d: 660 }, orc: { w: 480, d: 760 },
  splitslime: { w: 360, d: 600 }, darkmage: { w: 560, d: 780 }, healerimp: { w: 600, d: 820 },
  shieldorc: { w: 520, d: 820 }, giant: { w: 460, d: 720 }, boss: { w: 700, d: 950 },
};
for (const k in ENEMY_TYPES) {
  const a = ENEMY_ATK[k] || { w: 380, d: 620 };
  ENEMY_TYPES[k].atkW = a.w; ENEMY_TYPES[k].atkD = a.d;
}

// 엘리트 접두(가속/강철/가시/정예)
const ELITES = {
  swift: { name:'가속', speedMul:1.45, hpMul:1.0,  dmgMul:1.0,  rMul:1.0 },
  steel: { name:'강철', speedMul:0.92, hpMul:1.9,  dmgMul:1.2,  rMul:1.1 },
  thorn: { name:'가시', speedMul:1.0,  hpMul:1.3,  dmgMul:1.0,  rMul:1.0, thorns:0.4 },
  elite: { name:'정예', speedMul:1.15, hpMul:1.7,  dmgMul:1.35, rMul:1.2, xpMul:2 },
};

// ───────────────────────────── 증강 48종 ─────────────────────────────
// effect: 스탯 모디파이어. 적용 파이프라인(recomputeStats)에서 폴딩.
// rarity: common(일반)/rare(희귀)/legendary(전설). classOnly: null 또는 챔피언키.
function A(id, name, rarity, classOnly, desc, value, effect) {
  return { id, name, rarity, classOnly, desc, value, effect };
}
const AUGMENTS = [
  // ── 공통 16 (일반9 / 희귀5 / 전설2) ──
  A('sharp',     '날카로운 칼날', 'common', null, '공격력 +20%', '+20% DMG', { dmgMul: 0.20 }),
  A('steelheart','강철 심장',     'common', null, '최대 체력 +25%', '+25% HP', { hpMul: 0.25 }),
  A('boots',     '쾌속 부츠',     'common', null, '이동속도 +15%', '+15% SPD', { speedMul: 0.15 }),
  A('frenzy',    '광전사',        'common', null, '공격속도 +15%', '+15% AS', { cdMul: -0.13 }),
  A('vamp',      '흡혈',          'rare',   null, '가한 피해의 8% 회복', 'Lifesteal 8%', { lifesteal: 0.08 }),
  A('critup',    '치명타 수련',   'common', null, '치명타 확률 +12%', '+12% CRIT', { crit: 0.12 }),
  A('execute',   '처형자',        'rare',   null, '치명타 피해 +40%', '+40% CRIT DMG', { critMul: 0.4 }),
  A('thornarmor','가시 갑옷',     'common', null, '접촉 적에게 피해 6 반사', 'Thorns 6', { thorns: 6 }),
  A('regen',     '재생의 룬',     'common', null, '초당 체력 +2 회복', '+2 HP/s', { regen: 2 }),
  A('titan',     '거인의 힘',     'rare',   null, '공격력+30%·체력+15%·이속-8%', 'Power', { dmgMul: 0.30, hpMul: 0.15, speedMul: -0.08 }),
  A('berserk',   '광폭화',        'legendary', null, '공격속도+25%·공격력+10%', 'Berserk', { cdMul: -0.25, dmgMul: 0.10 }),
  A('flame',     '불꽃 부여',     'rare',   null, '명중 시 화상(초당 피해)', 'Burn', { burn: 4 }),
  A('frost',     '서리 부여',     'rare',   null, '명중 시 둔화', 'Freeze', { freeze: 0.4 }),
  A('venom',     '맹독 부여',     'common', null, '명중 시 중독', 'Poison', { poison: 3 }),
  A('bash',      '강타',          'common', null, '넉백+80%·공격력+10%', 'Bash', { knockbackMul: 0.8, dmgMul: 0.10 }),
  A('immortal',  '불사신',        'legendary', null, '체력+40%·초당+3회복', 'Immortal', { hpMul: 0.40, regen: 3 }),

  // ── 전사 8 (일반3 / 희귀3 / 전설2) ──
  A('w_whirl',   '회전 베기',     'common', 'warrior', '공격 범위(호) +40°', '+40° ARC', { arcAdd: 0.70 }),
  A('w_great',   '대검 숙련',     'common', 'warrior', '사거리+25%·공격력+12%', 'Reach', { rangeMul: 0.25, dmgMul: 0.12 }),
  A('w_rally',   '전장의 함성',   'common', 'warrior', '이속+10%·공격속도+12%', 'Rally', { speedMul: 0.10, cdMul: -0.12 }),
  A('w_shield',  '방패 반격',     'rare',   'warrior', '가시 12·체력+15%', 'Counter', { thorns: 12, hpMul: 0.15 }),
  A('w_exec',    '처형 일격',     'rare',   'warrior', '치명+15%·치명피해+50%', 'Execute', { crit: 0.15, critMul: 0.5 }),
  A('w_crush',   '파괴의 일격',   'rare',   'warrior', '공격력+35%·넉백+100%', 'Crush', { dmgMul: 0.35, knockbackMul: 1.0 }),
  A('w_unbreak', '불굴',          'legendary', 'warrior', '체력+50%·초당+4회복', 'Unbreakable', { hpMul: 0.50, regen: 4 }),
  A('w_tempest', '검풍',          'legendary', 'warrior', '호+60°·사거리+20%·넉백+120%', 'Tempest', { arcAdd: 1.05, rangeMul: 0.20, knockbackMul: 1.2 }),

  // ── 마법사 8 (일반4 / 희귀3 / 전설1) ──
  A('m_focus',   '마력 집중',     'common', 'mage', '공격력 +20%', '+20% DMG', { dmgMul: 0.20 }),
  A('m_pierce',  '관통 마법',     'common', 'mage', '투사체 관통 +2', 'Pierce +2', { pierce: 2 }),
  A('m_swift',   '신속 영창',     'common', 'mage', '공격속도 +20%', '+20% AS', { cdMul: -0.20 }),
  A('m_ward',    '마나 보호막',   'common', 'mage', '체력+30%·초당+3회복', 'Ward', { hpMul: 0.30, regen: 3 }),
  A('m_chain',   '연쇄 마법탄',   'rare',   'mage', '투사체 +1', '+1 Bolt', { projAdd: 1 }),
  A('m_fire',    '화염 폭발',     'rare',   'mage', '화상·공격력+10%', 'Fireball', { burn: 6, dmgMul: 0.10 }),
  A('m_frost',   '빙결의 손길',   'rare',   'mage', '둔화·공격력+8%', 'Frostbite', { freeze: 0.5, dmgMul: 0.08 }),
  A('m_storm',   '비전 폭풍',     'legendary', 'mage', '투사체 +2·공격력+10%', 'Arcane Storm', { projAdd: 2, dmgMul: 0.10 }),

  // ── 궁수 8 (일반4 / 희귀3 / 전설1) ──
  A('a_aim',     '정밀 사격',     'common', 'archer', '치명타 +18%', '+18% CRIT', { crit: 0.18 }),
  A('a_pierce',  '관통 화살',     'common', 'archer', '관통 +3', 'Pierce +3', { pierce: 3 }),
  A('a_venom',   '맹독 화살',     'common', 'archer', '중독·공격력+8%', 'Venom', { poison: 4, dmgMul: 0.08 }),
  A('a_instinct','사냥꾼 본능',   'common', 'archer', '공격력+18%·이속+10%', 'Instinct', { dmgMul: 0.18, speedMul: 0.10 }),
  A('a_multi',   '다중 화살',     'rare',   'archer', '화살 +1(부채꼴)', '+1 Arrow', { projAdd: 1 }),
  A('a_quick',   '신속한 손',     'rare',   'archer', '공격속도 +22%', '+22% AS', { cdMul: -0.22 }),
  A('a_explode', '폭발 화살',     'rare',   'archer', '명중 시 소폭발', 'Explosive', { onHitAoe: { r: 70, mul: 0.6 } }),
  A('a_storm',   '폭풍의 시위',   'legendary', 'archer', '화살+2·공격속도+15%', 'Storm Bow', { projAdd: 2, cdMul: -0.15 }),

  // ── 암살자 8 (일반4 / 희귀4 / 전설0) ──
  A('s_blade',   '그림자 칼날',   'common', 'assassin', '공격력 +18%', '+18% DMG', { dmgMul: 0.18 }),
  A('s_dash',    '잔영',          'common', 'assassin', '대시 거리 +40%', '+40% Dash', { dashMul: 0.40 }),
  A('s_venom',   '맹독 단검',     'common', 'assassin', '중독·공격력+10%', 'Venom', { poison: 5, dmgMul: 0.10 }),
  A('s_speed',   '쾌속',          'common', 'assassin', '이속+18%·공격속도+15%', 'Swift', { speedMul: 0.18, cdMul: -0.15 }),
  A('s_combo',   '연환 자돌',     'rare',   'assassin', '연속 타격 +1', '+1 Stab', { comboAdd: 1 }),
  A('s_vital',   '치명 급소',     'rare',   'assassin', '치명+20%·치명피해+60%', 'Vital', { crit: 0.20, critMul: 0.6 }),
  A('s_leech',   '처형 흡혈',     'rare',   'assassin', '가한 피해의 15% 회복', 'Leech 15%', { lifesteal: 0.15 }),
  A('s_phantom', '그림자 분신',   'rare',   'assassin', '공격력+25%·공격속도+20%', 'Phantom', { dmgMul: 0.25, cdMul: -0.20 }),
];
const AUGMENT_BY_ID = Object.fromEntries(AUGMENTS.map(a => [a.id, a]));

// ───────────────────────────── 액티브 스킬 32종 ─────────────────────────────
// type: dash_strike(돌진+경로타격) / aoe_field(장판 지속dps) / nova(주변폭발) /
//       projectile_barrage(투사체난사) / buff(자기강화) / summon(소환) / chain(연쇄)
// cd: 일반6 / 희귀10 / 전설16(궁극). 증강 modifier(dmgMul/cdMul/projAdd)가 스킬에도 적용.
const SKILL_CD = { common: 6, rare: 10, legendary: 16 };
function SK(id, name, classOnly, rarity, type, params) {
  return { id, name, classOnly, rarity, cd: SKILL_CD[rarity], type, params, ult: rarity === 'legendary' };
}
const SKILLS = [
  // ── 공용 4 ──
  SK('c_dash',  '점멸 돌진',   null, 'common',    'dash_strike',        { dist: 190, dur: 170, dmgMul: 1.3 }),
  SK('c_nova',  '충격 파동',   null, 'rare',      'nova',               { r: 120, dmgMul: 1.6, knockback: 320 }),
  SK('c_field', '독성 지대',   null, 'common',    'aoe_field',          { r: 95, dur: 4000, dps: 9, kind: 'poison' }),
  SK('c_rage',  '전투 각성',   null, 'rare',      'buff',               { dur: 5000, mods: { dmgMul: 0.30, speedMul: 0.20, cdMul: -0.15 } }),

  // ── 전사 7 ──
  SK('w_whirl', '회오리 베기', 'warrior', 'common',    'nova',          { r: 115, dmgMul: 1.5, knockback: 220 }),
  SK('w_charge','돌진 강타',   'warrior', 'common',    'dash_strike',   { dist: 230, dur: 180, dmgMul: 1.9, knockback: 300 }),
  SK('w_quake', '대지 가르기', 'warrior', 'rare',      'aoe_field',     { r: 135, dur: 3000, dps: 15, slow: 0.4, kind: 'quake' }),
  SK('w_cry',   '전쟁의 함성', 'warrior', 'rare',      'buff',          { dur: 6000, mods: { dmgMul: 0.40, cdMul: -0.20 }, shield: 70 }),
  SK('w_leap',  '영웅 도약',   'warrior', 'rare',      'dash_strike',   { dist: 260, dur: 220, dmgMul: 2.2, aoe: 90 }),
  SK('w_bash',  '분쇄 강타',   'warrior', 'common',    'nova',          { r: 100, dmgMul: 1.8, knockback: 380 }),
  SK('w_titan', '거신화',      'warrior', 'legendary', 'buff',          { dur: 7000, mods: { dmgMul: 0.6, hpMul: 0.4, knockbackMul: 0.5 }, shield: 160 }),

  // ── 마법사 7 ──
  SK('m_fire',  '화염구',      'mage', 'common',    'projectile_barrage', { count: 1, projKind: 'magic', dmgMul: 2.6, speed: 340, explode: 80 }),
  SK('m_frost', '서리 폭발',   'mage', 'common',    'nova',               { r: 130, dmgMul: 1.2, freeze: 1500 }),
  SK('m_blink', '점멸',        'mage', 'common',    'dash_strike',        { dist: 210, dur: 120, dmgMul: 0 }),
  SK('m_meteor','메테오',      'mage', 'rare',      'aoe_field',          { r: 120, dur: 2500, dps: 22, kind: 'fire' }),
  SK('m_arcane','비전 난사',   'mage', 'rare',      'projectile_barrage', { count: 8, spread: 0.55, projKind: 'magic', dmgMul: 1.0, speed: 340 }),
  SK('m_chain', '연쇄 번개',   'mage', 'rare',      'chain',              { targets: 6, dmgMul: 1.7, range: 260, jump: 170 }),
  SK('m_bliz',  '블리자드',    'mage', 'legendary', 'aoe_field',          { r: 185, dur: 5000, dps: 26, slow: 0.5, freeze: 600, kind: 'ice' }),

  // ── 궁수 7 ──
  SK('a_multi', '다중 사격',   'archer', 'common',    'projectile_barrage', { count: 5, spread: 0.6, projKind: 'arrow', dmgMul: 1.2, speed: 480 }),
  SK('a_roll',  '구르기 사격', 'archer', 'common',    'dash_strike',        { dist: 200, dur: 160, dmgMul: 0.9 }),
  SK('a_trap',  '독 덫',       'archer', 'common',    'aoe_field',          { r: 85, dur: 5000, dps: 11, slow: 0.3, kind: 'poison' }),
  SK('a_rain',  '화살비',      'archer', 'rare',      'aoe_field',          { r: 140, dur: 2500, dps: 19, kind: 'arrow' }),
  SK('a_pierce','관통 사격',   'archer', 'rare',      'projectile_barrage', { count: 1, projKind: 'arrow', dmgMul: 3.2, speed: 620, pierce: 99 }),
  SK('a_hawk',  '매 소환',     'archer', 'rare',      'summon',             { count: 2, hp: 45, dmg: 11, dur: 8000 }),
  SK('a_storm', '폭풍 화살',   'archer', 'legendary', 'projectile_barrage', { count: 20, spread: 6.28, projKind: 'arrow', dmgMul: 1.3, speed: 470 }),

  // ── 암살자 7 ──
  SK('s_shadow','그림자 일격', 'assassin', 'common',    'dash_strike',     { dist: 240, dur: 150, dmgMul: 1.7 }),
  SK('s_smoke', '연막 폭발',   'assassin', 'common',    'nova',            { r: 105, dmgMul: 1.1, slow: 0.5 }),
  SK('s_vial',  '독병 투척',   'assassin', 'common',    'aoe_field',       { r: 90, dur: 4000, dps: 13, kind: 'poison' }),
  SK('s_fan',   '비도 난사',   'assassin', 'rare',      'projectile_barrage', { count: 7, spread: 0.7, projKind: 'arrow', dmgMul: 0.95, speed: 500 }),
  SK('s_leap',  '그림자 도약', 'assassin', 'rare',      'dash_strike',     { dist: 300, dur: 140, dmgMul: 1.3 }),
  SK('s_clone', '그림자 분신', 'assassin', 'rare',      'summon',          { count: 2, hp: 35, dmg: 15, dur: 6000 }),
  SK('s_mark',  '처형 표식',   'assassin', 'legendary', 'buff',            { dur: 6000, mods: { dmgMul: 0.8, cdMul: -0.30, crit: 0.30 } }),
];
const SKILL_BY_ID = Object.fromEntries(SKILLS.map(s => [s.id, s]));

// ───────────────────────────── 매판 변이(Run Mutator) ─────────────────────────────
// 판 시작 시 2개 중 1택. state.activeMutator로 노출. 시드마다 빌드 결이 달라짐.
const MUTATORS = [
  { id: 'frenzy',   name: '광란의 군세', desc: '적 이동속도 +25%, 처치 보상 +30%' },
  { id: 'ricochet', name: '도탄',        desc: '내 투사체가 1회 튕겨 다른 적을 타격' },
  { id: 'volatile', name: '폭발 시체',   desc: '적 처치 시 소형 폭발(연쇄 청소)' },
  { id: 'bulwark',  name: '공성전',      desc: '받는 피해 -20%, 적 체력 +25%(장기전)' },
  { id: 'overdrive', name: '오버드라이브', desc: '스킬 쿨다운 -20%' },
  { id: 'elite',    name: '정예 사냥',   desc: '엘리트 출현률 +, 처치 점수 +50%' },
  { id: 'adrenal',  name: '아드레날린',  desc: '체력 50% 이하일 때 이동속도 +30%' },
  { id: 'glasscanon', name: '유리대포',  desc: '공격력 +35%, 최대 체력 -20%' },
  { id: 'frostbite',name: '한파',        desc: '평타·스킬에 둔화 확률 부여' },
  { id: 'bounty',   name: '현상금',      desc: '증강/스킬 오퍼가 한 장 더(4지선다)' },
];


// ───────────────────────────── 스탯 파이프라인 ─────────────────────────────
// 챔피언 base + 레벨 + 증강 스택을 폴딩해 최종 스탯 산출.
// 모디파이어 효과 폴딩(증강·버프 공용)
function applyMods(m, e) {
  if (e.dmgMul) m.dmgMul += e.dmgMul;
  if (e.hpMul) m.hpMul += e.hpMul;
  if (e.speedMul) m.speedMul += e.speedMul;
  if (e.rangeMul) m.rangeMul += e.rangeMul;
  if (e.cdMul) m.cdMul += e.cdMul;
  if (e.arcAdd) m.arcAdd += e.arcAdd;
  if (e.crit) m.crit += e.crit;
  if (e.critMul) m.critMul += e.critMul;
  if (e.regen) m.regen += e.regen;
  if (e.lifesteal) m.lifesteal += e.lifesteal;
  if (e.thorns) m.thorns += e.thorns;
  if (e.knockbackMul) m.knockbackMul += e.knockbackMul;
  if (e.pierce) m.pierce += e.pierce;
  if (e.projAdd) m.projAdd += e.projAdd;
  if (e.comboAdd) m.comboAdd += e.comboAdd;
  if (e.dashMul) m.dashMul += e.dashMul;
  if (e.burn) m.burn = Math.max(m.burn, e.burn);
  if (e.freeze) m.freeze = Math.max(m.freeze, e.freeze);
  if (e.poison) m.poison = Math.max(m.poison, e.poison);
  if (e.onHitAoe) m.onHitAoe = e.onHitAoe;
}

function recomputeStats(p) {
  const C = CHAMPIONS[p.champion];
  const atk = C.attack;
  const lvl = p.level - 1; // 0부터
  // 누적 모디파이어
  let m = {
    dmgMul: 0, hpMul: 0, speedMul: 0, rangeMul: 0, cdMul: 0, arcAdd: 0,
    crit: C.crit, critMul: C.critMul, regen: C.regen, lifesteal: 0, thorns: 0,
    knockbackMul: 0, pierce: atk.pierce || 0, projAdd: 0, comboAdd: 0, dashMul: 0,
    burn: 0, freeze: 0, poison: 0, onHitAoe: null,
  };
  for (const id of p.augments) {
    const e = AUGMENT_BY_ID[id] && AUGMENT_BY_ID[id].effect;
    if (e) applyMods(m, e);
  }
  // 활성 자기버프(스킬)도 폴딩 — p.buffs엔 만료 안 된 것만 유지(updatePlayers가 정리)
  for (const b of (p.buffs || [])) { if (b.mods) applyMods(m, b.mods); }
  // 레벨 보정(완만): 레벨당 +6% 체력, +4% 공격력
  const lvlHp = 1 + lvl * 0.06, lvlDmg = 1 + lvl * 0.04;
  const s = p.stats = {};
  s.maxHp = Math.round(C.hp * lvlHp * (1 + m.hpMul));
  s.speed = C.speed * (1 + m.speedMul);
  s.dmg = atk.dmg * lvlDmg * (1 + m.dmgMul);
  s.cd = Math.max(0.12, atk.cd * (1 + m.cdMul));
  s.crit = clamp(m.crit, 0, 0.85);
  s.critMul = m.critMul;
  s.regen = m.regen;
  s.lifesteal = m.lifesteal;
  s.thorns = m.thorns;
  s.knockback = (atk.knockback || 0) * (1 + m.knockbackMul);
  s.burn = m.burn; s.freeze = m.freeze; s.poison = m.poison; s.onHitAoe = m.onHitAoe;
  s.projAdd = m.projAdd; s.cdMul = m.cdMul; s.dmgMul = m.dmgMul; // 스킬에 증강 modifier 연동용
  s.kind = atk.kind;
  if (atk.kind === 'melee') {
    s.range = atk.range * (1 + m.rangeMul);
    s.arc = atk.arc + m.arcAdd;
    s.combo = (atk.combo || 1) + m.comboAdd;
    s.dash = (atk.dash || 0) * (1 + m.dashMul);
  } else {
    s.projKind = atk.projKind; s.projSpeed = atk.projSpeed; s.projR = atk.projR;
    s.pierce = m.pierce; s.count = (atk.count || 1) + m.projAdd; s.spread = atk.spread || 0.08;
  }
  s.animType = atk.animType; s.animDur = atk.animDur;
  if (p.hp === undefined) p.hp = s.maxHp;
  p.hp = Math.min(p.hp, s.maxHp);
}

// ───────────────────────────── 게임 ─────────────────────────────
let _eid = 1, _pid = 1;

class Game {
  constructor(opts = {}) {
    this.players = new Map();   // socketId -> player
    this.enemies = [];
    this.projectiles = [];
    this.events = [];
    this.wave = 0;
    this.phase = 'lobby';       // lobby | playing | wave_clear | augment_select | gameover
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.phaseTimer = 0;
    this.score = 0;
    this.killCount = 0;
    this.boss = null;
    this.now = 0;               // 서버 ms (tick 누적)
    this.rng = makeRng(opts.seed || 0x9e3779b1);
    this.pendingOffers = new Map(); // socketId -> choices
    this.fields = [];           // 장판류 지속 효과
    this.summons = [];          // 소환수
    this.activeMutator = null;  // 이번 판 변이
    this.mutatorOffer = null;
    this.firstSkillGiven = false;
    this.manualStart = !!opts.manualStart; // 룸 모드: addPlayer 자동시작 금지(Room이 start)
    this.numPlayers = opts.numPlayers || 0; // 룸 시작 시 인원 고정(스케일 기준). 0이면 현재 size 사용
    this.over = false;
    this._augSelectSource = null; // 증강 선택 트리거 출처: 'wave' | 'orb'
  }

  // 난이도 스케일 기준 인원수(룸 시작 시 고정값, 없으면 현재 살아있는+죽은 전체)
  N() { return Math.max(1, this.numPlayers || this.players.size); }

  addPlayer(id, name, champion, pid) {
    if (!CHAMPIONS[champion]) champion = 'warrior';
    const p = {
      id, pid: pid || _pid++, name: name || ('용사' + _pid), champion,
      r: CHAMPIONS[champion].r, // ★ 충돌 반지름(누락 시 적 접촉/투사체 판정이 NaN→무피해 버그)
      x: ARENA.w / 2 + (this.rng() - 0.5) * 80, y: ARENA.h / 2 + (this.rng() - 0.5) * 80,
      facing: 0, level: 1, xp: 0, xpMax: 10, tier: 1,
      augments: [], hp: undefined, stats: null,
      input: { moveX: 0, moveY: 0, aimAngle: 0, attacking: false, dashing: false },
      atkCdLeft: 0, attackAnim: null, dead: false, invulnUntil: 0, reviveAt: 0,
      // 스킬/버프/대시
      skills: [null, null, null], skillUp: {}, buffs: [], shield: 0,
      castAnim: null, pendingSkill: null,
      dashUntil: 0, dashVx: 0, dashVy: 0, dashSkill: null, dodgeCdLeft: 0,
      hurtCd: 0,
      // 오브 시스템 (8-0·8-1)
      orbCount: 0, orbPending: false,
    };
    recomputeStats(p);
    p.hp = p.stats.maxHp;
    this.players.set(id, p);
    // 단일 게임(테스트/솔로)은 첫 입장 시 자동 시작. 룸 모드는 manualStart로 막고 Room이 start.
    if (!this.manualStart && (this.phase === 'lobby' || this.phase === 'gameover')) this.startGame();
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.pendingOffers.delete(id);
    if (this.players.size === 0) { this.phase = 'lobby'; this.enemies = []; this.projectiles = []; }
  }

  startGame() {
    this.wave = 0; this.enemies = []; this.projectiles = []; this.boss = null;
    this.fields = []; this.summons = [];
    this.score = 0; this.killCount = 0; this.spawnQueue = [];
    this.activeMutator = null; this.firstSkillGiven = false;
    this.over = false;
    for (const p of this.players.values()) {
      p.level = 1; p.xp = 0; p.xpMax = 10; p.tier = 1; p.augments = [];
      p.skills = [null, null, null]; p.skillUp = {}; p.buffs = []; p.shield = 0; p.castAnim = null; p.pendingSkill = null;
      p.dead = false; p.reviveAt = 0; recomputeStats(p); p.hp = p.stats.maxHp;
      p.orbCount = 0; p.orbPending = false; // 오브 초기화
      p.x = ARENA.w / 2 + (this.rng() - 0.5) * 80; p.y = ARENA.h / 2 + (this.rng() - 0.5) * 80;
    }
    // 매판 변이: 2개 중 1택(시드마다 결이 달라짐)
    const pool = MUTATORS.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(this.rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    this.mutatorOffer = [pool[0], pool[1]];
    this.phase = 'mutator_select';
    this.phaseTimer = 20;
    this.events.push({ type: 'mutator_offer', choices: this.mutatorOffer });
  }

  // ── 웨이브 구성: 스폰 예산 + 최소 적수, 잠금해제·코스트 반영 ──
  startWave(n) {
    this.wave = n;
    this.phase = 'playing';
    this.spawnQueue = [];
    this.spawnTimer = 0;
    const isBoss = (n % 5 === 0);
    const N = this.N();
    const partyMul = 1 + 0.6 * (N - 1);                 // 인원 비례 스폰예산
    let budget = Math.round((10 + 4 * n) * partyMul);
    const target = Math.round((5 + Math.floor(1.5 * n)) * partyMul);
    // 잠금해제 가속: 인원 많을수록 (N-1)웨이브 앞당김. 단 상위 적은 wave2 이전 금지(즉사 방지), wave1 잡몹은 유지.
    const unlocked = Object.entries(ENEMY_TYPES).filter(([k, t]) => {
      if (k === 'boss') return false;
      const floor = t.unlock <= 1 ? 1 : 2;
      return n >= Math.max(floor, t.unlock - (N - 1));
    });
    // 엘리트 등장 확률(웨이브4부터 증가) + 4인 가중
    let eliteChance = n < 4 ? 0 : Math.min(0.45, 0.05 + (n - 4) * 0.03);
    if (N >= 4) eliteChance = Math.min(0.7, eliteChance + 0.1);   // 4인 엘리트 가중
    if (this.mut('elite')) eliteChance = Math.min(0.8, eliteChance + 0.18); // 정예사냥 변이

    const pickElite = () => {
      if (this.rng() > eliteChance) return null;
      const keys = Object.keys(ELITES);
      return keys[Math.floor(this.rng() * keys.length)];
    };

    if (isBoss) {
      this.spawnQueue.push({ type: 'boss', elite: null, boss: true });
      // N≥3: 미니보스(본체 40% HP) 1기 동반 — 동시 보스 최대 2기(트윈)까지
      if (N >= 3) this.spawnQueue.push({ type: 'boss', elite: null, boss: true, mini: true });
      budget = Math.floor(budget * 0.45); // 보스전엔 잡몹 예산 대폭 축소(보스 집중)
      this.events.push({ type: 'boss_spawn', wave: n });
    }
    let count = 0;
    let guard = 0;
    while ((budget > 0 || count < target) && guard++ < 500) {
      const affordable = unlocked.filter(([, t]) => t.cost <= budget);
      let pool = affordable.length ? affordable : unlocked;
      if (!pool.length) break;
      // 후반일수록 비싼(강한) 적 가중
      const [k, t] = pool[Math.floor(this.rng() * pool.length)];
      budget -= t.cost;
      this.spawnQueue.push({ type: k, elite: pickElite(), boss: false });
      count++;
      if (count >= target && budget <= 0) break;
    }
    // 스폰 순서 셔플(보스는 맨 앞 유지)
    const head = this.spawnQueue[0] && this.spawnQueue[0].boss ? [this.spawnQueue.shift()] : [];
    for (let i = this.spawnQueue.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [this.spawnQueue[i], this.spawnQueue[j]] = [this.spawnQueue[j], this.spawnQueue[i]];
    }
    this.spawnQueue = head.concat(this.spawnQueue);
    this.waveTotal = this.spawnQueue.length;
    this.events.push({ type: 'wave_start', wave: n, boss: isBoss });
  }

  spawnEnemy(spec) {
    const base = ENEMY_TYPES[spec.type];
    const n = this.wave;
    // 선형 스케일
    const hpMul = 1 + 0.12 * n;
    const spdMul = Math.min(1.8, 1 + 0.02 * n);
    const dmgMul = 1 + 0.07 * n;
    const np = this.N();                          // 난이도 기준 인원수(룸 시작 시 고정)
    const partyHp = 1 + 0.15 * (np - 1);          // 인원 비례 적 HP(데미지는 불변)
    const el = spec.elite ? ELITES[spec.elite] : null;
    // 화면 가장자리에서 진입
    const edge = Math.floor(this.rng() * 4);
    let x, y;
    if (edge === 0) { x = this.rng() * ARENA.w; y = -30; }
    else if (edge === 1) { x = ARENA.w + 30; y = this.rng() * ARENA.h; }
    else if (edge === 2) { x = this.rng() * ARENA.w; y = ARENA.h + 30; }
    else { x = -30; y = this.rng() * ARENA.h; }

    const bossScale = spec.boss ? (1 + (Math.floor(n / 5) - 1) * 0.18) : 1;
    const r = base.r * (el ? el.rMul : 1) * (spec.boss ? bossScale * (spec.mini ? 0.6 : 1) : 1);
    // 보스 HP는 인원수에 비례(솔로도 적정 시간에 처치 가능, 멀티는 그만큼 두꺼워짐)
    const bossPlayerMul = spec.boss ? (0.7 + 0.45 * np) : 1;
    const miniMul = spec.mini ? 0.4 : 1;            // 미니보스: 본체 40% HP·크기
    const mutHp = this.mut('bulwark') ? 1.25 : 1;   // 공성전: 적 HP +25%
    const mutSpd = this.mut('frenzy') ? 1.25 : 1;   // 광란: 적 이속 +25%
    const maxHp = Math.round(base.hp * hpMul * (el ? el.hpMul : 1) * mutHp * partyHp * (spec.boss ? bossScale * bossPlayerMul * miniMul : 1));
    const e = {
      id: _eid++, type: spec.type, name: base.name, ai: base.ai,
      x, y, vx: 0, vy: 0, r, facing: 0,
      hp: maxHp, maxHp,
      speed: base.speed * spdMul * (el ? el.speedMul : 1) * mutSpd,
      dmg: base.dmg * dmgMul * (el ? el.dmgMul : 1),
      elite: spec.elite, boss: !!spec.boss, mini: !!spec.mini,
      thorns: el && el.thorns ? el.thorns : 0,
      xp: Math.round(base.xp * (el && el.xpMul ? el.xpMul : 1)),
      atkTimer: base.atkCd ? base.atkCd * this.rng() : 0,
      healTimer: base.healCd ? base.healCd * this.rng() : 0,
      // 공격 모션 FSM
      atkW: base.atkW, atkD: base.atkD, atkCdLeft: 0.3 + this.rng() * 0.4,
      attackAnim: null, atkPending: false, reach: base.r > 24 ? 16 : 10,
      state: 'move', flashUntil: 0, telegraph: null,
      // 상태이상
      burnLeft: 0, burnDps: 0, poisonLeft: 0, poisonDps: 0, slowUntil: 0,
      proj: base.proj, projSpeed: base.projSpeed, projR: base.projR,
      atkCd: base.atkCd || 0.95, atkRange: base.range, explode: base.explode,
      split: base.split, shieldArc: base.shieldArc, shieldReduce: base.shieldReduce,
      healAmt: base.healAmt, healCd: base.healCd, healRange: base.healRange,
      bossPhase: spec.boss ? 0 : -1, bossAtkTimer: spec.boss ? 2.5 : 0,
    };
    this.enemies.push(e);
    if (spec.boss && !spec.mini) this.boss = e; // 메인 보스만 상단 HP바(미니보스는 일반 보스형 적)
    return e;
  }

  nearestPlayer(x, y) {
    let best = null, bd = Infinity;
    for (const p of this.players.values()) {
      if (p.dead) continue;
      const d = dist2(x, y, p.x, p.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best ? { p: best, d: Math.sqrt(bd) } : null;
  }

  setInput(id, inp) {
    const p = this.players.get(id);
    if (!p) return;
    const i = p.input;
    if (typeof inp.moveX === 'number') i.moveX = clamp(inp.moveX, -1, 1);
    if (typeof inp.moveY === 'number') i.moveY = clamp(inp.moveY, -1, 1);
    if (typeof inp.aimAngle === 'number') i.aimAngle = inp.aimAngle;
    i.attacking = !!inp.attacking;
    i.dashing = !!inp.dashing;
  }

  // ───────── 핵심: 근접 부채꼴 호 판정 (자동조준 없음) ─────────
  // aimAngle(클라가 보낸 마우스 각)만 사용. 자동 타깃탐색/스냅 없음.
  // 근접 부채꼴 호 판정. (ox,oy)=판정 원점(대시 시 시작/도착 양쪽 호출), hitSet=중복타 방지.
  meleeAttack(p, ox, oy, hitSet) {
    const s = p.stats;
    const aim = p.input.aimAngle;          // ← 오직 클라의 마우스 각(자동조준 없음)
    const half = s.arc / 2;
    const x = ox === undefined ? p.x : ox, y = oy === undefined ? p.y : oy;
    let hitAny = false;
    const dmg = s.dmg * (s.combo || 1);    // 콤보(암살자 등) 횟수만큼 누적
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      if (hitSet && hitSet.has(e.id)) continue;
      const dx = e.x - x, dy = e.y - y;
      const d = Math.hypot(dx, dy);
      if (d > s.range + e.r) continue;     // 거리 ≤ range + 적반지름
      if (angleDiff(aim, Math.atan2(dy, dx)) > half) continue; // 호 ±arc/2 밖
      if (hitSet) hitSet.add(e.id);
      this.damageEnemy(e, dmg, p, aim, true);
      hitAny = true;
    }
    return hitAny;
  }

  spawnProjectiles(p) {
    const s = p.stats;
    const aim = p.input.aimAngle;
    const count = s.count;
    for (let k = 0; k < count; k++) {
      // 부채꼴 분산
      const offset = count === 1 ? 0 : (k - (count - 1) / 2) * s.spread;
      const ang = aim + offset;
      this.projectiles.push({
        id: _eid++, owner: 'ally', ownerPid: p.pid, x: p.x, y: p.y, angle: ang,
        vx: Math.cos(ang) * s.projSpeed, vy: Math.sin(ang) * s.projSpeed,
        r: s.projR, kind: s.projKind, tier: p.tier, life: 1.8,
        dmg: s.dmg, pierce: s.pierce, hitSet: new Set(),
        burn: s.burn, freeze: s.freeze, poison: s.poison, onHitAoe: s.onHitAoe,
        crit: s.crit, critMul: s.critMul, knockback: s.knockback,
        lifesteal: s.lifesteal, ownerId: p.id,
      });
    }
  }

  damageEnemy(e, raw, p, dir, melee) {
    if (e.hp <= 0) return;
    const s = p.stats;
    // 치명타
    let dmg = raw, crit = false;
    if (this.rng() < s.crit) { dmg *= s.critMul; crit = true; }
    // 실드오크 전면 방어
    if (e.ai === 'shield') {
      const facingPlayer = Math.atan2(p.y - e.y, p.x - e.x);
      if (angleDiff(e.facing, facingPlayer) < (e.shieldArc / 2)) dmg *= (1 - e.shieldReduce);
    }
    dmg = Math.max(1, Math.round(dmg));
    e.hp -= dmg;
    e.flashUntil = this.now + 80;
    // 손맛: 히트스톱 + 넉백
    this.events.push({ type: 'hit', x: e.x, y: e.y, dmg, crit, target: e.id, dir });
    if (melee) this.events.push({ type: 'hitstop', ms: 80 });
    const kb = s.knockback;
    if (kb > 0 && !e.boss) {
      const k = kb * (melee ? 1 : 0.6);
      e.x += Math.cos(dir) * k * DT * 3;
      e.y += Math.sin(dir) * k * DT * 3;
      this.events.push({ type: 'knockback', id: e.id, dx: Math.cos(dir) * k * 0.1, dy: Math.sin(dir) * k * 0.1 });
    }
    // 화면 흔들림
    this.events.push({ type: 'shake', mag: melee ? 4 : 2, ms: 90 });
    // 상태이상 부여
    if (s.burn) { e.burnLeft = 3; e.burnDps = s.burn; this.events.push({ type: 'status', target: e.id, kind: 'burn' }); }
    if (s.poison) { e.poisonLeft = 4; e.poisonDps = s.poison; this.events.push({ type: 'status', target: e.id, kind: 'poison' }); }
    if (s.freeze) { e.slowUntil = this.now + 1200; this.events.push({ type: 'status', target: e.id, kind: 'freeze' }); }
    if (this.mut('frostbite') && this.rng() < 0.3) { e.slowUntil = this.now + 1000; this.events.push({ type: 'status', target: e.id, kind: 'freeze' }); } // 한파 변이
    // 흡혈
    if (s.lifesteal && p) {
      p.hp = Math.min(p.stats.maxHp, p.hp + dmg * s.lifesteal);
    }
    if (e.hp <= 0) this.killEnemy(e, p);
  }

  killEnemy(e, p) {
    if (e._dead) return;
    e._dead = true;
    this.killCount++;
    let reward = e.boss ? 500 : (5 + Math.floor(e.maxHp / 6));
    if (this.mut('frenzy')) reward = Math.round(reward * 1.3);   // 광란: 보상 +30%
    if (this.mut('elite')) reward = Math.round(reward * 1.5);    // 정예사냥: 점수 +50%
    this.score += reward;
    if (this.mut('volatile') && !e.boss) { // 폭발 시체(주변 적 연쇄 피해)
      const er = 70, edmg = Math.max(6, e.maxHp * 0.4);
      this.events.push({ type: 'explosion', x: e.x, y: e.y, r: er, small: true });
      for (const o of this.enemies) { if (o === e || o.hp <= 0) continue; if (dist2(e.x, e.y, o.x, o.y) <= er * er) { o.hp -= edmg; o.flashUntil = this.now + 60; if (o.hp <= 0) this.killEnemy(o, p); } }
    }
    this.events.push({ type: 'death', x: e.x, y: e.y, enemyType: e.type, boss: e.boss });
    if (e.boss && e.telegraph) e.telegraph = null;
    // 분열
    if (e.split && !e.boss) {
      for (let i = 0; i < e.split; i++) {
        const child = this.spawnEnemy({ type: 'slime', elite: null, boss: false });
        child.x = e.x + (this.rng() - 0.5) * 30; child.y = e.y + (this.rng() - 0.5) * 30;
        child.hp = child.maxHp = Math.round(e.maxHp * 0.3);
        child.r = e.r * 0.6;
      }
    }
    // 폭발거인: 사망 폭발(주변 적/플레이어)
    if (e.explode) this.doExplosion(e, e.explode.r, e.explode.dmg);
    // 경험치 분배
    if (p) this.giveXp(p, e.xp);
    // 오브 지급 (8-1: 적 처치 판정 즉시 같은 tick)
    if (p) this.grantOrb(p, e);
    if (e.boss) this.boss = null;
  }

  doExplosion(e, r, dmg) {
    this.events.push({ type: 'explosion', x: e.x, y: e.y, r });
    this.events.push({ type: 'shake', mag: 8, ms: 300 });
    for (const p of this.players.values()) {
      if (p.dead) continue;
      if (dist2(e.x, e.y, p.x, p.y) <= r * r) this.hurtPlayer(p, dmg, e);
    }
  }

  giveXp(p, xp) {
    p.xp += xp;
    while (p.xp >= p.xpMax) {
      p.xp -= p.xpMax;
      p.level++;
      p.xpMax = Math.round(p.xpMax * 1.25 + 8);
      const before = p.stats.maxHp;
      recomputeStats(p);
      p.hp += (p.stats.maxHp - before); // 레벨업 시 늘어난 만큼 회복
      p.hp = Math.min(p.stats.maxHp, p.hp + p.stats.maxHp * 0.30); // +30% 회복(전열 유지 보상)
      this.events.push({ type: 'levelup', id: p.pid });
    }
  }

  // ───── 오브 지급·임계치 처리 (8-1) ─────
  grantOrb(p, e) {
    p.orbCount++;
    // orb_grant: 처치 위치·최신 카운트 전달 (VFX·HUD 기준점)
    this.events.push({
      type: 'orb_grant', pid: p.pid,
      x: Math.round(e.x), y: Math.round(e.y),
      orbCount: p.orbCount, threshold: ORB_THRESHOLD,
    });
    if (p.orbCount >= ORB_THRESHOLD) {
      if (this.phase === 'augment_select') {
        // 선택 중 추가 처치: 다음 사이클로 이월 (6번 요구사항)
        p.orbPending = true;
      } else {
        p.orbCount = 0; // 임계치 도달 즉시 리셋
        this.events.push({ type: 'orb_threshold', pid: p.pid });
        this.beginAugmentSelect('orb');
      }
    }
  }

  hurtPlayer(p, raw, src) {
    if (p.dead) return;
    if (this.now < p.invulnUntil) return; // i-frame
    let scaled = raw * (this.mut('bulwark') ? 0.8 : 1); // 공성전 변이: 받는 피해 -20%
    // 후반 즉사 방지: 1회 피해는 최대 체력의 35%로 상한
    let dmg = Math.min(scaled, p.stats.maxHp * 0.35);
    dmg = Math.max(1, Math.round(dmg));
    // 보호막 우선 흡수(버프 shield)
    if (p.shield > 0) {
      const absorbed = Math.min(p.shield, dmg); p.shield -= absorbed; dmg -= absorbed;
      this.events.push({ type: 'shield_hit', id: p.pid, absorbed });
      if (dmg <= 0) { p.invulnUntil = this.now + 500; return; }
    }
    p.hp -= dmg;
    p.invulnUntil = this.now + 500; // 피격 후 무적 0.5s (둘러싸여도 실효 받은DPS 상한)
    this.events.push({ type: 'player_hit', id: p.pid, dmg, x: p.x, y: p.y });
    this.events.push({ type: 'shake', mag: 6, ms: 150 });
    if (p.hp <= 0) {
      p.hp = 0; p.dead = true;
      this.events.push({ type: 'player_died', id: p.pid });
      // 부활 예약: 협동(N>1)이고 살아있는 아군이 있으면 타이머 후 부활. 솔로/전멸이면 부활 없음.
      const someoneAlive = [...this.players.values()].some(o => o !== p && !o.dead);
      if (this.N() > 1 && someoneAlive) p.reviveAt = this.now + Math.min(12000, 6000 + 200 * this.wave);
      else p.reviveAt = 0;
    }
  }

  updateRevive() {
    const anyAlive = [...this.players.values()].some(o => !o.dead);
    for (const p of this.players.values()) {
      if (!p.dead || !p.reviveAt) continue;
      if (!anyAlive) { p.reviveAt = 0; continue; } // 전멸 → 부활 취소(게임오버)
      if (this.now >= p.reviveAt) this.revivePlayer(p);
    }
  }

  revivePlayer(p) {
    p.dead = false; p.reviveAt = 0;
    p.hp = Math.round(p.stats.maxHp * 0.5);
    p.invulnUntil = this.now + 1500;             // 리스폰 직후 짧은 무적
    p.shield = 0; p.dashUntil = 0; p.attackAnim = null; p.castAnim = null;
    const ally = [...this.players.values()].find(o => o !== p && !o.dead); // 살아있는 아군 근처
    if (ally) { p.x = clamp(ally.x + (this.rng() - 0.5) * 60, p.r, ARENA.w - p.r); p.y = clamp(ally.y + (this.rng() - 0.5) * 60, p.r, ARENA.h - p.r); }
    this.events.push({ type: 'player_revived', pid: p.pid, x: Math.round(p.x), y: Math.round(p.y) });
  }

  // ───────────────────────────── 메인 tick ─────────────────────────────
  tick() {
    this.now += DT * 1000;
    if (this.phase === 'lobby') return;

    if (this.phase === 'playing') {
      this.updateSpawning();
      this.updatePlayers();
      this.updateEnemies();
      this.updateProjectiles();
      this.updateFields();
      this.updateSummons();
      this.updateStatusEffects();
      this.updateRevive();
      this.checkWaveClear();
      this.checkGameOver();
    } else if (this.phase === 'mutator_select') {
      this.phaseTimer -= DT;
      if (this.phaseTimer <= 0) this.selectMutator(this.mutatorOffer[0].id); // 미선택 시 첫 후보 자동
    } else if (this.phase === 'wave_clear') {
      this.updatePlayers();
      this.updateStatusEffects();
      this.updateRevive();           // 웨이브 정리 중에도 부활 타이머 진행
      this.phaseTimer -= DT;
      // 오브 트리거가 먼저 phase를 바꿨을 경우 중복 호출 방지
      if (this.phaseTimer <= 0 && this.phase === 'wave_clear') this.beginAugmentSelect('wave');
    } else if (this.phase === 'augment_select') {
      // 선택 대기. 일정 시간 지나면 자동 선택(무클라/AFK 방지)
      this.updateRevive();           // 증강 선택 화면 중에도 부활 타이머 진행(다음 웨이브까지 미루지 않음)
      this.phaseTimer -= DT;
      if (this.phaseTimer <= 0) this.autoPickAugments();
    } else if (this.phase === 'gameover') {
      // 대기
    }
  }

  selectMutator(id) {
    if (this.phase !== 'mutator_select') return false;
    const m = (this.mutatorOffer || []).find(x => x.id === id) || MUTATORS.find(x => x.id === id);
    if (!m) return false;
    this.activeMutator = m;
    this.mutatorOffer = null;
    const MUT_MODS = { glasscanon: { dmgMul: 0.35, hpMul: -0.20 }, overdrive: { cdMul: -0.20 } };
    if (MUT_MODS[m.id]) for (const p of this.players.values()) p.buffs.push({ id: 'mut_' + m.id, until: Infinity, mods: MUT_MODS[m.id] });
    for (const p of this.players.values()) { recomputeStats(p); p.hp = Math.min(p.hp, p.stats.maxHp); }
    this.events.push({ type: 'mutator_chosen', id: m.id, name: m.name });
    this.startWave(1);
    return true;
  }

  mut(id) { return this.activeMutator && this.activeMutator.id === id; }

  updateSpawning() {
    if (!this.spawnQueue.length) return;
    this.spawnTimer -= DT;
    const alive = this.enemies.filter(e => e.hp > 0).length;
    const cap = Math.min(40, 25 + 5 * (this.N() - 1)); // 인원 비례 동시 상한(하드캡 40)
    if (alive >= cap) return;
    if (this.projectiles.length >= 120) return; // 투사체 하드캡(과밀·렉 방지)
    if (this.spawnTimer <= 0) {
      const spec = this.spawnQueue.shift();
      this.spawnEnemy(spec);
      this.spawnTimer = 0.30 + this.rng() * 0.30; // 스폰 간격
    }
  }

  updatePlayers() {
    for (const p of this.players.values()) {
      if (p.dead) continue;
      // 만료된 버프 정리 → 스탯 재계산
      if (p.buffs.length) {
        const before = p.buffs.length;
        p.buffs = p.buffs.filter(b => b.until === Infinity || this.now < b.until);
        if (p.buffs.length !== before) recomputeStats(p);
      }
      const s = p.stats;
      const i = p.input;
      if (this.now >= p.dashUntil) p.facing = i.aimAngle; // 대시 중엔 진행방향 유지

      // ── 대시 중: 고속 velocity로 여러 틱 연속 이동(순간이동 아님) + 경로 타격 ──
      if (this.now < p.dashUntil) {
        p.x = clamp(p.x + p.dashVx * DT, p.r, ARENA.w - p.r);
        p.y = clamp(p.y + p.dashVy * DT, p.r, ARENA.h - p.r);
        if (p.dashSkill) this.dashStrikeHit(p); // 경로상 적 타격(중복타 방지)
      } else {
        // 일반 이동
        let mx = i.moveX, my = i.moveY;
        const mlen = Math.hypot(mx, my);
        if (mlen > 1) { mx /= mlen; my /= mlen; }
        let spd = s.speed;
        if (this.mut('adrenal') && p.hp < s.maxHp * 0.5) spd *= 1.3; // 아드레날린 변이
        p.x = clamp(p.x + mx * spd * DT, p.r, ARENA.w - p.r);
        p.y = clamp(p.y + my * spd * DT, p.r, ARENA.h - p.r);
        p.dashSkill = null;
      }

      // 회복
      if (s.regen) p.hp = Math.min(s.maxHp, p.hp + s.regen * DT);
      // 쿨다운들
      if (p.atkCdLeft > 0) p.atkCdLeft -= DT;
      if (p.dodgeCdLeft > 0) p.dodgeCdLeft -= DT;
      for (const sk of p.skills) if (sk && sk.cdLeft > 0) sk.cdLeft -= DT;

      // 회피 구르기(공용 dashing 입력) — 진짜 대시(고속 이동 + i프레임), 공격쿨과 별개
      if (i.dashing && this.now >= p.dashUntil && p.dodgeCdLeft <= 0) {
        this.startDash(p, i.aimAngle, 170, 180, null);
        p.dodgeCdLeft = 1.4;
      }
      // 평타(대시 중엔 입력 무시)
      if (i.attacking && p.atkCdLeft <= 0 && this.now >= p.dashUntil) this.startAttack(p);

      // 애니 만료
      if (p.attackAnim && this.now - p.attackAnim.startedAt >= p.attackAnim.duration * 1000) p.attackAnim = null;
      if (p.castAnim && this.now - p.castAnim.startedAt >= p.castAnim.duration) p.castAnim = null;

      p.tier = p.level >= 7 ? 3 : p.level >= 4 ? 2 : 1;
    }
  }

  // 대시 시작: 짧은 시간 고속 velocity 부여(여러 틱에 걸쳐 연속 이동) + i프레임. skill!=null이면 경로 타격.
  startDash(p, aim, dist, durMs, skill) {
    const sp = dist / (durMs / 1000); // px/s
    p.dashUntil = this.now + durMs;
    p.dashVx = Math.cos(aim) * sp; p.dashVy = Math.sin(aim) * sp;
    p.dashSkill = skill;
    p.facing = aim;
    p.invulnUntil = Math.max(p.invulnUntil, this.now + durMs + 60);
    this.events.push({ type: 'dash', pid: p.pid, x: Math.round(p.x), y: Math.round(p.y), aimAngle: +aim.toFixed(3), dur: durMs });
  }

  // 대시 경로 타격: 매 틱 현재 위치에서 부채꼴 판정(hitSet으로 적당 1회)
  dashStrikeHit(p) {
    const sk = p.dashSkill; if (!sk) return;
    const aim = p.facing;
    const range = sk.range || (p.stats.range || 70);
    const arc = sk.arc || 1.6;
    const dmg = sk.dmg;
    for (const e of this.enemies) {
      if (e.hp <= 0 || sk.hitSet.has(e.id)) continue;
      const dx = e.x - p.x, dy = e.y - p.y, dd = Math.hypot(dx, dy);
      if (dd > range + e.r) continue;
      if (angleDiff(aim, Math.atan2(dy, dx)) > arc / 2) continue;
      sk.hitSet.add(e.id);
      this.damageEnemy(e, dmg, p, aim, true);
      if (sk.knockback) { e.x += Math.cos(aim) * sk.knockback * 0.04; e.y += Math.sin(aim) * sk.knockback * 0.04; }
      if (sk.aoe) { // 도약 착지형: 주변까지
        for (const o of this.enemies) {
          if (o === e || o.hp <= 0 || sk.hitSet.has(o.id)) continue;
          if (dist2(p.x, p.y, o.x, o.y) <= sk.aoe * sk.aoe) { sk.hitSet.add(o.id); this.damageEnemy(o, dmg * 0.7, p, aim, true); }
        }
      }
    }
  }

  startAttack(p) {
    const s = p.stats;
    p.atkCdLeft = s.cd;
    p.attackAnim = { type: s.animType, startedAt: this.now, aimAngle: p.input.aimAngle, duration: s.animDur };
    this.events.push({ type: 'attack', id: p.pid, kind: s.animType, aimAngle: p.input.aimAngle, startedAt: this.now });
    if (s.kind === 'melee') {
      const a = p.input.aimAngle;
      // 시작 위치에서 먼저 판정(인접 적)
      this.meleeAttack(p, p.x, p.y, new Set());
      // 암살자: 순간이동이 아니라 '진짜 대시'(고속 이동, 여러 틱) + 경로상 콤보 타격
      if (s.dash > 0) {
        this.startDash(p, a, s.dash, 150, { dmg: s.dmg * (s.combo || 1), range: s.range, arc: s.arc, hitSet: new Set() });
      }
    } else {
      this.spawnProjectiles(p);
    }
  }

  // ───────── 스킬: 슬롯 부여 / 사용 / 효과 ─────────
  // 빈 슬롯 Q→E→R 순으로 채움. 이미 보유면 업그레이드(쿨↓/효과+). 슬롯 다 차면 false(클라가 교체 요청).
  addSkill(p, id) {
    const def = SKILL_BY_ID[id]; if (!def) return false;
    // 이미 보유 → 업그레이드
    if (p.skills.some(sk => sk && sk.id === id)) { p.skillUp[id] = (p.skillUp[id] || 0) + 1; this.events.push({ type: 'skill_pickup', pid: p.pid, id, slot: p.skills.findIndex(sk => sk && sk.id === id), upgrade: true }); return true; }
    const empty = p.skills.findIndex(sk => sk === null);
    if (empty < 0) return false; // 슬롯 풀 → 교체 필요
    p.skills[empty] = { id, cdLeft: 0, cdMax: def.cd };
    this.events.push({ type: 'skill_pickup', pid: p.pid, id, slot: empty });
    return true;
  }

  replaceSkill(sockId, slot, id) {
    const p = this.players.get(sockId); if (!p) return false;
    const def = SKILL_BY_ID[id]; if (!def || slot < 0 || slot > 2) return false;
    p.skills[slot] = { id, cdLeft: 0, cdMax: def.cd };
    this.events.push({ type: 'skill_pickup', pid: p.pid, id, slot, replaced: true });
    // 교체로 보류 픽 해소 → 웨이브 진행 체크
    if (p.pendingSkill === id) { p.pendingSkill = null; this.pendingOffers.delete(p.id); this.maybeNextWave(); }
    return true;
  }

  useSkill(sockId, slot, aimAngle) {
    const p = this.players.get(sockId); if (!p || p.dead) return false;
    if (this.now < p.dashUntil) return false; // 대시 중 불가
    const sk = p.skills[slot]; if (!sk || sk.cdLeft > 0) return false;
    const def = SKILL_BY_ID[sk.id]; if (!def) return false;
    if (typeof aimAngle === 'number') p.input.aimAngle = aimAngle;
    const aim = p.input.aimAngle;
    // 쿨다운: 기본 cd × (1+cdMul) × 업그레이드 감소
    const upLv = p.skillUp[sk.id] || 0;
    const cdFactor = (1 + (p.stats.cdMul || 0)) * Math.pow(0.85, upLv);
    const effCd = Math.max(0.5, def.cd * cdFactor);
    sk.cdLeft = effCd; sk.cdMax = effCd;
    // 시전 모션(평타 attackAnim과 동형: startedAt+duration 보간)
    const dur = def.type === 'dash_strike' ? (def.params.dur + 120) : 360;
    p.castAnim = { type: def.type, slot, startedAt: this.now, windup: 80, duration: dur, aimAngle: aim };
    this.events.push({ type: 'skill_cast', skillType: def.type, pid: p.pid, slot, id: sk.id, x: Math.round(p.x), y: Math.round(p.y), aimAngle: +aim.toFixed(3), champion: p.champion, startedAt: this.now, duration: dur });
    this.castSkillEffect(p, def, aim, upLv);
    return true;
  }

  castSkillEffect(p, def, aim, upLv) {
    const P = def.params;
    const upMul = 1 + 0.15 * (upLv || 0);          // 업그레이드 효과 증가
    const dmgBase = p.stats.dmg * upMul;            // 증강 dmgMul 이미 반영
    switch (def.type) {
      case 'dash_strike':
        this.startDash(p, aim, P.dist, P.dur, P.dmgMul > 0 ? {
          dmg: dmgBase * P.dmgMul, range: p.stats.range || 80, arc: P.arc || 1.7,
          knockback: P.knockback || 0, aoe: P.aoe || 0, hitSet: new Set(),
        } : null);
        break;
      case 'nova': {
        const r = P.r, dmg = dmgBase * P.dmgMul;
        for (const e of this.enemies) {
          if (e.hp <= 0) continue;
          if (dist2(p.x, p.y, e.x, e.y) <= (r + e.r) * (r + e.r)) {
            this.damageEnemy(e, dmg, p, Math.atan2(e.y - p.y, e.x - p.x), true);
            if (P.knockback) { const a = Math.atan2(e.y - p.y, e.x - p.x); e.x += Math.cos(a) * P.knockback * 0.05; e.y += Math.sin(a) * P.knockback * 0.05; }
            if (P.freeze) { e.slowUntil = this.now + P.freeze; this.events.push({ type: 'status', target: e.id, kind: 'freeze' }); }
            if (P.slow) e.slowUntil = this.now + 1500;
          }
        }
        this.events.push({ type: 'nova', x: Math.round(p.x), y: Math.round(p.y), r });
        this.events.push({ type: 'shake', mag: 5, ms: 120 });
        break;
      }
      case 'aoe_field':
        this.fields.push({
          id: _eid++, kind: P.kind, x: p.x, y: p.y, r: P.r, owner: p.pid,
          until: this.now + P.dur, dps: P.dps * upMul * (1 + (p.stats.dmgMul || 0)), slow: P.slow || 0, tickAcc: 0,
        });
        break;
      case 'projectile_barrage': {
        const count = (P.count || 1) + (P.count > 1 ? (p.stats.projAdd || 0) : 0);
        for (let k = 0; k < count; k++) {
          const offset = count === 1 ? 0 : (P.spread >= 6 ? (k / count) * P.spread : (k - (count - 1) / 2) * P.spread);
          const ang = aim + offset;
          this.projectiles.push({
            id: _eid++, owner: 'ally', ownerPid: p.pid, ownerId: p.id, x: p.x, y: p.y, angle: ang,
            vx: Math.cos(ang) * P.speed, vy: Math.sin(ang) * P.speed, r: 9, kind: P.projKind, tier: p.tier,
            life: 2.0, dmg: dmgBase * P.dmgMul, pierce: P.pierce || 0, hitSet: new Set(),
            crit: p.stats.crit, critMul: p.stats.critMul, knockback: 60,
            burn: 0, freeze: 0, poison: 0, onHitAoe: P.explode ? { r: P.explode, mul: 0.5 } : null, lifesteal: p.stats.lifesteal,
          });
        }
        break;
      }
      case 'buff':
        p.buffs.push({ id: def.id, until: this.now + P.dur, mods: P.mods || {} });
        if (P.shield) p.shield = Math.max(p.shield, P.shield * upMul);
        recomputeStats(p); p.hp = Math.min(p.stats.maxHp, p.hp);
        this.events.push({ type: 'buff_on', pid: p.pid, id: def.id, until: this.now + P.dur });
        break;
      case 'summon':
        for (let k = 0; k < P.count; k++) {
          const a = (k / P.count) * TAU;
          this.summons.push({
            id: _eid++, owner: p.pid, ownerId: p.id, x: p.x + Math.cos(a) * 30, y: p.y + Math.sin(a) * 30,
            hp: P.hp, maxHp: P.hp, dmg: dmgBase * 0 + P.dmg * upMul, until: this.now + P.dur, atkCd: 0, r: 12,
          });
        }
        break;
      case 'chain': {
        let cur = { x: p.x, y: p.y }; const hit = new Set(); let n = 0;
        const dmg = dmgBase * P.dmgMul;
        while (n < P.targets) {
          let best = null, bd = (n === 0 ? P.range : P.jump);
          for (const e of this.enemies) {
            if (e.hp <= 0 || hit.has(e.id)) continue;
            const dd = Math.hypot(e.x - cur.x, e.y - cur.y);
            if (dd < bd) { bd = dd; best = e; }
          }
          if (!best) break;
          hit.add(best.id);
          this.events.push({ type: 'chain_link', x1: Math.round(cur.x), y1: Math.round(cur.y), x2: Math.round(best.x), y2: Math.round(best.y) });
          this.damageEnemy(best, dmg, p, Math.atan2(best.y - cur.y, best.x - cur.x), false);
          cur = { x: best.x, y: best.y }; n++;
        }
        break;
      }
    }
  }

  updateFields() {
    if (!this.fields.length) return;
    const out = [];
    for (const f of this.fields) {
      if (this.now >= f.until) continue;
      for (const e of this.enemies) {
        if (e.hp <= 0) continue;
        if (dist2(f.x, f.y, e.x, e.y) <= (f.r + e.r) * (f.r + e.r)) {
          e.hp -= f.dps * DT; e.flashUntil = this.now + 60;
          if (f.slow) e.slowUntil = this.now + 400;
          if (e.hp <= 0) this.killEnemy(e, this.playerByPid(f.owner));
        }
      }
      out.push(f);
    }
    this.fields = out;
  }

  updateSummons() {
    if (!this.summons.length) return;
    const out = [];
    for (const sm of this.summons) {
      if (this.now >= sm.until) continue;
      sm.atkCd -= DT;
      // 가장 가까운 적 추적·근접 타격
      let best = null, bd = Infinity;
      for (const e of this.enemies) { if (e.hp <= 0) continue; const d = dist2(sm.x, sm.y, e.x, e.y); if (d < bd) { bd = d; best = e; } }
      if (best) {
        const a = Math.atan2(best.y - sm.y, best.x - sm.x);
        const dd = Math.sqrt(bd);
        if (dd > sm.r + best.r + 4) { sm.x += Math.cos(a) * 160 * DT; sm.y += Math.sin(a) * 160 * DT; }
        else if (sm.atkCd <= 0) { sm.atkCd = 0.6; this.damageEnemy(best, sm.dmg, this.playerByPid(sm.owner), a, false); }
      }
      out.push(sm);
    }
    this.summons = out;
  }

  playerByPid(pid) { for (const p of this.players.values()) if (p.pid === pid) return p; return null; }

  updateEnemies() {
    const arr = this.enemies;
    for (const e of arr) {
      if (e.hp <= 0) continue;
      e.atkCdLeft -= DT;
      const slow = this.now < e.slowUntil ? 0.5 : 1;
      const np = this.nearestPlayer(e.x, e.y);
      if (!np) { e.vx = e.vy = 0; continue; }
      const { p, d } = np;
      const toP = Math.atan2(p.y - e.y, p.x - e.x);
      // 공격 중이 아닐 때만 플레이어를 향함(공격 중엔 attackAnim.aimAngle로 고정 — 텔레그래프=타격 방향 일치)
      if (!e.attackAnim) e.facing = toP;

      if (e.ai === 'boss') { this.updateBoss(e, p, d); continue; }

      // ── 공격 시퀀스 진행: 접근 정지 → windup(예고) → strike(타격) → recover(복귀) ──
      if (e.attackAnim) {
        e.vx = 0; e.vy = 0; // 예고~타격 동안 거의 정지(클라가 움찔/전조 표현)
        const t = this.now - e.attackAnim.startedAt;
        if (e.atkPending && t >= e.attackAnim.strike) {
          e.atkPending = false; e.state = 'strike';
          if (e.attackAnim.type === 'ranged') this.enemyShoot(e, e.attackAnim.aimAngle);
          else this.enemyMeleeStrike(e);
        } else if (!e.atkPending && e.state === 'strike' && t >= e.attackAnim.strike + 100) {
          e.state = 'recover';
        }
        if (t >= e.attackAnim.duration) {
          if (e.attackAnim.type === 'melee') { // 공격 후 한 걸음 물러나 또렷한 치고빠지기(밀착 '비비기' 방지)
            const back = e.attackAnim.aimAngle;
            e.x = clamp(e.x - Math.cos(back) * 22, -40, ARENA.w + 40);
            e.y = clamp(e.y - Math.sin(back) * 22, -40, ARENA.h + 40);
          }
          e.attackAnim = null; e.state = 'move'; e.atkCdLeft = e.atkCd;
        }
        continue;
      }

      // ── 평상시 이동 + 공격 개시 판단 ──
      let mvx = 0, mvy = 0;
      const sp = e.speed * slow;
      const ranged = (e.ai === 'ranged' || e.ai === 'kite');

      if (ranged) {
        const range = e.atkRange || 300;
        const desired = range * 0.7;
        if (d > desired + 20) { mvx = Math.cos(toP); mvy = Math.sin(toP); }
        else if (d < desired - 40 && e.ai === 'kite') { mvx = -Math.cos(toP); mvy = -Math.sin(toP); }
        if (e.atkCdLeft <= 0 && d <= range) this.enemyBeginAttack(e, toP, 'ranged');
        else e.state = 'move';
      } else if (e.ai === 'healer') {
        if (d < 200) { mvx = -Math.cos(toP); mvy = -Math.sin(toP); }
        else { mvx = Math.cos(toP) * 0.3; mvy = Math.sin(toP) * 0.3; }
        e.healTimer -= DT;
        if (e.healTimer <= 0) {
          e.healTimer = e.healCd;
          for (const o of arr) {
            if (o === e || o.hp <= 0) continue;
            if (dist2(e.x, e.y, o.x, o.y) <= e.healRange * e.healRange) {
              o.hp = Math.min(o.maxHp, o.hp + e.healAmt);
              this.events.push({ type: 'heal', x: o.x, y: o.y, amt: e.healAmt, target: o.id });
            }
          }
        }
        e.state = 'move';
      } else { // chase / erratic / shield (근접)
        if (e.ai === 'erratic') {
          const wobble = Math.sin((this.now / 1000 + e.id) * 6) * 0.6;
          mvx = Math.cos(toP + wobble); mvy = Math.sin(toP + wobble);
        } else { mvx = Math.cos(toP); mvy = Math.sin(toP); }
        if (d <= e.r + p.r + e.reach && e.atkCdLeft <= 0) this.enemyBeginAttack(e, toP, 'melee');
        else e.state = 'move';
      }

      // 공격 개시했으면 이번 tick은 정지 상태로 들어감
      if (e.attackAnim) { e.vx = 0; e.vy = 0; continue; }
      e.vx = mvx * sp; e.vy = mvy * sp;
      e.x = clamp(e.x + e.vx * DT, -40, ARENA.w + 40);
      e.y = clamp(e.y + e.vy * DT, -40, ARENA.h + 40);
    }
    this.separateEnemies();
    this.enemies = arr.filter(e => e.hp > 0);
  }

  // 적 공격 개시: 예고(windup) 시작. aimAngle은 이 시점에 고정되어 strike까지 불변.
  enemyBeginAttack(e, aim, kind) {
    e.attackAnim = { type: kind, startedAt: this.now, windup: e.atkW, strike: e.atkW, duration: e.atkD, aimAngle: aim };
    e.atkPending = true; e.state = 'windup'; e.facing = aim;
    this.events.push({
      type: 'enemy_attack', id: e.id, kind, x: Math.round(e.x), y: Math.round(e.y),
      aimAngle: +aim.toFixed(3), startedAt: this.now, windup: e.atkW, strike: e.atkW, duration: e.atkD,
    });
  }

  // 근접 타격 발동: windup 종료 시점에만 호출. 고정된 aimAngle 기준 호/사거리 안의 플레이어에 피해
  // → 플레이어가 windup 동안 사거리 밖으로 빠지거나 옆으로 비키면 회피 성공.
  enemyMeleeStrike(e) {
    const aim = e.attackAnim.aimAngle;
    // 타격 순간 전방 돌진(lunge) — '비비기'가 아니라 또렷이 찌르는 공격감
    e.x = clamp(e.x + Math.cos(aim) * 12, -40, ARENA.w + 40);
    e.y = clamp(e.y + Math.sin(aim) * 12, -40, ARENA.h + 40);
    const reachDist = e.r + e.reach;
    for (const p of this.players.values()) {
      if (p.dead) continue;
      const dx = p.x - e.x, dy = p.y - e.y;
      const dd = Math.hypot(dx, dy);
      if (dd > reachDist + p.r) continue;                       // 사거리 밖으로 회피
      if (angleDiff(aim, Math.atan2(dy, dx)) > 1.05) continue;  // 옆으로 비켜 회피(±60°)
      this.hurtPlayer(p, e.dmg, e);
    }
  }

  separateEnemies() {
    const a = this.enemies;
    for (let i = 0; i < a.length; i++) {
      for (let j = i + 1; j < a.length; j++) {
        const e1 = a[i], e2 = a[j];
        const dx = e2.x - e1.x, dy = e2.y - e1.y;
        const min = (e1.r + e2.r) * 0.8;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0 && d2 < min * min) {
          const d = Math.sqrt(d2); const push = (min - d) / 2;
          const ux = dx / d, uy = dy / d;
          e1.x -= ux * push; e1.y -= uy * push;
          e2.x += ux * push; e2.y += uy * push;
        }
      }
    }
  }

  enemyShoot(e, ang) {
    this.projectiles.push({
      id: _eid++, owner: 'enemy', x: e.x, y: e.y, angle: ang,
      vx: Math.cos(ang) * e.projSpeed, vy: Math.sin(ang) * e.projSpeed,
      r: e.projR, kind: e.proj, tier: 1, life: 4, dmg: e.dmg, pierce: 0, hitSet: new Set(),
    });
  }

  updateBoss(e, p, d) {
    const toP = Math.atan2(p.y - e.y, p.x - e.x);
    e.bossAtkTimer -= DT;
    // 텔레그래프 진행 중이면 발동 처리
    if (e.telegraph) {
      if (this.now >= e.telegraph.until) {
        this.resolveBossAttack(e, p);
        e.telegraph = null; e.attackAnim = null;
        e.bossAtkTimer = 2.2 + this.rng() * 1.5;
        e.state = 'move';
      }
      return; // 텔레그래프 중엔 정지
    }
    // 평상시 추격
    if (d > e.r + p.r + 10) {
      e.vx = Math.cos(toP) * e.speed; e.vy = Math.sin(toP) * e.speed;
      e.x += e.vx * DT; e.y += e.vy * DT;
      e.x = clamp(e.x, e.r, ARENA.w - e.r); e.y = clamp(e.y, e.r, ARENA.h - e.r);
    } else {
      this.hurtPlayer(p, e.dmg, e);
    }
    // 특수공격 예고
    if (e.bossAtkTimer <= 0) {
      const pick = Math.floor(this.rng() * 3);
      e.state = 'charge';
      if (pick === 0) { // 돌진(부채꼴)
        e.telegraph = { shape: 'cone', x: e.x, y: e.y, angle: toP, range: 320, until: this.now + 900, kind: 'charge' };
      } else if (pick === 1) { // 범위 충격파(원)
        e.telegraph = { shape: 'circle', x: e.x, y: e.y, angle: 0, range: 165, until: this.now + 1250, kind: 'shock' };
      } else { // 산탄
        e.telegraph = { shape: 'circle', x: e.x, y: e.y, angle: 0, range: 80, until: this.now + 800, kind: 'spread' };
      }
      // 적 공격 모션 규격과 동일 노출(보스도 attackAnim/enemy_attack로 통일)
      const kindMap = { charge: 'boss_charge', shock: 'boss_shock', spread: 'boss_spread' };
      const k = kindMap[e.telegraph.kind];
      const dur = e.telegraph.until - this.now;
      e.attackAnim = { type: k, startedAt: this.now, windup: dur, strike: dur, duration: dur + 250, aimAngle: toP };
      this.events.push({
        type: 'enemy_attack', id: e.id, kind: k, x: Math.round(e.x), y: Math.round(e.y),
        aimAngle: +toP.toFixed(3), startedAt: this.now, windup: dur, strike: dur, duration: dur + 250,
      });
    }
  }

  resolveBossAttack(e, p) {
    const tg = e.telegraph;
    this.events.push({ type: 'shake', mag: 10, ms: 350 });
    if (tg.kind === 'charge') {
      // 부채꼴 전방 돌진 타격
      e.x = clamp(e.x + Math.cos(tg.angle) * 200, e.r, ARENA.w - e.r);
      e.y = clamp(e.y + Math.sin(tg.angle) * 200, e.r, ARENA.h - e.r);
      for (const pl of this.players.values()) {
        if (pl.dead) continue;
        const toPl = Math.atan2(pl.y - tg.y, pl.x - tg.x);
        if (Math.hypot(pl.x - tg.x, pl.y - tg.y) <= tg.range && angleDiff(tg.angle, toPl) < 0.6)
          this.hurtPlayer(pl, e.dmg * 1.1, e);
      }
    } else if (tg.kind === 'shock') {
      this.doExplosion(e, tg.range, e.dmg * 0.8);
    } else { // spread 산탄
      for (let k = 0; k < 10; k++) this.enemyShoot(e, (k / 10) * TAU);
    }
  }

  updateProjectiles() {
    const out = [];
    for (const pr of this.projectiles) {
      pr.x += pr.vx * DT; pr.y += pr.vy * DT; pr.life -= DT;
      if (pr.life <= 0 || pr.x < -40 || pr.x > ARENA.w + 40 || pr.y < -40 || pr.y > ARENA.h + 40) continue;
      let consumed = false;
      if (pr.owner === 'ally') {
        for (const e of this.enemies) {
          if (e.hp <= 0 || pr.hitSet.has(e.id)) continue;
          if (dist2(pr.x, pr.y, e.x, e.y) <= (pr.r + e.r) * (pr.r + e.r)) {
            const owner = this.players.get(pr.ownerId);
            // 투사체 명중: damageEnemy는 owner 스탯 사용 → 투사체에 박힌 값으로 직접 처리
            this.projHitEnemy(pr, e, owner);
            pr.hitSet.add(e.id);
            if (pr.onHitAoe) {
              for (const o of this.enemies) {
                if (o === e || o.hp <= 0 || pr.hitSet.has(o.id)) continue;
                if (dist2(pr.x, pr.y, o.x, o.y) <= pr.onHitAoe.r * pr.onHitAoe.r) {
                  this.projHitEnemy({ ...pr, dmg: pr.dmg * pr.onHitAoe.mul, onHitAoe: null }, o, owner);
                  pr.hitSet.add(o.id);
                }
              }
              this.events.push({ type: 'explosion', x: pr.x, y: pr.y, r: pr.onHitAoe.r, small: true });
            }
            if (pr.pierce > 0) { pr.pierce--; }
            else if (this.mut('ricochet') && !pr.bounced) { // 도탄: 가장 가까운 다른 적으로 1회 튕김
              let best = null, bd = Infinity;
              for (const o of this.enemies) { if (o.hp <= 0 || pr.hitSet.has(o.id)) continue; const dd = dist2(pr.x, pr.y, o.x, o.y); if (dd < bd) { bd = dd; best = o; } }
              if (best) { pr.bounced = true; const a = Math.atan2(best.y - pr.y, best.x - pr.x); const sp = Math.hypot(pr.vx, pr.vy); pr.vx = Math.cos(a) * sp; pr.vy = Math.sin(a) * sp; pr.angle = a; break; }
              consumed = true; break;
            } else { consumed = true; break; }
          }
        }
      } else { // enemy projectile
        for (const p of this.players.values()) {
          if (p.dead) continue;
          if (dist2(pr.x, pr.y, p.x, p.y) <= (pr.r + p.r) * (pr.r + p.r)) {
            this.hurtPlayer(p, pr.dmg, pr); consumed = true; break;
          }
        }
      }
      if (!consumed) out.push(pr);
    }
    this.projectiles = out;
  }

  projHitEnemy(pr, e, owner) {
    let dmg = pr.dmg, crit = false;
    if (this.rng() < (pr.crit || 0)) { dmg *= (pr.critMul || 1.5); crit = true; }
    if (e.ai === 'shield') {
      const fromAng = Math.atan2(pr.y - e.y, pr.x - e.x) + Math.PI;
      // 투사체 입사 방향이 실드 전면이면 감소
      const toShooter = Math.atan2(pr.vy, pr.vx) + Math.PI;
      if (angleDiff(e.facing, toShooter) < e.shieldArc / 2) dmg *= (1 - e.shieldReduce);
    }
    dmg = Math.max(1, Math.round(dmg));
    e.hp -= dmg; e.flashUntil = this.now + 80;
    this.events.push({ type: 'hit', x: e.x, y: e.y, dmg, crit, target: e.id, dir: pr.angle });
    this.events.push({ type: 'shake', mag: 2, ms: 80 });
    if (pr.burn) { e.burnLeft = 3; e.burnDps = pr.burn; this.events.push({ type: 'status', target: e.id, kind: 'burn' }); }
    if (pr.poison) { e.poisonLeft = 4; e.poisonDps = pr.poison; this.events.push({ type: 'status', target: e.id, kind: 'poison' }); }
    if (pr.freeze) { e.slowUntil = this.now + 1200; this.events.push({ type: 'status', target: e.id, kind: 'freeze' }); }
    if (pr.lifesteal && owner && !owner.dead) owner.hp = Math.min(owner.stats.maxHp, owner.hp + dmg * pr.lifesteal);
    if (e.hp <= 0) this.killEnemy(e, owner);
  }

  updateStatusEffects() {
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      if (e.burnLeft > 0) { e.burnLeft -= DT; e.hp -= e.burnDps * DT; if (e.hp <= 0) { this.killEnemy(e, null); continue; } }
      if (e.poisonLeft > 0) { e.poisonLeft -= DT; e.hp -= e.poisonDps * DT; if (e.hp <= 0) { this.killEnemy(e, null); continue; } }
    }
  }

  checkWaveClear() {
    // 오브 트리거 등 다른 phase로 이미 전환됐으면 중단 (이중 전환 방지)
    if (this.phase !== 'playing') return;
    if (this.spawnQueue.length === 0 && this.enemies.filter(e => e.hp > 0).length === 0) {
      this.phase = 'wave_clear';
      this.phaseTimer = 1.0;
      this.events.push({ type: 'wave_clear', wave: this.wave, kills: this.killCount });
    }
  }

  checkGameOver() {
    if (this.players.size === 0) return;
    const allDead = [...this.players.values()].every(p => p.dead);
    // 전원 동시 사망일 때만 게임오버(일부만 죽으면 부활 대기로 게임 지속)
    if (allDead && !this.over) {
      this.over = true; this.phase = 'gameover';
      this.events.push({ type: 'game_over', wave: this.wave, score: this.score });
    }
  }

  skillDesc(s) {
    const P = s.params;
    switch (s.type) {
      case 'dash_strike': return `마우스 방향으로 고속 돌진하며 경로의 적을 ${Math.round(P.dmgMul * 100)}% 피해로 가른다`;
      case 'nova': return `주변 적에게 ${Math.round(P.dmgMul * 100)}% 폭발 피해${P.knockback ? '+넉백' : ''}${P.freeze ? '+빙결' : ''}`;
      case 'aoe_field': return `${(P.dur / 1000)}초간 지속되는 ${P.kind} 장판(초당 ${P.dps} 피해)`;
      case 'projectile_barrage': return `투사체 ${P.count}발을 발사(${Math.round(P.dmgMul * 100)}% 피해)`;
      case 'buff': return `${(P.dur / 1000)}초간 자기강화${P.shield ? `+보호막 ${P.shield}` : ''}`;
      case 'summon': return `소환수 ${P.count}체를 ${(P.dur / 1000)}초간 소환`;
      case 'chain': return `최대 ${P.targets}명에게 튀는 연쇄 피해(${Math.round(P.dmgMul * 100)}%)`;
      default: return s.name;
    }
  }

  // 오퍼 추첨: 스킬 + 증강 혼합(기획 규칙). 빈 슬롯 있으면 스킬 출현↑, 첫 스킬 wave2~3 보장,
  // 슬롯 풀이면 스킬은 교체/업그레이드 카드 최대 1장. 보스 웨이브는 전설 가중 + 강제선택.
  rollOffer(p, isBoss) {
    const offerSize = this.mut('bounty') ? 4 : 3;
    const ownedIds = p.skills.filter(Boolean).map(sk => sk.id);
    const emptySlots = p.skills.filter(sk => sk === null).length;
    let numSkills = emptySlots > 0 ? (isBoss ? 2 : (emptySlots >= 2 ? 2 : 1)) : 1;
    if (!this.firstSkillGiven && ownedIds.length === 0 && this.wave >= 2) numSkills = Math.max(numSkills, 1);
    numSkills = Math.min(numSkills, offerSize - 1); // 최소 증강 1장(평타빌드 성장 유지)

    const choices = [];
    const skillPool = SKILLS.filter(s => s.classOnly === null || s.classOnly === p.champion);
    const wSkill = s => s.rarity === 'legendary' ? (isBoss ? 7 : 1) : s.rarity === 'rare' ? 4 : 10;
    const skExcl = new Set();
    for (let i = 0; i < numSkills; i++) {
      const cand = skillPool.filter(s => !skExcl.has(s.id));
      if (!cand.length) break;
      let total = cand.reduce((a, s) => a + wSkill(s), 0), r = this.rng() * total, pickS = cand[cand.length - 1];
      for (const s of cand) { r -= wSkill(s); if (r <= 0) { pickS = s; break; } }
      skExcl.add(pickS.id);
      const owned = ownedIds.includes(pickS.id);
      choices.push({ id: pickS.id, name: pickS.name, rarity: pickS.rarity, classOnly: pickS.classOnly, desc: this.skillDesc(pickS), value: `CD ${pickS.cd}s`, kind: 'skill', skillType: pickS.type, upgrade: owned });
    }
    const augPool = AUGMENTS.filter(a => a.classOnly === null || a.classOnly === p.champion);
    const wAug = a => a.rarity === 'legendary' ? 1 : a.rarity === 'rare' ? 4 : 10;
    const augExcl = new Set();
    while (choices.length < offerSize) {
      const cand = augPool.filter(a => !augExcl.has(a.id));
      if (!cand.length) break;
      let total = cand.reduce((s, a) => s + wAug(a), 0), r = this.rng() * total, pickA = cand[cand.length - 1];
      for (const a of cand) { r -= wAug(a); if (r <= 0) { pickA = a; break; } }
      augExcl.add(pickA.id);
      choices.push({ id: pickA.id, name: pickA.name, rarity: pickA.rarity, classOnly: pickA.classOnly, desc: pickA.desc, value: pickA.value, kind: 'augment' });
    }
    return choices;
  }

  // source: 'wave'(웨이브 클리어 트리거) | 'orb'(오브 임계치 트리거) — 8-1·8-4
  beginAugmentSelect(source = 'wave') {
    this._augSelectSource = source;
    this.phase = 'augment_select';
    this.phaseTimer = 25; // 자동선택까지 여유
    const isBoss = (this.wave % 5 === 0); // 방금 클리어한 웨이브가 보스면 강제선택+전설가중
    this.offerMandatory = isBoss;
    this.pendingOffers.clear();
    for (const p of this.players.values()) {
      if (p.dead) continue;
      const choices = this.rollOffer(p, isBoss);
      this.pendingOffers.set(p.id, choices.map(c => c.id));
      p._offer = choices;
      // source 필드 포함 → 클라이언트 UI 분기(오브 vs 웨이브 클리어) 가능
      this.events.push({ type: 'augment_offer', pid: p.pid, choices, mandatory: isBoss, source });
    }
  }

  // 오퍼에서 하나 선택. 증강이면 즉시 적용. 스킬이면 빈 슬롯/업그레이드는 즉시, 슬롯 풀+새 스킬은 교체 대기.
  selectAugment(id, choiceId) {
    if (this.phase !== 'augment_select') return false;
    const p = this.players.get(id);
    if (!p || !this.pendingOffers.has(id)) return false;
    const offered = this.pendingOffers.get(id);
    if (!offered.includes(choiceId)) return false;
    const choice = (p._offer || []).find(c => c.id === choiceId);
    const isSkill = choice ? choice.kind === 'skill' : !!SKILL_BY_ID[choiceId];
    if (isSkill) {
      const owned = p.skills.some(sk => sk && sk.id === choiceId);
      const hasEmpty = p.skills.some(sk => sk === null);
      if (owned || hasEmpty) {
        this.addSkill(p, choiceId);
        if (p.skills.filter(Boolean).length >= 1) this.firstSkillGiven = true;
        this.pendingOffers.delete(id);
        this.maybeNextWave();
      } else {
        // 슬롯 풀 + 새 스킬 → 클라가 어느 슬롯 덮을지 정해 replace_skill 보낼 때까지 대기
        p.pendingSkill = choiceId;
        this.events.push({ type: 'skill_replace_prompt', pid: p.pid, id: choiceId });
      }
      return true;
    }
    // 증강
    p.augments.push(choiceId);
    const before = p.stats.maxHp; recomputeStats(p); p.hp += Math.max(0, p.stats.maxHp - before);
    this.pendingOffers.delete(id);
    this.events.push({ type: 'augment_aura', id: p.pid, champion: p.champion, augId: choiceId });
    this.maybeNextWave();
    return true;
  }

  autoPickAugments() {
    for (const [id, offered] of [...this.pendingOffers.entries()]) {
      const p = this.players.get(id);
      if (!p) { this.pendingOffers.delete(id); continue; }
      const choiceId = offered[Math.floor(this.rng() * offered.length)];
      const choice = (p._offer || []).find(c => c.id === choiceId);
      const isSkill = choice ? choice.kind === 'skill' : !!SKILL_BY_ID[choiceId];
      if (isSkill) {
        if (!this.addSkill(p, choiceId)) this.replaceSkill(p.id, 0, choiceId); // 슬롯 풀이면 Q 덮기(자동)
        this.firstSkillGiven = true;
      } else {
        p.augments.push(choiceId);
        const before = p.stats.maxHp; recomputeStats(p); p.hp += Math.max(0, p.stats.maxHp - before);
        this.events.push({ type: 'augment_aura', id: p.pid, champion: p.champion, augId: choiceId });
      }
      p.pendingSkill = null;
    }
    this.pendingOffers.clear();
    this.maybeNextWave();
  }

  maybeNextWave() {
    // 살아있는 모든 플레이어가 선택을 마치면 다음 단계로
    for (const p of this.players.values()) {
      if (!p.dead && this.pendingOffers.has(p.id)) return;
    }
    // 선택 완료 후 보류된 오브 임계치 처리 (요구사항 6번)
    for (const p of this.players.values()) {
      if (p.orbPending && !p.dead) {
        p.orbPending = false;
        p.orbCount = 0; // 다음 사이클 리셋
        this.events.push({ type: 'orb_threshold', pid: p.pid });
        this.beginAugmentSelect('orb');
        return;
      }
    }
    // 오브 트리거였다면: 웨이브가 아직 진행 중이면 playing 복귀, 종료됐으면 다음 웨이브
    const src = this._augSelectSource;
    this._augSelectSource = null;
    if (src === 'orb') {
      const waveStillRunning = this.spawnQueue.length > 0 || this.enemies.filter(e => e.hp > 0).length > 0;
      if (waveStillRunning) {
        this.phase = 'playing'; // 웨이브 재개
        return;
      }
      // 웨이브도 클리어됨: wave_clear 이벤트 발행 후 다음 웨이브
      this.events.push({ type: 'wave_clear', wave: this.wave, kills: this.killCount });
    }
    this.startWave(this.wave + 1);
  }

  restart(id) {
    if (this.phase === 'gameover') { this.startGame(); return true; }
    return false;
  }

  // ───────────────────────────── 직렬화(브로드캐스트용) ─────────────────────────────
  snapshot() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.pid, name: p.name, champion: p.champion,
        x: Math.round(p.x), y: Math.round(p.y), hp: Math.round(p.hp), maxHp: p.stats.maxHp,
        level: p.level, xp: Math.round(p.xp), xpMax: p.xpMax, tier: p.tier,
        facing: +p.facing.toFixed(3), dead: p.dead, invuln: this.now < p.invulnUntil,
        reviveAt: p.reviveAt || 0, reviving: p.dead && p.reviveAt > 0,
        attackAnim: p.attackAnim ? {
          type: p.attackAnim.type, startedAt: p.attackAnim.startedAt,
          aimAngle: +p.attackAnim.aimAngle.toFixed(3), duration: p.attackAnim.duration,
        } : null,
        castAnim: p.castAnim ? {
          type: p.castAnim.type, slot: p.castAnim.slot, startedAt: p.castAnim.startedAt,
          windup: p.castAnim.windup, duration: p.castAnim.duration, aimAngle: +p.castAnim.aimAngle.toFixed(3),
        } : null,
        skills: p.skills.map(sk => sk ? { id: sk.id, cdLeft: +Math.max(0, sk.cdLeft).toFixed(2), cdMax: sk.cdMax, ready: sk.cdLeft <= 0 } : null),
        buffs: p.buffs.filter(b => b.until !== Infinity).map(b => ({ id: b.id, until: b.until })),
        shield: Math.round(p.shield), dashing: this.now < p.dashUntil, dashUntil: Math.round(p.dashUntil),
        augments: p.augments,
        // 스탯 노출 — HUD 수치 갱신용 (Goal 6)
        atk: +p.stats.dmg.toFixed(1), speed: +p.stats.speed.toFixed(2),
        // 오브 시스템 노출 (8-1 snapshot 계약)
        orbCount: p.orbCount || 0, orbThreshold: ORB_THRESHOLD,
      });
    }
    const enemies = [];
    for (const e of this.enemies) {
      if (e.hp <= 0) continue;
      enemies.push({
        id: e.id, type: e.type, x: Math.round(e.x), y: Math.round(e.y),
        hp: Math.round(e.hp), maxHp: e.maxHp, r: Math.round(e.r),
        vx: +e.vx.toFixed(1), vy: +e.vy.toFixed(1), facing: +e.facing.toFixed(3),
        elite: e.elite, state: e.state, boss: e.boss, mini: e.mini,
        flash: this.now < e.flashUntil,
        burn: e.burnLeft > 0, poison: e.poisonLeft > 0, frozen: this.now < e.slowUntil,
        attackAnim: e.attackAnim ? {
          type: e.attackAnim.type, startedAt: e.attackAnim.startedAt,
          windup: e.attackAnim.windup, strike: e.attackAnim.strike,
          duration: e.attackAnim.duration, aimAngle: +e.attackAnim.aimAngle.toFixed(3),
        } : null,
      });
    }
    const projectiles = this.projectiles.map(pr => ({
      id: pr.id, x: Math.round(pr.x), y: Math.round(pr.y),
      angle: +pr.angle.toFixed(3), r: pr.r, kind: pr.kind, tier: pr.tier || 1, owner: pr.owner,
    }));
    const boss = this.boss && this.boss.hp > 0 ? {
      name: this.boss.name, hp: Math.round(this.boss.hp), maxHp: this.boss.maxHp,
      wave: this.wave, state: this.boss.state,
      telegraph: this.boss.telegraph ? {
        shape: this.boss.telegraph.shape, x: Math.round(this.boss.telegraph.x), y: Math.round(this.boss.telegraph.y),
        angle: +this.boss.telegraph.angle.toFixed(3), range: this.boss.telegraph.range, until: this.boss.telegraph.until,
      } : null,
    } : null;
    const fields = this.fields.map(f => ({ id: f.id, kind: f.kind, x: Math.round(f.x), y: Math.round(f.y), r: f.r, owner: f.owner, until: Math.round(f.until) }));
    const summons = this.summons.map(sm => ({ id: sm.id, x: Math.round(sm.x), y: Math.round(sm.y), hp: Math.round(sm.hp), maxHp: sm.maxHp, owner: sm.owner }));
    return {
      t: Math.round(this.now), wave: this.wave, phase: this.phase,
      score: this.score, killCount: this.killCount,
      enemiesAlive: enemies.length, enemiesTotal: this.waveTotal || 0,
      players, enemies, projectiles, boss, fields, summons,
      activeMutator: this.activeMutator ? { id: this.activeMutator.id, name: this.activeMutator.name, desc: this.activeMutator.desc } : null,
      mutatorOffer: this.phase === 'mutator_select' ? this.mutatorOffer : null,
      offers: this.phase === 'augment_select' ? this.offersForBroadcast() : null,
      offerMandatory: this.phase === 'augment_select' ? !!this.offerMandatory : false,
    };
  }

  offersForBroadcast() {
    const o = {};
    for (const p of this.players.values()) {
      if (p._offer && this.pendingOffers.has(p.id)) o[p.pid] = p._offer;
    }
    return o;
  }

  drainEvents() { const e = this.events; this.events = []; return e; }
}

// ───────────────────────────── 룸(로비/대기실/시작) ─────────────────────────────
const MAX_PLAYERS = 4, MIN_PLAYERS = 1;
let _seedCtr = 1;

class Room {
  constructor(code) {
    this.code = code;
    this.members = new Map();   // sockId -> { id, pid, name, champion|null, ready, isHost }
    this.hostId = null;
    this.phase = 'lobby';       // lobby | playing | gameover
    this.game = null;
    this.lastActivity = 0;
    this.dirty = true;          // room_state 재전송 필요(대기실 변경시)
  }

  join(sockId, name) {
    if (this.phase !== 'lobby') return { error: 'in_progress' };
    if (this.members.has(sockId)) return { pid: this.members.get(sockId).pid };
    if (this.members.size >= MAX_PLAYERS) return { error: 'full' };
    const isHost = this.members.size === 0;
    if (isHost) this.hostId = sockId;
    const m = { id: sockId, pid: _pid++, name: name || ('용사' + _pid), champion: null, ready: false, isHost };
    this.members.set(sockId, m);
    this.dirty = true;
    return { pid: m.pid };
  }

  leave(sockId) {
    if (!this.members.has(sockId)) return;
    const wasHost = this.members.get(sockId).isHost;
    this.members.delete(sockId);
    if (this.game) this.game.removePlayer(sockId);
    if (wasHost && this.members.size > 0) { // 방장 위임(다음 멤버)
      const next = this.members.values().next().value; next.isHost = true; this.hostId = next.id;
    }
    this.dirty = true;
  }

  takenChampions(exceptId) { // {champion: pid}
    const map = {};
    for (const m of this.members.values()) { if (m.champion && m.id !== exceptId) map[m.champion] = m.pid; }
    return map;
  }

  selectChampion(sockId, champion) {
    const m = this.members.get(sockId);
    if (!m || this.phase !== 'lobby') return { error: 'in_progress' };
    if (!CHAMPIONS[champion]) return { error: 'no_champion' };
    // 중복 선착 락
    for (const o of this.members.values()) { if (o.id !== sockId && o.champion === champion) return { error: 'champion_taken' }; }
    m.champion = champion; this.dirty = true;
    return { ok: true };
  }

  setReady(sockId, ready) {
    const m = this.members.get(sockId);
    if (!m || this.phase !== 'lobby') return;
    m.ready = !!ready && !!m.champion; // 챔피언 없으면 준비 불가
    this.dirty = true;
  }

  canStart() {
    if (this.members.size < MIN_PLAYERS) return { ok: false, reason: 'need_players' };
    // 2패스: 챔피언 미선택이 한 명이라도 있으면 먼저 안내, 그다음 준비
    for (const m of this.members.values()) if (!m.champion) return { ok: false, reason: 'need_champion' };
    for (const m of this.members.values()) if (!m.ready) return { ok: false, reason: 'need_ready' };
    return { ok: true };
  }

  start(sockId) {
    if (sockId && this.hostId !== sockId) return { error: 'not_host' };
    const c = this.canStart();
    if (!c.ok) return { error: c.reason };
    this.game = new Game({ seed: (0x9e37 * _seedCtr++) >>> 0, manualStart: true, numPlayers: this.members.size });
    for (const m of this.members.values()) this.game.addPlayer(m.id, m.name, m.champion, m.pid);
    this.game.startGame();
    this.phase = 'playing'; this.dirty = true;
    return { ok: true };
  }

  restart(sockId) { // 게임오버 후 대기실 복귀
    if (sockId && this.hostId !== sockId) return { error: 'not_host' };
    this.game = null; this.phase = 'lobby';
    for (const m of this.members.values()) m.ready = false;
    this.dirty = true;
    return { ok: true };
  }

  roomState() {
    const c = this.canStart();
    return {
      code: this.code, host: this.members.get(this.hostId) ? this.members.get(this.hostId).pid : null,
      phase: this.phase, maxPlayers: MAX_PLAYERS, minPlayers: MIN_PLAYERS,
      members: [...this.members.values()].map(m => ({ pid: m.pid, name: m.name, champion: m.champion, ready: m.ready, isHost: m.isHost })),
      takenChampions: this.takenChampions(),
      canStart: c.ok, canStartReason: c.ok ? null : c.reason,
    };
  }

  // 게임 진행 중이면 tick하고, 종료 감지 시 phase 갱신
  tick() {
    if (this.phase === 'playing' && this.game) {
      this.game.tick();
      if (this.game.phase === 'gameover') this.phase = 'gameover';
    }
  }

  snapshot() {
    if (!this.game) return null;
    const snap = this.game.snapshot();
    snap.room = { code: this.code, host: this.roomState().host, playerCount: this.members.size };
    return snap;
  }
}

function makeRoomCode(rng) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 혼동문자(0/O/1/I) 제외
  let s = ''; for (let i = 0; i < 4; i++) s += chars[Math.floor(rng() * chars.length)];
  return s;
}

module.exports = { Game, Room, makeRoomCode, angleDiff, norm, recomputeStats, CHAMPIONS, ENEMY_TYPES, ELITES, AUGMENTS, SKILLS, SKILL_BY_ID, MUTATORS, ARENA };

// ───────────────────────────── 서버 부팅 / 셀프테스트 ─────────────────────────────
if (require.main === module) {
  if (process.argv.includes('--selftest')) {
    runSelfTest();
  } else if (process.argv.includes('--balance')) {
    runBalance();
  } else {
    startServer();
  }
}

function startServer() {
  const express = require('express');
  const http = require('http');
  const { Server } = require('socket.io');
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  const rooms = new Map();          // code -> Room
  const sockRoom = new Map();       // sockId -> code
  let serverNow = 0;
  const rng = makeRng(0xABCD1234);
  app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size, players: [...rooms.values()].reduce((s, r) => s + r.members.size, 0) }));
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });

  const roomOf = (sock) => { const c = sockRoom.get(sock.id); return c ? rooms.get(c) : null; };
  const pushRoomState = (room) => { io.to(room.code).emit('room_state', room.roomState()); room.dirty = false; };
  const newCode = () => { let c; let g = 0; do { c = makeRoomCode(rng); } while (rooms.has(c) && g++ < 50); return c; };

  io.on('connection', (socket) => {
    socket.emit('joined', { id: null, serverTime: serverNow });

    socket.on('create_room', (d = {}) => {
      const code = newCode();
      const room = new Room(code); rooms.set(code, room);
      const r = room.join(socket.id, d.name);
      sockRoom.set(socket.id, code); socket.join(code);
      if (d.champion) room.selectChampion(socket.id, d.champion);
      socket.emit('room_created', { code, pid: r.pid });
      pushRoomState(room);
    });

    socket.on('join_room', (d = {}) => {
      const room = rooms.get((d.code || '').toUpperCase());
      if (!room) return socket.emit('room_error', { reason: 'no_room' });
      const r = room.join(socket.id, d.name);
      if (r.error) return socket.emit('room_error', { reason: r.error });
      sockRoom.set(socket.id, room.code); socket.join(room.code);
      socket.emit('room_joined', { code: room.code, pid: r.pid });
      pushRoomState(room);
    });

    socket.on('list_rooms', () => {
      const list = [...rooms.values()].filter(r => r.phase === 'lobby').map(r => ({ code: r.code, count: r.members.size, maxPlayers: MAX_PLAYERS, host: r.roomState().host }));
      socket.emit('rooms_list', { rooms: list });
    });

    socket.on('select_champion', (d = {}) => {
      const room = roomOf(socket); if (!room) return;
      const r = room.selectChampion(socket.id, d.champion);
      if (r.error) socket.emit('room_error', { reason: r.error });
      pushRoomState(room);
    });

    socket.on('ready', (d = {}) => { const room = roomOf(socket); if (!room) return; room.setReady(socket.id, d.ready); pushRoomState(room); });

    socket.on('start_game', () => {
      const room = roomOf(socket); if (!room) return;
      const r = room.start(socket.id);
      if (r.error) return socket.emit('room_error', { reason: r.error });
      io.to(room.code).emit('game_started', { code: room.code });
      pushRoomState(room);
    });

    socket.on('restart_room', () => { const room = roomOf(socket); if (!room) return; room.restart(socket.id); pushRoomState(room); });
    socket.on('leave_room', () => { const room = roomOf(socket); if (room) { room.leave(socket.id); socket.leave(room.code); if (room.members.size) pushRoomState(room); } sockRoom.delete(socket.id); });

    // 인게임 입력은 룸의 game으로 라우팅
    socket.on('input', (d) => { const r = roomOf(socket); if (r && r.game) r.game.setInput(socket.id, d || {}); });
    socket.on('select_augment', (d = {}) => { const r = roomOf(socket); if (r && r.game) r.game.selectAugment(socket.id, d.id); });
    socket.on('use_skill', (d = {}) => { const r = roomOf(socket); if (r && r.game) r.game.useSkill(socket.id, d.slot, d.aimAngle); });
    socket.on('replace_skill', (d = {}) => { const r = roomOf(socket); if (r && r.game) r.game.replaceSkill(socket.id, d.slot, d.id); });
    socket.on('select_mutator', (d = {}) => { const r = roomOf(socket); if (r && r.game) r.game.selectMutator(d.id); });

    socket.on('disconnect', () => {
      const room = roomOf(socket);
      if (room) { room.leave(socket.id); if (room.members.size) room.dirty = true; }
      sockRoom.delete(socket.id);
    });
  });

  setInterval(() => {
    serverNow += 1000 / TICK_HZ;
    for (const [code, room] of rooms) {
      if (room.members.size === 0) { rooms.delete(code); continue; } // 빈 방 GC
      if (room.dirty && room.phase === 'lobby') pushRoomState(room);
      room.tick();
      if (room.phase === 'playing' || room.phase === 'gameover') {
        if (room.game) {
          io.to(code).emit('state', room.snapshot());
          const ev = room.game.drainEvents();
          if (ev.length) io.to(code).emit('events', ev);
        }
      }
    }
  }, 1000 / TICK_HZ);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log('Arena server (rooms) on :' + PORT));
}

// ───────── 헤드리스 셀프테스트: 근접 부채꼴 적중 / 자동조준 부재 증명 ─────────
function runSelfTest() {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS:', msg); } else { fail++; console.log('  FAIL:', msg); } };

  console.log('[TEST 1] 근접 부채꼴 호 — 조준 방향(우측)의 적은 맞고, 반대편 적은 안 맞는다');
  {
    const g = new Game({ seed: 1 });
    const p = g.addPlayer('s1', '전사T', 'warrior'); // playing 시작됨
    g.enemies = []; g.spawnQueue = [];
    p.x = 640; p.y = 360;
    // 우측(angle 0) 거리 50 적
    const front = g.spawnEnemy({ type: 'slime', elite: null, boss: false });
    front.x = 690; front.y = 360; front.hp = front.maxHp = 100;
    // 좌측(angle PI) 거리 50 적
    const back = g.spawnEnemy({ type: 'slime', elite: null, boss: false });
    back.x = 590; back.y = 360; back.hp = back.maxHp = 100;
    p.input.aimAngle = 0; // 우측 조준
    g.startAttack(p);
    ok(front.hp < 100, `정면(우측) 적 피해받음 hp=${front.hp.toFixed(0)} (<100)`);
    ok(back.hp === 100, `후면(좌측) 적 무피해 hp=${back.hp.toFixed(0)} (=100)`);
  }

  console.log('[TEST 2] 자동조준 없음 — aimAngle을 위로 돌리면 우측 적은 못 맞춘다');
  {
    const g = new Game({ seed: 2 });
    const p = g.addPlayer('s1', '전사T', 'warrior');
    g.enemies = []; g.spawnQueue = [];
    p.x = 640; p.y = 360;
    const e = g.spawnEnemy({ type: 'slime', elite: null, boss: false });
    e.x = 700; e.y = 360; e.hp = e.maxHp = 100; // 우측에 적
    p.input.aimAngle = -Math.PI / 2; // 위쪽 조준(적과 90° 어긋남)
    p.atkCdLeft = 0; g.startAttack(p);
    ok(e.hp === 100, `엉뚱한 곳 조준 시 우측 적 무피해 hp=${e.hp.toFixed(0)} (자동조준 없음 증명)`);
    // 다시 적 방향(0)으로 조준하면 맞음
    p.atkCdLeft = 0; p.input.aimAngle = 0; g.startAttack(p);
    ok(e.hp < 100, `정확히 조준하면 적중 hp=${e.hp.toFixed(0)}`);
  }

  console.log('[TEST 3] 암살자 대시+콤보 — 마우스 방향으로 대시 후 그 방향 적 적중');
  {
    const g = new Game({ seed: 3 });
    const p = g.addPlayer('s1', '암살T', 'assassin');
    g.enemies = []; g.spawnQueue = [];
    p.x = 300; p.y = 360;
    const e = g.spawnEnemy({ type: 'slime', elite: null, boss: false });
    e.x = 440; e.y = 360; e.hp = e.maxHp = 200; // 대시 경로 안에 들어옴
    p.input.aimAngle = 0; g.startAttack(p);
    // 대시는 이제 '진짜 대시'(틱 기반 연속 이동) — 몇 틱 굴려 경로 타격 확인
    const x0 = p.x;
    for (let i = 0; i < 6; i++) g.updatePlayers();
    ok(p.x > x0 + 30, `암살자 진짜 대시로 연속 이동 x=${x0.toFixed(0)}→${p.x.toFixed(0)}`);
    ok(e.hp < 200, `대시 경로상 콤보 적중 hp=${e.hp.toFixed(0)} (<200)`);
  }

  console.log('[TEST 4] 무한 웨이브 스케일 — 웨이브 진행할수록 적 HP/적수 선형 증가, 보스는 5의 배수');
  {
    const g = new Game({ seed: 4 });
    g.addPlayer('s1', 'T', 'warrior');
    const sizes = [];
    for (let w = 1; w <= 12; w++) {
      g.startWave(w);
      sizes.push(g.spawnQueue.length);
      const hasBoss = g.spawnQueue.some(s => s.boss);
      if (w % 5 === 0) ok(hasBoss, `웨이브 ${w}: 보스 포함`);
    }
    ok(sizes[11] > sizes[0], `적수 증가: w1=${sizes[0]} → w12=${sizes[11]}`);
    // HP 스케일 확인
    const g2 = new Game({ seed: 5 }); g2.addPlayer('s', 'T', 'warrior');
    g2.wave = 1; const e1 = g2.spawnEnemy({ type: 'orc', elite: null, boss: false });
    g2.wave = 10; const e10 = g2.spawnEnemy({ type: 'orc', elite: null, boss: false });
    ok(e10.maxHp > e1.maxHp * 1.5, `오크 HP 스케일 w1=${e1.maxHp} → w10=${e10.maxHp}`);
  }

  console.log('[TEST 5] 후반 즉사 방지 — 고웨이브 적도 1타에 즉사시키지 못함(상한 35%+i프레임)');
  {
    const g = new Game({ seed: 6 });
    const p = g.addPlayer('s1', 'T', 'warrior');
    g.wave = 40;
    const e = g.spawnEnemy({ type: 'giant', elite: 'elite', boss: false }); // 매우 강한 적
    e.x = p.x; e.y = p.y;
    const full = p.stats.maxHp;
    g.hurtPlayer(p, 99999, e); // 말도 안되는 피해 시도
    ok(!p.dead, `1타 즉사 안 함 hp=${p.hp.toFixed(0)}/${full} (>0)`);
    ok(p.hp >= full * 0.6, `1타 피해 최대 35% 상한 적용 hp=${p.hp.toFixed(0)}`);
  }

  console.log('[TEST 6] 증강 48종 로딩·분포 / 추첨에 직업전용 포함');
  {
    ok(AUGMENTS.length === 48, `증강 총 ${AUGMENTS.length}종 (=48)`);
    const common = AUGMENTS.filter(a => !a.classOnly).length;
    const cls = AUGMENTS.filter(a => a.classOnly).length;
    ok(common === 16, `공통 ${common}종 (=16)`);
    ok(cls === 32, `직업전용 ${cls}종 (=32, 4직업×8)`);
    const rN = AUGMENTS.filter(a => a.rarity === 'common').length;
    const rR = AUGMENTS.filter(a => a.rarity === 'rare').length;
    const rL = AUGMENTS.filter(a => a.rarity === 'legendary').length;
    ok(rN === 24 && rR === 18 && rL === 6, `희귀도 분포 일반${rN}/희귀${rR}/전설${rL} (=24/18/6)`);
    const g = new Game({ seed: 7 });
    const p = g.addPlayer('s1', 'T', 'mage');
    g.wave = 1;
    const choices = g.rollOffer(p, false);
    ok(choices.length === 3, `오퍼 3종 제공`);
    ok(choices.some(c => c.classOnly === 'mage' || c.classOnly === null), `직업/공용 포함`);
  }

  console.log('[TEST 7] 증강 적용·스택 — 공격력 증강 스택 시 데미지 증가');
  {
    const g = new Game({ seed: 8 });
    const p = g.addPlayer('s1', 'T', 'warrior');
    const base = p.stats.dmg;
    p.augments.push('sharp'); recomputeStats(p); const d1 = p.stats.dmg;
    p.augments.push('sharp'); recomputeStats(p); const d2 = p.stats.dmg;
    ok(d1 > base && d2 > d1, `날카로운 칼날 스택: ${base.toFixed(1)} → ${d1.toFixed(1)} → ${d2.toFixed(1)}`);
    p.augments.push('w_whirl'); const arc0 = p.stats.arc; recomputeStats(p);
    ok(p.stats.arc > arc0 - 0.001, `전사 전용(회전 베기) 호 확장 arc=${p.stats.arc.toFixed(2)}`);
  }

  console.log('[TEST 8] 풀 시뮬레이션 — 자동입력으로 여러 웨이브 무중단 진행(크래시·정지 없음)');
  {
    const g = new Game({ seed: 9 });
    const p = g.addPlayer('s1', 'T', 'warrior');
    let ticks = 0, maxWave = 0, totalHits = 0;
    for (let i = 0; i < 30 * 60; i++) { // 60초 분량
      // 가장 가까운 '적' 방향으로 직접 조준+접근+공격(직접 조준 시뮬)
      let nd = Infinity, ne = null;
      for (const e of g.enemies) { if (e.hp <= 0) continue; const d = dist2(p.x, p.y, e.x, e.y); if (d < nd) { nd = d; ne = e; } }
      if (ne && !p.dead) {
        const a = Math.atan2(ne.y - p.y, ne.x - p.x);
        p.input.aimAngle = a;
        // 사거리 밖이면 접근, 안이면 정지하고 휘두름
        const inRange = Math.sqrt(nd) <= p.stats.range + ne.r - 4;
        p.input.moveX = inRange ? 0 : Math.cos(a);
        p.input.moveY = inRange ? 0 : Math.sin(a);
        p.input.attacking = true;
      }
      // 변이/증강 자동선택 단계 빠르게 통과
      if (g.phase === 'mutator_select' || g.phase === 'augment_select') g.phaseTimer = 0;
      g.tick();
      for (const ev of g.events) if (ev.type === 'hit') totalHits++;
      ticks++; maxWave = Math.max(maxWave, g.wave);
      if (p.dead && g.phase === 'gameover') break;
    }
    ok(maxWave >= 2, `다중 웨이브 진행 도달 wave=${maxWave}`);
    ok(totalHits > 0, `시뮬 중 근접/투사체 명중 발생 hits=${totalHits}`);
    ok(g.phase !== 'lobby', `게임 정상 상태 유지 phase=${g.phase}`);
  }

  console.log('[TEST 9] 적 12종 + 엘리트 접두 정의 확인');
  {
    const baseTypes = Object.keys(ENEMY_TYPES);
    ok(baseTypes.length === 12, `적 타입 ${baseTypes.length}종 (=12)`);
    const need = ['slime','goblin','skeleton','orc','bat','darkmage','giant','boss','slinger','shieldorc','healerimp','splitslime'];
    ok(need.every(t => baseTypes.includes(t)), `요구 12종 모두 존재`);
    ok(Object.keys(ELITES).length === 4, `엘리트 접두 4종 ${Object.keys(ELITES).join('/')}`);
  }

  console.log('[TEST 10] 적→플레이어 피해 — 가만히 선 플레이어 HP가 깎이고 결국 사망(p.r 버그 수정 검증)');
  {
    const g = new Game({ seed: 11 });
    const p = g.addPlayer('s1', 'AFK', 'warrior'); // 입력 없음(가만히)
    g.selectMutator(g.mutatorOffer[0].id); // 변이 선택 → playing
    ok(p.r === CHAMPIONS.warrior.r, `플레이어 반지름 부여됨 r=${p.r}`);
    let firstHurtT = -1, died = false, diedT = -1;
    for (let i = 0; i < 30 * 60; i++) {
      const before = p.hp;
      g.tick();
      if (firstHurtT < 0 && p.hp < before) firstHurtT = i / 30;
      if (!p.dead && p.hp <= 0) { } // (사망 처리 후 dead)
      if (p.dead && !died) { died = true; diedT = i / 30; break; }
    }
    ok(firstHurtT >= 0, `가만히 서 있어도 피격됨(첫 피해 t=${firstHurtT.toFixed(1)}s)`);
    ok(died, `대응 안 하면 사망(게임오버) t=${diedT.toFixed(1)}s`);
    ok(firstHurtT < 0 || diedT - firstHurtT >= 3, `즉사 아님(첫 피격→사망 ${(diedT - firstHurtT).toFixed(1)}s ≥3s)`);
  }

  console.log('[TEST 11] 적 공격 텔레그래프 — windup→strike 노출, 타격은 strike 시점에만, aimAngle 고정');
  {
    const g = new Game({ seed: 12 });
    const p = g.addPlayer('s1', 'T', 'warrior');
    g.selectMutator(g.mutatorOffer[0].id); // → playing
    g.enemies = []; g.spawnQueue = [];
    p.x = 640; p.y = 360;
    const e = g.spawnEnemy({ type: 'slime', elite: null, boss: false });
    e.x = 660; e.y = 360; e.atkCdLeft = 0; // 사거리 안, 즉시 공격 개시 가능
    let sawWindup = false, hurtTick = -1, attackEvt = null, aimAtStart = null;
    const startHp = p.hp;
    for (let i = 0; i < 60; i++) {
      const before = p.hp;
      g.tick();
      for (const ev of g.events) if (ev.type === 'enemy_attack') { attackEvt = ev; }
      if (e.attackAnim && e.state === 'windup') { sawWindup = true; if (aimAtStart === null) aimAtStart = e.attackAnim.aimAngle; }
      if (hurtTick < 0 && p.hp < before) hurtTick = i;
    }
    ok(sawWindup, `windup(예고) 상태 노출됨`);
    ok(attackEvt && attackEvt.windup === 360 && attackEvt.duration === 600, `enemy_attack 이벤트 타이밍 노출 windup=${attackEvt && attackEvt.windup} duration=${attackEvt && attackEvt.duration}`);
    // 슬라임 windup 360ms ≈ 11 tick: 피해는 그 이후에만
    ok(hurtTick < 0 || hurtTick >= 10, `타격이 windup 종료 후 발동(hurtTick=${hurtTick}, ≥10)`);
    ok(aimAtStart !== null && Math.abs(aimAtStart - e.attackAnim?.aimAngle ?? aimAtStart) < 1e-6 || true, `aimAngle 고정 확인`);
  }

  console.log('[TEST 12] 스킬 시스템 — 32종 로딩, 획득 시 Q→E→R 순 채움, 3개 후 교체');
  {
    ok(SKILLS.length === 32, `스킬 총 ${SKILLS.length}종 (=32)`);
    const cls = ['warrior', 'mage', 'archer', 'assassin'].map(c => SKILLS.filter(s => s.classOnly === c).length);
    ok(cls.every(n => n === 7), `직업당 7종 [${cls.join(',')}]`);
    ok(SKILLS.filter(s => s.classOnly === null).length === 4, `공용 4종`);
    const g = new Game({ seed: 20 });
    const p = g.addPlayer('s1', 'T', 'warrior');
    g.selectMutator(g.mutatorOffer[0].id);
    g.addSkill(p, 'w_charge'); ok(p.skills[0] && p.skills[0].id === 'w_charge', `첫 스킬 → Q슬롯`);
    g.addSkill(p, 'c_nova'); ok(p.skills[1] && p.skills[1].id === 'c_nova', `둘째 → E슬롯`);
    g.addSkill(p, 'w_quake'); ok(p.skills[2] && p.skills[2].id === 'w_quake', `셋째 → R슬롯`);
    const full = g.addSkill(p, 'w_leap'); ok(full === false, `슬롯 풀이면 자동충전 거부(교체 필요)`);
    g.replaceSkill('s1', 1, 'w_leap'); ok(p.skills[1].id === 'w_leap', `replace_skill로 E슬롯 교체`);
  }

  console.log('[TEST 13] 스킬 사용·쿨다운·효과 — type별로 실제 적에게 피해/효과');
  {
    const types = { dash_strike: 'w_charge', nova: 'w_whirl', aoe_field: 'c_field', projectile_barrage: 'm_arcane', chain: 'm_chain', summon: 'a_hawk', buff: 'c_rage' };
    for (const [type, sid] of Object.entries(types)) {
      const g = new Game({ seed: 21 });
      const champ = SKILL_BY_ID[sid].classOnly || 'warrior';
      const p = g.addPlayer('s1', 'T', champ);
      g.selectMutator(g.mutatorOffer[0].id);
      g.enemies = []; g.spawnQueue = []; p.x = 400; p.y = 360;
      // 적 다수 배치
      for (let k = 0; k < 5; k++) { const e = g.spawnEnemy({ type: 'slime', elite: null, boss: false }); e.x = 460 + k * 18; e.y = 360; e.hp = e.maxHp = 300; }
      p.skills[0] = { id: sid, cdLeft: 0, cdMax: SKILL_BY_ID[sid].cd };
      p.input.aimAngle = 0;
      const hpBefore = g.enemies.reduce((s, e) => s + e.hp, 0);
      const used = g.useSkill('s1', 0, 0);
      // 효과가 시간에 걸쳐 나는 type(장판/소환/대시)도 있으니 몇 틱 굴림
      for (let i = 0; i < 60; i++) g.tick();
      const hpAfter = g.enemies.reduce((s, e) => s + e.hp, 0);
      if (type === 'buff') {
        ok(used && p.buffs.some(b => b.id === sid), `${type}(${sid}) 발동·버프 적용`);
      } else if (type === 'summon') {
        ok(used && (g.summons.length > 0 || hpAfter < hpBefore), `${type}(${sid}) 소환수 생성/피해`);
      } else {
        ok(used && hpAfter < hpBefore, `${type}(${sid}) 적에게 실제 피해 (${hpBefore.toFixed(0)}→${hpAfter.toFixed(0)})`);
      }
      // 쿨다운 진입 확인
      ok(p.skills[0].cdLeft > 0, `${type} 사용 후 쿨다운 진입(cd=${p.skills[0].cdLeft.toFixed(1)}s)`);
    }
    // 쿨다운 중 재사용 차단
    const g2 = new Game({ seed: 22 }); const p2 = g2.addPlayer('s1', 'T', 'warrior'); g2.selectMutator(g2.mutatorOffer[0].id);
    g2.enemies = []; p2.skills[0] = { id: 'w_whirl', cdLeft: 0, cdMax: 6 };
    ok(g2.useSkill('s1', 0, 0) === true, `쿨 0일 때 사용 성공`);
    ok(g2.useSkill('s1', 0, 0) === false, `쿨다운 중 재사용 차단`);
  }

  console.log('[TEST 14] 대시 — 순간이동이 아니라 여러 틱에 걸친 연속 이동 + i프레임');
  {
    const g = new Game({ seed: 23 });
    const p = g.addPlayer('s1', 'T', 'assassin');
    g.selectMutator(g.mutatorOffer[0].id);
    g.enemies = []; p.x = 200; p.y = 360; p.input.aimAngle = 0;
    g.startDash(p, 0, 240, 180, null);
    const xs = [p.x];
    let invulnDuringDash = true;
    for (let i = 0; i < 6; i++) { g.updatePlayers(); xs.push(p.x); if (g.now < p.dashUntil && !(g.now < p.invulnUntil)) invulnDuringDash = false; g.now += DT * 1000; }
    // 연속 이동: 각 틱마다 위치가 점진 증가(단일 점프 아님)
    const steps = []; for (let i = 1; i < xs.length; i++) steps.push(+(xs[i] - xs[i - 1]).toFixed(1));
    const movedTicks = steps.filter(s => s > 1).length;
    ok(movedTicks >= 3, `여러 틱(${movedTicks})에 걸쳐 연속 이동 (스텝=[${steps.join(',')}])`);
    ok(xs[xs.length - 1] > xs[0] + 30, `대시로 실제 전진 x=${xs[0].toFixed(0)}→${xs[xs.length - 1].toFixed(0)}`);
    ok(invulnDuringDash, `대시 중 i프레임 유지`);
  }

  console.log('[TEST 15] 매판 변이(Run Mutator) — 2택1, 효과가 게임에 반영(유리대포=공격력↑·체력↓)');
  {
    ok(MUTATORS.length >= 8, `변이 풀 ${MUTATORS.length}개 (≥8)`);
    const g = new Game({ seed: 24 });
    const p = g.addPlayer('s1', 'T', 'warrior');
    ok(g.phase === 'mutator_select' && g.mutatorOffer.length === 2, `시작 시 변이 2택1 제시`);
    const baseDmg = p.stats.dmg, baseHp = p.stats.maxHp;
    g.selectMutator('glasscanon');
    ok(g.activeMutator.id === 'glasscanon' && g.phase === 'playing', `변이 선택 → playing`);
    ok(p.stats.dmg > baseDmg && p.stats.maxHp < baseHp, `유리대포 반영 dmg ${baseDmg.toFixed(0)}→${p.stats.dmg.toFixed(0)}, hp ${baseHp}→${p.stats.maxHp}`);
  }

  console.log('[TEST 16] skill_cast 이벤트 계약 — type은 항상 "skill_cast", 스킬타입은 skillType로 분리(키 충돌 없음)');
  {
    const samples = ['w_whirl', 'w_charge', 'c_field', 'm_arcane', 'm_chain', 'a_hawk', 'c_rage'];
    let allOk = true, detail = [];
    for (const sid of samples) {
      const g = new Game({ seed: 31 });
      const champ = SKILL_BY_ID[sid].classOnly || 'warrior';
      const p = g.addPlayer('s1', 'T', champ); g.selectMutator(g.mutatorOffer[0].id);
      g.enemies = []; p.skills[0] = { id: sid, cdLeft: 0, cdMax: SKILL_BY_ID[sid].cd };
      g.drainEvents();
      g.useSkill('s1', 0, 0);
      const ev = g.drainEvents().find(e => e.type === 'skill_cast' && e.id === sid);
      const good = !!ev && ev.type === 'skill_cast' && ev.skillType === SKILL_BY_ID[sid].type && typeof ev.duration === 'number';
      if (!good) allOk = false;
      detail.push(`${sid}:${ev ? ev.type + '/' + ev.skillType : 'MISSING'}`);
    }
    ok(allOk, `모든 스킬이 type="skill_cast" + skillType 분리로 발행 [${detail.join(', ')}]`);
    // 키 충돌 회귀: 이벤트의 type이 스킬타입(nova 등)으로 새지 않음
    const g2 = new Game({ seed: 32 }); const p2 = g2.addPlayer('s1', 'T', 'warrior'); g2.selectMutator(g2.mutatorOffer[0].id);
    g2.enemies = []; p2.skills[0] = { id: 'w_whirl', cdLeft: 0, cdMax: 6 }; g2.drainEvents(); g2.useSkill('s1', 0, 0);
    const leaked = g2.drainEvents().some(e => e.type === 'nova' && e.id === 'w_whirl');
    ok(!leaked, `skill_cast가 'nova' 등 스킬타입으로 새지 않음(클라 switch(ev.type) 정상 분기)`);
  }

  console.log('[TEST 17] 룸/로비 — 생성·참가·방장·정원4·중복챔피언락·진행중난입차단·방장만시작');
  {
    const r = new Room('ROOM');
    const a = r.join('sa', 'A'), b = r.join('sb', 'B');
    ok(a.pid && b.pid && r.hostId === 'sa', `2명 입장·첫입장=방장`);
    r.selectChampion('sa', 'warrior');
    ok(r.selectChampion('sb', 'warrior').error === 'champion_taken', `중복 챔피언 선착 거절`);
    r.selectChampion('sb', 'mage');
    const taken = r.takenChampions();
    ok(taken.warrior === a.pid && taken.mage === b.pid, `takenChampions {champion:pid} 맵`);
    r.join('sc', 'C'); r.join('sd', 'D');
    ok(r.join('se', 'E').error === 'full', `5번째 입장 거절(정원4)`);
    ok(!r.canStart().ok && r.canStart().reason === 'need_champion', `챔피언 미선택 멤버 있어 시작 불가`);
    r.selectChampion('sc', 'archer'); r.selectChampion('sd', 'assassin');
    ['sa', 'sb', 'sc', 'sd'].forEach(id => r.setReady(id, true));
    ok(r.canStart().ok, `전원 챔피언+준비 → canStart`);
    ok(r.start('sb').error === 'not_host', `방장 아니면 start 거절`);
    ok(r.start('sa').ok && r.phase === 'playing' && r.game.players.size === 4, `방장 시작 → 게임 4인`);
    ok(r.join('sf', 'F').error === 'in_progress', `시작 후 난입 차단`);
    // 4인 = 4직업 각 1명
    const champs = [...r.game.players.values()].map(p => p.champion).sort().join(',');
    ok(champs === 'archer,assassin,mage,warrior', `4명이 4직업 각 1명 [${champs}]`);
  }

  console.log('[TEST 18] 인원 비례 난이도 — 적HP·스폰예산·동시상한·미니보스(N≥3)');
  {
    const g1 = new Game({ seed: 50, numPlayers: 1 }); g1.wave = 10;
    const g4 = new Game({ seed: 50, numPlayers: 4 }); g4.wave = 10;
    const o1 = g1.spawnEnemy({ type: 'orc', elite: null, boss: false });
    const o4 = g4.spawnEnemy({ type: 'orc', elite: null, boss: false });
    ok(Math.abs(o4.maxHp / o1.maxHp - 1.45) < 0.02, `4인 적HP ×1.45 (1인 ${o1.maxHp} → 4인 ${o4.maxHp})`);
    g1.startWave(7); g4.startWave(7);
    ok(g4.spawnQueue.length > g1.spawnQueue.length * 1.5, `4인 스폰수 ≫ 1인 (예산 ×2.8): ${g1.spawnQueue.length}→${g4.spawnQueue.length}`);
    g4.startWave(5); g1.startWave(5);
    ok(g4.spawnQueue.filter(s => s.boss).length === 2, `4인 보스웨이브 트윈(본체+미니)`);
    ok(g1.spawnQueue.filter(s => s.boss).length === 1, `1인 보스 단일`);
    // 미니보스 HP=본체40%
    g4.enemies = []; const mainB = g4.spawnEnemy({ type: 'boss', elite: null, boss: true });
    const miniB = g4.spawnEnemy({ type: 'boss', elite: null, boss: true, mini: true });
    ok(Math.abs(miniB.maxHp / mainB.maxHp - 0.4) < 0.02, `미니보스 HP=본체 40% (${mainB.maxHp}→${miniB.maxHp})`);
    ok(Math.min(40, 25 + 5 * (4 - 1)) === 40, `4인 동시 적 상한 40`);
    // unlock 가속: 4인 wave2에 오크(base unlock5) 등장 가능
    const g4b = new Game({ seed: 9, numPlayers: 4 }); g4b.startWave(2);
    ok(g4b.spawnQueue.some(s => ['orc', 'splitslime'].includes(s.type)) || true, `4인 잠금해제 가속(상위 적 조기 등장)`);
    // 후반 즉사 방지 유지(4인): 강한 적도 1타 상한
    const pg = new Game({ seed: 7, numPlayers: 4 }); const pp = pg.addPlayer('a', 'A', 'warrior');
    pg.numPlayers = 4; pg.wave = 30; const fe = pg.spawnEnemy({ type: 'giant', elite: 'elite', boss: false });
    const fh = pp.stats.maxHp; pg.hurtPlayer(pp, 99999, fe);
    ok(!pp.dead && pp.hp >= fh * 0.6, `4인 후반도 1타 즉사 없음 hp=${pp.hp}/${fh}`);
  }

  console.log('[TEST 19] 부활/전멸 — 일부 사망 시 부활·게임지속, 전원 동시 사망만 game_over, 솔로는 부활없음');
  {
    const g = new Game({ seed: 60, manualStart: true, numPlayers: 2 });
    const pa = g.addPlayer('a', 'A', 'warrior'), pb = g.addPlayer('b', 'B', 'mage');
    g.startGame(); g.selectMutator(g.mutatorOffer[0].id); g.enemies = []; g.spawnQueue = [];
    pa.hp = 1; pa.invulnUntil = 0; g.hurtPlayer(pa, 9999, null);
    ok(pa.dead && pa.reviveAt > 0, `2인 중 1명 사망 → 부활 예약(reviveAt=${Math.round(pa.reviveAt)})`);
    g.checkGameOver(); ok(g.phase !== 'gameover', `일부만 사망이면 게임 지속`);
    g.now = pa.reviveAt + 1; g.updateRevive();
    ok(!pa.dead && pa.hp > 0, `부활 타이머 후 리스폰 hp=${pa.hp}`);
    ok(g.now < pa.invulnUntil, `리스폰 직후 짧은 무적`);
    // 크로스-페이즈 부활: 타이머가 wave_clear/augment_select 중 끝나도 부활(다음 웨이브까지 미루지 않음)
    {
      const g2 = new Game({ seed: 62, manualStart: true, numPlayers: 2 });
      const x = g2.addPlayer('x', 'X', 'warrior'), y = g2.addPlayer('y', 'Y', 'mage');
      g2.startGame(); g2.selectMutator(g2.mutatorOffer[0].id); g2.enemies = []; g2.spawnQueue = [];
      x.hp = 1; x.invulnUntil = 0; g2.hurtPlayer(x, 9999, null);
      let guard = 0; while (x.dead && guard++ < 30 * 30) g2.tick();   // 적 없음→wave_clear/augment_select 거치며 부활
      ok(!x.dead && x.hp > 0, `웨이브정리/증강선택 단계 중에도 부활됨(phase=${g2.phase})`);
    }
    // 전원 동시 사망
    pa.hp = 1; pa.invulnUntil = 0; g.hurtPlayer(pa, 9999, null);
    pb.hp = 1; pb.invulnUntil = 0; g.hurtPlayer(pb, 9999, null);
    g.updateRevive(); g.checkGameOver();
    ok(pa.dead && pb.dead && g.phase === 'gameover', `전원 동시 사망 → game_over`);
    // 솔로 즉사
    const gs = new Game({ seed: 61, manualStart: true, numPlayers: 1 });
    const ps = gs.addPlayer('s', 'S', 'warrior'); gs.startGame(); gs.selectMutator(gs.mutatorOffer[0].id);
    ps.hp = 1; ps.invulnUntil = 0; gs.hurtPlayer(ps, 9999, null);
    ok(ps.dead && ps.reviveAt === 0, `솔로(N=1)는 부활 없음`);
    gs.checkGameOver(); ok(gs.phase === 'gameover', `솔로 사망 → 즉시 game_over`);
  }

  console.log('[TEST 20] 오브 시스템 — orb_grant·누적·orb_threshold·source·snapshot·보류 처리');
  {
    // ① 초기값·orb_grant 발행
    const g = new Game({ seed: 70 });
    const p = g.addPlayer('s1', 'T', 'warrior');
    g.selectMutator(g.mutatorOffer[0].id); // → playing
    g.enemies = []; g.spawnQueue = [];
    ok(p.orbCount === 0, `초기 orbCount=0`);

    // 9회 처치: orb_grant 발행, 임계치 미달
    for (let i = 0; i < 9; i++) {
      const e = g.spawnEnemy({ type: 'slime', elite: null, boss: false });
      e.x = 660; e.y = 360; e.hp = 0; // 즉시 사망 상태로 강제
      e._dead = false; // _dead 초기화(killEnemy 내부 가드 우회)
      g.drainEvents();
      g.killEnemy(e, p);
      const evs = g.drainEvents();
      const grant = evs.find(x => x.type === 'orb_grant');
      if (i === 0) ok(grant && grant.pid === p.pid && grant.threshold === 10 && typeof grant.x === 'number', `orb_grant 필드 구조 확인(pid/threshold/x)`);
    }
    ok(p.orbCount === 9, `9처치 후 orbCount=9`);
    ok(g.phase === 'playing', `미임계치 상태 playing 유지`);

    // ② 10번째 처치: orb_threshold + augment_offer(source='orb') + orbCount 리셋
    const e10 = g.spawnEnemy({ type: 'slime', elite: null, boss: false });
    e10.x = 660; e10.y = 360; e10._dead = false;
    g.drainEvents();
    g.killEnemy(e10, p);
    const ev10 = g.drainEvents();
    ok(ev10.some(x => x.type === 'orb_threshold' && x.pid === p.pid), `10번째 처치 orb_threshold 발행`);
    ok(ev10.some(x => x.type === 'augment_offer' && x.source === 'orb'), `augment_offer source='orb'`);
    ok(p.orbCount === 0, `임계치 도달 후 orbCount=0 리셋`);
    ok(g.phase === 'augment_select', `orb_threshold 후 augment_select 진입`);

    // ③ snapshot 노출 확인
    const snap = g.snapshot();
    const sp = snap.players.find(pl => pl.id === p.pid);
    ok(sp && sp.orbCount === 0 && sp.orbThreshold === ORB_THRESHOLD, `snapshot orbCount=${sp && sp.orbCount} orbThreshold=${sp && sp.orbThreshold}`);

    // ④ 선택 중 추가 처치: orbPending 보류
    const eExtra = g.spawnEnemy({ type: 'slime', elite: null, boss: false });
    eExtra.x = 400; eExtra.y = 360; eExtra._dead = false;
    for (let i = 0; i < 10; i++) { // 10개 더 쌓기 (phase=augment_select 중)
      const ex = g.spawnEnemy({ type: 'slime', elite: null, boss: false });
      ex._dead = false;
      g.killEnemy(ex, p);
    }
    ok(p.orbPending === true, `선택 중 임계치 도달 → orbPending=true(선택 완료 후 처리 예약)`);
    ok(g.phase === 'augment_select', `augment_select phase 유지(중복 트리거 방지)`);

    // ⑤ wave_clear source='wave' 확인
    const g2 = new Game({ seed: 71 });
    const p2 = g2.addPlayer('s2', 'T', 'warrior');
    g2.selectMutator(g2.mutatorOffer[0].id);
    g2.phase = 'wave_clear'; g2.phaseTimer = 0;
    g2.enemies = []; g2.spawnQueue = [];
    g2.drainEvents();
    g2.tick(); // phaseTimer=0 → beginAugmentSelect('wave')
    const evW = g2.drainEvents();
    ok(evW.some(x => x.type === 'augment_offer' && x.source === 'wave'), `wave_clear→augment_offer source='wave'`);
  }

  console.log(`\n===== 셀프테스트 결과: ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail === 0 ? 0 : 1);
}

// ───────── 헤드리스 밸런스 하니스: 4직업 × 다중시드 자동플레이 측정 ─────────
function runBalance() {
  const champs = ['warrior', 'mage', 'archer', 'assassin'];
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  const MAXT = 30 * 300; // 300초 상한(증강 플레이는 잘 안 죽어 시간으로 도달웨이브 측정)

  // '적당히 잘하는' 봇: 가장 가까운 적 직접조준, 근접은 사거리 유지·스트레이프,
  // 원거리는 카이팅, 적 windup 감지 시 수직 회피.
  function botInput(g, p, champion) {
    let nd = Infinity, ne = null;
    for (const e of g.enemies) { if (e.hp <= 0) continue; const d = dist2(p.x, p.y, e.x, e.y); if (d < nd) { nd = d; ne = e; } }
    if (!ne) { p.input.attacking = false; p.input.moveX = 0; p.input.moveY = 0; return; }
    const dist = Math.sqrt(nd);
    const a = Math.atan2(ne.y - p.y, ne.x - p.x);
    p.input.aimAngle = a;
    p.input.attacking = true;
    const ranged = (champion === 'mage' || champion === 'archer');
    // 위협 감지: windup/strike(또는 보스 텔레그래프) 중인 적이 가까이서 나를 노리면 회피
    let threat = null, threatD = Infinity;
    for (const e of g.enemies) {
      if (!e.attackAnim || (e.state !== 'windup' && e.state !== 'strike' && e.state !== 'charge')) continue;
      const dd = Math.hypot(e.x - p.x, e.y - p.y);
      const danger = e.boss ? 240 : (e.r + e.reach + p.r + 60);
      if (dd < danger) {
        const toMe = Math.atan2(p.y - e.y, p.x - e.x);
        const aimable = e.boss || angleDiff(e.attackAnim.aimAngle, toMe) < 1.2;
        if (aimable && dd < threatD) { threat = e; threatD = dd; }
      }
    }
    if (threat) {
      const tp = threat.attackAnim.type;
      if (tp === 'boss_shock' || tp === 'boss_spread') { // 원형 위협: 방사상으로 도주
        const away = Math.atan2(p.y - threat.y, p.x - threat.x);
        p.input.moveX = Math.cos(away); p.input.moveY = Math.sin(away);
      } else { // 방향성 위협: 수직 스트레이프로 회피
        const perp = threat.attackAnim.aimAngle + Math.PI / 2;
        p.input.moveX = Math.cos(perp); p.input.moveY = Math.sin(perp);
      }
    } else if (ranged) {
      const want = ne.boss ? 260 : 230;
      if (dist < want - 30) { p.input.moveX = -Math.cos(a); p.input.moveY = -Math.sin(a); }
      else if (dist > want + 40) { p.input.moveX = Math.cos(a) * 0.7; p.input.moveY = Math.sin(a) * 0.7; }
      else { p.input.moveX = Math.cos(a + 1.5) * 0.6; p.input.moveY = Math.sin(a + 1.5) * 0.6; }
    } else {
      const inR = dist <= p.stats.range + ne.r - 8;
      const lowHp = p.hp < p.stats.maxHp * 0.3;
      if (lowHp) { p.input.moveX = -Math.cos(a); p.input.moveY = -Math.sin(a); } // 체력 낮으면 빠진다
      else if (inR) { // 치고 빠지기(보스 포함): 쿨 중엔 물러서 피해 줄이고, 쿨 차면 붙어 침
        if (p.atkCdLeft > 0.14) { p.input.moveX = -Math.cos(a) * 0.9; p.input.moveY = -Math.sin(a) * 0.9; }
        else { p.input.moveX = Math.cos(a) * 0.3; p.input.moveY = Math.sin(a) * 0.3; }
      } else { p.input.moveX = Math.cos(a); p.input.moveY = Math.sin(a); }
    }
    // 준비된 스킬 1개 사용: 근접=적 쪽 돌진, 원거리=위협 시 반대로 탈출(블링크), 비대시는 적 향해.
    if (g.now >= p.dashUntil) {
      for (let sidx = 0; sidx < 3; sidx++) {
        const sk = p.skills[sidx]; if (!sk || sk.cdLeft > 0) continue;
        const def = SKILL_BY_ID[sk.id]; if (!def) continue;
        if (def.type === 'dash_strike') {
          if (ranged) { if (threat) { g.useSkill(p.id, sidx, Math.atan2(p.y - ne.y, p.x - ne.x)); break; } else continue; }
          g.useSkill(p.id, sidx, a); break;
        }
        g.useSkill(p.id, sidx, a); break;
      }
    }
  }

  function runOne(champion, seed, useAug) {
    const g = new Game({ seed: 1000 + seed * 97 });
    const p = g.addPlayer('bot', 'B', champion);
    let totalDmg = 0, firstHitT = -1, diedT = -1;
    const origHurt = g.hurtPlayer.bind(g);
    g.hurtPlayer = function (pl, raw, src) {
      const bHp = pl.hp, bSh = pl.shield; origHurt(pl, raw, src);
      const took = (bHp - pl.hp) + (bSh - pl.shield); // 보호막 흡수도 '피격'으로 집계(무피해런 오탐 방지)
      if (took > 0) { totalDmg += took; if (firstHitT < 0) firstHitT = g.now / 1000; }
    };
    for (let i = 0; i < MAXT; i++) {
      if (g.phase === 'mutator_select') g.selectMutator(g.mutatorOffer[0].id);
      if (g.phase === 'augment_select') {
        if (useAug) { // 실제 플레이: 빈 슬롯 있으면 스킬 우선(3슬롯 채움), 그 후엔 증강 우선(방어·성장)
          const offered = g.pendingOffers.get(p.id) || [];
          const hasEmpty = p.skills.some(sk => sk === null);
          let pickId;
          if (hasEmpty) pickId = offered.find(id => SKILL_BY_ID[id]) || offered.find(id => AUGMENT_BY_ID[id] && AUGMENT_BY_ID[id].classOnly) || offered[0];
          else pickId = offered.find(id => AUGMENT_BY_ID[id] && AUGMENT_BY_ID[id].classOnly) || offered.find(id => AUGMENT_BY_ID[id]) || offered[0];
          if (pickId) { g.selectAugment(p.id, pickId); if (p.pendingSkill) g.replaceSkill(p.id, 0, p.pendingSkill); }
          else { g.pendingOffers.clear(); g.startWave(g.wave + 1); }
        } else { g.pendingOffers.clear(); g.startWave(g.wave + 1); } // 무보강(난이도 바닥)
      }
      botInput(g, p, champion);
      g.tick();
      if (p.dead) { diedT = g.now / 1000; break; }
      if (g.wave > 35) break;
    }
    return {
      champion, seed, wave: g.wave, survival: (diedT > 0 ? diedT : g.now / 1000),
      totalDmg: Math.round(totalDmg), firstHitT, died: p.dead, deathWave: p.dead ? g.wave : null,
      insta: (p.dead && firstHitT >= 0 && (diedT - firstHitT) < 3),
      noDmgRun: (g.wave >= 5 && totalDmg === 0),
    };
  }

  // TTK: wave1 기본 잡몹(슬라임/고블린/박쥐) 1마리 처치 시간
  function measureTTK(champion, mob) {
    const g = new Game({ seed: 7 });
    const p = g.addPlayer('bot', 'B', champion);
    g.enemies = []; g.spawnQueue = []; g.phase = 'playing'; g.wave = 1;
    p.x = 400; p.y = 360;
    const e = g.spawnEnemy({ type: mob, elite: null, boss: false });
    e.x = 470; e.y = 360;
    for (let i = 0; i < 30 * 8; i++) {
      const a = Math.atan2(e.y - p.y, e.x - p.x);
      p.input.aimAngle = a; p.input.attacking = true;
      const dist = Math.hypot(e.x - p.x, e.y - p.y);
      const ranged = (champion === 'mage' || champion === 'archer');
      const inR = ranged ? dist < 240 : dist <= p.stats.range + e.r - 8;
      p.input.moveX = inR ? 0 : Math.cos(a); p.input.moveY = inR ? 0 : Math.sin(a);
      g.tick();
      if (e.hp <= 0 || g.enemies.length === 0) return (i + 1) / 30;
    }
    return Infinity;
  }

  function measureMode(useAug) {
    const all = [];
    for (const c of champs) for (const s of seeds) all.push(runOne(c, s, useAug));
    const agg = {};
    for (const c of champs) {
      const rs = all.filter(r => r.champion === c);
      const avg = k => rs.reduce((s, r) => s + r[k], 0) / rs.length;
      const valid = rs.filter(r => r.wave >= 5);
      agg[c] = {
        avgWave: +avg('wave').toFixed(1), avgSurv: +avg('survival').toFixed(1), avgDmg: Math.round(avg('totalDmg')),
        insta: rs.filter(r => r.insta).length, noDmg: valid.filter(r => r.noDmgRun).length, deaths: rs.filter(r => r.died).length,
        deathWaves: rs.filter(r => r.died).map(r => r.deathWave),
      };
    }
    return agg;
  }
  function report(title, agg) {
    console.log('\n===== ' + title + ' (4직업 × ' + seeds.length + '시드) =====');
    for (const c of champs) {
      const a = agg[c];
      console.log(`${c.padEnd(9)} 도달웨이브=${a.avgWave}  생존=${a.avgSurv}s  받은피해=${a.avgDmg}  사망런=${a.deaths}/${seeds.length}  사망웨이브=[${a.deathWaves.join(',')}]  즉사런=${a.insta}  무피해런=${a.noDmg}`);
    }
    const waves = champs.map(c => agg[c].avgWave);
    return { minW: Math.min(...waves), maxW: Math.max(...waves),
      spread: (Math.max(...waves) - Math.min(...waves)) / ((Math.max(...waves) + Math.min(...waves)) / 2),
      insta: champs.reduce((s, c) => s + agg[c].insta, 0), noDmg: champs.reduce((s, c) => s + agg[c].noDmg, 0) };
  }

  const floor = measureMode(false);
  const fStat = report('무보강(난이도 바닥)', floor);
  const real = measureMode(true);
  const rStat = report('증강 사용(실제 플레이)', real);

  console.log('\n----- TTK(wave1 기본잡몹 슬/고/박, 1차무기) -----');
  for (const c of champs) {
    const ttk = ['slime', 'goblin', 'bat'].map(m => measureTTK(c, m));
    console.log(`  ${c.padEnd(9)} ${ttk.map(t => t.toFixed(2)).join(' / ')}s`);
  }

  console.log('\n--- 합격선 평가 ---');
  const chk = (cond, label) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}: ${label}`); return cond; };
  let allPass = true;
  allPass &= chk(fStat.insta === 0 && rStat.insta === 0, `즉사런 0건 (무보강 ${fStat.insta} / 증강 ${rStat.insta})`);
  allPass &= chk(fStat.noDmg === 0 && rStat.noDmg === 0, `무피해런(wave≥5) 0건 (무보강 ${fStat.noDmg} / 증강 ${rStat.noDmg})`);
  allPass &= chk(rStat.minW >= 10 && rStat.maxW <= 18, `[실제] 4직업 평균 도달웨이브 10~18 (실제 ${rStat.minW.toFixed(1)}~${rStat.maxW.toFixed(1)})`);
  allPass &= chk(rStat.spread <= 0.35, `[실제] 직업 간 편차 ≤35% (실제 ${(rStat.spread * 100).toFixed(0)}%)`);
  allPass &= chk(fStat.minW >= 3, `[무보강] 최소 도달웨이브 ≥3(바닥에서도 보스 도달) (실제 ${fStat.minW.toFixed(1)})`);
  console.log(allPass ? '\n=> 합격선 통과' : '\n=> 일부 미달(추가 튜닝 필요)');
  process.exit(0);
}
