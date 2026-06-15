'use strict';
/* Arena Wave — app.js (클라이언트 본체)
 * 역할: socket.io 연결 / 직접조준 입력 / 30Hz input 송신 / state·events 렌더.
 * 렌더는 z-order(design-spec §0)대로. 챔피언·적·이펙트는 자체 폴백을 내장하되,
 * window.ChampMotion / window.Effects 훅이 있으면 우선 사용한다(없어도 완전 동작).
 *
 * 소켓 계약(server.js와 합의):
 *  클→서: join{name,champion} / input{moveX,moveY,aimAngle,attacking,dashing}
 *          / select_augment{id} / restart
 *  서→클: joined{id} / state(30Hz) / events[]
 */

(() => {
// ────────────────────────────── 디자인 토큰 ──────────────────────────────
const PAL = {
  bgBase: '#0D0D1A', bgGrid: '#1E1E3A', arena: '#334466',
  ally: '#4A90E2', allyLt: '#88CCFF', allyDk: '#1A4A8A',
  enemy: '#FF4444', enemyLt: '#FF8844', enemyDk: '#8B0000',
  gold: '#FFD700', goldDim: '#AA8800', warn: '#FF4444',
  text: '#FFFFFF', text2: '#AAAACC',
};
const TAU = Math.PI * 2;
const ARENA = { w: 1280, h: 720 };
const RENDER_DELAY = 16; // 보간 지연 버퍼(ms) — 30Hz 스냅샷을 외삽 없이 매끄럽게 잇기 위한 소폭 지연

const ease = {
  outQuad: t => 1 - (1 - t) * (1 - t),
  outBack: t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  outCirc: t => Math.sqrt(1 - Math.pow(t - 1, 2)),
  inOutSine: t => -(Math.cos(Math.PI * t) - 1) / 2,
  inQuad: t => t * t,
  linear: t => t,
};
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => { let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI; return a + d * t; };
const rnd = (a, b) => a + Math.random() * (b - a);

// ────────────────────────────── 챔피언 메타 ──────────────────────────────
const CHAMP_META = {
  warrior: {
    name: '전사', role: '근접 · 광역 검 스윙', color: PAL.ally, body: '#2C4A7C', accent: '#4A7FBF',
    desc: '넓은 부채꼴 호로 다수를 쓸어담는 강인한 전선 지휘관.',
    stats: { hp: 1.0, spd: 0.66, dmg: 0.78, rng: 0.5 },
  },
  mage: {
    name: '마법사', role: '원거리 · 마법탄', color: '#9B59B6', body: '#4A1080', accent: '#8B44CC',
    desc: '관통·연쇄 마법탄으로 화면을 메우는 폭격형 캐스터.',
    stats: { hp: 0.55, spd: 0.55, dmg: 0.62, rng: 0.9 },
  },
  archer: {
    name: '궁수', role: '원거리 · 연사 화살', color: '#27AE60', body: '#2E7D32', accent: '#4CAF50',
    desc: '빠른 연사와 관통으로 일렬의 적을 꿰뚫는 명사수.',
    stats: { hp: 0.62, spd: 0.62, dmg: 0.5, rng: 1.0 },
  },
  assassin: {
    name: '암살자', role: '근접 · 대시 단검', color: '#E91E63', body: '#2D1B4E', accent: '#7B3FA0',
    desc: '마우스 방향으로 순간 대시해 연속 베기를 꽂는 처형자.',
    stats: { hp: 0.5, spd: 1.0, dmg: 0.46, rng: 0.42 },
  },
};
const CHAMP_ORDER = ['warrior', 'mage', 'archer', 'assassin'];

// ────────────────────────────── 적 메타(폴백 외형) ──────────────────────────────
const ENEMY_META = {
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
const ELITE_TINT = {
  swift: '#FFE24A', steel: '#7FB4FF', thorn: '#FF5C5C', elite: '#FFD700',
};
const ELITE_NAME = { swift: '가속', steel: '강철', thorn: '가시', elite: '정예' };
const BOSS_THEME = (wave) => {
  if (wave >= 20) return { body: 'hue', edge: '#FFFFFF' };
  if (wave >= 15) return { body: '#005500', edge: '#44FF88' };
  if (wave >= 10) return { body: '#000088', edge: '#44AAFF' };
  return { body: '#880000', edge: '#FFD700' };
};

// 증강 아이콘 글리프(이모지) — DOM 카드용
const AUG_GLYPH = {
  sharp: '🗡️', steelheart: '❤️', boots: '👢', frenzy: '⚡', vamp: '🩸', critup: '🎯',
  execute: '💥', thornarmor: '🌵', regen: '✨', titan: '🗿', berserk: '😡', flame: '🔥',
  frost: '❄️', venom: '🧪', bash: '🔨', immortal: '🛡️',
  w_whirl: '🌀', w_great: '⚔️', w_rally: '📣', w_shield: '🛡️', w_exec: '☠️', w_crush: '💢', w_unbreak: '🏰', w_tempest: '🌪️',
  m_focus: '🔮', m_pierce: '➡️', m_swift: '💨', m_ward: '🟣', m_chain: '⛓️', m_fire: '🔥', m_frost: '❄️', m_storm: '🌌',
  a_aim: '🎯', a_pierce: '🏹', a_venom: '🟢', a_instinct: '🐺', a_multi: '🎏', a_quick: '✋', a_explode: '💥', a_storm: '🌬️',
  s_blade: '🔪', s_dash: '👣', s_venom: '☠️', s_speed: '💨', s_combo: '✖️', s_vital: '💗', s_leech: '🩸', s_phantom: '👤',
};

// ────────────────────────────── 스킬 메타(폴백 표현) ──────────────────────────────
// 서버 스킬 type → 아이콘 글리프·색. 슬롯 이름/등급은 offer choice 수신 시 캐시에 저장.
const SKILL_TYPE_GLYPH = {
  dash_strike: '⚡', aoe_field: '☣', nova: '✺', projectile_barrage: '✶',
  buff: '🔆', summon: '☗', chain: '🔗',
};
const SKILL_TYPE_COLOR = {
  dash_strike: '#FF66AA', aoe_field: '#88FF44', nova: '#FFAA33', projectile_barrage: '#66CCFF',
  buff: '#FFD700', summon: '#9B6BFF', chain: '#33E0E0',
};
const RARITY_COLOR = { common: '#9aa0b5', rare: '#4A90E2', legendary: '#FFD700' };
const SLOT_KEYS = ['Q', 'E', 'R'];
const KEY_TO_SLOT = { q: 0, e: 1, r: 2 };
// id → { name, rarity, skillType, desc } : offer가 올 때마다 누적(서버 단일 출처).
const skillMetaCache = Object.create(null);
function cacheChoiceMeta(choices) {
  if (!choices) return;
  for (const c of choices) {
    if (c && c.kind === 'skill') skillMetaCache[c.id] = { name: c.name, rarity: c.rarity, skillType: c.skillType, desc: c.desc };
  }
}
function skillMeta(id) { return skillMetaCache[id] || { name: id, rarity: 'common', skillType: 'buff', desc: '' }; }

// ────────────────────────────── 캔버스 셋업 ──────────────────────────────
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
canvas.width = ARENA.w; canvas.height = ARENA.h;

function fitCanvas() {
  const stage = document.getElementById('stage');
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const scale = Math.min(sw / ARENA.w, sh / ARENA.h);
  canvas.style.width = Math.round(ARENA.w * scale) + 'px';
  canvas.style.height = Math.round(ARENA.h * scale) + 'px';
}
window.addEventListener('resize', fitCanvas);
fitCanvas();

// 마우스 client → 캔버스 내부좌표 변환
function toCanvas(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (clientX - r.left) / r.width * ARENA.w,
    y: (clientY - r.top) / r.height * ARENA.h,
  };
}

// ────────────────────────────── 입력 상태 ──────────────────────────────
const keys = Object.create(null);
const input = { moveX: 0, moveY: 0, aimAngle: 0, attacking: false, dashing: false };
let mouseCanvas = { x: ARENA.w / 2, y: ARENA.h / 2 };
let dashLatch = false; // Space 단발 대시

const skillFeedback = [0, 0, 0]; // 슬롯별 사용 펄스(performance.now+ms). 막힘은 음수 표시.
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (!e.repeat) keys[k] = true;
  if (k === ' ' && uiMode === 'game') { dashLatch = true; e.preventDefault(); }
  // 스킬: Q/E/R → use_skill{slot}. 자동조준 없이 현재 마우스 각만 사용.
  if (!e.repeat && (k === 'q' || k === 'e' || k === 'r') && uiMode === 'game' && phase === 'playing') {
    trySkill(KEY_TO_SLOT[k]);
  }
});

function trySkill(slot) {
  const me = myRenderPlayer();
  if (!me || !me.skills) return;
  const sk = me.skills[slot];
  if (!sk) { skillFeedback[slot] = -(performance.now() + 320); return; } // 빈 슬롯: 막힘
  if (!sk.ready || sk.cdLeft > 0) { skillFeedback[slot] = -(performance.now() + 320); return; } // 쿨다운: 막힘
  const aim = Math.atan2(mouseCanvas.y - me.y, mouseCanvas.x - me.x);
  socket.emit('use_skill', { slot, aimAngle: aim });
  skillFeedback[slot] = performance.now() + 260; // 사용 펄스
}
window.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; input.attacking = false; });

canvas.addEventListener('mousemove', (e) => { mouseCanvas = toCanvas(e.clientX, e.clientY); });
canvas.addEventListener('mousedown', (e) => {
  if (e.button === 0) input.attacking = true;
  if (e.button === 2) dashLatch = true;
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) input.attacking = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function readMovement() {
  let x = 0, y = 0;
  if (keys['w'] || keys['arrowup']) y -= 1;
  if (keys['s'] || keys['arrowdown']) y += 1;
  if (keys['a'] || keys['arrowleft']) x -= 1;
  if (keys['d'] || keys['arrowright']) x += 1;
  input.moveX = x; input.moveY = y;
}

// ────────────────────────────── 네트워크 상태 ──────────────────────────────
let socket = null;
let myPid = null;
let joined = false;
let selectedChamp = null;
let phase = 'lobby';
let uiMode = 'lobby';   // 'lobby' | 'room' | 'game'
let roomCode = null;
let roomData = null;    // 최신 room_state

let snapPrev = null, snapCur = null;
let snapPrevAt = 0, snapCurAt = 0;
let serverClockOffset = 0; // serverNow = performance.now() + offset

const connEl = document.getElementById('conn');
function setConn(txt, ok) {
  connEl.textContent = txt;
  connEl.classList.toggle('ok', !!ok);
}

function connect() {
  socket = io({ transports: ['websocket', 'polling'] });
  socket.on('connect', () => setConn('서버 연결됨', true));
  socket.on('disconnect', () => { setConn('연결 끊김 — 재접속 중…', false); connEl.classList.remove('hide'); });
  socket.on('connect_error', () => setConn('연결 오류 — 재시도 중…', false));

  // ── 룸/로비 이벤트 ──
  socket.on('room_created', (d) => { if (d && d.pid != null) { myPid = d.pid; roomCode = d.code; enterRoom(); } });
  socket.on('room_joined', (d) => { if (d && d.pid != null) { myPid = d.pid; roomCode = d.code; enterRoom(); } });
  socket.on('room_error', (d) => { showToast(roomErrorText((d && d.reason) || 'error')); });
  socket.on('rooms_list', (d) => { renderRoomList((d && d.rooms) || []); });
  socket.on('room_state', (s) => {
    roomData = s;
    // 게임오버 후 restart_room 등으로 방이 lobby 단계로 돌아오면 대기실로 복귀.
    if (s.phase === 'lobby' && uiMode === 'game') { enterRoom(); return; }
    if (uiMode === 'room') renderRoom(s);
  });
  socket.on('game_started', () => { enterGame(); });

  socket.on('state', (s) => {
    snapPrev = snapCur; snapPrevAt = snapCurAt;
    snapCur = s; snapCurAt = performance.now();
    serverClockOffset = s.t - snapCurAt;
    if (!snapPrev) { snapPrev = s; snapPrevAt = snapCurAt; }
    if (uiMode !== 'game') enterGame(); // state가 오면 인게임 보장(재접속/늦참)
    handlePhase(s);
  });

  socket.on('events', (evs) => { for (const ev of evs) handleEvent(ev); });
}

function roomErrorText(reason) {
  return ({
    no_room: '존재하지 않는 방 코드입니다', full: '방이 가득 찼습니다(최대 4명)',
    in_progress: '이미 진행 중인 방입니다', champion_taken: '이미 선택된 챔피언입니다',
    not_host: '방장만 시작할 수 있습니다', not_ready: '모든 멤버가 준비해야 합니다',
    need_players: '최소 인원이 필요합니다', name_taken: '사용 중인 닉네임입니다',
  })[reason] || ('오류: ' + reason);
}

function serverNow() { return performance.now() + serverClockOffset; }

// ────────────────────────────── input 송신 30Hz ──────────────────────────────
function myRenderPlayer() {
  if (!snapCur || myPid == null) return null;
  return snapCur.players.find(p => p.id === myPid) || null;
}

function sendInput() {
  if (!socket || uiMode !== 'game') return;
  readMovement();
  const me = myRenderPlayer();
  if (me) {
    // 직접조준: 마우스 캔버스 좌표 - 내 플레이어 위치 → 각도(자동조준 없음)
    input.aimAngle = Math.atan2(mouseCanvas.y - me.y, mouseCanvas.x - me.x);
  }
  input.dashing = dashLatch || keys[' '];
  socket.emit('input', {
    moveX: input.moveX, moveY: input.moveY, aimAngle: input.aimAngle,
    attacking: input.attacking, dashing: input.dashing,
  });
  dashLatch = false;
}
setInterval(sendInput, 1000 / 30);

// ────────────────────────────── 로비 → 대기실 → 게임 흐름 ──────────────────────────────
function playerName() {
  const el = document.getElementById('player-name');
  return (el && el.value.trim()) || '용사';
}
function createRoom() { socket.emit('create_room', { name: playerName() }); }
function joinRoom(code) {
  code = (code || '').trim().toUpperCase();
  if (!code) { showToast('방 코드를 입력하세요'); return; }
  socket.emit('join_room', { code, name: playerName() });
}
function enterRoom() {
  uiMode = 'room';
  hideOverlay('lobby'); hideOverlay('gameover'); hideOverlay('augment-select');
  hideOverlay('mutator-select'); hideOverlay('skill-replace');
  showOverlay('room');
  startRoomPreview();
  if (roomData) renderRoom(roomData);
  setTimeout(() => connEl.classList.add('hide'), 1000);
}
function enterGame() {
  uiMode = 'game';
  hideOverlay('lobby'); hideOverlay('room'); hideOverlay('gameover');
  connEl.classList.add('hide');
}
function backToLobby() {
  uiMode = 'lobby'; roomData = null; roomCode = null; snapCur = null; snapPrev = null;
  hideOverlay('room'); hideOverlay('gameover'); hideOverlay('augment-select');
  hideOverlay('mutator-select'); hideOverlay('skill-replace');
  showOverlay('lobby'); requestRoomList();
}
// 게임오버 후 '다시 시작' = 대기실 복귀(restart_room). 방장만 실제 초기화, 비방장은 대기.
function restartGame() { socket.emit('restart_room'); }

let roomListTimer = null;
function requestRoomList() { if (socket) socket.emit('list_rooms'); }
function showToast(msg) {
  const t = document.getElementById('lobby-error');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(showToast._t); showToast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ────────────────────────────── phase 전환 처리 ──────────────────────────────
function handlePhase(s) {
  const prev = phase;
  phase = s.phase;
  if (phase === 'augment_select') {
    canvas.classList.add('time-stopped');   // 시간정지 비주얼
    renderAugmentCards(s);
  } else {
    canvas.classList.remove('time-stopped'); // 퇴장 시 제거
    if (!skillReplace.open) hideOverlay('augment-select');
  }
  if (phase === 'mutator_select') renderMutatorCards(s);
  else hideOverlay('mutator-select');
  if (phase === 'gameover' && prev !== 'gameover') showGameOver(s);
  if (phase !== 'gameover') hideOverlay('gameover');
}

// ────────────────────────────── 이벤트 → 연출/이펙트 ──────────────────────────────
const FX = makeFallbackEffects();
const dmgNumbers = [];
let hitstopUntil = 0;
const shake = { mag: 0, until: 0, seed: 0 };
const waveBanner = { text: '', sub: '', until: 0, start: 0, boss: false };
const bossDefeated = { until: 0 };
let bossVignette = 0; // 보스전 지속 비네트 강도(0~0.2)

// ── 오브 카운터 HUD 애니메이션 상태 (design-spec 8-3) ──
const ORB_THRESHOLD = 10;
const orbSlotAnims = []; // [{ until, duration, start }] — 슬롯별 fill 펄스
let orbThresholdAnim = null; // { start, until } — 임계치 도달 특별 연출
let _orbDisplayCount = 0; // 마지막으로 렌더한 orbCount (슬롯 ON 트리거용)
let lastAugSource = 'wave'; // 마지막 augment_offer 출처 ('wave' | 'orb')

function addShake(mag, ms) {
  const now = performance.now();
  shake.mag = Math.max(shake.mag, mag);
  shake.until = Math.max(shake.until, now + ms);
  shake.seed = Math.random() * 1000;
}

function enemyPos(id) {
  if (!snapCur) return null;
  const e = snapCur.enemies.find(en => en.id === id);
  return e ? { x: e.x, y: e.y } : null;
}

function effectsAPI() { return (window.Effects && typeof window.Effects.spawn === 'function') ? window.Effects : FX; }

function handleEvent(ev) {
  const fx = effectsAPI();
  // 방어: 서버가 skill_cast 이벤트의 type 키를 스킬타입으로 덮어쓴 경우(객체 키 중복 직렬화 버그)
  // ev.type이 'skill_cast'가 아니라 'nova'/'aoe_field' 등으로 오므로 정규화한다.
  // 서버가 향후 {type:'skill_cast', skillType} 형태로 고쳐도 그대로 동작한다.
  let etype = ev.type;
  if (etype !== 'skill_cast' && SKILL_TYPE_GLYPH[etype] && ev.slot != null) { ev.skillType = etype; etype = 'skill_cast'; }
  switch (etype) {
    case 'attack': {
      const p = snapCur && snapCur.players.find(pp => pp.id === ev.id);
      const champ = p ? p.champion : 'warrior';
      fx.spawn('attack', { x: p ? p.x : 0, y: p ? p.y : 0, kind: ev.kind, aimAngle: ev.aimAngle, champion: champ, tier: p ? p.tier : 1 });
      break;
    }
    case 'hit': {
      fx.spawn('hit', ev);
      dmgNumbers.push({
        x: ev.x, y: ev.y - 10, vy: -42, life: 0, max: ev.crit ? 1.0 : 0.85,
        text: String(ev.dmg), crit: !!ev.crit, color: ev.crit ? PAL.gold : '#FFFFFF', friend: false,
      });
      break;
    }
    case 'player_hit': {
      dmgNumbers.push({ x: ev.x, y: ev.y - 14, vy: -40, life: 0, max: 0.85, text: String(ev.dmg), crit: false, color: PAL.warn, friend: true });
      addShake(6, 150);
      fx.spawn('player_hit', ev); // Effects가 붉은 비네트+피격 스파크만 추가(숫자/셰이크는 위에서 app이 처리)
      break;
    }
    case 'heal': {
      fx.spawn('heal', ev);
      dmgNumbers.push({ x: ev.x, y: ev.y - 10, vy: -38, life: 0, max: 0.9, text: '+' + ev.amt, crit: false, color: '#44FF88', friend: false });
      break;
    }
    case 'explosion': fx.spawn('explosion', ev); if (!ev.small) addShake(8, 300); break;
    case 'death': fx.spawn('death', ev); break;
    case 'status': { const pos = enemyPos(ev.target); if (pos) fx.spawn('status', { x: pos.x, y: pos.y, kind: ev.kind }); break; }
    case 'levelup': { const p = snapCur && snapCur.players.find(pp => pp.id === ev.id); if (p) fx.spawn('levelup', { x: p.x, y: p.y }); break; }
    case 'augment_aura': {
      const p = snapCur && snapCur.players.find(pp => pp.id === ev.id);
      if (p) fx.spawn('augment_aura', { x: p.x, y: p.y, champion: ev.champion, augId: ev.augId });
      break;
    }
    case 'knockback': break; // 위치는 서버 권위(state 반영). 시각만 보간으로 따라감.
    case 'chain_link': fx.spawn('chain_link', ev); break; // 연쇄 번개 좌표 → Effects가 번개 폴리라인 렌더
    case 'skill_cast': {
      // 스킬 발동 1회 신호 → VFX(없으면 폴백 노바/장판/돌진 이펙트). 모션은 player.castAnim으로 ChampMotion이 그림.
      const st = ev.skillType || ev.type;
      fx.spawn('skill_cast', ev);
      addShake(st === 'nova' || st === 'aoe_field' ? 5 : 3, 120);
      break;
    }
    case 'player_revived': { fx.spawn('respawn', { x: ev.x, y: ev.y }); addShake(3, 110); break; } // 아군 부활 연출
    case 'augment_offer': cacheChoiceMeta(ev.choices); lastAugSource = ev.source || 'wave'; break; // 스킬 id→메타 캐시(서버 단일 출처)
    case 'orb_grant': {
      const _now = performance.now();
      const _slot = Math.max(0, (ev.orbCount || 1) - 1); // 0-indexed 슬롯
      orbSlotAnims[_slot] = { start: _now, until: _now + 450, duration: 450 };
      _orbDisplayCount = ev.orbCount || 0;
      const _SOX = 20, _SOY = ARENA.h - 64, _SW = 16, _SH = 6, _SGAP = 4;
      const _slotCx = _SOX + _slot * (_SW + _SGAP) + _SW / 2;
      const _slotCy = _SOY + _SH / 2;
      fx.spawn('orb_grant', { x: ev.x, y: ev.y, tx: _slotCx, ty: _slotCy });
      break;
    }
    case 'orb_threshold': {
      const _now2 = performance.now();
      orbThresholdAnim = { start: _now2, until: _now2 + 900 };
      fx.spawn('orb_threshold', { pid: ev.pid });
      addShake(5, 200);
      break;
    }
    case 'orb_revoke': {
      if (ev.orbCount != null) _orbDisplayCount = ev.orbCount;
      break;
    }
    case 'mutator_offer': cacheMutatorOffer(ev.choices); break;
    case 'mutator_chosen': {
      waveBanner.text = ev.name || '변이 적용'; waveBanner.sub = '이번 판 규칙이 바뀐다';
      waveBanner.boss = false; waveBanner.start = performance.now(); waveBanner.until = performance.now() + 1600;
      break;
    }
    case 'hitstop': hitstopUntil = performance.now() + (ev.ms || 60); break;
    case 'shake': addShake(ev.mag || 3, ev.ms || 100); break;
    case 'wave_start': {
      const boss = !!ev.boss;
      waveBanner.text = boss ? '⚠ BOSS WAVE ⚠' : 'WAVE ' + ev.wave;
      waveBanner.sub = boss ? '강력한 적이 다가온다…' : '준비하세요!';
      waveBanner.boss = boss;
      waveBanner.start = performance.now();
      waveBanner.until = performance.now() + (boss ? 2600 : 2000);
      bossVignette = boss ? 0.2 : 0;
      break;
    }
    case 'boss_spawn': addShake(6, 500); break;
    case 'wave_clear':
      waveBanner.text = 'WAVE CLEAR!'; waveBanner.sub = '+ 처치 ' + (ev.kills || 0);
      waveBanner.boss = false; waveBanner.start = performance.now(); waveBanner.until = performance.now() + 1400;
      bossVignette = 0;
      break;
    case 'game_over': break; // handlePhase에서 처리
    default: break;
  }
}

// ────────────────────────────── 메인 렌더 루프 ──────────────────────────────
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  // 이펙트 인스턴스를 프레임당 1회 확정 — spawn(handleEvent)/update/render가 같은 인스턴스로 가도록.
  const fx = effectsAPI();
  // 히트스톱: 보간 동결(렌더는 계속). app가 권위지만 window.Effects가 getHitStop를 제공하면 그 값도 반영.
  let frozen = now < hitstopUntil;
  if (typeof fx.getHitStop === 'function') { const hs = fx.getHitStop(); if (typeof hs === 'number' && hs > 0) frozen = true; }

  // 보간 알파 — 외삽(적 다수 시 떨림·순간이동)을 제거하고 두 스냅샷 사이를 [0,1]로만 내삽.
  // 작은 지연 버퍼(RENDER_DELAY)로 30Hz→60fps가 매끄럽게 이어진다.
  let alpha = 1;
  if (snapPrev && snapCur && snapCurAt > snapPrevAt) {
    alpha = clamp((now - RENDER_DELAY - snapPrevAt) / (snapCurAt - snapPrevAt), 0, 1);
  }
  if (frozen) alpha = 0;

  // 화면 흔들림
  let sx = 0, sy = 0;
  if (now < shake.until) {
    const k = (shake.until - now) / 220;
    const m = shake.mag * clamp(k, 0, 1);
    sx = Math.cos(now * 0.09 + shake.seed) * m;
    sy = Math.sin(now * 0.11 + shake.seed * 1.7) * m;
  } else { shake.mag = 0; }
  // window.Effects가 자체 화면흔들림을 제공하면 픽셀 오프셋을 합산(없으면 app 자체값만).
  if (typeof fx.getScreenShake === 'function') { const sh = fx.getScreenShake(); if (sh && typeof sh.x === 'number') { sx += sh.x; sy += sh.y; } }

  ctx.clearRect(0, 0, ARENA.w, ARENA.h);
  ctx.save();
  ctx.translate(sx, sy);

  // L0 배경
  drawBackground(now);

  const sNow = serverNow();
  if (snapCur) {
    const players = interpEntities(snapPrev.players, snapCur.players, alpha);
    const enemies = interpEntities(snapPrev.enemies, snapCur.enemies, alpha);
    const projectiles = interpEntities(snapPrev.projectiles, snapCur.projectiles, alpha);
    tagBossWave(enemies, snapCur.wave); // 보스 _wave 주입(L2 적 렌더 전 — EnemyMotion 보스 테마용)

    // 최신 스냅샷을 Effects에 주입(적 windup 텔레그래프·boss.telegraph 렌더용). 폴백엔 setState 없음.
    if (typeof fx.setState === 'function') fx.setState(snapCur);

    drawFloorEffects(enemies, snapCur.boss, now);          // L1
    drawFields(snapCur.fields, sNow);                      // L1 — 스킬 장판(aoe_field)
    for (const e of enemies) drawEnemy(ctx, e, sNow);      // L2
    const summons = interpEntities(snapPrev.summons || [], snapCur.summons || [], alpha);
    for (const sm of summons) drawSummon(ctx, sm, sNow);   // L2.5 — 소환수
    for (const p of players) drawChampionDispatch(ctx, p, sNow); // L3
    drawReviveTimers(players, sNow);                       // L3.5 — 다운된 아군 부활 카운트다운
    for (const pr of projectiles) drawProjectile(ctx, pr, sNow); // L4

    if (!frozen && typeof fx.update === 'function') fx.update(dt);
    (fx.render || FX.render).call(fx, ctx, sNow, snapCur); // L5 — 3번째 인자=최신 스냅샷(적/보스 텔레그래프용; 폴백은 무시)

    drawDamageNumbers(dt, frozen);                         // L6
    drawHUD(snapCur, players);                             // L7
    drawSkillBar(snapCur, sNow);                           // L7 — Q/E/R 스킬바
    drawBuffsAndMutator(snapCur, sNow);                    // L7 — 버프/변이 표시
    drawPartyHud(snapCur);                                 // L7 — 파티 HP(멀티)
    drawBossBar(snapCur);                                  // L7
  }

  drawWaveBanner(now);   // L8
  drawBossDefeated(now); // L8
  ctx.restore();

  requestAnimationFrame(frame);
}

// 엔티티 id 매칭 보간
function interpEntities(prevArr, curArr, alpha) {
  if (!prevArr || alpha >= 1) return curArr;
  const prevMap = new Map(prevArr.map(e => [e.id, e]));
  return curArr.map(cur => {
    const pv = prevMap.get(cur.id);
    if (!pv) return cur;
    const o = Object.assign({}, cur);
    o.x = lerp(pv.x, cur.x, alpha);
    o.y = lerp(pv.y, cur.y, alpha);
    if (typeof cur.facing === 'number' && typeof pv.facing === 'number')
      o.facing = lerpAngle(pv.facing, cur.facing, alpha);
    return o;
  });
}

// ────────────────────────────── L0 배경 ──────────────────────────────
let floorDecor = null;
function drawBackground(now) {
  ctx.fillStyle = PAL.bgBase;
  ctx.fillRect(0, 0, ARENA.w, ARENA.h);
  // 격자
  ctx.strokeStyle = PAL.bgGrid; ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for (let x = 0; x <= ARENA.w; x += 60) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, ARENA.h); }
  for (let y = 0; y <= ARENA.h; y += 60) { ctx.moveTo(0, y + 0.5); ctx.lineTo(ARENA.w, y + 0.5); }
  ctx.stroke();
  ctx.globalAlpha = 1;
  // 바닥 장식(고정 패턴)
  if (!floorDecor) {
    floorDecor = [];
    let seed = 1337;
    const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 10; i++) floorDecor.push({ x: rng() * ARENA.w, y: rng() * ARENA.h, r: 20 + rng() * 20 });
  }
  ctx.strokeStyle = '#FFFFFF'; ctx.globalAlpha = 0.03; ctx.lineWidth = 2;
  for (const d of floorDecor) { ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, TAU); ctx.stroke(); }
  ctx.globalAlpha = 1;
  // 아레나 경계
  ctx.strokeStyle = PAL.arena; ctx.lineWidth = 3; ctx.shadowColor = PAL.arena; ctx.shadowBlur = 8;
  ctx.strokeRect(2, 2, ARENA.w - 4, ARENA.h - 4);
  ctx.shadowBlur = 0;
  // 비네트
  const g = ctx.createRadialGradient(ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.35, ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.42)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, ARENA.w, ARENA.h);
  // 보스전 붉은 비네트
  if (bossVignette > 0.001 && phase === 'playing') {
    const r = ctx.createRadialGradient(ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.3, ARENA.w / 2, ARENA.h / 2, ARENA.h * 0.78);
    r.addColorStop(0, 'rgba(170,0,0,0)'); r.addColorStop(1, 'rgba(170,0,0,' + (0.45 * bossVignette / 0.2) + ')');
    ctx.fillStyle = r; ctx.fillRect(0, 0, ARENA.w, ARENA.h);
  }
}

// ────────────────────────────── L1 바닥 이펙트(그림자/텔레그래프) ──────────────────────────────
function drawFloorEffects(enemies, boss, now) {
  // 그림자
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  for (const e of enemies) {
    ctx.beginPath(); ctx.ellipse(e.x, e.y + e.r * 0.78, e.r * 0.85, e.r * 0.34, 0, 0, TAU); ctx.fill();
  }
  // 폭발거인 범위 표시
  for (const e of enemies) {
    if (e.type === 'giant') {
      ctx.strokeStyle = 'rgba(255,68,0,0.22)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(e.x, e.y, 120, 0, TAU); ctx.stroke();
    }
    if (e.type === 'darkmage') {
      ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(now * 0.0005);
      ctx.strokeStyle = 'rgba(155,0,255,0.3)'; ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) { const a = i / 6 * TAU; const px = Math.cos(a) * 28, py = Math.sin(a) * 28; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
      ctx.stroke(); ctx.restore();
    }
  }
  // 보스 텔레그래프(예고 범위)
  if (boss && boss.telegraph) {
    const tg = boss.telegraph;
    const left = Math.max(0, (tg.until - serverNow()));
    const pulse = 0.35 + 0.25 * Math.sin(now * 0.012);
    ctx.save();
    ctx.fillStyle = 'rgba(255,40,40,' + (0.16 + pulse * 0.12) + ')';
    ctx.strokeStyle = 'rgba(255,80,80,0.9)'; ctx.lineWidth = 3;
    if (tg.shape === 'cone') {
      ctx.beginPath(); ctx.moveTo(tg.x, tg.y);
      ctx.arc(tg.x, tg.y, tg.range, tg.angle - 0.6, tg.angle + 0.6); ctx.closePath();
      ctx.fill(); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(tg.x, tg.y, tg.range, 0, TAU); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
}

// ────────────────────────────── L2 적 12종 폴백 외형 ──────────────────────────────
function drawEnemy(ctx, e, now) {
  // 모션 훅 우선: enemyMotion.js가 본체+모션(windup/strike/recover)+엘리트·플래시·체력바까지 1:1 대체.
  if (window.EnemyMotion && typeof window.EnemyMotion.drawEnemy === 'function') {
    try { window.EnemyMotion.drawEnemy(ctx, e, now, { wave: snapCur ? snapCur.wave : 0 }); return; }
    catch (err) { /* 폴백으로 진행 */ }
  }
  const m = ENEMY_META[e.type] || ENEMY_META.slime;
  ctx.save();
  ctx.translate(e.x, e.y);
  const tilt = clamp((e.vx || 0) / 160, -1, 1) * (e.type === 'goblin' ? 0.26 : 0.17);
  // 엘리트 오라
  if (e.elite) {
    ctx.save();
    ctx.shadowColor = ELITE_TINT[e.elite] || '#fff'; ctx.shadowBlur = 16;
    ctx.strokeStyle = ELITE_TINT[e.elite] || '#fff'; ctx.lineWidth = 2; ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.arc(0, 0, e.r + 4, 0, TAU); ctx.stroke();
    ctx.restore();
  }
  ctx.rotate(tilt);

  const drawBody = ENEMY_DRAW[e.type] || ENEMY_DRAW.slime;
  drawBody(ctx, e, m, now);

  ctx.restore();

  // 피격 플래시(흰 오버레이)
  if (e.flash) {
    ctx.save(); ctx.translate(e.x, e.y); ctx.globalAlpha = 0.7;
    ctx.fillStyle = '#FFFFFF'; ctx.beginPath(); ctx.arc(0, 0, e.r, 0, TAU); ctx.fill(); ctx.restore();
  }
  // 상태이상 표시
  if (e.frozen) { ctx.save(); ctx.translate(e.x, e.y); ctx.fillStyle = 'rgba(136,204,255,0.35)'; ctx.beginPath(); ctx.arc(0, 0, e.r, 0, TAU); ctx.fill(); ctx.restore(); }
  // 체력바
  drawEnemyHp(e);
}

function drawEnemyHp(e) {
  if (e.hp >= e.maxHp) return;
  const w = e.r * 2.2, h = e.boss ? 0 : 4;
  if (h === 0) return;
  const x = e.x - w / 2, y = e.y - e.r - 9;
  ctx.fillStyle = '#222222'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#FF4444'; ctx.fillRect(x, y, w * clamp(e.hp / e.maxHp, 0, 1), h);
}

const ENEMY_DRAW = {
  slime(ctx, e, m, now) {
    const r = e.r, sq = 0.85 + 0.12 * Math.sin(now * 0.006 + e.id);
    ctx.save(); ctx.scale(1, sq);
    const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r);
    g.addColorStop(0, m.hi); g.addColorStop(1, e.hp / e.maxHp < 0.3 ? '#668844' : m.c);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill();
    ctx.restore();
    eyes(ctx, -r * 0.32, -r * 0.18, r * 0.32, r * 0.25);
  },
  goblin(ctx, e, m) {
    const r = e.r;
    // 귀
    ctx.fillStyle = m.c;
    tri(ctx, -r * 0.7, -r * 1.1, -r * 0.2, -r * 0.5, -r * 1.0, -r * 0.4);
    tri(ctx, r * 0.7, -r * 1.1, r * 0.2, -r * 0.5, r * 1.0, -r * 0.4);
    ball(ctx, 0, 0, r, m.hi, m.c);
    // 이빨
    ctx.fillStyle = '#fff'; tri(ctx, -r * 0.25, r * 0.45, -r * 0.05, r * 0.45, -r * 0.15, r * 0.78);
    tri(ctx, r * 0.25, r * 0.45, r * 0.05, r * 0.45, r * 0.15, r * 0.78);
    // 눈
    ctx.fillStyle = '#FFFF00'; dot(ctx, -r * 0.32, -r * 0.1, r * 0.16); dot(ctx, r * 0.32, -r * 0.1, r * 0.16);
    // 몽둥이
    ctx.strokeStyle = '#8B4513'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(r * 0.6, 0); ctx.lineTo(r * 1.5, -r * 0.4); ctx.stroke();
  },
  bat(ctx, e, m, now) {
    const r = e.r, flap = Math.sin(now * 0.02 + e.id);
    ctx.fillStyle = m.dk;
    ctx.save(); ctx.scale(1, 0.6 + 0.5 * Math.abs(flap));
    wing(ctx, -1, r); wing(ctx, 1, r);
    ctx.restore();
    ball(ctx, 0, 0, r, m.hi, m.c);
    ctx.fillStyle = '#FF0000'; dot(ctx, -r * 0.3, -r * 0.1, r * 0.18); dot(ctx, r * 0.3, -r * 0.1, r * 0.18);
  },
  skeleton(ctx, e, m, now) {
    const r = e.r;
    ball(ctx, 0, -r * 0.1, r * 0.92, m.hi, m.c);
    // 턱
    ctx.fillStyle = m.dk; ctx.beginPath(); ctx.arc(0, r * 0.35, r * 0.55, 0, Math.PI); ctx.fill();
    // 눈 소켓 글로우
    const gl = (e.state === 'attack' || e.state === 'idle') ? 14 : 6;
    ctx.save(); ctx.shadowColor = m.eye; ctx.shadowBlur = gl; ctx.fillStyle = m.eye;
    dot(ctx, -r * 0.32, -r * 0.15, r * 0.2); dot(ctx, r * 0.32, -r * 0.15, r * 0.2); ctx.restore();
    // 갈비뼈
    ctx.strokeStyle = m.c; ctx.lineWidth = 2;
    for (let i = 0; i < 3; i++) { const y = r * 0.55 + i * 5; ctx.beginPath(); ctx.moveTo(-r * 0.4, y); ctx.lineTo(r * 0.4, y); ctx.stroke(); }
  },
  slinger(ctx, e, m, now) {
    const r = e.r;
    // 후드 망토
    ctx.fillStyle = m.dk; ctx.beginPath(); ctx.arc(0, 0, r * 1.05, Math.PI * 0.1, Math.PI * 0.9); ctx.fill();
    ball(ctx, 0, 0, r, m.hi, m.c);
    ctx.fillStyle = m.eye; dot(ctx, -r * 0.3, -r * 0.05, r * 0.15); dot(ctx, r * 0.3, -r * 0.05, r * 0.15);
    // 투석끈
    ctx.strokeStyle = '#5E4F34'; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    const sw = Math.sin(now * 0.02 + e.id) * 0.5;
    ctx.beginPath(); ctx.moveTo(r * 0.7, 0); ctx.lineTo(r * 1.3, r * (0.4 + sw)); ctx.stroke();
    ctx.fillStyle = '#777'; dot(ctx, r * 1.3, r * (0.4 + sw), 3);
  },
  orc(ctx, e, m, now) {
    const r = e.r, bnc = 1 + 0.04 * Math.sin(now * 0.005 + e.id);
    ctx.save(); ctx.scale(1.12, bnc);
    // 어깨
    ctx.fillStyle = m.dk; ball(ctx, -r * 0.85, -r * 0.3, r * 0.5, m.dk, m.dk); ball(ctx, r * 0.85, -r * 0.3, r * 0.5, m.dk, m.dk);
    ball(ctx, 0, 0, r, m.hi, m.c);
    ctx.restore();
    // 엄니
    ctx.fillStyle = '#fff'; tri(ctx, -r * 0.28, r * 0.4, -r * 0.1, r * 0.4, -r * 0.2, r * 0.72);
    tri(ctx, r * 0.28, r * 0.4, r * 0.1, r * 0.4, r * 0.2, r * 0.72);
    ctx.fillStyle = '#FFEE66'; dot(ctx, -r * 0.3, -r * 0.1, r * 0.14); dot(ctx, r * 0.3, -r * 0.1, r * 0.14);
    // 도끼
    ctx.strokeStyle = '#888'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(r * 0.9, r * 0.4); ctx.lineTo(r * 1.5, -r * 0.5); ctx.stroke();
    ctx.fillStyle = '#aaa'; tri(ctx, r * 1.4, -r * 0.6, r * 1.7, -r * 0.2, r * 1.3, -r * 0.1);
  },
  splitslime(ctx, e, m, now) {
    const r = e.r, sq = 0.85 + 0.14 * Math.sin(now * 0.008 + e.id);
    ctx.save(); ctx.scale(1, sq);
    ball(ctx, 0, 0, r, m.hi, m.c);
    // 분열 균열선
    ctx.strokeStyle = m.dk; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -r * 0.7); ctx.lineTo(0, r * 0.7); ctx.moveTo(-r * 0.6, 0); ctx.lineTo(r * 0.6, 0); ctx.stroke();
    ctx.restore();
    eyes(ctx, -r * 0.3, -r * 0.18, r * 0.3, r * 0.22);
  },
  darkmage(ctx, e, m, now) {
    const r = e.r;
    // 어깨 삼각
    ctx.fillStyle = m.dk; tri(ctx, -r, -r * 0.2, -r * 0.3, -r * 0.6, -r * 0.3, r * 0.2);
    tri(ctx, r, -r * 0.2, r * 0.3, -r * 0.6, r * 0.3, r * 0.2);
    // 로브 Y자 자락
    ctx.beginPath(); ctx.moveTo(-r * 0.7, r * 0.3); ctx.lineTo(0, r * 1.3); ctx.lineTo(r * 0.7, r * 0.3); ctx.closePath(); ctx.fill();
    ball(ctx, 0, 0, r, m.hi, m.c);
    // 모자
    ctx.fillStyle = m.dk; tri(ctx, 0, -r * 1.5, -r * 0.7, -r * 0.6, r * 0.7, -r * 0.6);
    ctx.save(); ctx.shadowColor = m.eye; ctx.shadowBlur = 10; ctx.fillStyle = m.eye;
    dot(ctx, -r * 0.3, -r * 0.05, r * 0.16); dot(ctx, r * 0.3, -r * 0.05, r * 0.16); ctx.restore();
  },
  healerimp(ctx, e, m, now) {
    const r = e.r;
    ball(ctx, 0, 0, r, m.hi, m.c);
    // 작은 뿔
    ctx.fillStyle = m.dk; tri(ctx, -r * 0.5, -r * 0.8, -r * 0.2, -r * 0.5, -r * 0.7, -r * 0.4);
    tri(ctx, r * 0.5, -r * 0.8, r * 0.2, -r * 0.5, r * 0.7, -r * 0.4);
    ctx.fillStyle = '#fff'; dot(ctx, -r * 0.3, -r * 0.1, r * 0.14); dot(ctx, r * 0.3, -r * 0.1, r * 0.14);
    // 치유 십자 오라
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.006 + e.id);
    ctx.save(); ctx.globalAlpha = 0.5 + 0.4 * pulse; ctx.fillStyle = '#AFFFD0';
    ctx.fillRect(-2, -r - 12, 4, 9); ctx.fillRect(-5, -r - 9, 10, 4); ctx.restore();
  },
  shieldorc(ctx, e, m, now) {
    const r = e.r;
    ctx.save(); ctx.scale(1.1, 1);
    ball(ctx, 0, 0, r, m.hi, m.c);
    ctx.restore();
    ctx.fillStyle = '#fff'; tri(ctx, -r * 0.26, r * 0.4, -r * 0.08, r * 0.4, -r * 0.18, r * 0.68);
    tri(ctx, r * 0.26, r * 0.4, r * 0.08, r * 0.4, r * 0.18, r * 0.68);
    ctx.fillStyle = '#FFEE66'; dot(ctx, -r * 0.28, -r * 0.1, r * 0.13); dot(ctx, r * 0.28, -r * 0.1, r * 0.13);
    // 방패(전면 facing)
    ctx.save(); ctx.rotate(e.facing);
    const g = ctx.createLinearGradient(r * 0.6, 0, r * 1.3, 0); g.addColorStop(0, '#9bb0c5'); g.addColorStop(1, '#5a6a7a');
    ctx.fillStyle = g; ctx.strokeStyle = '#cdddee'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(r * 1.05, 0, r * 0.34, r * 0.95, 0, 0, TAU); ctx.fill(); ctx.stroke();
    ctx.restore();
  },
  giant(ctx, e, m, now) {
    const r = e.r;
    // 울퉁 외곽
    ctx.fillStyle = m.c; ctx.beginPath();
    for (let i = 0; i <= 16; i++) { const a = i / 16 * TAU; const rr = r * (1 + 0.06 * (i % 2 ? 1 : -1)); const px = Math.cos(a) * rr, py = Math.sin(a) * rr; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath(); ctx.fill();
    // 균열
    ctx.strokeStyle = m.hi; ctx.lineWidth = 2; ctx.globalAlpha = 0.8;
    ctx.beginPath(); ctx.moveTo(-r * 0.5, -r * 0.3); ctx.lineTo(0, 0); ctx.lineTo(-r * 0.2, r * 0.5); ctx.moveTo(0, 0); ctx.lineTo(r * 0.5, r * 0.2); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#FFFF00'; dot(ctx, -r * 0.28, -r * 0.1, r * 0.13); dot(ctx, r * 0.28, -r * 0.1, r * 0.13);
    // 심지
    const flick = 0.8 + 0.4 * Math.sin(now * 0.03);
    ctx.strokeStyle = m.fuse; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(0, -r - 12 * flick); ctx.stroke();
    ctx.save(); ctx.shadowColor = '#FF8800'; ctx.shadowBlur = 10; ctx.fillStyle = '#FFCC00'; dot(ctx, 0, -r - 12 * flick, 3); ctx.restore();
  },
  boss(ctx, e, m, now) {
    const r = e.r;
    const theme = BOSS_THEME(e._wave || 5);
    let body = theme.body;
    if (body === 'hue') { const h = (now * 0.06) % 360; body = 'hsl(' + h + ',70%,45%)'; }
    // 몸통
    const g = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.2, 0, 0, r);
    g.addColorStop(0, '#ffffff44'); g.addColorStop(0.3, body); g.addColorStop(1, '#000000aa');
    ctx.fillStyle = g; ctx.strokeStyle = theme.edge; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fill(); ctx.stroke();
    // 왕관
    ctx.fillStyle = '#FFD700';
    for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + (i - 2) * 0.42; const cx = Math.cos(a) * r * 0.7, cy = Math.sin(a) * r * 0.7 - r * 0.55; tri(ctx, cx - 5, cy + 7, cx + 5, cy + 7, cx, cy - 7); }
    // 오각별
    ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i < 5; i++) { const a = -Math.PI / 2 + i * (TAU * 2 / 5); const px = Math.cos(a) * r * 0.5, py = Math.sin(a) * r * 0.5; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
    ctx.closePath(); ctx.stroke();
    // 눈
    ctx.save(); ctx.shadowColor = '#CC44FF'; ctx.shadowBlur = 14; ctx.fillStyle = '#E0B0FF';
    dot(ctx, -r * 0.32, 0, r * 0.16); dot(ctx, r * 0.32, 0, r * 0.16); ctx.restore();
  },
};

// 적 그리기 보조
function ball(ctx, x, y, r, hi, c) {
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.2, x, y, r);
  g.addColorStop(0, hi); g.addColorStop(1, c);
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
}
function dot(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
function tri(ctx, x1, y1, x2, y2, x3, y3) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.closePath(); ctx.fill(); }
function eyes(ctx, lx, ly, gap, r) {
  ctx.fillStyle = '#fff'; dot(ctx, lx, ly, r); dot(ctx, lx + gap, ly, r);
  ctx.fillStyle = '#111'; dot(ctx, lx, ly, r * 0.5); dot(ctx, lx + gap, ly, r * 0.5);
}
function wing(ctx, dir, r) {
  ctx.beginPath(); ctx.moveTo(dir * r * 0.5, 0);
  ctx.quadraticCurveTo(dir * r * 1.9, -r * 0.7, dir * r * 1.4, r * 0.5);
  ctx.quadraticCurveTo(dir * r * 1.1, r * 0.1, dir * r * 0.5, 0); ctx.fill();
}

// 보스 wave 주입(테마 색)
function tagBossWave(enemies, wave) { for (const e of enemies) if (e.boss) e._wave = wave; }

// ────────────────────────────── L3 챔피언 디스패치(훅 or 폴백) ──────────────────────────────
function drawOneChampion(ctx, p, now, opts) {
  if (window.ChampMotion && typeof window.ChampMotion.drawChampion === 'function') {
    try { window.ChampMotion.drawChampion(ctx, p, now, opts); return; } catch (err) { /* 폴백으로 */ }
  }
  drawChampionFallback(ctx, p, now, opts);
}
function drawChampionDispatch(ctx, p, now) {
  const opts = { isSelf: p.id === myPid, color: (CHAMP_META[p.champion] || CHAMP_META.warrior).color };
  // 대시: 순간이동이 아니라 고속 이동 — 진행방향 반대로 잔상 고스트 + 스피드라인으로 질주감 표현.
  if (p.dashing && !p.dead) {
    const dir = p.facing || 0;
    ctx.save();
    ctx.globalAlpha = 0.55; ctx.strokeStyle = opts.color; ctx.lineWidth = 2; ctx.lineCap = 'round';
    for (let i = 0; i < 5; i++) {
      const off = (i - 2) * 7, ox = -Math.sin(dir) * off, oy = Math.cos(dir) * off;
      ctx.beginPath();
      ctx.moveTo(p.x + ox - Math.cos(dir) * 12, p.y + oy - Math.sin(dir) * 12);
      ctx.lineTo(p.x + ox - Math.cos(dir) * 36, p.y + oy - Math.sin(dir) * 36);
      ctx.stroke();
    }
    ctx.restore();
    const gopts = { isSelf: opts.isSelf, color: opts.color, ghost: true };
    for (let i = 1; i <= 3; i++) {
      ctx.save(); ctx.globalAlpha = 0.24 - i * 0.055;
      const gp = Object.assign({}, p, { x: p.x - Math.cos(dir) * i * 13, y: p.y - Math.sin(dir) * i * 13, dashing: false, invuln: false });
      drawOneChampion(ctx, gp, now, gopts);
      ctx.restore();
    }
  }
  drawOneChampion(ctx, p, now, opts);
}

// 폴백 챔피언 렌더(4종 × Tier1~3 + 공격 모션)
function drawChampionFallback(ctx, p, now, opts) {
  const meta = CHAMP_META[p.champion] || CHAMP_META.warrior;
  const aim = p.facing || 0;
  let prog = -1, atype = null;
  if (p.attackAnim) {
    atype = p.attackAnim.type;
    prog = clamp((now - p.attackAnim.startedAt) / (p.attackAnim.duration * 1000), 0, 1);
  }
  ctx.save();
  ctx.translate(p.x, p.y);

  // 무적 깜빡임
  if (p.invuln) ctx.globalAlpha = 0.45 + 0.35 * Math.sin(now * 0.03);
  // 사망 반투명
  if (p.dead) ctx.globalAlpha = 0.25;

  // 발 그림자
  ctx.save(); ctx.globalAlpha *= 0.5; ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath(); ctx.ellipse(0, 20, 18, 7, 0, 0, TAU); ctx.fill(); ctx.restore();

  // Tier 오라(치장)
  drawTierAura(ctx, p, meta, now);

  // 본체(직업별)
  CHAMP_DRAW[p.champion] ? CHAMP_DRAW[p.champion](ctx, p, meta, now, aim, atype, prog) : CHAMP_DRAW.warrior(ctx, p, meta, now, aim, atype, prog);

  // 자기 자신 표시 링
  if (opts.isSelf && !p.dead) {
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 22, 16, 0.1 * Math.PI, 0.9 * Math.PI); ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  // 이름/HP/레벨 (월드 좌표) — 대시 잔상 고스트는 라벨 생략
  if (!opts.ghost) drawChampLabel(p, meta, opts);
}

function drawTierAura(ctx, p, meta, now) {
  if (p.tier >= 2) {
    ctx.save(); ctx.shadowColor = meta.color; ctx.shadowBlur = 9; ctx.strokeStyle = meta.color; ctx.lineWidth = 2; ctx.globalAlpha = 0.65;
    ctx.beginPath(); ctx.arc(0, 0, 25, 0, TAU); ctx.stroke(); ctx.restore();
  }
  if (p.tier >= 3) {
    ctx.save(); ctx.globalAlpha = 0.9;
    for (let i = 0; i < 8; i++) {
      const a = now * 0.003 + i / 8 * TAU; const rr = 28 + Math.sin(now * 0.006 + i) * 3;
      ctx.fillStyle = i % 2 ? meta.color : '#FFFFFF';
      dot(ctx, Math.cos(a) * rr, Math.sin(a) * rr, 2.4);
    }
    ctx.restore();
  }
}

function drawChampLabel(p, meta, opts) {
  // 체력바(발 아래)
  const w = 44, h = 5, x = p.x - w / 2, y = p.y + 30;
  const ratio = clamp(p.hp / p.maxHp, 0, 1);
  ctx.fillStyle = '#333'; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = ratio > 0.5 ? '#44DD44' : ratio > 0.25 ? '#FFCC00' : '#FF4444';
  ctx.fillRect(x, y, w * ratio, h);
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h);
  // Tier 별
  const starColor = p.tier >= 3 ? '#FFD700' : p.tier >= 2 ? '#4A90E2' : '#888888';
  ctx.fillStyle = starColor; ctx.font = '10px Arial'; ctx.textAlign = 'center';
  ctx.fillText('★'.repeat(p.tier) + '☆'.repeat(3 - p.tier), p.x, y + 16);
  // 이름
  ctx.fillStyle = opts.isSelf ? '#FFFFFF' : '#cfcfe6'; ctx.font = 'bold 11px Arial';
  ctx.fillText(p.name || meta.name, p.x, p.y - 32);
  ctx.textAlign = 'left';
}

// ── 직업별 본체 + 무기/모션 ──
const CHAMP_DRAW = {
  warrior(ctx, p, meta, now, aim, atype, prog) {
    const breathe = Math.sin(now * 0.004) * 0.6;
    // 몸통
    ball(ctx, 0, breathe, 22, meta.accent, meta.body);
    ctx.strokeStyle = meta.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, breathe, 22, 0, TAU); ctx.stroke();
    // 가슴 십자
    ctx.beginPath(); ctx.moveTo(-10, breathe); ctx.lineTo(10, breathe); ctx.moveTo(0, breathe - 10); ctx.lineTo(0, breathe + 10); ctx.stroke();
    // 투구
    ctx.fillStyle = '#1E3A6A'; ctx.beginPath(); ctx.arc(0, -6 + breathe, 16, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#111'; ctx.fillRect(-8, -8 + breathe, 16, 5);
    // 뿔
    ctx.fillStyle = '#1E3A6A'; tri(ctx, -16, -22, -10, -14, -18, -12); tri(ctx, 16, -22, 10, -14, 18, -12);
    // 검(스윙 모션 — aim 중심 -60~+60도)
    let bladeAng = aim;
    if (atype === 'swing') {
      let sw;
      if (prog < 0.35) sw = lerp(-1.05, -1.05, prog / 0.35);       // windup 유지(-60°)
      else if (prog < 0.7) sw = lerp(-1.05, 1.05, ease.outQuad((prog - 0.35) / 0.35)); // 스윙
      else sw = lerp(1.05, 0, (prog - 0.7) / 0.3);                  // 복귀
      bladeAng = aim + sw;
    }
    drawSword(ctx, bladeAng, p.tier, meta);
  },
  mage(ctx, p, meta, now, aim, atype, prog) {
    const breathe = Math.sin(now * 0.004) * 0.5;
    // 로브 자락
    ctx.fillStyle = meta.body; tri(ctx, -12, 10 + breathe, 12, 10 + breathe, 0, 28 + breathe);
    ball(ctx, 0, breathe, 18, meta.accent, meta.body);
    ctx.strokeStyle = meta.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, breathe, 18, 0, TAU); ctx.stroke();
    // 모자
    ctx.fillStyle = '#2A0850'; tri(ctx, 0, -30 + breathe, -14, -16 + breathe, 14, -16 + breathe);
    ctx.fillRect(-16, -18 + breathe, 32, 4);
    if (p.tier >= 3) { ctx.fillStyle = '#FFD700'; star(ctx, 0, -30 + breathe, 5); }
    // 지팡이 + 마법구(캐스팅 모션)
    let orbR = 7, recoil = 0;
    if (atype === 'cast') {
      if (prog < 0.5) orbR = lerp(7, 11, prog / 0.5);
      else { orbR = lerp(11, 7, (prog - 0.5) / 0.5); recoil = -lerp(0, 4, (prog - 0.5) / 0.5); }
    }
    ctx.save(); ctx.rotate(aim);
    ctx.strokeStyle = '#6B3A1F'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(40 + recoil, 0); ctx.stroke();
    const orbCol = p.tier >= 3 ? '#FFFFFF' : p.tier >= 2 ? '#CC44FF' : '#9B59B6';
    ctx.save(); ctx.shadowColor = '#AA22FF'; ctx.shadowBlur = p.tier >= 2 ? 12 : 6;
    ctx.fillStyle = orbCol; dot(ctx, 40 + recoil, 0, orbR); ctx.restore();
    if (p.tier >= 3) { // 광선
      ctx.strokeStyle = '#CC88FF'; ctx.lineWidth = 1.5;
      for (let i = 0; i < 6; i++) { const a = now * 0.005 + i / 6 * TAU; ctx.beginPath(); ctx.moveTo(40 + recoil, 0); ctx.lineTo(40 + recoil + Math.cos(a) * 12, Math.sin(a) * 12); ctx.stroke(); }
    }
    ctx.restore();
  },
  archer(ctx, p, meta, now, aim, atype, prog) {
    const breathe = Math.sin(now * 0.004) * 0.5;
    // 망토
    ctx.fillStyle = meta.body; ctx.beginPath(); ctx.arc(0, breathe, 22, 0, Math.PI); ctx.fill();
    ball(ctx, 0, breathe, 18, meta.accent, meta.body);
    // 후드
    ctx.fillStyle = '#1B5E20'; ctx.beginPath(); ctx.arc(0, -2 + breathe, 16, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#FFD700'; ctx.fillRect(-5, -4 + breathe, 3, 3); ctx.fillRect(2, -4 + breathe, 3, 3);
    // 활(발사 모션: 당기기→반동)
    let pull = 0;
    if (atype === 'shoot') { pull = prog < 0.5 ? lerp(0, 6, prog / 0.5) : lerp(6, 0, (prog - 0.5) / 0.5); }
    ctx.save(); ctx.rotate(aim);
    const bowCol = p.tier >= 3 ? '#00E5FF' : p.tier >= 2 ? '#4CAF50' : '#8D6E63';
    ctx.save(); if (p.tier >= 2) { ctx.shadowColor = bowCol; ctx.shadowBlur = p.tier >= 3 ? 12 : 8; }
    ctx.strokeStyle = bowCol; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(20 - pull, 0, 18, -1.2, 1.2); ctx.stroke(); ctx.restore();
    // 시위
    ctx.strokeStyle = '#ccc'; ctx.lineWidth = 1.5;
    const sx = 20 - pull + Math.cos(1.2) * 18, sy = Math.sin(1.2) * 18;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(8 - pull, 0); ctx.lineTo(sx, -sy); ctx.stroke();
    // 장전 화살(공격 직전만)
    if (atype !== 'shoot' || prog < 0.5) {
      ctx.strokeStyle = bowCol; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(8 - pull, 0); ctx.lineTo(30 - pull, 0); ctx.stroke();
      ctx.fillStyle = bowCol; tri(ctx, 30 - pull, -3, 30 - pull, 3, 36 - pull, 0);
    }
    ctx.restore();
  },
  assassin(ctx, p, meta, now, aim, atype, prog) {
    const breathe = Math.sin(now * 0.005) * 0.5;
    // 대시 잔상
    if (atype === 'dash' && prog < 0.5) {
      ctx.save();
      for (let i = 1; i <= 3; i++) {
        ctx.globalAlpha = 0.22 - i * 0.05;
        const off = -i * 9;
        ball(ctx, Math.cos(aim) * off, Math.sin(aim) * off + breathe, 16, meta.accent, meta.body);
      }
      ctx.restore();
    }
    // 몸통
    ball(ctx, 0, breathe, 16, meta.accent, meta.body);
    ctx.strokeStyle = meta.accent; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, breathe, 16, 0, TAU); ctx.stroke();
    // 마스크
    ctx.fillStyle = '#1A0A30'; ctx.beginPath(); ctx.arc(0, -2 + breathe, 16, Math.PI, 0); ctx.fill();
    ctx.fillStyle = '#FF3399'; ctx.fillRect(-6, -4 + breathe, 4, 3); ctx.fillRect(2, -4 + breathe, 4, 3);
    // 단검 ×2 (대시 스탭: 교차 스윙)
    let bladeSpread = 0.5;
    if (atype === 'dash' && prog >= 0.4) {
      const sp = (prog - 0.4) / 0.6;
      bladeSpread = 0.5 + Math.sin(sp * Math.PI * 3) * 0.7; // 3회 교차
    }
    drawDagger(ctx, aim - bladeSpread * 0.4, p.tier, meta, 22);
    drawDagger(ctx, aim + bladeSpread * 0.4 - 0.4, p.tier, meta, 18);
    if (p.tier >= 3) { // 그림자 클론
      ctx.save(); ctx.globalAlpha = 0.35;
      ball(ctx, -Math.cos(aim) * 6, -Math.sin(aim) * 6 + breathe, 14, meta.body, meta.body); ctx.restore();
    }
  },
};

function drawSword(ctx, ang, tier, meta) {
  ctx.save(); ctx.rotate(ang + Math.PI / 2);
  const col = tier >= 3 ? '#FFD700' : tier >= 2 ? '#5BA3F5' : '#9E9E9E';
  if (tier >= 2) { ctx.shadowColor = tier >= 3 ? '#FF8800' : '#2266CC'; ctx.shadowBlur = tier >= 3 ? 10 : 6; }
  // 손잡이
  ctx.shadowBlur = ctx.shadowBlur; ctx.fillStyle = '#6B3A1F'; ctx.fillRect(-5, -2, 10, 8);
  // 검날
  ctx.fillStyle = col; ctx.fillRect(-2.5, 4, 5, 34);
  tri(ctx, -2.5, 38, 2.5, 38, 0, 44);
  if (tier >= 3) { ctx.fillRect(-5, 16, 3, 3); ctx.fillRect(2, 16, 3, 3); }
  ctx.restore();
}
function drawDagger(ctx, ang, tier, meta, len) {
  ctx.save(); ctx.rotate(ang + Math.PI / 2);
  const col = tier >= 3 ? '#FF00CC' : tier >= 2 ? '#CC44FF' : '#708090';
  if (tier >= 2) { ctx.shadowColor = '#AA22FF'; ctx.shadowBlur = 8; }
  ctx.strokeStyle = col; ctx.lineWidth = 3; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(0, 4); ctx.lineTo(0, len); ctx.stroke();
  ctx.fillStyle = col; tri(ctx, -3, len, 3, len, 0, len + 5);
  ctx.restore();
}
function star(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5; const rr = i % 2 ? r * 0.45 : r; const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
  ctx.closePath(); ctx.fill();
}

// ────────────────────────────── L4 투사체 ──────────────────────────────
function drawProjectile(ctx, pr, now) {
  const enemy = pr.owner === 'enemy';
  ctx.save(); ctx.translate(pr.x, pr.y); ctx.rotate(pr.angle);
  if (pr.kind === 'magic') {
    ctx.shadowColor = '#BB66FF'; ctx.shadowBlur = 16;
    for (let i = 1; i <= 6; i++) { ctx.globalAlpha = 0.5 - i * 0.07; ctx.fillStyle = '#BB66FF'; dot(ctx, -i * 5, 0, pr.r * (1 - i * 0.1)); }
    ctx.globalAlpha = 1; ctx.fillStyle = '#FFFFFF'; dot(ctx, 0, 0, pr.r);
  } else if (pr.kind === 'arrow') {
    const col = pr.tier >= 3 ? '#00E5FF' : pr.tier >= 2 ? '#4CAF50' : '#8B6914';
    if (pr.tier >= 2) { ctx.shadowColor = col; ctx.shadowBlur = 8; }
    for (let i = 1; i <= 3; i++) { ctx.globalAlpha = 0.5 - i * 0.13; ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-i * 8 - 12, 0); ctx.lineTo(-i * 8, 0); ctx.stroke(); }
    ctx.globalAlpha = 1; ctx.strokeStyle = col; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(-12, 0); ctx.lineTo(8, 0); ctx.stroke();
    ctx.fillStyle = col; tri(ctx, 8, -4, 8, 4, 16, 0);
  } else if (pr.kind === 'bone') {
    ctx.rotate(now * 0.01); ctx.shadowColor = enemy ? '#FF6666' : '#fff'; ctx.shadowBlur = 6;
    ctx.fillStyle = '#E8E8D0'; ctx.fillRect(-pr.r, -2, pr.r * 2, 4); dot(ctx, -pr.r, 0, 3); dot(ctx, pr.r, 0, 3);
    if (enemy) { ctx.globalAlpha = 0.4; ctx.strokeStyle = '#FF4444'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, pr.r + 2, 0, TAU); ctx.stroke(); }
  } else { // darkbolt
    ctx.shadowColor = '#9B00FF'; ctx.shadowBlur = 15; ctx.fillStyle = '#220044'; dot(ctx, 0, 0, pr.r);
    ctx.fillStyle = '#9B00FF'; ctx.globalAlpha = 0.6; dot(ctx, 0, 0, pr.r * 0.5);
  }
  ctx.restore();
}

// ────────────────────────────── L6 데미지 숫자 ──────────────────────────────
function drawDamageNumbers(dt, frozen) {
  ctx.textAlign = 'center';
  for (let i = dmgNumbers.length - 1; i >= 0; i--) {
    const d = dmgNumbers[i];
    if (!frozen) { d.life += dt; d.y += d.vy * dt; d.vy *= 0.92; }
    const t = d.life / d.max;
    if (t >= 1) { dmgNumbers.splice(i, 1); continue; }
    ctx.globalAlpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
    let size = d.crit ? 20 : 14;
    if (d.crit && t < 0.2) size = lerp(26, 20, t / 0.2);
    ctx.font = 'bold ' + size + 'px Arial';
    ctx.fillStyle = d.color; ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.fillText(d.text, d.x, d.y);
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1; ctx.textAlign = 'left';
}

// ────────────────────────────── L7 HUD ──────────────────────────────
function drawHUD(s, players) {
  const me = players.find(p => p.id === myPid) || (snapCur.players.find(p => p.id === myPid));
  // 웨이브(우상단)
  ctx.textAlign = 'right'; ctx.fillStyle = '#fff'; ctx.font = 'bold 22px Arial';
  ctx.fillText('WAVE ' + s.wave, ARENA.w - 16, 30);
  ctx.fillStyle = PAL.text2; ctx.font = '14px Arial';
  ctx.fillText('처치 ' + (s.enemiesTotal - s.enemiesAlive >= 0 ? (s.killCount) : s.killCount) + ' · 남은 적 ' + s.enemiesAlive, ARENA.w - 16, 50);
  // 점수(상단 중앙)
  ctx.textAlign = 'center'; ctx.fillStyle = PAL.gold; ctx.font = 'bold 18px Arial';
  ctx.shadowColor = '#AA8800'; ctx.shadowBlur = 4; ctx.fillText('SCORE ' + s.score, ARENA.w / 2, 24); ctx.shadowBlur = 0;
  // 킬 카운터(우하단)
  ctx.textAlign = 'right'; ctx.fillStyle = PAL.text2; ctx.font = 'bold 16px Arial';
  ctx.fillText('⚔ ' + s.killCount, ARENA.w - 16, ARENA.h - 14);

  if (me) {
    // HP바(좌하단)
    const bx = 20, by = ARENA.h - 38, bw = 220, bh = 20;
    ctx.textAlign = 'left';
    ctx.fillStyle = PAL.gold; ctx.font = 'bold 12px Arial'; ctx.fillText('Lv ' + me.level, bx, by - 6);
    ctx.fillStyle = '#333'; rrect(ctx, bx, by, bw, bh, 4); ctx.fill();
    const ratio = clamp(me.hp / me.maxHp, 0, 1);
    ctx.fillStyle = ratio > 0.5 ? '#44DD44' : ratio > 0.25 ? '#FFCC00' : '#FF4444';
    rrect(ctx, bx, by, bw * ratio, bh, 4); ctx.fill();
    ctx.strokeStyle = '#555'; ctx.lineWidth = 1; rrect(ctx, bx, by, bw, bh, 4); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.font = '12px Arial'; ctx.textAlign = 'left';
    ctx.fillText(Math.ceil(me.hp) + ' / ' + me.maxHp, bx + bw + 8, by + 15);
    // XP바
    const xr = clamp(me.xp / me.xpMax, 0, 1);
    ctx.fillStyle = '#222'; ctx.fillRect(bx, by + bh + 3, bw, 4);
    ctx.fillStyle = PAL.allyLt; ctx.fillRect(bx, by + bh + 3, bw * xr, 4);
    // ── 오브 슬롯 HUD (좌하단 HP바 위) ──
    {
      const now2 = performance.now();
      const orbCnt = (me.orbCount != null ? me.orbCount : _orbDisplayCount);
      const thresh = me.orbThreshold || ORB_THRESHOLD;
      const isFull = orbCnt >= thresh;
      const SOX = 20, SOY = ARENA.h - 64;
      const SW = 16, SH = 6, SGAP = 4;

      let thPulse = 0;
      if (orbThresholdAnim) {
        const tp = Math.min(1, (now2 - orbThresholdAnim.start) / 900);
        thPulse = tp < 0.3 ? tp / 0.3 : 1 - (tp - 0.3) / 0.7;
        if (tp >= 1) orbThresholdAnim = null;
      }

      for (let si = 0; si < thresh; si++) {
        const sx = SOX + si * (SW + SGAP);
        const sy = SOY;
        const lit = isFull || si < orbCnt;

        let pulse = 0;
        const sa = orbSlotAnims[si];
        if (sa) {
          const sp = Math.min(1, (now2 - sa.start) / sa.duration);
          pulse = sp < 0.4 ? sp / 0.4 : 1 - (sp - 0.4) / 0.6;
          if (sp >= 1) orbSlotAnims[si] = null;
        }

        ctx.fillStyle = '#1A0A2A'; rrect(ctx, sx, sy, SW, SH, 2); ctx.fill();

        if (lit) {
          const glow = 4 + pulse * 8 + thPulse * 10;
          ctx.save();
          ctx.shadowColor = isFull ? '#FF88FF' : '#BB77FF';
          ctx.shadowBlur = glow;
          ctx.fillStyle = isFull
            ? 'rgb(' + Math.round(lerp(187, 255, thPulse)) + ',' + Math.round(lerp(68, 136, thPulse)) + ',255)'
            : '#9B59B6';
          rrect(ctx, sx, sy, SW, SH, 2); ctx.fill();
          ctx.restore();
        } else {
          ctx.fillStyle = '#3A1050'; rrect(ctx, sx, sy, SW, SH, 2); ctx.fill();
        }
        ctx.strokeStyle = lit ? '#CC77FF' : '#441155'; ctx.lineWidth = 1;
        rrect(ctx, sx, sy, SW, SH, 2); ctx.stroke();
      }

      ctx.textAlign = 'left'; ctx.fillStyle = isFull ? '#FF88FF' : '#9977BB';
      ctx.font = 'bold 10px Arial';
      ctx.fillText('ORB', SOX + thresh * (SW + SGAP) + 6, SOY + SH - 1);

      if (orbThresholdAnim) {
        const tp2 = Math.min(1, (now2 - orbThresholdAnim.start) / 900);
        if (tp2 < 0.8) {
          const textAlpha = tp2 < 0.11 ? tp2 / 0.11 : tp2 > 0.78 ? 1 - (tp2 - 0.78) / 0.22 : 1;
          ctx.save();
          ctx.globalAlpha = textAlpha;
          ctx.font = 'bold 20px Arial';
          ctx.fillStyle = '#FFD700'; ctx.shadowColor = '#FFD700'; ctx.shadowBlur = 10;
          ctx.textAlign = 'center';
          ctx.fillText('UPGRADE!', SOX + thresh * (SW + SGAP) / 2, SOY - 28);
          ctx.restore();
        }
        if (tp2 < 0.33) {
          const rp = tp2 / 0.33;
          const ease = Math.sqrt(1 - Math.pow(rp - 1, 2));
          const ringR = lerp(16, 80, ease);
          const ringLW = lerp(4, 1, ease);
          const cx2 = SOX + thresh * (SW + SGAP) / 2;
          const cy2 = SOY + SH / 2;
          ctx.save();
          ctx.globalAlpha = 1 - rp * 0.7;
          ctx.strokeStyle = '#FFD700'; ctx.lineWidth = ringLW;
          ctx.shadowColor = '#FFD700'; ctx.shadowBlur = 8;
          ctx.beginPath(); ctx.arc(cx2, cy2, ringR, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }
      }
    }
    // 증강 아이콘 줄
    if (me.augments && me.augments.length) {
      ctx.font = '15px Arial'; ctx.textAlign = 'left';
      let ax = bx;
      const ay = by - 24;
      for (const id of me.augments.slice(-14)) {
        ctx.fillStyle = 'rgba(255,255,255,0.08)'; rrect(ctx, ax, ay - 15, 19, 19, 4); ctx.fill();
        ctx.fillText(AUG_GLYPH[id] || '◆', ax + 1, ay); ax += 22;
      }
    }
  }
  ctx.textAlign = 'left';
}
function rrect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

function drawBossBar(s) {
  if (!s.boss) return;
  const b = s.boss;
  tagBossWaveCur(s);
  const x = 16, y = 12, w = ARENA.w - 32, h = 18;
  const theme = BOSS_THEME(b.wave || s.wave);
  ctx.fillStyle = '#333'; rrect(ctx, x, y, w, h, 8); ctx.fill();
  const ratio = clamp(b.hp / b.maxHp, 0, 1);
  let col = theme.body === 'hue' ? 'hsl(' + ((performance.now() * 0.06) % 360) + ',70%,45%)' : theme.body;
  ctx.fillStyle = col; rrect(ctx, x, y, w * ratio, h, 8); ctx.fill();
  ctx.strokeStyle = theme.edge; ctx.lineWidth = 2; rrect(ctx, x, y, w, h, 8); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 12px Arial'; ctx.textAlign = 'center';
  ctx.fillText('⚜ ' + (b.name || '보스') + ' ⚜   ' + Math.ceil(b.hp) + ' / ' + b.maxHp, ARENA.w / 2, y + 14);
  ctx.textAlign = 'left';
}
function tagBossWaveCur(s) { if (snapCur && snapCur.enemies) tagBossWave(snapCur.enemies, s.wave); }

// ────────────────────────────── 스킬 장판/소환수 ──────────────────────────────
const FIELD_COLOR = { poison: '#88FF44', fire: '#FF8844', burn: '#FF8844', frost: '#88CCFF', default: '#5BE7D6' };
function drawFields(fields, now) {
  if (!fields || !fields.length) return;
  for (const f of fields) {
    const col = FIELD_COLOR[f.kind] || FIELD_COLOR.default;
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.006 + f.id);
    ctx.save();
    ctx.globalAlpha = 0.16 + 0.06 * pulse;
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, TAU); ctx.fill();
    ctx.globalAlpha = 0.55; ctx.strokeStyle = col; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, TAU); ctx.stroke();
    // 내부 떠다니는 점들
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * TAU + now * 0.001 * (i % 2 ? 1 : -1);
      const rr = f.r * (0.3 + 0.6 * ((i * 7 + (f.id % 13)) % 10) / 10);
      ctx.fillStyle = col; dot(ctx, f.x + Math.cos(a) * rr, f.y + Math.sin(a) * rr + Math.sin(now * 0.004 + i) * 4, 2.4);
    }
    ctx.restore();
  }
}
function drawSummon(ctx, sm, now) {
  ctx.save(); ctx.translate(sm.x, sm.y);
  // 그림자
  ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(0, 12, 11, 4, 0, 0, TAU); ctx.fill();
  // 아군 소환수: 반투명 청색 분신
  const pulse = 0.6 + 0.4 * Math.sin(now * 0.008 + sm.id);
  ctx.globalAlpha = 0.55 + 0.2 * pulse;
  ball(ctx, 0, 0, 12, '#9fd0ff', '#3a6ea5');
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#88CCFF'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 0, 13, 0, TAU); ctx.stroke();
  ctx.restore();
  // hp바
  if (sm.hp < sm.maxHp) {
    const w = 22, x = sm.x - w / 2, y = sm.y - 18;
    ctx.fillStyle = '#222'; ctx.fillRect(x, y, w, 3);
    ctx.fillStyle = '#88CCFF'; ctx.fillRect(x, y, w * clamp(sm.hp / sm.maxHp, 0, 1), 3);
  }
}

// ────────────────────────────── L3.5 다운된 아군 부활 카운트다운 ──────────────────────────────
// reviveAt만 서버가 주므로(총시간 가변), dead 전이 시점을 클라가 잡아 총시간을 추정해 링 비율을 그린다.
const reviveInfo = {};
function drawReviveTimers(players, now) {
  for (const p of players) {
    if (p.dead && p.reviveAt > 0) {
      let info = reviveInfo[p.id];
      if (!info || info.reviveAt !== p.reviveAt) info = reviveInfo[p.id] = { start: now, reviveAt: p.reviveAt };
      const total = Math.max(1, info.reviveAt - info.start);
      const remain = Math.max(0, info.reviveAt - now);
      const elapsed = clamp(1 - remain / total, 0, 1);
      const secs = Math.ceil(remain / 1000);
      ctx.save(); ctx.translate(p.x, p.y - 42);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, 15, 0, TAU); ctx.stroke();
      ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 4; ctx.shadowColor = '#AA8800'; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(0, 0, 15, -Math.PI / 2, -Math.PI / 2 + elapsed * TAU); ctx.stroke(); ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff'; ctx.font = 'bold 14px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(secs, 0, 1);
      ctx.fillStyle = '#FFD700'; ctx.font = 'bold 10px Arial'; ctx.fillText('부활 대기', 0, -26);
      ctx.restore(); ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    } else if (reviveInfo[p.id]) { delete reviveInfo[p.id]; }
  }
}

// ────────────────────────────── L7 파티 HP(멀티 전용) ──────────────────────────────
function drawPartyHud(s) {
  if (!s.room || (s.room.playerCount || 1) <= 1) return; // 솔로는 기본 HP바로 충분
  ctx.textAlign = 'left';
  let y = 96;
  for (const p of s.players) {
    const isMe = p.id === myPid;
    ctx.font = 'bold 11px Arial'; ctx.fillStyle = isMe ? PAL.allyLt : '#dfe2ee';
    ctx.fillText((isMe ? '▶ ' : '') + (p.name || ''), 16, y);
    const bw = 120, bh = 7, bx = 16, by = y + 4;
    ctx.fillStyle = '#2a2a40'; ctx.fillRect(bx, by, bw, bh);
    if (p.dead) {
      ctx.fillStyle = '#5a2a2a'; ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = '#FF8888'; ctx.font = 'bold 9px Arial'; ctx.fillText(p.reviveAt > 0 ? 'DOWN' : 'OUT', bx + bw + 6, by + 7);
    } else {
      const r = clamp(p.hp / p.maxHp, 0, 1);
      ctx.fillStyle = r > 0.5 ? '#44DD44' : r > 0.25 ? '#FFCC00' : '#FF4444';
      ctx.fillRect(bx, by, bw * r, bh);
    }
    y += 26;
  }
}

// ────────────────────────────── L7 스킬바(Q/E/R) ──────────────────────────────
const lastSkillIds = [null, null, null];
const skillNewUntil = [0, 0, 0];
function drawSkillBar(s, now) {
  const me = s.players.find(p => p.id === myPid);
  if (!me) return;
  const skills = me.skills || [null, null, null];
  const SLOT = 58, GAP = 12, n = 3;
  const totalW = SLOT * n + GAP * (n - 1);
  const x0 = (ARENA.w - totalW) / 2;
  const y = ARENA.h - SLOT - 18;
  const pnow = performance.now();
  for (let i = 0; i < n; i++) {
    const sk = skills[i];
    const x = x0 + i * (SLOT + GAP);
    // 신규 획득 감지
    const id = sk ? sk.id : null;
    if (id !== lastSkillIds[i]) { if (id) skillNewUntil[i] = pnow + 2400; lastSkillIds[i] = id; }
    const meta = sk ? skillMeta(sk.id) : null;
    const typeCol = meta ? (SKILL_TYPE_COLOR[meta.skillType] || '#5BE7D6') : '#3a3a52';
    const ready = sk && sk.ready;
    const fb = skillFeedback[i];

    ctx.save();
    // 막힘 흔들림
    let shx = 0;
    if (fb < 0 && pnow < -fb) { shx = Math.sin(pnow * 0.08) * 3; }
    ctx.translate(x + SLOT / 2 + shx, y + SLOT / 2);

    // 배경
    ctx.fillStyle = sk ? 'rgba(16,16,30,0.86)' : 'rgba(16,16,30,0.5)';
    rrect(ctx, -SLOT / 2, -SLOT / 2, SLOT, SLOT, 10); ctx.fill();
    // ready 글로우 테두리
    if (ready) { ctx.shadowColor = typeCol; ctx.shadowBlur = 10 + 5 * Math.sin(now * 0.006); }
    ctx.strokeStyle = sk ? typeCol : '#33334e'; ctx.lineWidth = ready ? 2.5 : 1.5;
    rrect(ctx, -SLOT / 2, -SLOT / 2, SLOT, SLOT, 10); ctx.stroke();
    ctx.shadowBlur = 0;

    if (sk) {
      // 아이콘
      ctx.fillStyle = ready ? typeCol : '#6a6a82';
      ctx.font = '28px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(SKILL_TYPE_GLYPH[meta.skillType] || '✦', 0, 1);
      // 쿨다운 방사 오버레이
      const frac = ready ? 0 : clamp(sk.cdLeft / (sk.cdMax || 1), 0, 1);
      if (frac > 0) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath(); ctx.moveTo(0, 0);
        ctx.arc(0, 0, SLOT / 2, -Math.PI / 2, -Math.PI / 2 + frac * TAU); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.font = 'bold 16px Arial';
        ctx.fillText(Math.ceil(sk.cdLeft), 0, 1);
      }
      // 사용 펄스
      if (fb > 0 && pnow < fb) {
        ctx.globalAlpha = (fb - pnow) / 260 * 0.5;
        ctx.fillStyle = typeCol; rrect(ctx, -SLOT / 2, -SLOT / 2, SLOT, SLOT, 10); ctx.fill();
        ctx.globalAlpha = 1;
      }
      // NEW 뱃지
      if (pnow < skillNewUntil[i]) {
        ctx.fillStyle = '#FFD700'; ctx.font = 'bold 9px Arial';
        ctx.fillText('NEW', 0, -SLOT / 2 - 6);
      }
    } else {
      ctx.fillStyle = '#44445e'; ctx.font = '22px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('＋', 0, 1);
    }
    // 키캡
    ctx.fillStyle = sk ? '#fff' : '#666'; ctx.font = 'bold 12px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(SLOT_KEYS[i], 0, SLOT / 2 - 5);
    ctx.restore();
  }
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
}

// ────────────────────────────── L7 버프/변이 표시 ──────────────────────────────
function drawBuffsAndMutator(s, now) {
  // 활성 변이(좌상단)
  if (s.activeMutator) {
    ctx.textAlign = 'left'; ctx.font = 'bold 13px Arial';
    ctx.fillStyle = '#C9A6FF'; ctx.shadowColor = '#7B52C4'; ctx.shadowBlur = 6;
    ctx.fillText('✦ ' + s.activeMutator.name, 16, 72); ctx.shadowBlur = 0;
  }
  // 내 버프 게이지(스킬바 위)
  const me = s.players.find(p => p.id === myPid);
  if (!me || !me.buffs || !me.buffs.length) return;
  const sNow = serverNow();
  let bx = ARENA.w / 2 - (me.buffs.length * 26) / 2;
  const by = ARENA.h - 58 - 26;
  for (const b of me.buffs) {
    const remain = b.until - sNow;
    if (remain <= 0) continue;
    ctx.fillStyle = 'rgba(255,215,0,0.16)'; rrect(ctx, bx, by, 22, 22, 5); ctx.fill();
    ctx.strokeStyle = '#FFD700'; ctx.lineWidth = 1; rrect(ctx, bx, by, 22, 22, 5); ctx.stroke();
    ctx.fillStyle = '#FFD700'; ctx.font = '13px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🔆', bx + 11, by + 11);
    bx += 26;
  }
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
}

// ────────────────────────────── L8 웨이브/보스 연출 ──────────────────────────────
function drawWaveBanner(now) {
  if (now > waveBanner.until) return;
  const el = waveBanner.until - now, total = waveBanner.until - waveBanner.start;
  const tin = clamp((now - waveBanner.start) / 300, 0, 1);
  let alpha = 1;
  if (el < 400) alpha = el / 400;
  ctx.save(); ctx.globalAlpha = alpha;
  const cy = lerp(-60, ARENA.h / 2, ease.outBack(tin));
  if (waveBanner.boss) {
    ctx.fillStyle = '#FF4444'; ctx.font = 'bold 58px Arial'; ctx.textAlign = 'center';
    ctx.shadowColor = '#FF0000'; ctx.shadowBlur = 20;
    ctx.fillText(waveBanner.text, ARENA.w / 2, cy);
    ctx.shadowBlur = 0; ctx.fillStyle = PAL.gold; ctx.font = '26px Arial';
    ctx.fillText(waveBanner.sub, ARENA.w / 2, cy + 50);
  } else {
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; rrect(ctx, ARENA.w / 2 - 320, cy - 80, 640, 160, 12); ctx.fill();
    ctx.fillStyle = waveBanner.text.startsWith('WAVE CLEAR') ? '#44FF88' : '#fff';
    ctx.font = 'bold 52px Arial'; ctx.textAlign = 'center';
    ctx.fillText(waveBanner.text, ARENA.w / 2, cy + 4);
    ctx.fillStyle = PAL.text2; ctx.font = '22px Arial'; ctx.fillText(waveBanner.sub, ARENA.w / 2, cy + 44);
  }
  ctx.restore(); ctx.textAlign = 'left';
}
function drawBossDefeated(now) {
  if (now > bossDefeated.until) return;
  const el = bossDefeated.until - now;
  ctx.save(); ctx.globalAlpha = clamp(el / 600, 0, 1);
  ctx.fillStyle = PAL.gold; ctx.font = 'bold 48px Arial'; ctx.textAlign = 'center';
  ctx.shadowColor = '#AA8800'; ctx.shadowBlur = 16;
  ctx.fillText('BOSS DEFEATED!', ARENA.w / 2, ARENA.h / 2 - 60);
  ctx.restore(); ctx.textAlign = 'left';
}

// ────────────────────────────── 폴백 이펙트 시스템 ──────────────────────────────
function makeFallbackEffects() {
  const parts = [];      // 파티클
  const rings = [];      // 폭발/아우라 링
  const slashes = [];    // 슬래시 아크
  const bolts = [];      // 연쇄 번개(chain_link)
  const auras = [];      // 증강 아우라 파티클은 parts로

  function addPart(x, y, ang, spd, life, r, color, grav, fade) {
    parts.push({ x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd, life: 0, max: life, r, color, grav: grav || 0, fade: fade !== false });
  }

  return {
    spawn(type, d) {
      switch (type) {
        case 'attack': {
          if (d.kind === 'swing' || d.kind === 'dash') {
            slashes.push({ x: d.x, y: d.y, ang: d.aimAngle, life: 0, max: 0.18, kind: d.kind, tier: d.tier || 1, arc: d.kind === 'swing' ? 1.05 : 0.7, r: d.kind === 'swing' ? 58 : 44 });
          }
          break;
        }
        case 'hit': {
          // 방향 파티클(아군 공격=흰/금)
          const dir = d.dir || 0;
          for (let i = 0; i < 6; i++) addPart(d.x, d.y, dir + rnd(-0.5, 0.5), rnd(80, 180), rnd(0.2, 0.35), rnd(2, 4), d.crit ? '#FFD700' : '#FFFFFF', 0);
          break;
        }
        case 'death': {
          const mt = ENEMY_META[d.enemyType] || ENEMY_META.slime;
          const n = d.boss ? 40 : 12;
          for (let i = 0; i < n; i++) addPart(d.x, d.y, rnd(0, TAU), rnd(60, d.boss ? 300 : 150), rnd(0.4, d.boss ? 1.2 : 0.7), rnd(3, d.boss ? 10 : 6), Math.random() < 0.5 ? mt.c : mt.hi, 40);
          rings.push({ x: d.x, y: d.y, life: 0, max: d.boss ? 0.6 : 0.4, r0: 8, r1: d.boss ? 150 : 50, color: mt.hi, lw: 3 });
          if (d.boss) {
            rings.push({ x: ARENA.w / 2, y: ARENA.h / 2, life: 0, max: 0.2, r0: 0, r1: 900, color: '#FFFFFF', lw: 8, flash: true });
            bossDefeated.until = performance.now() + 2000;
          }
          break;
        }
        case 'explosion': {
          const big = !d.small;
          rings.push({ x: d.x, y: d.y, life: 0, max: big ? 0.4 : 0.25, r0: 8, r1: d.r || (big ? 100 : 60), color: big ? '#FF6600' : '#FFAA44', lw: big ? 4 : 2 });
          const n = big ? 24 : 10;
          for (let i = 0; i < n; i++) addPart(d.x, d.y, rnd(0, TAU), rnd(120, big ? 240 : 160), rnd(0.3, 0.6), rnd(4, big ? 10 : 6), Math.random() < 0.5 ? '#FF6600' : '#FFCC00', 30);
          break;
        }
        case 'status': {
          const col = d.kind === 'burn' ? '#FF8800' : d.kind === 'poison' ? '#88FF44' : '#88CCFF';
          for (let i = 0; i < 5; i++) addPart(d.x, d.y, rnd(0, TAU), rnd(20, 50), rnd(0.3, 0.6), rnd(2, 4), col, d.kind === 'poison' ? -20 : 0);
          break;
        }
        case 'heal': {
          for (let i = 0; i < 6; i++) addPart(d.x + rnd(-8, 8), d.y, -Math.PI / 2 + rnd(-0.3, 0.3), rnd(20, 50), rnd(0.4, 0.7), rnd(2, 4), '#44FF88', -10);
          break;
        }
        case 'levelup': {
          rings.push({ x: d.x, y: d.y, life: 0, max: 0.5, r0: 10, r1: 60, color: '#FFD700', lw: 3 });
          for (let i = 0; i < 12; i++) addPart(d.x, d.y, -Math.PI / 2 + rnd(-0.8, 0.8), rnd(60, 140), rnd(0.4, 0.8), rnd(2, 4), '#FFD700', -20);
          break;
        }
        case 'augment_aura': {
          const cc = (CHAMP_META[d.champion] || CHAMP_META.warrior).color;
          rings.push({ x: d.x, y: d.y, life: 0, max: 0.2, r0: 30, r1: 120, color: cc, lw: 4, ease: 'outCirc' });
          for (let i = 0; i < 16; i++) addPart(d.x, d.y, i / 16 * TAU, 120, 0.6, 4, cc, 0);
          for (let i = 0; i < 6; i++) addPart(d.x, d.y, rnd(0, TAU), rnd(60, 120), 0.8, 3, '#FFD700', -30);
          break;
        }
        case 'skill_cast': {
          // 스킬 type별 폴백 이펙트(effects.js 미로드 시). 색은 SKILL_TYPE_COLOR.
          const st = d.skillType || d.type;
          const col = SKILL_TYPE_COLOR[st] || '#5BE7D6';
          const aim = d.aimAngle || 0;
          if (st === 'nova' || st === 'aoe_field') {
            rings.push({ x: d.x, y: d.y, life: 0, max: 0.45, r0: 12, r1: st === 'nova' ? 130 : 95, color: col, lw: 5, ease: 'outCirc' });
            for (let i = 0; i < 20; i++) addPart(d.x, d.y, i / 20 * TAU, rnd(90, 200), rnd(0.4, 0.7), rnd(3, 6), col, 0);
          } else if (st === 'dash_strike') {
            slashes.push({ x: d.x + Math.cos(aim) * 40, y: d.y + Math.sin(aim) * 40, ang: aim, life: 0, max: 0.2, kind: 'swing', tier: 3, arc: 1.2, r: 60 });
            for (let i = 0; i < 10; i++) addPart(d.x, d.y, aim + Math.PI + rnd(-0.5, 0.5), rnd(80, 180), rnd(0.2, 0.4), rnd(2, 5), col, 0);
          } else if (st === 'projectile_barrage') {
            for (let i = 0; i < 12; i++) addPart(d.x, d.y, aim + rnd(-0.6, 0.6), rnd(160, 320), rnd(0.25, 0.5), rnd(2, 4), col, 0);
          } else if (st === 'buff') {
            rings.push({ x: d.x, y: d.y, life: 0, max: 0.5, r0: 16, r1: 56, color: col, lw: 4, ease: 'outCirc' });
            for (let i = 0; i < 14; i++) addPart(d.x, d.y, -Math.PI / 2 + rnd(-0.9, 0.9), rnd(50, 120), rnd(0.5, 0.9), rnd(2, 4), col, -28);
          } else if (st === 'summon') {
            rings.push({ x: d.x, y: d.y, life: 0, max: 0.5, r0: 10, r1: 70, color: col, lw: 3 });
            for (let i = 0; i < 10; i++) addPart(d.x, d.y, rnd(0, TAU), rnd(40, 100), rnd(0.4, 0.8), rnd(2, 4), col, -10);
          } else { // chain 등
            for (let i = 0; i < 10; i++) addPart(d.x, d.y, rnd(0, TAU), rnd(80, 200), rnd(0.3, 0.6), rnd(2, 5), col, 0);
            rings.push({ x: d.x, y: d.y, life: 0, max: 0.3, r0: 8, r1: 80, color: col, lw: 2 });
          }
          break;
        }
        case 'chain_link': {
          // 두 점 사이 지그재그 번개(짧은 수명).
          bolts.push({ x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, life: 0, max: 0.18, color: '#33E0E0' });
          break;
        }
        case 'respawn': {
          rings.push({ x: d.x, y: d.y, life: 0, max: 0.6, r0: 10, r1: 72, color: '#FFD700', lw: 4, ease: 'outCirc' });
          for (let i = 0; i < 16; i++) addPart(d.x, d.y, -Math.PI / 2 + rnd(-1, 1), rnd(80, 170), rnd(0.5, 0.95), rnd(2, 4), '#FFE680', -34);
          break;
        }
      }
    },
    update(dt) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i]; p.life += dt;
        if (p.life >= p.max) { parts.splice(i, 1); continue; }
        p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.grav * dt * 4;
        p.vx *= 0.96; p.vy *= 0.96;
      }
      for (let i = rings.length - 1; i >= 0; i--) { rings[i].life += dt; if (rings[i].life >= rings[i].max) rings.splice(i, 1); }
      for (let i = slashes.length - 1; i >= 0; i--) { slashes[i].life += dt; if (slashes[i].life >= slashes[i].max) slashes.splice(i, 1); }
      for (let i = bolts.length - 1; i >= 0; i--) { bolts[i].life += dt; if (bolts[i].life >= bolts[i].max) bolts.splice(i, 1); }
    },
    render(ctx, now) {
      // 슬래시 아크
      for (const s of slashes) {
        const t = s.life / s.max;
        ctx.save(); ctx.translate(s.x, s.y);
        ctx.globalAlpha = (1 - t) * 0.9;
        const sweep = lerp(-s.arc, s.arc, ease.outQuad(t));
        const col = s.tier >= 3 ? '#FFD700' : s.tier >= 2 ? '#88CCFF' : '#FFFFFF';
        ctx.strokeStyle = col; ctx.shadowColor = '#4A90E2'; ctx.shadowBlur = 12;
        ctx.lineWidth = lerp(8, 2, t); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.arc(0, 0, s.r, s.ang + sweep - 0.5, s.ang + sweep + 0.3); ctx.stroke();
        // 잔상
        ctx.globalAlpha = (1 - t) * 0.3; ctx.lineWidth = lerp(5, 1, t);
        ctx.beginPath(); ctx.arc(0, 0, s.r - 4, s.ang - s.arc * 0.6, s.ang + sweep); ctx.stroke();
        ctx.restore();
      }
      // 링
      for (const r of rings) {
        const t = r.life / r.max;
        const e = r.ease === 'outCirc' ? ease.outCirc(t) : t;
        const rad = lerp(r.r0, r.r1, e);
        ctx.save(); ctx.globalAlpha = (1 - t) * (r.flash ? 0.5 : 0.85);
        if (r.flash) { ctx.fillStyle = r.color; ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, TAU); ctx.fill(); }
        else { ctx.strokeStyle = r.color; ctx.lineWidth = lerp(r.lw, 1, t); ctx.shadowColor = r.color; ctx.shadowBlur = 10; ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, TAU); ctx.stroke(); }
        ctx.restore();
      }
      // 파티클
      for (const p of parts) {
        const t = p.life / p.max;
        ctx.globalAlpha = p.fade ? (1 - t) : 1;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (1 - t * 0.4), 0, TAU); ctx.fill();
      }
      // 연쇄 번개(지그재그)
      for (const b of bolts) {
        const t = b.life / b.max;
        ctx.save(); ctx.globalAlpha = (1 - t) * 0.95;
        ctx.strokeStyle = b.color; ctx.shadowColor = b.color; ctx.shadowBlur = 12; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
        const segs = 6, dx = (b.x2 - b.x1) / segs, dy = (b.y2 - b.y1) / segs;
        const nx = -(b.y2 - b.y1), ny = (b.x2 - b.x1); const nl = Math.hypot(nx, ny) || 1;
        ctx.beginPath(); ctx.moveTo(b.x1, b.y1);
        for (let i = 1; i < segs; i++) {
          const j = (Math.sin(i * 12.9898 + b.x1) * 43758.5) % 1; // 결정적 지그재그
          const off = (j - 0.5) * 18;
          ctx.lineTo(b.x1 + dx * i + nx / nl * off, b.y1 + dy * i + ny / nl * off);
        }
        ctx.lineTo(b.x2, b.y2); ctx.stroke(); ctx.restore();
      }
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    },
    _debug() { return { parts: parts.length, rings: rings.length, slashes: slashes.length }; },
  };
}

// ────────────────────────────── 오버레이 헬퍼 ──────────────────────────────
function showOverlay(id) { document.getElementById(id).classList.remove('hidden'); }
function hideOverlay(id) { document.getElementById(id).classList.add('hidden'); }

// ── 챔피언 선택 카드 ──
// ── 로비: 방 목록 렌더 ──
function renderRoomList(rooms) {
  const wrap = document.getElementById('room-list');
  if (!wrap) return;
  if (!rooms.length) { wrap.innerHTML = '<div class="room-list-empty">열린 방이 없습니다 · [방 만들기]로 시작하세요</div>'; return; }
  wrap.innerHTML = '';
  for (const r of rooms) {
    const full = r.count >= (r.maxPlayers || 4);
    const row = document.createElement('div');
    row.className = 'room-row ' + (full ? 'blocked' : 'joinable');
    row.innerHTML =
      '<span class="rr-code">' + r.code + '</span>' +
      '<span class="rr-meta">' + r.count + '/' + (r.maxPlayers || 4) + (full ? ' · 만원' : ' · 대기중') + '</span>';
    if (!full) row.addEventListener('click', () => joinRoom(r.code));
    wrap.appendChild(row);
  }
}

// ── 대기실: 챔피언 카드(1회 생성, 상태는 renderRoom에서 갱신) ──
let roomChampPreviews = [];
function buildRoomChamps() {
  const wrap = document.getElementById('room-champs');
  if (!wrap) return;
  wrap.innerHTML = '';
  roomChampPreviews = [];
  for (const key of CHAMP_ORDER) {
    const m = CHAMP_META[key];
    const card = document.createElement('div');
    card.className = 'champ-card'; card.style.setProperty('--cc', m.color);
    card.dataset.champ = key;
    const pc = document.createElement('canvas'); pc.width = 120; pc.height = 120;
    card.innerHTML =
      '<div class="cc-name" style="color:' + m.color + '">' + m.name + '</div>' +
      '<div class="cc-role">' + m.role + '</div>';
    card.insertBefore(pc, card.firstChild);
    const desc = document.createElement('div'); desc.className = 'cc-desc'; desc.textContent = m.desc;
    card.appendChild(desc);
    const statsBox = document.createElement('div'); statsBox.className = 'cc-stats';
    const st = m.stats;
    statsBox.innerHTML = statRow('체력', st.hp) + statRow('속도', st.spd) + statRow('공격', st.dmg) + statRow('사거리', st.rng);
    card.appendChild(statsBox);
    const owner = document.createElement('div'); owner.className = 'cc-owner'; card.appendChild(owner);
    card.addEventListener('click', () => {
      if (card.classList.contains('locked')) { showToast('이미 선택된 챔피언입니다'); return; }
      selectedChamp = key;
      socket.emit('select_champion', { champion: key }); // 서버 권위 — room_state로 반영
    });
    wrap.appendChild(card);
    roomChampPreviews.push({ key, ctx: pc.getContext('2d'), m, card, owner });
  }
}
// 대기실 미리보기 애니메이션 루프(중복 방지 가드)
let previewRunning = false;
function startRoomPreview() {
  if (previewRunning) return;
  previewRunning = true;
  (function animate() {
    if (uiMode !== 'room') { previewRunning = false; return; }
    const now = performance.now();
    for (const pv of roomChampPreviews) {
      pv.ctx.clearRect(0, 0, 120, 120);
      pv.ctx.save(); pv.ctx.translate(60, 64);
      const fakeP = { champion: pv.key, x: 0, y: 0, facing: Math.sin(now * 0.001) * 0.7, tier: 2, level: 5, hp: 100, maxHp: 100, dead: false, invuln: false, attackAnim: null, name: '' };
      drawChampPreview(pv.ctx, fakeP, now, pv.m);
      pv.ctx.restore();
    }
    requestAnimationFrame(animate);
  })();
}

// ── 대기실 전체 렌더(room_state 수신마다) ──
function renderRoom(s) {
  if (!s) return;
  document.getElementById('room-code').textContent = s.code || '----';
  const me = (s.members || []).find(m => m.pid === myPid);
  const taken = s.takenChampions || {};
  // 멤버 슬롯(4)
  const mwrap = document.getElementById('room-members');
  mwrap.innerHTML = '';
  const max = s.maxPlayers || 4;
  for (let i = 0; i < max; i++) {
    const m = s.members[i];
    const slot = document.createElement('div');
    if (!m) { slot.className = 'member-slot empty'; slot.innerHTML = '<div class="ms-name dim">빈 자리</div>'; }
    else {
      slot.className = 'member-slot filled' + (m.pid === myPid ? ' me' : '');
      const champName = m.champion ? (CHAMP_META[m.champion] ? CHAMP_META[m.champion].name : m.champion) : '미선택';
      slot.innerHTML =
        '<div class="ms-name">' + escapeHtml(m.name) + (m.isHost ? ' <span class="ms-host">👑</span>' : '') + '</div>' +
        '<div class="ms-champ">' + champName + '</div>' +
        '<div class="ms-ready ' + (m.ready ? 'yes' : 'no') + '">' + (m.ready ? '준비완료' : '대기중') + '</div>';
    }
    mwrap.appendChild(slot);
  }
  // 챔피언 카드 잠금/선택 상태
  for (const pv of roomChampPreviews) {
    const ownerPid = taken[pv.key];
    const mineSel = me && me.champion === pv.key;
    pv.card.classList.toggle('selected', !!mineSel);
    pv.card.classList.toggle('locked', ownerPid != null && !mineSel);
    if (ownerPid != null) {
      const om = s.members.find(mm => mm.pid === ownerPid);
      pv.owner.textContent = mineSel ? '내 선택' : (om ? om.name + ' 선택' : '선택됨');
    } else pv.owner.textContent = '';
  }
  // 준비 버튼
  const readyBtn = document.getElementById('ready-btn');
  readyBtn.textContent = (me && me.ready) ? '준비 해제' : '준비';
  readyBtn.disabled = !(me && me.champion); // 챔피언 안 고르면 준비 불가
  readyBtn.classList.toggle('gold', !!(me && me.ready));
  // 시작 버튼(방장만)
  const startBtn = document.getElementById('start-btn');
  const hint = document.getElementById('start-hint');
  const isHost = me && me.isHost;
  startBtn.style.display = isHost ? '' : 'none';
  if (isHost) {
    startBtn.disabled = !s.canStart;
    hint.textContent = s.canStart ? '' : (roomErrorText(s.canStartReason || 'not_ready'));
  } else {
    hint.textContent = '방장이 게임을 시작하기를 기다리는 중…';
  }
}
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function statRow(label, v) {
  return '<div class="cc-stat"><span class="lbl">' + label + '</span><span class="cc-bar"><i style="width:' + Math.round(clamp(v, 0, 1) * 100) + '%"></i></span></div>';
}
// 미리보기는 본체만(라벨 제외)
function drawChampPreview(ctx, p, now, meta) {
  const aim = p.facing;
  drawTierAura(ctx, p, meta, now);
  (CHAMP_DRAW[p.champion] || CHAMP_DRAW.warrior)(ctx, p, meta, now, aim, null, -1);
}

// ── 증강 카드 ──
let augmentLocked = false;
const skillReplace = { open: false }; // 교체 오버레이 활성 시 augment-select를 숨기지 않게 가드
const rarityKo = { common: '★☆☆ 일반', rare: '★★☆ 희귀', legendary: '★★★ 전설' };

function mySkillsArr() { const me = myRenderPlayer(); return me && me.skills ? me.skills : [null, null, null]; }
function skillsFull() { const a = mySkillsArr(); return a.length >= 3 && a.every(x => x); }

function renderAugmentCards(s) {
  const offers = s.offers && s.offers[myPid];
  if (!offers) { if (!skillReplace.open) hideOverlay('augment-select'); return; }
  cacheChoiceMeta(offers); // 스킬 id→메타 캐시(스킬바 아이콘/이름의 서버 단일 출처)
  if (augmentLocked || skillReplace.open) return;
  const wrap = document.getElementById('augment-cards');
  if (wrap.dataset.sig === offers.map(o => o.id).join(',')) { showOverlay('augment-select'); return; }
  wrap.dataset.sig = offers.map(o => o.id).join(',');
  wrap.innerHTML = '';
  for (const o of offers) {
    const isSkill = o.kind === 'skill';
    const card = document.createElement('div');
    card.className = 'aug-card' + (isSkill ? ' skill' : (o.classOnly ? ' classonly' : ''));
    if (!isSkill && o.classOnly) card.style.setProperty('--cc', (CHAMP_META[o.classOnly] || {}).color || PAL.gold);
    let badge;
    if (isSkill) badge = '<div class="aug-badge skill">스킬' + (o.upgrade ? ' · 강화' : '') + '</div>';
    else if (o.classOnly) badge = '<div class="aug-badge cls">' + (CHAMP_META[o.classOnly] ? CHAMP_META[o.classOnly].name : '') + ' 전용</div>';
    else badge = '<div class="aug-badge common">공통</div>';
    const icon = isSkill ? (SKILL_TYPE_GLYPH[o.skillType] || '✦') : (AUG_GLYPH[o.id] || '◆');
    const iconColor = isSkill ? (SKILL_TYPE_COLOR[o.skillType] || '#5BE7D6') : '';
    card.innerHTML = badge +
      '<div class="aug-icon"' + (iconColor ? ' style="color:' + iconColor + '"' : '') + '>' + icon + '</div>' +
      '<div class="aug-name">' + o.name + '</div>' +
      '<div class="aug-rarity ' + o.rarity + '">' + (rarityKo[o.rarity] || o.rarity) + '</div>' +
      '<div class="aug-desc">' + o.desc + '</div>' +
      '<div class="aug-value">' + (o.value || '') + '</div>';
    card.addEventListener('click', () => {
      if (augmentLocked || skillReplace.open) return;
      // 스킬인데 슬롯이 꽉 찼으면 교체 UI로 — 서버에 후보 등록(select_augment) 후 슬롯 선택→replace_skill.
      if (isSkill && skillsFull()) {
        augmentLocked = true; card.classList.add('flash');
        socket.emit('select_augment', { id: o.id });
        openSkillReplace(o);
        return;
      }
      augmentLocked = true; card.classList.add('flash');
      socket.emit('select_augment', { id: o.id }); // 증강 또는 빈 슬롯 스킬(서버 자동 배치)
      setTimeout(() => { hideOverlay('augment-select'); augmentLocked = false; wrap.dataset.sig = ''; }, 200);
    });
    wrap.appendChild(card);
  }
  showOverlay('augment-select');
  document.getElementById('augment-timer').textContent =
    lastAugSource === 'orb'
      ? '오브 10개 누적 — 업그레이드를 선택하세요'
      : '직업 전용 증강·스킬이 섞여 제공됩니다 · 스킬은 Q→E→R 순으로 채워지고, 가득 차면 교체합니다 · 미선택 시 자동 선택';
}

// ── 스킬 슬롯 교체 UI ──
function openSkillReplace(skillChoice) {
  skillReplace.open = true;
  skillReplace.id = skillChoice.id;
  hideOverlay('augment-select');
  const meta = { name: skillChoice.name, skillType: skillChoice.skillType, rarity: skillChoice.rarity };
  document.getElementById('skill-replace-sub').innerHTML =
    '<b style="color:' + (SKILL_TYPE_COLOR[meta.skillType] || '#5BE7D6') + '">' + (SKILL_TYPE_GLYPH[meta.skillType] || '✦') + ' ' + meta.name + '</b> 을(를) 어느 슬롯에 넣을까요?';
  const wrap = document.getElementById('skill-replace-cards');
  wrap.innerHTML = '';
  const cur = mySkillsArr();
  for (let slot = 0; slot < 3; slot++) {
    const sid = cur[slot] && cur[slot].id;
    const m = sid ? skillMeta(sid) : null;
    const card = document.createElement('div');
    card.className = 'slot-card';
    card.innerHTML =
      '<div class="slot-key">' + SLOT_KEYS[slot] + '</div>' +
      (m
        ? '<div class="slot-icon" style="color:' + (SKILL_TYPE_COLOR[m.skillType] || '#5BE7D6') + '">' + (SKILL_TYPE_GLYPH[m.skillType] || '✦') + '</div>' +
          '<div class="slot-name">' + m.name + '</div><div class="slot-cur">현재 슬롯 — 덮어쓰기</div>'
        : '<div class="slot-icon">＋</div><div class="slot-empty">빈 슬롯</div>');
    card.addEventListener('click', () => {
      socket.emit('replace_skill', { slot, id: skillReplace.id });
      closeSkillReplace();
    });
    wrap.appendChild(card);
  }
  showOverlay('skill-replace');
}
function closeSkillReplace() {
  skillReplace.open = false; augmentLocked = false;
  hideOverlay('skill-replace');
  const wrap = document.getElementById('augment-cards'); if (wrap) wrap.dataset.sig = '';
}

// ── 매판 변이 선택 UI ──
let mutatorSig = '';
const mutatorOfferCache = {};
function cacheMutatorOffer(choices) { if (choices) for (const c of choices) mutatorOfferCache[c.id] = c; }
const MUT_GLYPH = { frenzy: '🔥', ricochet: '🎯', volatile: '💣', bulwark: '🛡️', overdrive: '⚙️', elite: '👑', adrenal: '💉' };
function renderMutatorCards(s) {
  const offer = s.mutatorOffer;
  if (!offer || !offer.length) { hideOverlay('mutator-select'); return; }
  cacheMutatorOffer(offer);
  const sig = offer.map(o => o.id).join(',');
  if (sig === mutatorSig) { showOverlay('mutator-select'); return; }
  mutatorSig = sig;
  const wrap = document.getElementById('mutator-cards');
  wrap.innerHTML = '';
  for (const o of offer) {
    const card = document.createElement('div');
    card.className = 'mut-card';
    card.innerHTML =
      '<div class="mut-icon">' + (MUT_GLYPH[o.id] || '✦') + '</div>' +
      '<div class="mut-name">' + o.name + '</div>' +
      '<div class="mut-desc">' + o.desc + '</div>';
    card.addEventListener('click', () => {
      socket.emit('select_mutator', { id: o.id });
      hideOverlay('mutator-select'); mutatorSig = '';
    });
    wrap.appendChild(card);
  }
  showOverlay('mutator-select');
}

// ── 게임오버 ──
function showGameOver(s) {
  const box = document.getElementById('go-stats');
  box.innerHTML =
    goItem(s.wave, '도달 웨이브') + goItem(s.killCount, '처치 수') + goItem(s.score, '점수');
  showOverlay('gameover');
  augmentLocked = false; skillReplace.open = false; mutatorSig = '';
  hideOverlay('skill-replace'); hideOverlay('mutator-select');
  const wrap = document.getElementById('augment-cards'); if (wrap) wrap.dataset.sig = '';
}
function goItem(num, label) {
  return '<div class="go-item"><div class="go-num">' + num + '</div><div class="go-lbl">' + label + '</div></div>';
}

// ────────────────────────────── 부팅 ──────────────────────────────
// 로비
document.getElementById('create-room-btn').addEventListener('click', createRoom);
document.getElementById('join-room-btn').addEventListener('click', () => joinRoom(document.getElementById('join-code').value));
document.getElementById('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(e.target.value); });
document.getElementById('refresh-rooms').addEventListener('click', requestRoomList);
// 대기실
document.getElementById('ready-btn').addEventListener('click', () => {
  const me = roomData && (roomData.members || []).find(m => m.pid === myPid);
  socket.emit('ready', { ready: !(me && me.ready) });
});
document.getElementById('start-btn').addEventListener('click', () => socket.emit('start_game'));
document.getElementById('leave-btn').addEventListener('click', () => { socket.emit('leave_room'); backToLobby(); });
document.getElementById('copy-code').addEventListener('click', () => {
  if (roomCode && navigator.clipboard) navigator.clipboard.writeText(roomCode).then(() => showToast('코드 복사됨: ' + roomCode), () => {});
});
// 게임오버 '다시 시작' = 대기실 복귀
document.getElementById('restart-btn').addEventListener('click', restartGame);
document.getElementById('skill-replace-cancel').addEventListener('click', () => {
  if (skillReplace.open) { socket.emit('replace_skill', { slot: 0, id: skillReplace.id }); closeSkillReplace(); }
});

buildRoomChamps();
connect();
requestRoomList();
// 로비에 있는 동안 방 목록 주기 갱신(로비 밖에선 요청 안 함)
roomListTimer = setInterval(() => { if (uiMode === 'lobby') requestRoomList(); }, 2500);
if (window.Effects && typeof window.Effects.init === 'function') { try { window.Effects.init(); } catch (e) {} }
if (window.ChampMotion && typeof window.ChampMotion.init === 'function') { try { window.ChampMotion.init(); } catch (e) {} }
requestAnimationFrame(frame);

// ── QA / E2E 테스트 훅 (프로덕션 무해 — window 노출만) ──────────────────
window.__qaHook = {
  injectEvent:  function(ev)    { try { handleEvent(ev); } catch(e) {} },
  injectPhase:  function(state) { try { handlePhase(state); } catch(e) {} },
  enterGame:    function()      { try { enterGame(); } catch(e) {} },
  setMyPid:     function(pid)   { myPid = pid; },
  setSnapCur:   function(s)     { snapCur = s; snapPrev = s; snapCurAt = performance.now(); snapPrevAt = snapCurAt; },
  resetAugLock: function()      { augmentLocked = false; skillReplace.open = false; const w = document.getElementById('augment-cards'); if (w) w.dataset.sig = ''; },
  getOrbCount:  function()      { return _orbDisplayCount; },
  getPhase:     function()      { return phase; },
  getThreshAnim:function()      { return orbThresholdAnim; },
  getSlotAnims: function()      { return orbSlotAnims.map(a => !!a); }
};

})();
