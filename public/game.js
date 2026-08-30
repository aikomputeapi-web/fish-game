/* Fire Kirin Dev — server-authoritative arcade fish-shooter client.
   The server spawns fish and decides kills; this file is the renderer + input.
   All artwork is drawn procedurally on canvas; all audio is synthesized. */
'use strict';

// ============================================================ constants
const W = 1440, H = 810;                 // logical resolution (16:9)
const FIRE_INTERVAL = 0.14;              // seconds between shots when holding
const BULLET_SPEED = 640;
const MAX_BOUNCES = 3;
const params = new URLSearchParams(location.search);
const requestedGameMode = params.get('mode') === 'multiplayer' ? 'multiplayer' : 'solo';
const requestedTier = params.get('tier') || 'mid';

// Stake tiers (mirrors server/game/constants.js ROOM_TIERS).
const ROOM_TIERS = {
  low:  { id: 'low',  label: 'LOW',  bets: [1, 2, 5],             vip: false },
  mid:  { id: 'mid',  label: 'MID',  bets: [1, 2, 5, 10, 20],     vip: false },
  high: { id: 'high', label: 'HIGH', bets: [5, 10, 20, 50, 100],  vip: false },
  vip:  { id: 'vip',  label: 'VIP',  bets: [20, 50, 100, 200, 500], vip: true },
};
const tierBets = () => (ROOM_TIERS[state && state.tier] || ROOM_TIERS.mid).bets;

// Weapon levels — each has a unique mechanic (mirrors server constants.js).
const WEAPON_LEVELS = [
  { name: 'STD',    type: 'single',  costMult: 1,  fireMult: 1.0,  sizeMult: 1.0, color: '#ffd54a', desc: 'Standard cannon' },
  { name: 'SPREAD', type: 'spread',   costMult: 2,  fireMult: 0.9,  sizeMult: 1.0, color: '#ff9a3a', desc: '3-shot fan', spreadCount: 3, spreadAngle: 0.18 },
  { name: 'PIERCE', type: 'pierce',   costMult: 4,  fireMult: 0.8,  sizeMult: 0.9, color: '#ff5a3a', desc: 'Piercing beam', pierceTargets: 5, armorPierce: 0.5 },
  { name: 'FROST',  type: 'freeze',   costMult: 6,  fireMult: 0.6,  sizeMult: 1.1, color: '#6acaff', desc: 'Freezes target', freezeDuration: 3.0, armorPierce: 0.3 },
  { name: 'HEAVY',  type: 'heavy',    costMult: 12, fireMult: 0.45, sizeMult: 1.6, color: '#c83aff', desc: 'Massive damage', armorPierce: 0.8 },
];

// ---- fish species table (must mirror server/game/fishTypes.js) ----
// mult  : payout multiplier (win = mult * bet). multRange for variable bosses.
// weight: relative spawn frequency (server-side).
// r     : collision radius / draw size
// kind  : which painter to use
// special: 'aoe' triggers a fullscreen chain; 'bonus' triggers a bonus round.
const SPECIES = [
  { id: 'guppy',    name: 'Reef Guppy',    mult: 2,   weight: 25, r: 20, speed: 110, armor: 0,  kind: 'fish',   body: '#ff9d3c', belly: '#ffe0b0', fin: '#ff6a00', stripe: '#e05a00' },
  { id: 'neon',     name: 'Neon Tetra',    mult: 3,   weight: 21, r: 22, speed: 120, armor: 0,  kind: 'fish',   body: '#3ec9ff', belly: '#d5f4ff', fin: '#0f7fd0', stripe: '#ff4d6d' },
  { id: 'angel',    name: 'Angelfish',     mult: 4,   weight: 17, r: 26, speed: 95,  armor: 0,  kind: 'fish',   body: '#ffd23c', belly: '#fff3c0', fin: '#e0a000', stripe: '#7a5200' },
  { id: 'clown',    name: 'Clownfish',     mult: 5,   weight: 14, r: 26, speed: 105, armor: 0,  kind: 'fish',   body: '#ff7330', belly: '#ffd9c0', fin: '#d84e10', stripe: '#ffffff' },
  { id: 'puffer',   name: 'Pufferfish',    mult: 7,   weight: 10, r: 30, speed: 70,  armor: 1,  kind: 'puffer', body: '#c9e265', belly: '#f2ffd0', fin: '#8aa63c', stripe: '#5d7522' },
  { id: 'mandarin', name: 'Coral Mandarinfish', mult: 9, weight: 9, r: 30, speed: 100, armor: 1, kind: 'mandarin', body: '#1f6dff', belly: '#7dffd8', fin: '#ff8c1a', stripe: '#ffb63c', glow: '#4ec9ff' },
  { id: 'turtle',   name: 'Rune Turtle',   mult: 12,  weight: 7,  r: 38, speed: 55,  armor: 4,  kind: 'turtle', body: '#3da35d', belly: '#cfe8b0', fin: '#2c7a44', stripe: '#1e5c31' },
  { id: 'serpray',  name: 'Emerald Serpent-Ray', mult: 16, weight: 5.5, r: 48, speed: 80, armor: 3, kind: 'serpentray', body: '#12a352', belly: '#8affc0', fin: '#0a6e36', stripe: '#ffd23c', glow: '#4dff9a' },
  { id: 'sword',    name: 'Swordfish',     mult: 20,  weight: 5,  r: 42, speed: 150, armor: 2,  kind: 'fish',   body: '#7f9bb5', belly: '#e6f0f8', fin: '#5a7690', stripe: '#3e556b', nose: true },
  { id: 'octomage', name: 'Gilded Octo-Mage', mult: 25, weight: 4, r: 44, speed: 60, armor: 5,  kind: 'octomage', body: '#8a4fd0', belly: '#d9b6ff', fin: '#5c2fa0', stripe: '#ffcf4a', glow: '#c86bff' },
  { id: 'thunder',  name: 'Thunder Hammerhead', mult: 35, weight: 3, r: 54, speed: 100, armor: 6, kind: 'thundershark', body: '#3d5a80', belly: '#dbe8f5', fin: '#28415f', stripe: '#ffd23c', hammer: true, glow: '#9fd8ff' },
  { id: 'shark',    name: 'Tiger Shark',   mult: 45,  weight: 2.5,r: 60, speed: 100, armor: 8,  kind: 'shark',  body: '#6e8494', belly: '#dbe6ec', fin: '#51636f', stripe: '#3a4a54' },
  { id: 'crab',     name: 'Bomb Crab',     mult: 12,  weight: 3,  r: 34, speed: 45,  armor: 3,  kind: 'crab',   body: '#e0483c', belly: '#ffb09e', fin: '#a82f26', stripe: '#701d17', special: 'aoe' },
  { id: 'madshark', name: 'Mad Shark',     mult: 30,  weight: 2.0, r: 52, speed: 110, armor: 6,  kind: 'shark',  body: '#c23a2a', belly: '#ffc9a8', fin: '#7a1d10', stripe: '#ffea3a', special: 'aoe', bomb: true },
  { id: 'dynamite', name: 'Dynamite Stick', mult: 20, weight: 2.0, r: 32, speed: 80,  armor: 2,  kind: 'dynamite', body: '#d2483a', belly: '#ffd9c9', fin: '#8a2418', stripe: '#ffd54a', special: 'aoe', bomb: true },
  { id: 'dragonkoi',name: 'Emperor Dragon-Koi', mult: 60, weight: 1.4, r: 42, speed: 120, armor: 10, kind: 'dragonkoi', body: '#c92a4e', belly: '#ffd98a', fin: '#ff8c1a', stripe: '#ffcf24', glow: '#ff9a2a' },
  { id: 'whale',    name: 'Blue Whale',    mult: 80,  weight: 0.8,r: 78, speed: 45,  armor: 15, kind: 'whale',  body: '#4a7ba6', belly: '#cfe2f0', fin: '#35597a', stripe: '#27435c' },
  { id: 'laser',    name: 'Laser Crab',     mult: 60,  weight: 1.0, r: 40, speed: 50,  armor: 12, kind: 'crab',   body: '#b048e0', belly: '#ffb0ff', fin: '#7a2fa0', stripe: '#33ddff', special: 'aoe', laser: true },
  { id: 'eel',      name: 'Electric Eel',   mult: 90,  weight: 0.9, r: 46, speed: 75,  armor: 14, kind: 'eel',    body: '#7adfff', belly: '#e6fbff', fin: '#3aa0c8', stripe: '#ffea3a', special: 'aoe', glow: '#aef6ff' },
  { id: 'pearl',    name: 'Bonus Pearl',    mult: 5,   weight: 0.6, r: 28, speed: 80,  armor: 0,  kind: 'pearl',  body: '#fff3a0', belly: '#ffffff', fin: '#ffcf4a', stripe: '#ff9a3a', special: 'bonus', glow: '#fff6c8' },
];

const BOSS = { id: 'kraken', name: 'KRAKEN', mult: 120, r: 80, speed: 55, kind: 'abysslord', tier: 'mega', armor: 20, body: '#5a4a8a', belly: '#c0a0ff', fin: '#3a2a6a', stripe: '#ffd23c', boss: true, sharedHp: 800 };
const VARIABLE_BOSSES = [
  { id: 'goldendragon', name: 'GOLDEN DRAGON', multRange: [100, 500], expectedMult: 300, r: 76, speed: 60, kind: 'dragonkoi', tier: 'mega', armor: 25, body: '#ffcf24', belly: '#fff3a0', fin: '#e09010', stripe: '#a05a00', glow: '#ffe680', boss: true, variable: true, sharedHp: 1200 },
  { id: 'kirin', name: 'FIRE KIRIN', multRange: [150, 600], expectedMult: 375, r: 84, speed: 55, kind: 'dragonkoi', tier: 'mega', armor: 28, body: '#ff5a1a', belly: '#ffd9a8', fin: '#c83200', stripe: '#ffe680', glow: '#ff9a2a', boss: true, variable: true, sharedHp: 1600 },
  { id: 'phoenix', name: 'PHOENIX KING', multRange: [200, 800], expectedMult: 500, r: 88, speed: 70, kind: 'abysslord', tier: 'mega', armor: 30, body: '#ff3a6a', belly: '#ffd9a8', fin: '#ff8c1a', stripe: '#fff0c0', glow: '#ffcf4a', boss: true, variable: true, sharedHp: 2000 },
];

// lookup tables: typeId -> def (for spawns received from the server)
const FISH_BY_ID = {};
for (const s of SPECIES) FISH_BY_ID[s.id] = s;
FISH_BY_ID[BOSS.id] = BOSS;
for (const b of VARIABLE_BOSSES) FISH_BY_ID[b.id] = b;

// ============================================================ canvas setup
const canvas = document.getElementById('game');
const g = canvas.getContext('2d');
let viewScale = 1, viewOX = 0, viewOY = 0;

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  const s = Math.min(canvas.width / W, canvas.height / H);
  viewScale = s;
  viewOX = (canvas.width - W * s) / 2;
  viewOY = (canvas.height - H * s) / 2;
}
addEventListener('resize', resize);
resize();

function toGame(clientX, clientY) {
  const dpr = canvas.width / canvas.clientWidth;
  return {
    x: (clientX * dpr - viewOX) / viewScale,
    y: (clientY * dpr - viewOY) / viewScale,
  };
}

// ============================================================ state
const state = {
  balance: 0,            // authoritative value, pushed by server
  displayBalance: 0,     // odometer value that ticks toward balance
  totalWin: 0,
  betIdx: 2,
  weaponLevel: 0,
  auto: false,
  firing: false,
  aim: { x: W / 2, y: H / 2 - 100 },
  fireCooldown: 0,
  time: 0,
  fish: [],              // {id, def, path, age, dur, receivedAt, x, y, angle, wag, flash, boss, frozenUntil}
  bullets: [],
  nets: [],
  coins: [],
  texts: [],
  particles: [],
  bubbles: [],
  weeds: [],
  // VFX
  hitstop: 0,            // seconds of frozen-frame on big kills
  shakeTime: 0,
  shakeAmp: 0,
  bonusActive: false,
  miniGamePending: false,
  connected: false,
  roomReady: false,
  gameMode: requestedGameMode,
  banned: false,
  // progression / economy
  tier: requestedTier,
  level: 1,
  xp: 0,
  xpNeeded: 100,
  jackpot: 0,
  // fury / energy meter
  fury: 0,               // 0..furyMax charge
  furyMax: 100,
  furyReady: false,      // meter full, ready to unleash
  furyActive: false,     // fury window currently running
  furyUntil: 0,          // ms timestamp fury ends
  powerups: {},          // key -> count
  aimPowerup: null,      // armed aim/target powerup waiting for a canvas click
  // lock-on targeting
  lockedFishId: null,
  // shared boss HP
  bossHp: null,          // { fishId, hp, maxHp, name }
  // multi-hit tracking (pierce bullets collect hits before removing)
  volleys: new Map(),    // volleyId -> { hits: Set<fishId>, weaponLevel, bet }
  nextVolleyId: 1,
};

const bet = () => tierBets()[state.betIdx];
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// decorative seaweed, fixed per session
for (let i = 0; i < 7; i++) {
  state.weeds.push({ x: rand(30, W - 30), h: rand(70, 170), sway: rand(0, 6.28), w: rand(10, 22) });
}
for (let i = 0; i < 26; i++) {
  state.bubbles.push({ x: rand(0, W), y: rand(0, H), r: rand(2, 7), v: rand(18, 55), drift: rand(0, 6.28) });
}

// ============================================================ HUD
const el = id => document.getElementById(id);
const hud = {
  balance: el('balance'), win: el('win'), bet: el('bet'),
  auto: el('btn-auto'), redeem: el('btn-redeem'),
  sound: el('btn-sound'), full: el('btn-full'),
  betUp: el('bet-up'), betDown: el('bet-down'),
  weaponRow: el('weapon-row'),
  authBar: el('auth-bar'), authUser: el('auth-user'), btnLogout: el('btn-logout'),
  solo: el('btn-solo'), multiplayer: el('btn-multiplayer'), matchStatus: el('match-status'),
  msg: el('msg-layer'),
  mega: el('mega-layer'),
  mini: el('mini-layer'),
  jackpot: el('jackpot-pill'),
  btnFury: el('btn-fury'), furyFill: el('fury-fill'),
  xpLevel: el('xp-level'), xpFill: el('xp-fill'),
  tierRow: el('tier-row'),
  powerupRow: el('powerup-row'),
  btnWallet: el('btn-wallet'),
  btnChat: el('btn-chat'),
  chatPanel: el('chat-panel'), chatList: el('chat-list'), chatInput: el('chat-input'), chatSend: el('chat-send'),
  walletModal: el('wallet-modal'),
  shopModal: el('shop-modal'),
};

function refreshHUD() {
  hud.balance.textContent = Math.floor(state.displayBalance).toLocaleString();
  hud.win.textContent = Math.floor(state.totalWin).toLocaleString();
  hud.bet.textContent = bet() * WEAPON_LEVELS[state.weaponLevel].costMult;
  hud.jackpot.textContent = '💎 ' + Math.floor(state.jackpot).toLocaleString();
  hud.xpLevel.textContent = 'LV ' + state.level;
  const pct = clamp((state.xp / (state.xpNeeded || 1)) * 100, 0, 100);
  hud.xpFill.style.width = pct + '%';
  updateFury();
  refreshPowerupRow();
}

// Reflect the fury meter/state onto the fury button.
function updateFury() {
  if (!hud.btnFury) return;
  const pctFury = clamp((state.fury / (state.furyMax || 100)) * 100, 0, 100);
  if (hud.furyFill) hud.furyFill.style.width = pctFury + '%';
  hud.btnFury.classList.toggle('ready', state.furyReady && !state.furyActive);
  hud.btnFury.classList.toggle('active', state.furyActive);
  hud.btnFury.disabled = !(state.furyReady && !state.furyActive);
  document.body.classList.toggle('fury-on', state.furyActive);
}

// Ask the server to unleash fury (validated server-side).
function activateFury() {
  if (!socket || !state.furyReady || state.furyActive) return;
  socket.emit('activateFury', (r) => {
    if (r && r.ok) { SFX.bigWin && SFX.bigWin(); }
  });
}

function selectGameMode(mode) {
  if (mode === state.gameMode) return;
  location.href = mode === 'multiplayer' ? '/game?mode=multiplayer' : '/game';
}

function updateGameModeUI(room = null) {
  hud.solo.classList.toggle('on', state.gameMode === 'solo');
  hud.multiplayer.classList.toggle('on', state.gameMode === 'multiplayer');
  if (!room) {
    hud.matchStatus.textContent = state.gameMode === 'multiplayer' ? 'MATCHMAKING…' : 'SOLO · READY';
    return;
  }
  if (room.status === 'waiting') {
    hud.matchStatus.textContent = `MATCHMAKING · ${room.queued || 1}/${room.required || 4}`;
    return;
  }
  hud.matchStatus.textContent = room.mode === 'multiplayer'
    ? `MULTIPLAYER · ${(room.players || []).length}/${room.required || 4}`
    : 'SOLO · READY';
}

function applyRoomState(room) {
  state.gameMode = room.mode === 'multiplayer' ? 'multiplayer' : 'solo';
  state.roomReady = room.status === 'active';
  // adopt the server-resolved tier (server downgrades VIP when under threshold)
  if (room.tier && ROOM_TIERS[room.tier]) {
    state.tier = room.tier;
    state.betIdx = clamp(state.betIdx, 0, ROOM_TIERS[room.tier].bets.length - 1);
  }
  if (room.reset) {
    state.fish = [];
    state.bullets = [];
    state.volleys.clear();
    state.lockedFishId = null;
    state.bossHp = null;
    state.bonusActive = false;
  }
  if (!state.roomReady) {
    state.firing = false;
    state.auto = false;
    hud.auto.classList.remove('on');
  } else if (room.mode === 'multiplayer' && room.reset) {
    banner('MATCH FOUND · 4 PLAYERS');
    SFX.bossAlert();
  }
  buildTierRow();
  updateGameModeUI(room);
  refreshHUD();
}

// weapon selector buttons
function buildWeaponRow() {
  hud.weaponRow.innerHTML = '';
  WEAPON_LEVELS.forEach((wl, i) => {
    const b = document.createElement('button');
    b.className = 'weapon-btn' + (i === state.weaponLevel ? ' on' : '');
    b.textContent = wl.name;
    b.title = `${wl.desc} (${wl.costMult}× bet)`;
    b.style.color = wl.color;
    b.onclick = () => { state.weaponLevel = i; if (socket) socket.emit('selectWeapon', i); SFX.click(); buildWeaponRow(); refreshHUD(); };
    hud.weaponRow.appendChild(b);
  });
}

// ---- stake-tier selector (reloads with ?tier=) ----
function buildTierRow() {
  if (!hud.tierRow) return;
  hud.tierRow.innerHTML = '';
  const mode = state.gameMode || 'solo';
  for (const t of Object.values(ROOM_TIERS)) {
    const b = document.createElement('button');
    b.className = 'tier-btn' + (t.id === state.tier ? ' on' : '');
    b.textContent = t.label;
    b.title = t.desc || '';
    b.disabled = t.vip; // VIP entry handled server-side by points gate
    b.onclick = () => {
      if (t.id === state.tier) return;
      location.href = '/game?mode=' + mode + (t.id === 'mid' ? '' : '&tier=' + t.id);
    };
    hud.tierRow.appendChild(b);
  }
}

// ---- power-up quick bar ----
const POWERUP_KEYS = [
  { key: 'missile', icon: '🚀' },
  { key: 'freeze', icon: '❄️' },
  { key: 'chain', icon: '⚡' },
  { key: 'laser', icon: '🔦' },
];

function refreshPowerupRow() {
  if (!hud.powerupRow) return;
  hud.powerupRow.innerHTML = '';
  for (const p of POWERUP_KEYS) {
    const n = state.powerups[p.key] || 0;
    const b = document.createElement('button');
    b.className = 'pw-btn' + (state.aimPowerup === p.key ? ' armed' : '') + (n === 0 ? ' empty' : '');
    b.innerHTML = `${p.icon}<span class="pw-count">${n}</span>`;
    b.title = p.key + (n === 0 ? ' — buy in the shop' : '');
    b.onclick = () => {
      if (n === 0) { openShop(); return; }
      SFX.click();
      if (p.key === 'freeze') {
        socket.emit('usePowerup', { key: 'freeze' }, (r) => {
          if (!r || !r.ok) banner('freeze failed');
        });
        return;
      }
      state.aimPowerup = state.aimPowerup === p.key ? null : p.key;
      refreshPowerupRow();
      banner(state.aimPowerup ? `${p.key.toUpperCase()} armed — tap the field to fire` : 'power-up cancelled');
    };
    hud.powerupRow.appendChild(b);
  }
  const shop = document.createElement('button');
  shop.className = 'pw-btn shop';
  shop.textContent = '🛒';
  shop.title = 'Power-up shop';
  shop.onclick = openShop;
  hud.powerupRow.appendChild(shop);
}

// ---- power-up shop modal ----
async function openShop() {
  if (!hud.shopModal) return;
  hud.shopModal.classList.remove('hidden');
  hud.shopModal.innerHTML = '<div class="modal-card"><h2>⚡ POWER-UP SHOP</h2><div id="shop-list">Loading…</div><button class="btn" id="shop-close">Close</button></div>';
  hud.shopModal.querySelector('#shop-close').onclick = () => hud.shopModal.classList.add('hidden');
  const r = await fetch('/api/player/powerups', { credentials: 'include' });
  const j = await r.json();
  const list = hud.shopModal.querySelector('#shop-list');
  list.innerHTML = '';
  (j.catalog || []).forEach((p) => {
    const owned = (j.inventory && j.inventory[p.key]) || 0;
    const row = document.createElement('div');
    row.className = 'shop-row';
    row.innerHTML = `<span class="shop-icon">${p.icon}</span><span class="shop-name">${p.name}<small>${p.desc}</small></span><span class="shop-owned">own ${owned}</span>`;
    const buy = document.createElement('button');
    buy.className = 'btn primary';
    buy.textContent = `${p.price.toLocaleString()} pts`;
    buy.onclick = async () => {
      const rr = await fetch('/api/player/powerups/buy', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: p.key }) });
      const jj = await rr.json();
      if (!rr.ok) { banner(jj.error || 'buy failed'); return; }
      state.powerups = jj.inventory;
      state.balance = jj.points;
      state.displayBalance = jj.points;
      banner(`${p.name} purchased`);
      openShop();
    };
    row.appendChild(buy);
    list.appendChild(row);
  });
}

// ---- chat ----
function toggleChat() {
  if (!hud.chatPanel) return;
  hud.chatPanel.classList.toggle('hidden');
  if (!hud.chatPanel.classList.contains('hidden')) hud.chatInput.focus();
}
function sendChat() {
  const text = hud.chatInput.value.trim();
  if (!text) return;
  socket.emit('chat', { message: text });
  hud.chatInput.value = '';
}

// ---- wallet modal: daily bonus / referral / promo ----
async function openWallet() {
  if (!hud.walletModal) return;
  hud.walletModal.classList.remove('hidden');
  hud.walletModal.innerHTML = '<div class="modal-card"><h2>🎁 WALLET</h2><div id="wallet-body">Loading…</div><button class="btn" id="wallet-close">Close</button></div>';
  hud.walletModal.querySelector('#wallet-close').onclick = () => hud.walletModal.classList.add('hidden');
  const body = hud.walletModal.querySelector('#wallet-body');
  body.innerHTML = '';

  // daily
  const daily = await fetch('/api/player/daily', { credentials: 'include' }).then(r => r.json());
  const dRow = document.createElement('div');
  dRow.className = 'wallet-row';
  dRow.innerHTML = `<span>📅 Daily login <small>streak ${daily.streak || 0}</small></span>`;
  const dBtn = document.createElement('button');
  dBtn.className = 'btn primary';
  dBtn.textContent = daily.claimable ? 'CLAIM' : 'CLAIMED ✓';
  dBtn.disabled = !daily.claimable;
  dBtn.onclick = async () => {
    const rr = await fetch('/api/player/daily', { method: 'POST', credentials: 'include' });
    const jj = await rr.json();
    if (!rr.ok) { banner(jj.error || 'daily failed'); return; }
    state.balance = jj.points; state.displayBalance = jj.points;
    banner(`DAILY BONUS +${jj.bonus.toLocaleString()}`);
    openWallet();
  };
  dRow.appendChild(dBtn);
  body.appendChild(dRow);

  // referral
  const ref = await fetch('/api/player/referral', { credentials: 'include' }).then(r => r.json());
  const refRow = document.createElement('div');
  refRow.className = 'wallet-row';
  refRow.innerHTML = `<span>🤝 Referral <small>${ref.referred ? 'you were referred' : 'share your code'}: ${ref.code || '—'} · ${ref.referredCount} referred · +${ref.totalBonus} earned</small></span>`;
  if (!ref.referred) {
    const refIn = document.createElement('input');
    refIn.placeholder = 'enter a referral code';
    refIn.className = 'wallet-input';
    const refBtn = document.createElement('button');
    refBtn.className = 'btn';
    refBtn.textContent = 'APPLY';
    refBtn.onclick = async () => {
      const rr = await fetch('/api/player/referral', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: refIn.value }) });
      const jj = await rr.json();
      if (!rr.ok) { banner(jj.error || 'referral failed'); return; }
      banner(`REFERRAL BONUS +${jj.bonus.toLocaleString()}`);
      openWallet();
    };
    refRow.appendChild(refIn);
    refRow.appendChild(refBtn);
  }
  body.appendChild(refRow);

  // promo
  const promRow = document.createElement('div');
  promRow.className = 'wallet-row';
  promRow.innerHTML = '<span>🎟️ Promo code</span>';
  const promIn = document.createElement('input');
  promIn.placeholder = 'enter promo code';
  promIn.className = 'wallet-input';
  const promBtn = document.createElement('button');
  promBtn.className = 'btn';
  promBtn.textContent = 'REDEEM';
  promBtn.onclick = async () => {
    const rr = await fetch('/api/player/promo', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: promIn.value }) });
    const jj = await rr.json();
    if (!rr.ok) { banner(jj.error || 'promo failed'); return; }
    state.balance = jj.balance; state.displayBalance = jj.balance;
    banner(`PROMO +${jj.points.toLocaleString()}`);
    openWallet();
  };
  promRow.appendChild(promIn);
  promRow.appendChild(promBtn);
  body.appendChild(promRow);
}

function banner(text) {
  const d = document.createElement('div');
  d.className = 'banner';
  d.textContent = text;
  hud.msg.appendChild(d);
  setTimeout(() => d.remove(), 3000);
}

function megaBanner(text) {
  hud.mega.style.display = 'flex';
  hud.mega.innerHTML = `<div class="mega-text">${text}</div>`;
  setTimeout(() => { hud.mega.style.display = 'none'; hud.mega.innerHTML = ''; }, 1700);
}

hud.betUp.addEventListener('click', () => { state.betIdx = Math.min(tierBets().length - 1, state.betIdx + 1); SFX.click(); refreshHUD(); });
hud.betDown.addEventListener('click', () => { state.betIdx = Math.max(0, state.betIdx - 1); SFX.click(); refreshHUD(); });
hud.auto.addEventListener('click', () => {
  state.auto = !state.auto;
  hud.auto.classList.toggle('on', state.auto);
  SFX.click();
});
hud.solo.addEventListener('click', () => selectGameMode('solo'));
hud.multiplayer.addEventListener('click', () => selectGameMode('multiplayer'));
if (hud.btnFury) hud.btnFury.addEventListener('click', activateFury);
// 'F' unleashes fury (ignored while typing in the chat box)
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    activateFury();
  }
});
hud.redeem.addEventListener('click', openRedeemModal);
if (hud.btnWallet) hud.btnWallet.addEventListener('click', openWallet);
if (hud.btnChat) hud.btnChat.addEventListener('click', toggleChat);
if (hud.chatSend) hud.chatSend.addEventListener('click', sendChat);
if (hud.chatInput) hud.chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
hud.sound.addEventListener('click', () => {
  hud.sound.textContent = SFX.toggle() ? '🔊' : '🔇';
});
hud.full.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});

// ---- redeem modal ----
async function openRedeemModal() {
  let info;
  try { info = await (await fetch('/api/player/redeem', { credentials: 'include' })).json(); }
  catch { info = null; }
  if (info && info.error) { banner(info.error); return; }
  const mgr = info && info.manager ? info.manager.username : null;
  const pending = info && info.pendingRequest;
  const card = document.createElement('div');
  card.className = 'mini-overlay';
  card.id = 'redeem-modal';
  if (pending) {
    card.innerHTML = `
      <h2>💎 Redeem</h2>
      <p class="muted">Pending request of <b>${pending.amount.toLocaleString()}</b> to your manager <b>${mgr || '?'}</b>.</p>
      <p class="muted small">Waiting for approval…</p>
      <button class="btn primary" id="rd-cancel">Cancel request</button>
      <button class="btn ghost" id="rd-close">Close</button>`;
  } else if (!mgr) {
    card.innerHTML = `
      <h2>💎 Redeem</h2>
      <p class="muted">You don't have a manager yet. Once a manager grants you points, you'll be able to redeem your virtual points back to them here.</p>
      <button class="btn primary" id="rd-close">OK</button>`;
  } else {
    card.innerHTML = `
      <h2>💎 Redeem</h2>
      <p class="muted">Manager: <b>${mgr}</b> · Balance: <b>${state.balance.toLocaleString()}</b></p>
      <input id="rd-amount" type="number" placeholder="amount to redeem" style="padding:9px;border-radius:8px;border:2px solid #2e7ea8;background:#02121f;color:#e6f6ff;font-size:16px;text-align:center">
      <div style="display:flex;gap:10px">
        <button class="btn primary" id="rd-submit">Request redeem</button>
        <button class="btn ghost" id="rd-close">Close</button>
      </div>`;
  }
  hud.mini.appendChild(card);
  const close = () => card.remove();
  card.querySelector('#rd-close').onclick = close;
  const cancel = card.querySelector('#rd-cancel');
  if (cancel) cancel.onclick = async () => { await fetch('/api/player/redeem/cancel', { method: 'POST', credentials: 'include' }); close(); banner('Redeem request cancelled'); };
  const submit = card.querySelector('#rd-submit');
  if (submit) submit.onclick = async () => {
    const amt = parseInt(card.querySelector('#rd-amount').value, 10);
    if (!Number.isFinite(amt) || amt <= 0) { banner('enter a positive amount'); return; }
    const r = await fetch('/api/player/redeem', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amt }) });
    const j = await r.json();
    if (!r.ok) { banner(j.error || 'redeem failed'); return; }
    close(); banner('Redeem requested — waiting for ' + mgr);
  };
}

// ============================================================ input
function pointerPos(e) {
  const t = e.touches ? e.touches[0] : e;
  return toGame(t.clientX, t.clientY);
}

canvas.addEventListener('pointerdown', e => {
  SFX.unlock();
  const p = pointerPos(e);
  state.aim = p;
  const tapped = pickFishAt(p.x, p.y);

  // armed power-up: consume the tap as its target
  if (state.aimPowerup && socket) {
    const key = state.aimPowerup;
    const payload = { key };
    if (key === 'laser') {
      if (!tapped) { banner('LASER — tap a fish to target'); return; }
      payload.fishId = tapped.id;
    } else {
      payload.x = Math.round(p.x);
      payload.y = Math.round(p.y);
    }
    socket.emit('usePowerup', payload, (r) => {
      if (r && r.ok) banner('POWER-UP FIRED — ' + key.toUpperCase());
      else banner((r && r.reason) ? 'power-up failed: ' + r.reason : 'power-up failed');
    });
    state.aimPowerup = null;
    refreshPowerupRow();
    return;
  }

  // lock-on: tap a fish to focus fire, tap empty space to clear
  if (tapped) {
    state.lockedFishId = tapped.id;
  } else {
    state.lockedFishId = null;
  }
  state.firing = true;
});
canvas.addEventListener('pointermove', e => { state.aim = pointerPos(e); });
addEventListener('pointerup', () => { state.firing = false; });
canvas.addEventListener('contextmenu', e => e.preventDefault());

function pickFishAt(x, y) {
  let best = null, bestD = 1e9;
  for (const f of state.fish) {
    const d = Math.hypot(f.x - x, f.y - y);
    if (d < f.def.r * 1.6 && d < bestD) { best = f; bestD = d; }
  }
  return best;
}

// ============================================================ bezier (shared with server)
function bezier(p, t) {
  const u = 1 - t;
  return {
    x: u*u*u*p[0].x + 3*u*u*t*p[1].x + 3*u*t*t*p[2].x + t*t*t*p[3].x,
    y: u*u*u*p[0].y + 3*u*u*t*p[1].y + 3*u*t*t*p[2].y + t*t*t*p[3].y,
  };
}
function bezierTangent(p, t) {
  const u = 1 - t;
  return {
    x: 3*u*u*(p[1].x-p[0].x) + 6*u*t*(p[2].x-p[1].x) + 3*t*t*(p[3].x-p[2].x),
    y: 3*u*u*(p[1].y-p[0].y) + 6*u*t*(p[2].y-p[1].y) + 3*t*t*(p[3].y-p[2].y),
  };
}

// ---- server-driven fish spawn ----
function addFishFromServer(s) {
  // server def overrides the client base def (e.g. shielded fish raise armor/mult)
  const base = FISH_BY_ID[s.typeId];
  const def = (s.def && s.def.id) ? Object.assign({}, base || s.def, s.def) : base;
  if (!def) return;
  if (state.fish.some(f => f.id === s.fishId)) return;
  const fish = {
    id: s.fishId, def, path: s.path, age: s.age, dur: s.dur,
    receivedAt: Date.now(),
    x: s.path[0].x, y: s.path[0].y, angle: 0,
    wag: rand(0, 6.28), flash: 0,
    boss: !!def.boss, dying: 0,
    frozenUntil: 0,      // client-side freeze timer
    frozenElapsed: 0,
    currentHp: s.currentHp || 0,
    maxHp: s.maxHp || 0,
  };
  state.fish.push(fish);
  if (def.boss) {
    SFX.bossAlert();
    if (fish.maxHp > 0) {
      state.bossHp = { fishId: fish.id, hp: fish.currentHp, maxHp: fish.maxHp, name: def.name };
    }
  }
}

function removeFish(fishId) {
  const i = state.fish.findIndex(f => f.id === fishId);
  if (i >= 0) state.fish.splice(i, 1);
}

// ============================================================ shooting
function cannonPos() { return { x: W / 2, y: H - 58 }; }

function cannonAngle() {
  const c = cannonPos();
  // if locked onto a fish, aim at it
  if (state.lockedFishId !== null) {
    const locked = state.fish.find(f => f.id === state.lockedFishId);
    if (locked && !locked.dying) {
      const a = Math.atan2(locked.y - c.y, locked.x - c.x);
      return clamp(a, -Math.PI + 0.25, -0.25);
    }
    state.lockedFishId = null; // fish died or left
  }
  const a = Math.atan2(state.aim.y - c.y, state.aim.x - c.x);
  return clamp(a, -Math.PI + 0.25, -0.25);
}

// bet value for a shot at the current weapon level
function shotBet() { return bet() * WEAPON_LEVELS[state.weaponLevel].costMult; }

function tryFire() {
  if (state.fireCooldown > 0) return;
  if (!state.connected || !state.roomReady) { SFX.denied(); state.firing = false; state.auto = false; hud.auto.classList.remove('on'); return; }
  const cost = shotBet();
  if (state.balance < cost) { if (!state.auto) SFX.denied(); state.firing = false; state.auto = false; hud.auto.classList.remove('on'); refreshHUD(); return; }
  state.fireCooldown = FIRE_INTERVAL * WEAPON_LEVELS[state.weaponLevel].fireMult;
  const c = cannonPos();
  const a = cannonAngle();
  const muzzle = 52;
  const wl = WEAPON_LEVELS[state.weaponLevel];
  const bulletR = (13 + state.betIdx * 2) * wl.sizeMult;

  function makeBullet(angle, opts = {}) {
    const volleyId = opts.volleyId || 0;
    state.bullets.push({
      x: c.x + Math.cos(angle) * muzzle,
      y: c.y + Math.sin(angle) * muzzle,
      vx: Math.cos(angle) * BULLET_SPEED,
      vy: Math.sin(angle) * BULLET_SPEED,
      bet: cost,
      weaponLevel: state.weaponLevel,
      bounces: 0,
      r: opts.r || bulletR,
      color: wl.color,
      flick: rand(0, 6.28),
      trail: [],
      owner: true,
      pierceRemaining: opts.pierceRemaining || 0,
      volleyId: volleyId,
      hitFishIds: new Set(),
    });
  }

  const flashColors = [wl.color, '#ff8c1a', '#ff5a1a'];
  function muzzleFlash(ax) {
    for (let i = 0; i < 6; i++) {
      state.particles.push({
        x: c.x + Math.cos(ax) * muzzle, y: c.y + Math.sin(ax) * muzzle,
        vx: Math.cos(ax + rand(-0.5, 0.5)) * rand(80, 260),
        vy: Math.sin(ax + rand(-0.5, 0.5)) * rand(80, 260),
        life: 0.25, maxLife: 0.25, r: rand(2.5, 6), color: flashColors[i % 3],
      });
    }
  }

  if (wl.type === 'spread') {
    const count = wl.spreadCount || 3;
    const halfAngle = wl.spreadAngle || 0.18;
    const vid = state.nextVolleyId++;
    state.volleys.set(vid, { hits: new Set(), weaponLevel: state.weaponLevel, bet: cost, total: count, resolved: 0 });
    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * halfAngle;
      makeBullet(a + offset, { volleyId: vid });
    }
    muzzleFlash(a);
  } else if (wl.type === 'pierce') {
    const vid = state.nextVolleyId++;
    state.volleys.set(vid, { hits: new Set(), weaponLevel: state.weaponLevel, bet: cost, total: 1, resolved: 0 });
    makeBullet(a, { pierceRemaining: wl.pierceTargets || 5, volleyId: vid });
    muzzleFlash(a);
  } else {
    // single, freeze, heavy — one bullet, direct hit
    makeBullet(a);
    muzzleFlash(a);
  }

  SFX.shoot();
  socket.emit('fire', { weaponLevel: state.weaponLevel });
  refreshHUD();
}

// a client-side bullet hits an alive fish
function hitFish(fish, bullet) {
  fish.flash = 0.12;
  SFX.hit();
  state.nets.push({ x: bullet.x, y: bullet.y, r: 10, max: 46 + bullet.bet * 0.6 + fish.def.r * 0.6, life: 0.35, maxLife: 0.35 });

  if (bullet.volleyId && state.volleys.has(bullet.volleyId)) {
    // multi-hit volley (spread/pierce): collect the hit, don't send yet
    const v = state.volleys.get(bullet.volleyId);
    v.hits.add(fish.id);
    if (bullet.pierceRemaining > 0) {
      // pierce: bullet continues, decrement remaining
      bullet.pierceRemaining--;
      if (bullet.pierceRemaining <= 0) {
        // pierce exhausted — remove bullet and flush volley
        bullet.remove = true;
        flushVolley(v, bullet.volleyId);
      }
    } else {
      // spread: bullet stops on hit
      bullet.remove = true;
      v.resolved++;
      if (v.resolved >= v.total) flushVolley(v, bullet.volleyId);
    }
  } else {
    // single/freeze/heavy: direct hit event
    socket.emit('hit', { fishId: fish.id, bet: bullet.bet, weaponLevel: bullet.weaponLevel });
    bullet.remove = true;
  }
}

function flushVolley(v, vid) {
  if (v.hits.size > 0) {
    socket.emit('multiHit', { fishIds: [...v.hits], bet: v.bet, weaponLevel: v.weaponLevel });
  }
  state.volleys.delete(vid);
}

// ---- server-kill handler: drives the credit + the celebration VFX ----
// Only act on kills awarded to THIS player (winnerId); AoE chain visual clears
// the surrounding fish without crediting them (their payout is bundled into one).
function onServerKill(k) {
  const fish = state.fish.find(f => f.id === k.fishId);
  const fx = k.x, fy = k.y;
  const myKill = k.winnerId === myUserId;
  let payout = k.payout;

  if (fish) {
    fish.dying = 0.6;
    fish.betAtKill = k.bet;
  }

  if (myKill) {
    state.totalWin += payout;
    // balance updated separately by the authoritative 'balance' push
    const mult = k.mult || 1;
    const big = mult >= 30;
    if (k.variable) { megaBanner(`${k.name || 'BOSS'} DOWN!  ×${mult}`); SFX.bigWin(); SFX.boom(); }
    else if (fish && fish.boss) { banner((k.name || 'BOSS') + ' DOWN! +' + payout.toLocaleString()); SFX.bigWin(); SFX.boom(); }
    else if (big) { banner('BIG WIN +' + payout.toLocaleString()); SFX.bigWin(); }
    else SFX.kill();

    // fury feeding-frenzy spark on boosted catches
    if (k.fury) state.texts.push({ x: fx + rand(-10, 10), y: fy + 16, text: '⚡', life: 0.6, maxLife: 0.6, big: false });

    // hit-stop + screen shake on big wins
    if (mult >= 50) { state.hitstop = 0.13; state.shakeTime = 0.45; state.shakeAmp = Math.min(26, 8 + mult / 20); }

    // coins fly to the balance counter
    const n = clamp(Math.round(3 + Math.log2(payout + 1)), 4, 18);
    for (let i = 0; i < n; i++) {
      state.coins.push({
        x: fx + rand(-20, 20), y: fy + rand(-20, 20),
        vx: rand(-160, 160), vy: rand(-260, -80),
        t: 0, delay: i * 0.03, r: rand(7, 11), spin: rand(0, 6.28),
      });
      if (i < 6) SFX.coin(i);
    }
    state.texts.push({ x: fx, y: fy - (fish ? fish.def.r : 40), text: '+' + payout.toLocaleString(), life: 1.2, maxLife: 1.2, big: mult >= 30 });
  }

  // splash particles (everyone sees the blast)
  for (let i = 0; i < 14; i++) {
    state.particles.push({
      x: fx, y: fy,
      vx: rand(-220, 220), vy: rand(-220, 220),
      life: rand(0.3, 0.7), maxLife: 0.7, r: rand(2, 5),
      color: i % 2 ? (fish ? fish.def.body : '#ffd54a') : '#ffffff',
    });
  }

  // AoE chain: visually clear the surrounding fish the server reported
  if (k.isAoE && k.chain) {
    SFX.boom();
    state.nets.push({ x: fx, y: fy, r: 20, max: 260, life: 0.5, maxLife: 0.5, bomb: true });
    for (const c of k.chain) {
      const other = state.fish.find(f => f.id === c.fishId);
      if (other) other.dying = 0.4;
      state.particles.push({ x: c.x, y: c.y, vx: rand(-120, 120), vy: rand(-120, 120), life: 0.5, maxLife: 0.5, r: rand(2, 4), color: '#ff8c1a' });
    }
  }

  refreshHUD();
}

// ---- near-miss tease: a close non-kill roll on a big fish ----
function onNearMiss(nm) {
  const fish = state.fish.find(f => f.id === nm.fishId);
  if (!fish) return;
  if (fish.def.mult < 30 && !fish.boss) return;
  fish.flash = 0.18;
  state.nets.push({ x: nm.x, y: nm.y, r: 10, max: 60, life: 0.3, maxLife: 0.3 });
  // brief "escape" speed-burst is purely visual; the server still owns the path
  for (let i = 0; i < 8; i++) {
    state.particles.push({ x: nm.x, y: nm.y, vx: rand(-180, 180), vy: rand(-180, 180), life: 0.4, maxLife: 0.4, r: rand(2, 4), color: '#ffffff' });
  }
}

// ============================================================ update
function update(dt) {
  // hit-stop: freeze gameplay for a beat on huge wins
  if (state.hitstop > 0) { state.hitstop -= dt; dt = Math.min(dt, 0.004); }
  state.time += dt;

  // firing (server rate-caps via the 'fire' ack, but we also bound locally)
  state.fireCooldown -= dt;
  const wantFire = state.firing || state.auto;
  if (wantFire) tryFire();

  // fish movement — server owns the path; we interpolate from age/dur using local time.
  const now = Date.now();
  for (let i = state.fish.length - 1; i >= 0; i--) {
    const f = state.fish[i];
    if (f.dying) {
      f.dying -= dt;
      if (f.dying <= 0) state.fish.splice(i, 1);
      continue;
    }
    // clear lock if fish is dead
    if (state.lockedFishId === f.id && (f.dying || f.def.r === undefined)) {
      state.lockedFishId = null;
    }
    // frozen fish don't move client-side
    if (f.frozenUntil > now) {
      f.wag += dt * 2; // slow idle wiggle
      if (f.flash > 0) f.flash -= dt;
      continue;
    }
    if (f.frozenUntil) {
      // Resume from the same path point at which the server froze this fish.
      f.age = f.frozenElapsed;
      f.receivedAt = now;
      f.frozenUntil = 0;
    }
    // unfrozen: compute position from age
    const elapsed = f.age + (now - f.receivedAt);
    const t = elapsed / f.dur;
    if (t >= 1.05) { state.fish.splice(i, 1); continue; }
    const tc = clamp(t, 0, 1);
    const pos = bezier(f.path, tc);
    const tan = bezierTangent(f.path, tc);
    f.x = pos.x; f.y = pos.y;
    f.angle = Math.atan2(tan.y, tan.x);
    f.wag += dt * (6 + f.def.speed / 30);
    if (f.flash > 0) f.flash -= dt;
  }

  // bullets (client-authoritative for feel; hits validated server-side)
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    const b = state.bullets[i];
    b.trail.push({ x: b.x, y: b.y });
    if (b.trail.length > 10) b.trail.shift();
    b.x += b.vx * dt;
    b.y += b.vy * dt;

    // embers peeling off the fireball
    if (Math.random() < 0.4) {
      state.particles.push({
        x: b.x + rand(-4, 4), y: b.y + rand(-4, 4),
        vx: -b.vx * 0.06 + rand(-35, 35), vy: -b.vy * 0.06 + rand(-35, 35),
        life: rand(0.2, 0.4), maxLife: 0.4, r: rand(1.5, 3.5),
        color: Math.random() < 0.5 ? '#ff8c1a' : '#ffd54a',
      });
    }

    // wall bounce
    let bounced = false;
    if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); bounced = true; }
    if (b.x > W - b.r) { b.x = W - b.r; b.vx = -Math.abs(b.vx); bounced = true; }
    if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); bounced = true; }
    if (bounced && ++b.bounces > MAX_BOUNCES) {
      // volley bullet expired on bounce limit
      if (b.volleyId && state.volleys.has(b.volleyId)) {
        const v = state.volleys.get(b.volleyId);
        v.resolved++;
        if (v.resolved >= v.total) flushVolley(v, b.volleyId);
      }
      state.bullets.splice(i, 1); continue;
    }
    if (b.y > H + 40) {
      if (b.volleyId && state.volleys.has(b.volleyId)) {
        const v = state.volleys.get(b.volleyId);
        v.resolved++;
        if (v.resolved >= v.total) flushVolley(v, b.volleyId);
      }
      state.bullets.splice(i, 1); continue;
    }

    // bullet marked for removal by hitFish (pierce exhausted)
    if (b.remove) { state.bullets.splice(i, 1); continue; }

    // collision with an alive fish -> notify server (it does the death check)
    for (const f of state.fish) {
      if (f.dying) continue;
      if (b.hitFishIds.has(f.id)) continue;
      if (Math.hypot(f.x - b.x, f.y - b.y) < f.def.r + b.r) {
        b.hitFishIds.add(f.id);
        hitFish(f, b);
        if (b.remove) { state.bullets.splice(i, 1); }
        break;
      }
    }
  }

  // nets
  for (let i = state.nets.length - 1; i >= 0; i--) {
    const n = state.nets[i];
    n.life -= dt;
    n.r = n.max * (1 - n.life / n.maxLife);
    if (n.life <= 0) state.nets.splice(i, 1);
  }

  // coins fly to the balance panel (bottom-left)
  const sink = { x: 200, y: H - 40 };
  for (let i = state.coins.length - 1; i >= 0; i--) {
    const c = state.coins[i];
    if (c.delay > 0) { c.delay -= dt; continue; }
    c.t += dt;
    if (c.t < 0.35) {
      c.x += c.vx * dt; c.y += c.vy * dt; c.vy += 500 * dt;
    } else {
      const k = Math.min(1, (c.t - 0.35) * 3.2);
      c.x += (sink.x - c.x) * k * dt * 8;
      c.y += (sink.y - c.y) * k * dt * 8;
      if (Math.hypot(c.x - sink.x, c.y - sink.y) < 26) state.coins.splice(i, 1);
    }
    c.spin += dt * 10;
  }

  // floating win text
  for (let i = state.texts.length - 1; i >= 0; i--) {
    const t = state.texts[i];
    t.life -= dt;
    t.y -= 36 * dt;
    if (t.life <= 0) state.texts.splice(i, 1);
  }

  // particles
  for (let i = state.particles.length - 1; i >= 0; i--) {
    const p = state.particles[i];
    p.life -= dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 0.96; p.vy *= 0.96;
    if (p.life <= 0) state.particles.splice(i, 1);
  }

  // ambient bubbles
  for (const bb of state.bubbles) {
    bb.y -= bb.v * dt;
    bb.drift += dt;
    if (bb.y < -10) { bb.y = H + 10; bb.x = rand(0, W); }
  }

  // screen-shake decay
  if (state.shakeTime > 0) state.shakeTime -= dt;

  // odometer: displayBalance ticks toward the authoritative balance
  if (state.displayBalance !== state.balance) {
    const diff = state.balance - state.displayBalance;
    const step = Math.sign(diff) * Math.max(1, Math.ceil(Math.abs(diff) * dt * 6));
    if (Math.abs(diff) <= Math.abs(step)) state.displayBalance = state.balance;
    else state.displayBalance += step;
    refreshHUD();
  }
}

// ============================================================ painters
function paintFish(def, wag) {
  const r = def.r;
  // tail
  g.save();
  g.translate(-r * 0.9, 0);
  g.rotate(Math.sin(wag) * 0.4);
  g.fillStyle = def.fin;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(-r * 0.85, -r * 0.55);
  g.quadraticCurveTo(-r * 0.55, 0, -r * 0.85, r * 0.55);
  g.closePath();
  g.fill();
  g.restore();

  // sword nose
  if (def.nose) {
    g.fillStyle = def.fin;
    g.beginPath();
    g.moveTo(r * 0.8, -r * 0.1);
    g.lineTo(r * 1.9, 0);
    g.lineTo(r * 0.8, r * 0.1);
    g.closePath();
    g.fill();
  }

  // body
  const grad = g.createLinearGradient(0, -r, 0, r);
  grad.addColorStop(0, def.body);
  grad.addColorStop(0.65, def.body);
  grad.addColorStop(1, def.belly);
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(0, 0, r, r * 0.62, 0, 0, Math.PI * 2);
  g.fill();

  if (def.glow) {
    g.save();
    g.globalAlpha = 0.55 + 0.35 * Math.sin(wag * 2);
    g.shadowColor = '#ffdf60';
    g.shadowBlur = 24;
    g.strokeStyle = '#fff3b0';
    g.lineWidth = 2;
    g.beginPath();
    g.ellipse(0, 0, r, r * 0.62, 0, 0, Math.PI * 2);
    g.stroke();
    g.restore();
  }

  // stripes
  g.fillStyle = def.stripe;
  g.globalAlpha = 0.85;
  for (const sx of [-r * 0.35, r * 0.05, r * 0.45]) {
    g.beginPath();
    g.ellipse(sx, 0, r * 0.09, r * 0.5, 0, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;

  // dorsal fin
  g.fillStyle = def.fin;
  g.beginPath();
  g.moveTo(-r * 0.4, -r * 0.5);
  g.quadraticCurveTo(0, -r * 1.05, r * 0.35, -r * 0.5);
  g.closePath();
  g.fill();

  // pectoral fin, wagging
  g.save();
  g.translate(r * 0.05, r * 0.2);
  g.rotate(Math.sin(wag + 1) * 0.3 + 0.5);
  g.beginPath();
  g.moveTo(0, 0);
  g.quadraticCurveTo(-r * 0.5, r * 0.4, -r * 0.15, r * 0.55);
  g.closePath();
  g.fill();
  g.restore();

  paintEye(r * 0.55, -r * 0.15, r * 0.13);
}

function paintEye(x, y, r) {
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#101820';
  g.beginPath(); g.arc(x + r * 0.25, y, r * 0.55, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(x + r * 0.4, y - r * 0.3, r * 0.2, 0, Math.PI * 2); g.fill();
}

function paintPuffer(def, wag) {
  const r = def.r * (1 + 0.08 * Math.sin(wag * 0.7));
  // spikes
  g.strokeStyle = def.stripe;
  g.lineWidth = 3;
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    g.beginPath();
    g.moveTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85);
    g.lineTo(Math.cos(a) * r * 1.15, Math.sin(a) * r * 1.15);
    g.stroke();
  }
  const grad = g.createRadialGradient(-r * 0.2, -r * 0.3, r * 0.2, 0, 0, r);
  grad.addColorStop(0, def.belly);
  grad.addColorStop(1, def.body);
  g.fillStyle = grad;
  g.beginPath(); g.arc(0, 0, r * 0.9, 0, Math.PI * 2); g.fill();
  // tail
  g.fillStyle = def.fin;
  g.beginPath();
  g.moveTo(-r * 0.8, 0);
  g.lineTo(-r * 1.3, -r * 0.35);
  g.lineTo(-r * 1.3, r * 0.35);
  g.closePath(); g.fill();
  paintEye(r * 0.4, -r * 0.2, r * 0.14);
  // mouth
  g.strokeStyle = def.stripe;
  g.lineWidth = 2;
  g.beginPath(); g.arc(r * 0.55, r * 0.15, r * 0.15, 0.2, Math.PI - 0.2); g.stroke();
}

function paintTurtle(def, wag) {
  const r = def.r;
  // flippers
  g.fillStyle = def.fin;
  for (const [fx, fy, base] of [[r*0.35, -r*0.55, -0.6], [r*0.35, r*0.55, 0.6], [-r*0.5, -r*0.5, -2.4], [-r*0.5, r*0.5, 2.4]]) {
    g.save();
    g.translate(fx, fy);
    g.rotate(base + Math.sin(wag) * 0.35);
    g.beginPath();
    g.ellipse(r * 0.3, 0, r * 0.38, r * 0.16, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  // head
  g.fillStyle = def.fin;
  g.beginPath(); g.ellipse(r * 0.85, 0, r * 0.28, r * 0.2, 0, 0, Math.PI * 2); g.fill();
  paintEye(r * 0.95, -r * 0.06, r * 0.07);
  // shell
  const grad = g.createRadialGradient(-r*0.15, -r*0.2, r*0.2, 0, 0, r*0.85);
  grad.addColorStop(0, def.body);
  grad.addColorStop(1, def.stripe);
  g.fillStyle = grad;
  g.beginPath(); g.ellipse(0, 0, r * 0.8, r * 0.62, 0, 0, Math.PI * 2); g.fill();
  // shell pattern
  g.strokeStyle = def.belly;
  g.lineWidth = 2;
  g.globalAlpha = 0.6;
  g.beginPath(); g.ellipse(0, 0, r * 0.5, r * 0.36, 0, 0, Math.PI * 2); g.stroke();
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.beginPath();
    g.moveTo(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.36);
    g.lineTo(Math.cos(a) * r * 0.8, Math.sin(a) * r * 0.6);
    g.stroke();
  }
  g.globalAlpha = 1;
}

// Emerald Serpent-Stingray — jade wings edged in gold, long serpent tail with a blade tip
function paintSerpentRay(def, wag) {
  const r = def.r;
  const flap = Math.sin(wag) * 0.5;

  // serpent tail: sinuous gold-edged whip ending in a blade
  const tipX = -r * 2.0, tipY = Math.sin(wag * 0.8 + 1) * r * 0.35 - r * 0.3;
  g.strokeStyle = def.body;
  g.lineWidth = r * 0.11;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(-r * 0.8, 0);
  g.bezierCurveTo(-r * 1.4, Math.sin(wag * 0.8) * r * 0.4, -r * 1.5, tipY + r * 0.5, tipX, tipY);
  g.stroke();
  g.strokeStyle = def.stripe;
  g.lineWidth = r * 0.04;
  g.stroke();
  g.lineCap = 'butt';
  // blade tip
  g.fillStyle = def.stripe;
  g.beginPath();
  g.moveTo(tipX, tipY);
  g.lineTo(tipX - r * 0.28, tipY - r * 0.16);
  g.lineTo(tipX - r * 0.18, tipY + r * 0.1);
  g.closePath();
  g.fill();

  // wings
  const grad = g.createLinearGradient(0, -r, 0, r);
  grad.addColorStop(0, def.body);
  grad.addColorStop(1, def.fin);
  g.fillStyle = grad;
  g.beginPath();
  g.moveTo(r * 0.7, 0);
  g.quadraticCurveTo(0, -r * (1.1 + flap * 0.5), -r * 0.9, -r * (0.25 + flap * 0.3));
  g.quadraticCurveTo(-r * 0.4, 0, -r * 0.9, r * (0.25 - flap * 0.3));
  g.quadraticCurveTo(0, r * (1.1 - flap * 0.5), r * 0.7, 0);
  g.closePath();
  g.fill();
  // gilded wing edges
  g.strokeStyle = def.stripe;
  g.lineWidth = 2.5;
  g.globalAlpha = 0.85;
  g.beginPath();
  g.moveTo(r * 0.7, 0);
  g.quadraticCurveTo(0, -r * (1.1 + flap * 0.5), -r * 0.9, -r * (0.25 + flap * 0.3));
  g.stroke();
  g.beginPath();
  g.moveTo(r * 0.7, 0);
  g.quadraticCurveTo(0, r * (1.1 - flap * 0.5), -r * 0.9, r * (0.25 - flap * 0.3));
  g.stroke();
  g.globalAlpha = 1;

  // dorsal thorns along the spine
  g.fillStyle = def.stripe;
  for (let i = 0; i < 4; i++) {
    const sx = r * 0.35 - i * r * 0.32;
    g.beginPath();
    g.moveTo(sx - r * 0.08, -r * 0.05);
    g.lineTo(sx, -r * 0.3 - i * r * 0.02);
    g.lineTo(sx + r * 0.08, -r * 0.05);
    g.closePath();
    g.fill();
  }

  // filigree scale glints
  g.fillStyle = def.belly;
  g.globalAlpha = 0.6;
  for (const [sx, sy] of [[0.1, -0.35], [-0.25, -0.15], [0.05, 0.3], [-0.3, 0.25], [0.3, -0.05]]) {
    g.beginPath(); g.arc(sx * r, sy * r, r * 0.055, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;

  // gold horn crest over the brow
  g.strokeStyle = def.stripe;
  g.lineWidth = 3.5;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(r * 0.45, -r * 0.2);
  g.quadraticCurveTo(r * 0.75, -r * 0.5, r * 0.95, -r * 0.42);
  g.stroke();
  g.lineCap = 'butt';

  // glowing emerald eye
  g.save();
  g.shadowColor = '#7dffb0';
  g.shadowBlur = 10;
  g.fillStyle = '#c8ffdc';
  g.beginPath(); g.arc(r * 0.45, -r * 0.1, r * 0.09, 0, Math.PI * 2); g.fill();
  g.restore();
  g.fillStyle = '#0a4a24';
  g.beginPath(); g.arc(r * 0.47, -r * 0.1, r * 0.045, 0, Math.PI * 2); g.fill();
}

function paintShark(def, wag) {
  const r = def.r;
  // tail
  g.save();
  g.translate(-r * 0.95, 0);
  g.rotate(Math.sin(wag) * 0.3);
  g.fillStyle = def.fin;
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(-r * 0.6, -r * 0.6);
  g.lineTo(-r * 0.35, 0);
  g.lineTo(-r * 0.55, r * 0.4);
  g.closePath();
  g.fill();
  g.restore();

  // body (long)
  const grad = g.createLinearGradient(0, -r * 0.6, 0, r * 0.6);
  grad.addColorStop(0, def.body);
  grad.addColorStop(0.6, def.body);
  grad.addColorStop(1, def.belly);
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(0, 0, r * 1.15, r * 0.48, 0, 0, Math.PI * 2);
  g.fill();

  // hammer head
  if (def.hammer) {
    g.fillStyle = def.body;
    g.beginPath();
    g.ellipse(r * 1.05, 0, r * 0.18, r * 0.5, 0, 0, Math.PI * 2);
    g.fill();
    paintEye(r * 1.05, -r * 0.42, r * 0.08);
    paintEye(r * 1.05, r * 0.42, r * 0.08);
  } else {
    paintEye(r * 0.7, -r * 0.14, r * 0.09);
    // gills
    g.strokeStyle = def.stripe;
    g.lineWidth = 2;
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(r * 0.35 - i * r * 0.12, 0, r * 0.28, -0.9, 0.9);
      g.stroke();
    }
    // teeth grin
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2.5;
    g.beginPath(); g.arc(r * 0.72, r * 0.16, r * 0.22, 0.3, 1.4); g.stroke();
  }

  // dorsal fin
  g.fillStyle = def.fin;
  g.beginPath();
  g.moveTo(-r * 0.25, -r * 0.4);
  g.quadraticCurveTo(0, -r * 1.0, r * 0.3, -r * 0.42);
  g.closePath();
  g.fill();
  // tiger stripes
  if (!def.hammer) {
    g.strokeStyle = def.stripe;
    g.lineWidth = 3;
    g.globalAlpha = 0.5;
    for (let i = -2; i <= 2; i++) {
      g.beginPath();
      g.moveTo(i * r * 0.25, -r * 0.42);
      g.quadraticCurveTo(i * r * 0.25 + r * 0.08, 0, i * r * 0.25, r * 0.3);
      g.stroke();
    }
    g.globalAlpha = 1;
  }
}

function paintCrab(def, wag) {
  const r = def.r;
  // legs
  g.strokeStyle = def.fin;
  g.lineWidth = 4;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const a = side * (0.5 + i * 0.4) + Math.sin(wag + i) * 0.1;
      g.beginPath();
      g.moveTo(0, side * r * 0.4);
      g.lineTo(Math.sin(a) * r * 0.9 * -0.3, side * r * (0.75 + i * 0.12));
      g.lineTo(Math.sin(a) * r * 0.4 - r * 0.4, side * r * (1.0 + i * 0.1));
      g.stroke();
    }
  }
  // claws
  for (const side of [-1, 1]) {
    g.save();
    g.translate(r * 0.6, side * r * 0.55);
    g.rotate(side * Math.sin(wag * 1.5) * 0.2);
    g.fillStyle = def.fin;
    g.beginPath(); g.ellipse(r * 0.25, 0, r * 0.3, r * 0.2, side * 0.4, 0, Math.PI * 2); g.fill();
    g.fillStyle = def.body;
    g.beginPath();
    g.moveTo(r * 0.45, -r * 0.12 * side);
    g.lineTo(r * 0.7, -r * 0.3 * side);
    g.lineTo(r * 0.55, 0);
    g.closePath(); g.fill();
    g.restore();
  }
  // body
  const grad = g.createRadialGradient(-r*0.15, -r*0.15, r*0.1, 0, 0, r*0.75);
  grad.addColorStop(0, def.belly);
  grad.addColorStop(1, def.body);
  g.fillStyle = grad;
  g.beginPath(); g.ellipse(0, 0, r * 0.72, r * 0.55, 0, 0, Math.PI * 2); g.fill();
  // bomb mark
  g.fillStyle = '#20140e';
  g.beginPath(); g.arc(0, 0, r * 0.26, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#ffd54a';
  g.lineWidth = 2.5;
  g.beginPath(); g.moveTo(r * 0.05, -r * 0.24); g.quadraticCurveTo(r * 0.22, -r * 0.42, r * 0.16, -r * 0.5); g.stroke();
  g.fillStyle = '#ff7a20';
  g.beginPath(); g.arc(r * 0.16, -r * 0.52, r * 0.07, 0, Math.PI * 2); g.fill();
  paintEye(r * 0.35, -r * 0.35, r * 0.1);
  paintEye(r * 0.35, r * 0.35, r * 0.1);
}

function paintWhale(def, wag) {
  const r = def.r;
  // tail
  g.save();
  g.translate(-r * 0.95, 0);
  g.rotate(Math.sin(wag * 0.8) * 0.2);
  g.fillStyle = def.fin;
  g.beginPath();
  g.moveTo(0, 0);
  g.quadraticCurveTo(-r * 0.35, -r * 0.45, -r * 0.6, -r * 0.35);
  g.quadraticCurveTo(-r * 0.3, 0, -r * 0.6, r * 0.35);
  g.quadraticCurveTo(-r * 0.35, r * 0.45, 0, 0);
  g.fill();
  g.restore();
  // body
  const grad = g.createLinearGradient(0, -r * 0.6, 0, r * 0.6);
  grad.addColorStop(0, def.body);
  grad.addColorStop(0.7, def.body);
  grad.addColorStop(1, def.belly);
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(0, 0, r * 1.05, r * 0.58, 0, 0, Math.PI * 2);
  g.fill();
  // belly grooves
  g.strokeStyle = def.stripe;
  g.globalAlpha = 0.4;
  g.lineWidth = 2;
  for (let i = 0; i < 4; i++) {
    g.beginPath();
    g.arc(r * 0.1, r * 2.1 - i * r * 0.09, r * 1.75 - i * r * 0.07, -1.95, -1.2);
    g.stroke();
  }
  g.globalAlpha = 1;
  // fin
  g.fillStyle = def.fin;
  g.save();
  g.translate(r * 0.1, r * 0.3);
  g.rotate(0.5 + Math.sin(wag) * 0.15);
  g.beginPath(); g.ellipse(0, r * 0.18, r * 0.4, r * 0.15, 0.3, 0, Math.PI * 2); g.fill();
  g.restore();
  paintEye(r * 0.72, -r * 0.05, r * 0.09);
  // spout bubbles
  if (Math.sin(wag * 0.5) > 0.7) {
    g.fillStyle = 'rgba(255,255,255,0.5)';
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      g.arc(r * 0.3 + rand(-4, 4), -r * (0.75 + i * 0.18), 3 + i, 0, Math.PI * 2);
      g.fill();
    }
  }
}

// Neon Coral Mandarinfish — psychedelic orange-on-blue swirls, huge fan fins
function paintMandarin(def, wag) {
  const r = def.r;

  // flowing round tail fan
  g.save();
  g.translate(-r * 0.7, 0);
  g.rotate(Math.sin(wag) * 0.3);
  const tg = g.createRadialGradient(0, 0, r * 0.1, 0, 0, r * 0.9);
  tg.addColorStop(0, def.stripe);
  tg.addColorStop(1, def.fin);
  g.fillStyle = tg;
  g.beginPath();
  g.moveTo(0, 0);
  g.quadraticCurveTo(-r * 1.1, -r * 0.75, -r * 0.85, 0);
  g.quadraticCurveTo(-r * 1.1, r * 0.75, 0, 0);
  g.fill();
  // tail ribs
  g.strokeStyle = def.body;
  g.lineWidth = 1.5;
  g.globalAlpha = 0.5;
  for (const ry of [-0.35, 0, 0.35]) {
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(-r * 0.5, ry * r, -r * 0.9, ry * r * 1.4);
    g.stroke();
  }
  g.globalAlpha = 1;
  g.restore();

  // dorsal fan with trailing filament
  g.fillStyle = def.fin;
  g.beginPath();
  g.moveTo(-r * 0.45, -r * 0.45);
  g.quadraticCurveTo(-r * 0.1, -r * 1.15, r * 0.4, -r * 0.45);
  g.closePath();
  g.fill();
  g.strokeStyle = def.stripe;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(r * 0.3, -r * 0.6);
  g.quadraticCurveTo(r * 0.8, -r * (1.0 + Math.sin(wag) * 0.1), r * 1.15, -r * 0.85);
  g.stroke();

  // plump body
  const grad = g.createLinearGradient(0, -r, 0, r);
  grad.addColorStop(0, def.body);
  grad.addColorStop(1, def.belly);
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(0, 0, r, r * 0.68, 0, 0, Math.PI * 2);
  g.fill();

  // psychedelic swirl stripes
  g.save();
  g.beginPath();
  g.ellipse(0, 0, r, r * 0.68, 0, 0, Math.PI * 2);
  g.clip();
  g.strokeStyle = def.fin;
  g.lineWidth = r * 0.12;
  g.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const sx = -r * 0.62 + i * r * 0.4;
    g.beginPath();
    g.moveTo(sx, -r * 0.55);
    g.bezierCurveTo(sx + r * 0.32, -r * 0.15, sx - r * 0.32, r * 0.15, sx + r * 0.18, r * 0.55);
    g.stroke();
  }
  g.strokeStyle = def.stripe;
  g.lineWidth = r * 0.04;
  for (let i = 0; i < 4; i++) {
    const sx = -r * 0.62 + i * r * 0.4;
    g.beginPath();
    g.moveTo(sx, -r * 0.55);
    g.bezierCurveTo(sx + r * 0.32, -r * 0.15, sx - r * 0.32, r * 0.15, sx + r * 0.18, r * 0.55);
    g.stroke();
  }
  g.lineCap = 'butt';
  g.restore();

  // pectoral fan
  g.save();
  g.translate(r * 0.1, r * 0.22);
  g.rotate(Math.sin(wag + 1) * 0.3 + 0.5);
  g.fillStyle = def.fin;
  g.beginPath();
  g.moveTo(0, 0);
  g.quadraticCurveTo(-r * 0.55, r * 0.45, -r * 0.15, r * 0.6);
  g.closePath();
  g.fill();
  g.restore();

  paintEye(r * 0.58, -r * 0.16, r * 0.13);
}

// Gilded Octo-Mage — jeweled purple octopus conjuring an arcane orb
function paintOcto(def, wag, t) {
  const r = def.r;

  // six trailing tentacles with curled tips
  g.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const spread = (i - 2.5) * 0.32;
    const sw = Math.sin(wag + i * 1.25) * r * 0.22;
    const ex = -r * (0.75 + (i % 3) * 0.22);
    const ey = spread * r * 0.9 + sw;
    g.strokeStyle = i % 2 ? def.fin : def.body;
    g.lineWidth = r * 0.15 - i * r * 0.008;
    g.beginPath();
    g.moveTo(-r * 0.1, spread * r * 0.28);
    g.quadraticCurveTo(-r * 0.55, spread * r * 0.7 + sw * 0.5, ex, ey);
    g.stroke();
    // curl at the tip
    g.lineWidth = r * 0.07;
    g.beginPath();
    g.arc(ex - r * 0.06, ey, r * 0.12, spread > 0 ? -1.2 : 1.2, spread > 0 ? 2.4 : -2.4, spread <= 0);
    g.stroke();
    // suckers
    g.fillStyle = def.belly;
    g.globalAlpha = 0.7;
    for (let s = 1; s <= 3; s++) {
      const k = s / 4;
      const px = (-r * 0.1) * (1 - k) + ex * k;
      const py = (spread * r * 0.28) * (1 - k) + ey * k + sw * 0.2;
      g.beginPath(); g.arc(px, py, r * 0.03, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
  }
  g.lineCap = 'butt';

  // mantle dome
  const grad = g.createRadialGradient(-r * 0.15, -r * 0.45, r * 0.15, 0, -r * 0.15, r * 0.85);
  grad.addColorStop(0, def.belly);
  grad.addColorStop(1, def.body);
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(0, -r * 0.15, r * 0.68, r * 0.62, 0, 0, Math.PI * 2);
  g.fill();

  // gold filigree swirls on the mantle
  g.strokeStyle = def.stripe;
  g.lineWidth = 2;
  g.globalAlpha = 0.8;
  for (const [cx, cy, cr] of [[-0.25, -0.45, 0.14], [0.2, -0.55, 0.1], [-0.05, -0.15, 0.11]]) {
    g.beginPath();
    g.arc(cx * r, cy * r, cr * r, 0.5, 5.5);
    g.stroke();
  }
  g.globalAlpha = 1;

  // sapphire brow gem
  g.save();
  g.shadowColor = '#48c8ff';
  g.shadowBlur = 12;
  g.fillStyle = '#48c8ff';
  g.beginPath();
  g.moveTo(r * 0.05, -r * 0.78);
  g.lineTo(r * 0.17, -r * 0.62);
  g.lineTo(r * 0.05, -r * 0.46);
  g.lineTo(-r * 0.07, -r * 0.62);
  g.closePath();
  g.fill();
  g.restore();
  g.strokeStyle = def.stripe;
  g.lineWidth = 1.5;
  g.stroke();

  // large arcane eye with gold iris
  g.fillStyle = '#f5ecff';
  g.beginPath(); g.arc(r * 0.3, -r * 0.12, r * 0.17, 0, Math.PI * 2); g.fill();
  g.fillStyle = def.stripe;
  g.beginPath(); g.arc(r * 0.34, -r * 0.12, r * 0.11, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#1a0830';
  g.beginPath(); g.arc(r * 0.34, -r * 0.12, r * 0.055, 0, Math.PI * 2); g.fill();

  // conjured orb pulsing in front
  const pulse = 0.85 + 0.15 * Math.sin(t * 5 + wag);
  g.save();
  g.globalCompositeOperation = 'lighter';
  const orb = g.createRadialGradient(r * 0.95, r * 0.15, 1, r * 0.95, r * 0.15, r * 0.34 * pulse);
  orb.addColorStop(0, 'rgba(255,240,255,0.95)');
  orb.addColorStop(0.5, 'rgba(200,107,255,0.8)');
  orb.addColorStop(1, 'rgba(120,40,220,0)');
  g.fillStyle = orb;
  g.beginPath(); g.arc(r * 0.95, r * 0.15, r * 0.34 * pulse, 0, Math.PI * 2); g.fill();
  g.restore();
  // tentacle cradling the orb
  g.strokeStyle = def.fin;
  g.lineWidth = r * 0.11;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(r * 0.25, r * 0.35);
  g.quadraticCurveTo(r * 0.75, r * 0.55, r * 0.95, r * 0.32);
  g.stroke();
  g.lineCap = 'butt';
}

// Thunder-Crest Hammerhead — armored shark wreathed in crackling lightning
function paintThunderShark(def, wag, t) {
  paintShark(def, wag);
  const r = def.r;

  // gold armor trim along the flank
  g.strokeStyle = def.stripe;
  g.lineWidth = 3;
  g.globalAlpha = 0.9;
  g.beginPath();
  g.moveTo(-r * 0.9, -r * 0.05);
  g.quadraticCurveTo(0, -r * 0.28, r * 0.85, -r * 0.05);
  g.stroke();
  // lightning-bolt sigil on the flank
  g.fillStyle = def.stripe;
  g.beginPath();
  g.moveTo(-r * 0.05, -r * 0.28);
  g.lineTo(-r * 0.22, r * 0.02);
  g.lineTo(-r * 0.08, r * 0.02);
  g.lineTo(-r * 0.28, r * 0.3);
  g.lineTo(0, r * 0.05);
  g.lineTo(-r * 0.12, r * 0.05);
  g.closePath();
  g.fill();
  g.globalAlpha = 1;

  // crackling arcs, flickering with time
  const flicker = 0.35 + 0.6 * Math.abs(Math.sin(t * 13 + wag));
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.globalAlpha = flicker;
  g.strokeStyle = '#9fd8ff';
  g.lineWidth = 2;
  const arcs = [
    [r * 0.1, -r * 0.85, 1], [r * 0.9, r * 0.35, 2], [-r * 0.8, -r * 0.4, 3],
  ];
  for (const [ax, ay, seed] of arcs) {
    g.beginPath();
    g.moveTo(ax, ay);
    let px = ax, py = ay;
    for (let s = 1; s <= 3; s++) {
      px += Math.sin(t * 31 + seed * 7 + s * 5) * r * 0.18 + r * 0.1;
      py += Math.cos(t * 27 + seed * 11 + s * 3) * r * 0.16 - r * 0.08;
      g.lineTo(px, py);
    }
    g.stroke();
  }
  g.restore();

  // glowing storm eyes on the hammer
  g.save();
  g.shadowColor = '#ffb03c';
  g.shadowBlur = 10;
  g.fillStyle = '#ffcf4a';
  g.beginPath(); g.arc(r * 1.05, -r * 0.42, r * 0.07, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(r * 1.05, r * 0.42, r * 0.07, 0, Math.PI * 2); g.fill();
  g.restore();
}

// Emperor Dragon-Koi — crimson-gold koi with a dragon's crest and fins of living flame
function paintDragonKoi(def, wag, t) {
  const r = def.r;

  // flame tail: three additive fire tongues
  g.save();
  g.globalCompositeOperation = 'lighter';
  for (let i = -1; i <= 1; i++) {
    g.save();
    g.translate(-r * 0.8, 0);
    g.rotate(i * 0.42 + Math.sin(wag + i) * 0.18);
    const fg = g.createLinearGradient(0, 0, -r * 1.5, 0);
    fg.addColorStop(0, 'rgba(255,220,120,0.85)');
    fg.addColorStop(0.6, 'rgba(255,120,20,0.5)');
    fg.addColorStop(1, 'rgba(255,50,0,0)');
    g.fillStyle = fg;
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(-r * 0.7, -r * 0.32, -r * 1.5, Math.sin(wag * 2 + i * 2) * r * 0.18);
    g.quadraticCurveTo(-r * 0.7, r * 0.32, 0, 0);
    g.fill();
    g.restore();
  }
  // flame dorsal crest
  const dg2 = g.createLinearGradient(0, -r * 0.4, 0, -r * 1.3);
  dg2.addColorStop(0, 'rgba(255,180,60,0.8)');
  dg2.addColorStop(1, 'rgba(255,80,0,0)');
  g.fillStyle = dg2;
  g.beginPath();
  g.moveTo(-r * 0.55, -r * 0.4);
  g.quadraticCurveTo(-r * 0.25, -r * (1.2 + Math.sin(wag * 2) * 0.1), 0, -r * 0.45);
  g.quadraticCurveTo(r * 0.25, -r * (1.05 + Math.sin(wag * 2 + 1) * 0.1), r * 0.45, -r * 0.4);
  g.closePath();
  g.fill();
  g.restore();

  // body with ember glow
  g.save();
  g.shadowColor = '#ff9a2a';
  g.shadowBlur = 16;
  const grad = g.createLinearGradient(0, -r * 0.65, 0, r * 0.65);
  grad.addColorStop(0, def.body);
  grad.addColorStop(0.6, def.fin);
  grad.addColorStop(1, def.belly);
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(0, 0, r, r * 0.58, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();

  // gold scale rows
  g.strokeStyle = def.stripe;
  g.lineWidth = 1.8;
  g.globalAlpha = 0.55;
  for (let row = -1; row <= 1; row++) {
    for (let cx = -0.65; cx <= 0.5; cx += 0.23) {
      g.beginPath();
      g.arc(cx * r, row * r * 0.26, r * 0.13, 0.4, Math.PI - 0.4);
      g.stroke();
    }
  }
  g.globalAlpha = 1;

  // antler horns
  g.strokeStyle = def.stripe;
  g.lineWidth = 4;
  g.lineCap = 'round';
  g.beginPath();
  g.moveTo(r * 0.35, -r * 0.4);
  g.quadraticCurveTo(r * 0.15, -r * 0.85, -r * 0.1, -r * 0.95);
  g.stroke();
  g.beginPath();
  g.moveTo(r * 0.22, -r * 0.68);
  g.lineTo(r * 0.38, -r * 0.88);
  g.stroke();

  // flowing whiskers
  g.lineWidth = 2.5;
  g.beginPath();
  g.moveTo(r * 0.95, r * 0.05);
  g.quadraticCurveTo(r * 1.4, -r * 0.1 + Math.sin(wag * 1.3) * 7, r * 1.65, r * 0.2);
  g.stroke();
  g.beginPath();
  g.moveTo(r * 0.9, r * 0.2);
  g.quadraticCurveTo(r * 1.3, r * 0.35 + Math.sin(wag * 1.3 + 1) * 7, r * 1.5, r * 0.55);
  g.stroke();
  g.lineCap = 'butt';

  // snout + fangs
  g.fillStyle = def.body;
  g.beginPath();
  g.ellipse(r * 0.85, r * 0.06, r * 0.28, r * 0.18, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#fff3d0';
  g.beginPath();
  g.moveTo(r * 0.95, r * 0.18); g.lineTo(r * 0.99, r * 0.3); g.lineTo(r * 1.03, r * 0.18);
  g.closePath();
  g.fill();

  // blazing gold eye
  g.save();
  g.shadowColor = '#ffcf4a';
  g.shadowBlur = 12;
  g.fillStyle = '#ffe98a';
  g.beginPath(); g.arc(r * 0.55, -r * 0.14, r * 0.11, 0, Math.PI * 2); g.fill();
  g.restore();
  g.fillStyle = '#802000';
  g.beginPath(); g.arc(r * 0.58, -r * 0.14, r * 0.05, 0, Math.PI * 2); g.fill();

  // ember motes drifting off the crest
  g.fillStyle = 'rgba(255,170,60,0.7)';
  for (let i = 0; i < 3; i++) {
    const mx = -r * 0.3 + i * r * 0.35 + Math.sin(t * 3 + i * 2) * r * 0.1;
    const my = -r * (0.9 + 0.25 * ((t * 0.7 + i * 0.33) % 1));
    g.beginPath(); g.arc(mx, my, r * 0.04, 0, Math.PI * 2); g.fill();
  }
}

// Colossal Deep-Sea Abyss-Lord — three-headed gilded hydra with orb-bearing tentacles
function paintAbyssLord(def, wag, t) {
  const r = def.r;
  const orbColors = ['#3ec9ff', '#c86bff', '#7dff5a', '#ff8c1a'];

  // orb-bearing tentacles sweeping behind the body
  g.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const spread = (i - 1.5) * 0.55;
    const sw = Math.sin(wag * 0.8 + i * 1.7) * r * 0.2;
    const ex = -r * (1.0 + (i % 2) * 0.35);
    const ey = spread * r * 0.85 + sw;
    g.strokeStyle = i % 2 ? def.fin : def.body;
    g.lineWidth = r * 0.13;
    g.beginPath();
    g.moveTo(-r * 0.2, spread * r * 0.3);
    g.quadraticCurveTo(-r * 0.7, spread * r * 0.7 + sw * 0.5, ex, ey);
    g.stroke();
    // spiral tip
    g.lineWidth = r * 0.06;
    g.beginPath();
    g.arc(ex - r * 0.1, ey, r * 0.14, 0, Math.PI * 1.6);
    g.stroke();
    // glowing elemental orb held in the curl
    const pulse = 0.8 + 0.2 * Math.sin(t * 4 + i * 1.6);
    g.save();
    g.globalCompositeOperation = 'lighter';
    const orb = g.createRadialGradient(ex - r * 0.1, ey, 1, ex - r * 0.1, ey, r * 0.22 * pulse);
    orb.addColorStop(0, 'rgba(255,255,255,0.9)');
    orb.addColorStop(0.45, orbColors[i]);
    orb.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = orb;
    g.beginPath(); g.arc(ex - r * 0.1, ey, r * 0.22 * pulse, 0, Math.PI * 2); g.fill();
    g.restore();
  }
  g.lineCap = 'butt';

  // armored golden chest
  const grad = g.createRadialGradient(-r * 0.1, -r * 0.15, r * 0.15, 0, 0, r * 0.85);
  grad.addColorStop(0, def.body);
  grad.addColorStop(1, '#8a5c10');
  g.fillStyle = grad;
  g.beginPath();
  g.ellipse(0, r * 0.05, r * 0.62, r * 0.75, 0, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(60,35,0,0.7)';
  g.lineWidth = 2.5;
  g.stroke();
  // plate lines
  g.strokeStyle = def.stripe;
  g.lineWidth = 2.5;
  g.globalAlpha = 0.7;
  for (let i = 0; i < 3; i++) {
    g.beginPath();
    g.arc(0, -r * 0.5, r * (0.45 + i * 0.16), 0.5, Math.PI - 0.5);
    g.stroke();
  }
  g.globalAlpha = 1;
  // chest gem
  g.save();
  g.shadowColor = '#48f0c8';
  g.shadowBlur = 14;
  g.fillStyle = '#48f0c8';
  g.beginPath();
  g.moveTo(0, -r * 0.18); g.lineTo(r * 0.13, 0); g.lineTo(0, r * 0.18); g.lineTo(-r * 0.13, 0);
  g.closePath();
  g.fill();
  g.restore();

  // three serpent necks and heads (center head largest)
  const heads = [
    { hx: r * 0.55, hy: -r * 0.75, hr: r * 0.3, breath: '#3ec9ff', tilt: -0.35 },
    { hx: r * 0.85, hy: 0,         hr: r * 0.38, breath: '#c86bff', tilt: 0 },
    { hx: r * 0.55, hy: r * 0.75,  hr: r * 0.3, breath: '#7dff5a', tilt: 0.35 },
  ];
  for (const hd of heads) {
    const bob = Math.sin(wag + hd.tilt * 4) * r * 0.06;
    const hx = hd.hx, hy = hd.hy + bob, hr = hd.hr;
    // neck: smooth tapered double stroke
    const nSway = Math.sin(wag * 1.2 + hd.tilt * 3) * r * 0.06;
    g.lineCap = 'round';
    g.strokeStyle = '#8a5c10';
    g.lineWidth = hr * 0.95;
    g.beginPath();
    g.moveTo(-r * 0.05, r * 0.05);
    g.quadraticCurveTo(hx * 0.4, hy * 0.8 + nSway, hx - hr * 0.4, hy);
    g.stroke();
    g.strokeStyle = def.body;
    g.lineWidth = hr * 0.58;
    g.stroke();
    g.lineCap = 'butt';
    // spiked mane behind the skull
    g.fillStyle = '#ffcf4a';
    g.strokeStyle = 'rgba(60,35,0,0.7)';
    g.lineWidth = 1.5;
    for (let s = -1; s <= 1; s++) {
      const ma = hd.tilt * 0.5 - 1.9 + s * 0.55;
      g.beginPath();
      g.moveTo(hx + Math.cos(ma - 0.18) * hr * 0.7, hy + Math.sin(ma - 0.18) * hr * 0.6);
      g.lineTo(hx + Math.cos(ma) * hr * 1.5, hy + Math.sin(ma) * hr * 1.4);
      g.lineTo(hx + Math.cos(ma + 0.18) * hr * 0.7, hy + Math.sin(ma + 0.18) * hr * 0.6);
      g.closePath();
      g.fill();
      g.stroke();
    }
    // skull
    const hg = g.createRadialGradient(hx - hr * 0.2, hy - hr * 0.3, hr * 0.2, hx, hy, hr);
    hg.addColorStop(0, '#ffd06a');
    hg.addColorStop(1, '#a06a10');
    g.fillStyle = hg;
    g.beginPath(); g.ellipse(hx, hy, hr, hr * 0.72, hd.tilt * 0.4, 0, Math.PI * 2); g.fill();
    g.strokeStyle = 'rgba(60,35,0,0.7)';
    g.lineWidth = 2;
    g.stroke();
    // open jaw with fangs
    g.fillStyle = '#3a2000';
    g.beginPath();
    g.moveTo(hx + hr * 0.5, hy + hr * 0.02);
    g.lineTo(hx + hr * 1.35, hy - hr * 0.22);
    g.lineTo(hx + hr * 1.25, hy + hr * 0.42);
    g.closePath();
    g.fill();
    g.fillStyle = '#fff3d0';
    for (const [t1, t2] of [[0.72, -0.1], [0.98, -0.16]]) {
      g.beginPath();
      g.moveTo(hx + hr * t1, hy + hr * t2);
      g.lineTo(hx + hr * (t1 + 0.07), hy + hr * (t2 + 0.22));
      g.lineTo(hx + hr * (t1 + 0.14), hy + hr * t2);
      g.closePath();
      g.fill();
    }
    // upper snout ridge
    g.fillStyle = '#c8871a';
    g.beginPath();
    g.ellipse(hx + hr * 0.8, hy - hr * 0.28, hr * 0.42, hr * 0.2, hd.tilt * 0.3 - 0.25, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = 'rgba(60,35,0,0.7)';
    g.stroke();
    // swept-back horns
    g.fillStyle = '#ffcf4a';
    g.beginPath();
    g.moveTo(hx - hr * 0.05, hy - hr * 0.5);
    g.quadraticCurveTo(hx - hr * 0.85, hy - hr * 1.3, hx - hr * 1.35, hy - hr * 1.0);
    g.quadraticCurveTo(hx - hr * 0.75, hy - hr * 0.9, hx - hr * 0.4, hy - hr * 0.45);
    g.closePath();
    g.fill();
    g.stroke();
    // glowing eye
    g.save();
    g.shadowColor = hd.breath;
    g.shadowBlur = 10;
    g.fillStyle = '#fff6d8';
    g.beginPath(); g.arc(hx + hr * 0.25, hy - hr * 0.2, hr * 0.14, 0, Math.PI * 2); g.fill();
    g.restore();
    g.fillStyle = '#301400';
    g.beginPath(); g.arc(hx + hr * 0.3, hy - hr * 0.2, hr * 0.07, 0, Math.PI * 2); g.fill();
    // elemental breath plume
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.55 + 0.3 * Math.sin(t * 4 + hd.tilt * 6);
    const bg2 = g.createLinearGradient(hx + hr, hy, hx + hr * 3.2, hy);
    bg2.addColorStop(0, hd.breath);
    bg2.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bg2;
    g.beginPath();
    g.moveTo(hx + hr * 0.9, hy + hr * 0.1);
    g.quadraticCurveTo(hx + hr * 2.1, hy - hr * 0.35 + Math.sin(t * 7 + hd.tilt) * hr * 0.3, hx + hr * 3.2, hy + Math.sin(t * 5 + hd.tilt * 2) * hr * 0.4);
    g.quadraticCurveTo(hx + hr * 2.1, hy + hr * 0.55, hx + hr * 0.9, hy + hr * 0.25);
    g.closePath();
    g.fill();
    g.restore();
  }
}

const PAINTERS = {
  fish: paintFish, puffer: paintPuffer, turtle: paintTurtle, serpentray: paintSerpentRay,
  shark: paintShark, crab: paintCrab, whale: paintWhale,
  mandarin: paintMandarin, octomage: paintOcto, thundershark: paintThunderShark,
  dragonkoi: paintDragonKoi, abysslord: paintAbyssLord,
  eel: paintSerpentRay, pearl: paintPuffer, dynamite: paintDynamite,
  // HP-bar bosses reuse the closest procedural painter (distinguished by colour).
  kraken: paintAbyssLord, kirin: paintDragonKoi, phoenix: paintDragonKoi,
};

// Dynamite Stick — a bundled stick of red dynamite with a lit fuse.
function paintDynamite(def, wag) {
  const r = def.r;
  g.save();
  g.rotate(Math.sin(wag) * 0.25);
  // stick body
  const grad = g.createLinearGradient(0, -r, 0, r);
  grad.addColorStop(0, def.body); grad.addColorStop(1, '#9c2a1c');
  g.fillStyle = grad;
  g.beginPath();
  g.roundRect(-r * 0.35, -r * 0.8, r * 0.7, r * 1.6, r * 0.3);
  g.fill();
  // metal cap
  g.fillStyle = '#e6c35a';
  g.beginPath();
  g.roundRect(-r * 0.38, -r * 0.95, r * 0.76, r * 0.3, r * 0.12);
  g.fill();
  // hazard band
  g.fillStyle = def.stripe;
  g.fillRect(-r * 0.35, -r * 0.15, r * 0.7, r * 0.24);
  // fuse
  g.strokeStyle = '#8a5a2a';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(0, -r * 0.95);
  g.quadraticCurveTo(r * 0.2, -r * 1.4, r * 0.45, -r * 1.35);
  g.stroke();
  // spark
  const spark = 0.6 + 0.4 * Math.sin(wag * 10);
  g.fillStyle = `rgba(255, ${Math.floor(200 + 55 * spark)}, 90, ${spark})`;
  g.beginPath();
  g.arc(r * 0.45, -r * 1.35, 5 + spark * 2, 0, Math.PI * 2);
  g.fill();
  g.restore();
  paintEye(r * 0.1, -r * 0.45, r * 0.1);
}

// ============================================================ render
function drawBackground() {
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#0a4152');
  grad.addColorStop(0.5, '#052b3a');
  grad.addColorStop(1, '#02141f');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  // light rays
  g.save();
  g.globalAlpha = 0.07;
  g.fillStyle = '#9fdcff';
  for (let i = 0; i < 5; i++) {
    const x = ((i * 331 + state.time * 12) % (W + 400)) - 200;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 130, 0);
    g.lineTo(x - 120, H);
    g.lineTo(x - 250, H);
    g.closePath();
    g.fill();
  }
  g.restore();

  // sunken ruins — pillared arches silhouetted in the deep
  g.save();
  g.fillStyle = 'rgba(14, 56, 72, 0.65)';
  for (const [ax, ah, as] of [[150, 240, 1], [640, 320, 1.25], [1150, 260, 1.1]]) {
    const pw = 34 * as, gap = 120 * as, top = H - ah;
    for (const px of [ax, ax + gap]) {
      g.fillRect(px, top + 24 * as, pw, ah);                    // shaft
      g.fillRect(px - 6 * as, top + 12 * as, pw + 12 * as, 14 * as);  // capital
      g.fillRect(px - 4 * as, H - 20, pw + 8 * as, 20);         // base
    }
    g.beginPath();                                              // arch span
    g.moveTo(ax - 6 * as, top + 26 * as);
    g.quadraticCurveTo(ax + gap * 0.5 + pw * 0.5, top - 60 * as, ax + gap + pw + 6 * as, top + 26 * as);
    g.lineTo(ax + gap + pw + 6 * as, top + 12 * as);
    g.quadraticCurveTo(ax + gap * 0.5 + pw * 0.5, top - 80 * as, ax - 6 * as, top + 12 * as);
    g.closePath();
    g.fill();
  }
  // moss glow on the stonework
  g.fillStyle = 'rgba(60, 140, 90, 0.18)';
  for (const [mx, my, mr] of [[168, H - 150, 26], [700, H - 260, 30], [1180, H - 120, 22], [780, H - 90, 24]]) {
    g.beginPath(); g.ellipse(mx, my, mr, mr * 0.45, 0.3, 0, Math.PI * 2); g.fill();
  }
  g.restore();

  // sea floor
  g.fillStyle = '#0d2436';
  g.beginPath();
  g.moveTo(0, H);
  for (let x = 0; x <= W; x += 60) {
    g.lineTo(x, H - 24 - Math.sin(x * 0.011 + 2) * 14);
  }
  g.lineTo(W, H);
  g.closePath();
  g.fill();

  // seaweed
  for (const wd of state.weeds) {
    const sway = Math.sin(state.time * 0.8 + wd.sway) * 14;
    g.strokeStyle = 'rgba(20, 90, 70, 0.55)';
    g.lineWidth = wd.w;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(wd.x, H - 10);
    g.quadraticCurveTo(wd.x + sway * 0.4, H - wd.h * 0.6, wd.x + sway, H - wd.h);
    g.stroke();
  }
  g.lineCap = 'butt';

  // bubbles
  g.strokeStyle = 'rgba(200, 235, 255, 0.35)';
  g.lineWidth = 1.5;
  for (const b of state.bubbles) {
    g.beginPath();
    g.arc(b.x + Math.sin(b.drift * 2) * 6, b.y, b.r, 0, Math.PI * 2);
    g.stroke();
  }
}

function drawFishAll() {
  const now = Date.now();
  for (const f of state.fish) {
    g.save();
    g.translate(f.x, f.y);
    const flip = Math.cos(f.angle) < 0;
    g.rotate(f.angle);
    if (flip) g.scale(1, -1);

    if (f.dying) {
      const k = f.dying / 0.6;
      g.globalAlpha = k;
      g.scale(1 + (1 - k) * 0.4, 1 + (1 - k) * 0.4);
    }
    // premium creatures carry a soft bioluminescent halo
    if (f.def.glow || f.boss) {
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha *= 0.10 + 0.04 * Math.sin(f.wag * 1.5);
      g.fillStyle = f.boss ? '#ffd06a' : f.def.glow;
      g.beginPath();
      g.ellipse(0, 0, f.def.r * 1.5, f.def.r * 1.1, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    (PAINTERS[f.def.kind] || paintFish)(f.def, f.wag, state.time);

    if (f.flash > 0) {
      g.globalAlpha = f.flash * 6;
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = '#ffffff';
      g.beginPath();
      g.ellipse(0, 0, f.def.r * 1.1, f.def.r * 0.75, 0, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = 'source-over';
    }
    g.restore();

    // ---- freeze VFX: ice crystals around frozen fish ----
    if (f.frozenUntil > now) {
      g.save();
      g.translate(f.x, f.y);
      const freezeAlpha = 0.5 + 0.2 * Math.sin(state.time * 6);
      g.globalAlpha = freezeAlpha;
      g.strokeStyle = '#6acaff';
      g.lineWidth = 2.5;
      // ice shard ring
      for (let j = 0; j < 6; j++) {
        const sa = (j / 6) * Math.PI * 2 + state.time * 1.5;
        const sr = f.def.r * 1.2 + Math.sin(state.time * 4 + j) * 4;
        const sx = Math.cos(sa) * sr, sy = Math.sin(sa) * sr;
        g.beginPath();
        g.moveTo(sx, sy - 6); g.lineTo(sx + 3, sy + 2); g.lineTo(sx - 3, sy + 2);
        g.closePath();
        g.fillStyle = '#a0e8ff';
        g.fill();
        g.stroke();
      }
      // frost glow
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = 0.12 + 0.06 * Math.sin(state.time * 3);
      const frostG = g.createRadialGradient(0, 0, f.def.r * 0.3, 0, 0, f.def.r * 1.5);
      frostG.addColorStop(0, 'rgba(160,230,255,0.6)');
      frostG.addColorStop(1, 'rgba(80,180,220,0)');
      g.fillStyle = frostG;
      g.beginPath(); g.arc(0, 0, f.def.r * 1.5, 0, Math.PI * 2); g.fill();
      g.restore();
    }

    // ---- lock-on reticle ----
    if (state.lockedFishId === f.id && !f.dying) {
      g.save();
      g.translate(f.x, f.y);
      const rr = f.def.r + 10 + 3 * Math.sin(state.time * 8);
      g.strokeStyle = '#ff3a3a';
      g.lineWidth = 2.5;
      g.globalAlpha = 0.85;
      // targeting circle
      g.beginPath(); g.arc(0, 0, rr, 0, Math.PI * 2); g.stroke();
      // crosshairs
      const ch = rr + 8;
      for (const [cx, cy] of [[ch, 0], [-ch, 0], [0, ch], [0, -ch]]) {
        g.beginPath(); g.moveTo(cx * 0.7, cy * 0.7); g.lineTo(cx, cy); g.stroke();
      }
      g.restore();
    }

    // ---- armored fish: shield badge ----
    if ((f.def.armor || 0) > 0 && !f.dying) {
      g.save();
      g.translate(f.x, f.y);
      const ax = f.def.r + 6, ay = f.def.r + 2;
      g.fillStyle = '#c0d0e0';
      g.globalAlpha = 0.8;
      // small shield
      g.beginPath();
      g.moveTo(ax, ay - 8);
      g.lineTo(ax + 7, ay - 4);
      g.lineTo(ax + 7, ay + 3);
      g.lineTo(ax, ay + 8);
      g.lineTo(ax - 7, ay + 3);
      g.lineTo(ax - 7, ay - 4);
      g.closePath();
      g.fill();
      g.strokeStyle = '#8899aa';
      g.lineWidth = 1.5;
      g.stroke();
      // armor number
      g.fillStyle = '#334';
      g.globalAlpha = 0.9;
      g.font = 'bold 9px Arial';
      g.textAlign = 'center';
      g.fillText(f.def.armor, ax, ay + 4);
      g.restore();
    }

    // ---- shielded fish: shimmering bubble shell ----
    if (f.def.shielded && !f.dying) {
      g.save();
      g.translate(f.x, f.y);
      const sr = f.def.r * 1.5;
      const sw = 0.5 + 0.3 * Math.sin(state.time * 3);
      g.globalAlpha = 0.35 + 0.2 * Math.sin(state.time * 4);
      g.strokeStyle = '#9fdcff';
      g.lineWidth = 2.5;
      g.beginPath(); g.arc(0, 0, sr, 0, Math.PI * 2); g.stroke();
      g.globalAlpha *= sw;
      g.strokeStyle = '#cfeaff';
      g.beginPath(); g.arc(0, 0, sr * 1.15, 0, Math.PI * 2); g.stroke();
      // highlight glint
      g.globalAlpha = 0.5;
      g.fillStyle = '#eaffff';
      g.beginPath(); g.arc(-sr * 0.4, -sr * 0.4, sr * 0.16, 0, Math.PI * 2); g.fill();
      g.restore();
    }

    // multiplier tag
    if (!f.dying) {
      g.save();
      g.font = 'bold 13px Arial';
      g.textAlign = 'center';
      g.fillStyle = f.boss ? '#ffd54a' : (f.def.special ? '#fff3a0' : 'rgba(255,255,255,0.78)');
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.lineWidth = 3;
      const label = f.def.variable ? ('x' + f.def.multRange[0] + '-' + f.def.multRange[1])
                 : f.def.special === 'bonus' ? 'BONUS'
                 : f.def.special === 'aoe' ? ('x' + f.def.mult + ' AoE')
                 : ('x' + f.def.mult);
      g.strokeText(label, f.x, f.y - f.def.r - 8);
      g.fillText(label, f.x, f.y - f.def.r - 8);
      g.restore();
    }

    }
}

function drawBullets() {
  for (const b of state.bullets) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    // flame tail
    for (let i = 0; i < b.trail.length; i++) {
      const tr = b.trail[i];
      const k = (i + 1) / b.trail.length;
      const tr_r = b.r * (0.35 + k * 0.85);
      g.globalAlpha = k * 0.4;
      const tg = g.createRadialGradient(tr.x, tr.y, 0, tr.x, tr.y, tr_r);
      tg.addColorStop(0, '#ffe27a');
      tg.addColorStop(0.55, '#ff7a1a');
      tg.addColorStop(1, 'rgba(255,60,0,0)');
      g.fillStyle = tg;
      g.beginPath(); g.arc(tr.x, tr.y, tr_r, 0, Math.PI * 2); g.fill();
    }
    // heat halo
    g.globalAlpha = 0.85;
    const halo = g.createRadialGradient(b.x, b.y, b.r * 0.2, b.x, b.y, b.r * 2);
    halo.addColorStop(0, 'rgba(255,190,80,0.85)');
    halo.addColorStop(1, 'rgba(255,80,0,0)');
    g.fillStyle = halo;
    g.beginPath(); g.arc(b.x, b.y, b.r * 2, 0, Math.PI * 2); g.fill();
    g.restore();

    // flickering white-hot core
    const flick = 1 + Math.sin(state.time * 24 + b.flick) * 0.09;
    const grad = g.createRadialGradient(b.x - b.r * 0.25, b.y - b.r * 0.25, 1, b.x, b.y, b.r * flick);
    grad.addColorStop(0, '#fffbe8');
    grad.addColorStop(0.35, '#ffd54a');
    grad.addColorStop(0.75, '#ff7a1a');
    grad.addColorStop(1, '#c93a00');
    g.fillStyle = grad;
    g.beginPath(); g.arc(b.x, b.y, b.r * flick, 0, Math.PI * 2); g.fill();
  }
}

function drawNets() {
  for (const n of state.nets) {
    const a = n.life / n.maxLife;
    g.save();
    g.globalAlpha = a * (n.bomb ? 0.9 : 0.8);
    g.strokeStyle = n.bomb ? '#ff8c1a' : '#aef1ff';
    g.lineWidth = n.bomb ? 4 : 2;
    g.beginPath(); g.arc(n.x, n.y, n.r, 0, Math.PI * 2); g.stroke();
    // net mesh
    if (!n.bomb) {
      g.globalAlpha = a * 0.4;
      g.lineWidth = 1;
      const step = Math.max(8, n.r / 4);
      for (let d = -n.r; d <= n.r; d += step) {
        const c = Math.sqrt(Math.max(0, n.r * n.r - d * d));
        g.beginPath(); g.moveTo(n.x + d, n.y - c); g.lineTo(n.x + d, n.y + c); g.stroke();
        g.beginPath(); g.moveTo(n.x - c, n.y + d); g.lineTo(n.x + c, n.y + d); g.stroke();
      }
    } else {
      g.globalAlpha = a * 0.35;
      g.fillStyle = '#ff6a00';
      g.beginPath(); g.arc(n.x, n.y, n.r, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }
}

function drawCoins() {
  for (const c of state.coins) {
    if (c.delay > 0) continue;
    g.save();
    g.translate(c.x, c.y);
    const squish = Math.abs(Math.cos(c.spin));
    g.scale(squish * 0.8 + 0.2, 1);
    const grad = g.createRadialGradient(-2, -2, 1, 0, 0, c.r);
    grad.addColorStop(0, '#fff3b0');
    grad.addColorStop(0.7, '#ffce2b');
    grad.addColorStop(1, '#c98a00');
    g.fillStyle = grad;
    g.beginPath(); g.arc(0, 0, c.r, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#8a5c00';
    g.lineWidth = 1.5;
    g.beginPath(); g.arc(0, 0, c.r * 0.65, 0, Math.PI * 2); g.stroke();
    g.restore();
  }
}

function drawTexts() {
  for (const t of state.texts) {
    const a = clamp(t.life / t.maxLife, 0, 1);
    g.save();
    g.globalAlpha = a;
    g.font = `bold ${t.big ? 42 : 24}px Arial`;
    g.textAlign = 'center';
    g.lineWidth = t.big ? 6 : 4;
    g.strokeStyle = 'rgba(60,30,0,0.9)';
    g.fillStyle = t.big ? '#ffd54a' : '#9dff8a';
    g.strokeText(t.text, t.x, t.y);
    g.fillText(t.text, t.x, t.y);
    g.restore();
  }
}

function drawParticles() {
  for (const p of state.particles) {
    g.globalAlpha = clamp(p.life / p.maxLife, 0, 1);
    g.fillStyle = p.color;
    g.beginPath(); g.arc(p.x, p.y, p.r, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
}

function drawCannon() {
  const c = cannonPos();
  const a = cannonAngle();
  const lvl = state.weaponLevel;

  // platform
  const pg = g.createRadialGradient(c.x, c.y + 10, 6, c.x, c.y + 10, 70);
  pg.addColorStop(0, '#274a63');
  pg.addColorStop(1, '#0c2233');
  g.fillStyle = pg;
  g.beginPath(); g.ellipse(c.x, c.y + 16, 78, 30, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#3f7ca6';
  g.lineWidth = 2;
  g.beginPath(); g.ellipse(c.x, c.y + 16, 78, 30, 0, 0, Math.PI * 2); g.stroke();

  // barrel — grows fancier with bet level
  g.save();
  g.translate(c.x, c.y);
  g.rotate(a);
  const bw = 14 + lvl * 1.6;
  const bl = 56 + lvl * 3;
  const bg = g.createLinearGradient(0, -bw, 0, bw);
  bg.addColorStop(0, '#ffe27a');
  bg.addColorStop(0.5, '#e89b1c');
  bg.addColorStop(1, '#8a5200');
  g.fillStyle = bg;
  g.beginPath();
  g.moveTo(0, -bw * 0.7);
  g.lineTo(bl, -bw);
  g.lineTo(bl, bw);
  g.lineTo(0, bw * 0.7);
  g.closePath();
  g.fill();
  // muzzle ring
  g.fillStyle = '#6b3e00';
  g.fillRect(bl - 6, -bw - 3, 8, bw * 2 + 6);
  // bands per level
  g.fillStyle = '#a56a00';
  for (let i = 0; i <= lvl; i++) g.fillRect(10 + i * 6, -bw * 0.85, 3, bw * 1.7);
  g.restore();

  // turret dome
  const dg = g.createRadialGradient(c.x - 8, c.y - 10, 4, c.x, c.y, 34);
  dg.addColorStop(0, '#ffe9a8');
  dg.addColorStop(0.6, '#e8a325');
  dg.addColorStop(1, '#7a4a00');
  g.fillStyle = dg;
  g.beginPath(); g.arc(c.x, c.y, 30, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#5c3800';
  g.lineWidth = 2;
  g.beginPath(); g.arc(c.x, c.y, 30, 0, Math.PI * 2); g.stroke();

  // bet label on the dome (shows the per-shot cost = bet × weapon costMult)
  g.font = 'bold 16px Arial';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#3a2200';
  g.fillText(String(shotBet()), c.x, c.y + 1);
  g.textBaseline = 'alphabetic';
}

function drawAimLine() {
  if (!state.firing) return;
  const c = cannonPos();
  const a = cannonAngle();
  g.save();
  g.globalAlpha = 0.15;
  g.strokeStyle = '#ffe27a';
  g.setLineDash([6, 10]);
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(c.x + Math.cos(a) * 60, c.y + Math.sin(a) * 60);
  g.lineTo(c.x + Math.cos(a) * 1400, c.y + Math.sin(a) * 1400);
  g.stroke();
  g.restore();
}

function drawBossHpBar() {
  if (!state.bossHp || state.bossHp.hp <= 0) return;
  const bh = state.bossHp;
  const barW = 500, barH = 22;
  const x = (W - barW) / 2, y = 28;
  const ratio = clamp(bh.hp / bh.maxHp, 0, 1);
  // background
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.beginPath(); g.roundRect(x - 4, y - 4, barW + 8, barH + 26, 8); g.fill();
  // name
  g.font = 'bold 14px Arial';
  g.textAlign = 'center';
  g.fillStyle = '#ffd54a';
  g.fillText(bh.name, W / 2, y + 14);
  // bar background
  g.fillStyle = '#2a1a0a';
  g.beginPath(); g.roundRect(x, y + 20, barW, barH, 4); g.fill();
  // bar fill
  const hpColor = ratio > 0.5 ? '#ff5a3a' : ratio > 0.25 ? '#ffaa3a' : '#ff3a3a';
  const grad = g.createLinearGradient(x, 0, x + barW * ratio, 0);
  grad.addColorStop(0, hpColor);
  grad.addColorStop(1, ratio > 0.5 ? '#ff8c1a' : '#ff5a3a');
  g.fillStyle = grad;
  g.beginPath(); g.roundRect(x, y + 20, barW * ratio, barH, 4); g.fill();
  // HP text
  g.font = 'bold 12px Arial';
  g.fillStyle = '#fff';
  g.fillText(Math.max(0, Math.ceil(bh.hp)) + ' / ' + bh.maxHp, W / 2, y + 20 + barH - 5);
}

function render() {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#01080f';
  g.fillRect(0, 0, canvas.width, canvas.height);
  // screen shake offset (decays in update)
  let sx = 0, sy = 0;
  if (state.shakeTime > 0) {
    const k = state.shakeTime / 0.45;
    sx = Math.sin(state.time * 60) * state.shakeAmp * k;
    sy = Math.cos(state.time * 55) * state.shakeAmp * k;
  }
  g.setTransform(viewScale, 0, 0, viewScale, viewOX + sx * viewScale, viewOY + sy * viewScale);

  drawBackground();
  drawAimLine();
  drawFishAll();
  drawNets();
  drawBullets();
  drawParticles();
  drawCoins();
  drawTexts();
  drawCannon();
  drawBossHpBar();

  // bonus mode tint
  if (state.bonusActive) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 0.08 + 0.04 * Math.sin(state.time * 4);
    g.fillStyle = '#ffcf4a';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.globalAlpha = 1;
  }
}

// ============================================================ main loop
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  render();
  requestAnimationFrame(frame);
}

// ============================================================ socket + auth init
let socket = null;
let myUserId = null;

function showMiniGame(data) {
  state.miniGamePending = true;
  const card = document.createElement('div');
  card.className = 'mini-overlay';
  card.innerHTML = `<h2>💎 BONUS!</h2><p class="muted">${data.prompt || 'Pick one!'}</p><div class="chest-row"></div>`;
  const row = card.querySelector('.chest-row');
  (data.choices || [0, 1, 2]).forEach(choice => {
    const b = document.createElement('div');
    b.className = 'chest';
    b.textContent = '🎁';
    b.onclick = () => {
      socket.emit('miniGamePick', choice);
      card.remove();
      state.miniGamePending = false;
    };
    row.appendChild(b);
  });
  hud.mini.appendChild(card);
  // auto-dismiss if no choice in 20s
  setTimeout(() => { if (card.parentNode) { card.remove(); state.miniGamePending = false; } }, 20000);
}

function onMiniGameResult(r) {
  const card = document.createElement('div');
  card.className = 'mini-overlay';
  card.innerHTML = `<h2>💎 +${(r.win || 0).toLocaleString()}!</h2><p class="muted">You picked chest ${r.choice + 1}</p><button class="btn primary" id="mg-close">Collect</button>`;
  hud.mini.appendChild(card);
  card.querySelector('#mg-close').onclick = () => card.remove();
  SFX.bigWin();
  setTimeout(() => card.remove(), 4000);
  banner('BONUS PRIZE +' + (r.win || 0).toLocaleString());
}

async function init() {
  buildWeaponRow();
  refreshHUD();
  updateGameModeUI();
  requestAnimationFrame(frame);

  // auth gate
  const me = await Auth.me();
  if (!me) { location.href = '/auth'; return; }
  if (me.role === 'owner') { location.href = '/admin'; return; }
  if (me.role === 'manager') { location.href = '/manager'; return; }
  if (me.banned) { location.href = '/auth'; return; }

  myUserId = me.id;
  state.balance = me.points;
  state.displayBalance = me.points;
  state.level = me.level || 1;
  state.xp = me.xp || 0;
  state.xpNeeded = me.xpNeeded || 100;
  state.powerups = me.powerups || {};
  hud.authBar.classList.remove('hidden');
  hud.authUser.textContent = me.username;
  hud.btnLogout.classList.remove('hidden');
  hud.btnLogout.onclick = async () => { await Auth.logout(); location.href = '/auth'; };
  buildTierRow();
  refreshHUD();

  // connect socket (cookie auth handled server-side)
  socket = io({ withCredentials: true, auth: { gameMode: requestedGameMode, tier: requestedTier } });
  socket.on('connect', () => { state.connected = true; state.roomReady = false; updateGameModeUI(); });
  socket.on('disconnect', () => { state.connected = false; state.roomReady = false; updateGameModeUI(); });
  socket.on('roomState', applyRoomState);
  socket.on('spawn', addFishFromServer);
  socket.on('despawn', d => removeFish(d.fishId));
  socket.on('kill', k => {
    onServerKill(k);
    // clear boss HP bar if the killed fish was the tracked boss
    if (state.bossHp && state.bossHp.fishId === k.fishId) {
      state.bossHp = null;
    }
  });
  socket.on('nearmiss', nm => onNearMiss(nm));
  socket.on('balance', b => { state.balance = b.points; });
  socket.on('banner', b => banner(b.text));
  socket.on('bonusStart', b => { state.bonusActive = true; banner('✦ BONUS ROUND ✦'); SFX.bossAlert(); });
  socket.on('bonusEnd', () => { state.bonusActive = false; });
  socket.on('miniGame', d => showMiniGame(d));
  socket.on('miniGameResult', r => onMiniGameResult(r));
  socket.on('banned', () => { state.banned = true; location.href = '/auth'; });
  socket.on('error', () => { if (!state.banned) location.href = '/auth'; });
  // new game mechanic events
  socket.on('freeze', f => {
    const fish = state.fish.find(x => x.id === f.fishId);
    if (fish) {
      const now = Date.now();
      fish.frozenElapsed = fish.age + (now - fish.receivedAt);
      fish.frozenUntil = now + f.duration * 1000;
    }
  });
  socket.on('bossDamage', bd => {
    if (state.bossHp && state.bossHp.fishId === bd.fishId) {
      state.bossHp.hp = bd.hp;
    }
    const fish = state.fish.find(x => x.id === bd.fishId);
    if (fish) {
      fish.currentHp = bd.hp;
      fish.flash = 0.08;
      state.nets.push({ x: bd.x, y: bd.y, r: 8, max: 30 + bd.dmg * 0.3, life: 0.3, maxLife: 0.3 });
    }
  });
  socket.on('bossHp', bh => {
    state.bossHp = { fishId: bh.fishId, hp: bh.hp, maxHp: bh.maxHp, name: bh.name };
  });
  // ---- new economy / progression events ----
  socket.on('jackpotState', jp => { state.jackpot = jp.pool || 0; refreshHUD(); });
  socket.on('jackpot', jp => {
    state.jackpot = jp.pool || 0;
    refreshHUD();
    megaBanner('💎 JACKPOT! +' + (jp.amount || 0).toLocaleString() + ' 💎');
    banner('JACKPOT WON: +' + (jp.amount || 0).toLocaleString());
    SFX.bigWin();
  });
  // ---- fury / energy meter ----
  socket.on('furyMeter', m => {
    state.fury = m.value || 0;
    state.furyMax = m.max || 100;
    if (state.fury < state.furyMax) state.furyReady = false;
    updateFury();
  });
  socket.on('furyReady', () => {
    state.furyReady = true;
    updateFury();
    banner('⚡ FURY READY — press F');
    SFX.bossAlert && SFX.bossAlert();
  });
  socket.on('furyStart', d => {
    state.furyActive = true;
    state.furyReady = false;
    state.fury = 0;
    state.furyUntil = Date.now() + (d.ms || 8000);
    updateFury();
    megaBanner('⚡ FURY MODE ⚡');
    state.shakeTime = 0.4; state.shakeAmp = 8;
  });
  socket.on('furyEnd', () => {
    state.furyActive = false;
    state.furyUntil = 0;
    updateFury();
  });
  socket.on('levelup', lu => {
    state.level = lu.level;
    state.xp = lu.xp || 0;
    state.xpNeeded = lu.xpNeeded || state.xpNeeded;
    refreshHUD();
    banner('LEVEL ' + lu.level + ' — +' + (lu.reward || 0).toLocaleString() + ' pts');
    buildWeaponRow();
  });
  socket.on('achievement', a => {
    banner('🏆 ' + a.name + ' — +' + (a.reward || 0).toLocaleString());
    megaBanner('🏆 ' + a.name + '!');
    SFX.bossAlert();
  });
  socket.on('powerups', inv => { state.powerups = inv || {}; refreshHUD(); });
  socket.on('weapon', wl => { state.weaponLevel = wl || 0; buildWeaponRow(); refreshHUD(); });
  socket.on('powerup', p => {
    // ring VFX where the power-up detonated
    state.nets.push({ x: p.x, y: p.y, r: 10, max: 220 + p.kills.length * 20, life: 0.5, maxLife: 0.5 });
    state.shakeTime = 0.25; state.shakeAmp = 6;
    banner((p.kills || []).length + ' fish caught by ' + p.key.toUpperCase());
    if (p.kills && p.kills.length > 0) SFX.bigWin();
  });
  socket.on('freezeAll', f => {
    const until = Date.now() + (f.duration || 3) * 1000;
    for (const fish of state.fish) {
      const now = Date.now();
      fish.frozenElapsed = fish.age + (now - fish.receivedAt);
      fish.frozenUntil = until;
    }
    banner('❄️ ALL FISH FROZEN');
  });
  socket.on('botShot', b => {
    // short tracer for AI opponents
    state.particles.push({ x: b.x, y: b.y, vx: Math.cos(b.angle) * 500, vy: Math.sin(b.angle) * 500, life: 0.18, maxLife: 0.18, color: b.color || '#ff8c5a', size: 3 });
  });
  socket.on('chatMsg', m => {
    if (!hud.chatList) return;
    const row = document.createElement('div');
    row.className = 'chat-msg';
    row.textContent = m.user + ': ' + m.text;
    hud.chatList.appendChild(row);
    hud.chatList.scrollTop = hud.chatList.scrollHeight;
  });
  // close any open modal when clicking the backdrop
  [hud.walletModal, hud.shopModal].forEach(m => {
    if (m) m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
  });

  // debug exports (handy for the test harness; harmless in prod)
  window.__fk = { state, socket, myUserId, SFX, addFishFromServer, onServerKill };
}

init();
