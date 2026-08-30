/* rooms.js — server-authoritative game room engine.
   Spawns fish on parametric paths, validates hits/score on demand, runs the
   death-check + RTP allowance controller, triggers bonus rounds + AoE chains,
   and pushes balance/kill/spawn events to clients.

   Features: armor damage reduction, 5 unique weapon types (single/spread/
   pierce/freeze/heavy), shared boss HP pools, freeze status effects,
   stake-tier rooms, AI practice opponents, shielded fish, progressive jackpot,
   purchasable power-ups, chat, and the XP / achievement hooks. */
'use strict';

const db = require('../db');
const { W, H, ROOM_TIERS, WEAPON_LEVELS, FIRE_INTERVAL, FURY } = require('./constants');
const { FISH, BOSS, VARIABLE_BOSSES } = require('./fishTypes');
// Every HP-bar boss spawnBoss can draw from, picked with even weight for variety.
const BOSS_POOL = [BOSS, ...VARIABLE_BOSSES];
const { makePath, makeBossPath, bezier, bezierTangent, pathLength } = require('./paths');
const rng = require('./rng');
const progression = require('./progression');
const achievements = require('./achievements');
const jackpot = require('./jackpot');
const powerups = require('./powerups');

const TICK_MS = 500;
const MULTIPLAYER_SIZE = 4;

const TOTAL_WEIGHT = FISH.reduce((s, x) => s + x.weight, 0);

const rooms = new Map();   // roomKey -> Room
const sockets = new Map(); // userId -> Set<socket>
const multiplayerQueues = new Map(); // tier -> array of unique user ids, FIFO
const queuedPlayers = new Map(); // userId -> { id, username }
const multiplayerMatches = new Map(); // userId -> roomKey
let nextMatchId = 1;

progression.setSocketRegistry(sockets);

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function getRoom(key, opts = {}) {
  let r = rooms.get(key);
  if (!r) { r = createRoom(key, opts); rooms.set(key, r); }
  return r;
}

function createRoom(key, { mode = 'solo', tier = 'mid', players = [] } = {}) {
  return {
    key,
    mode,
    tier,
    statsKey: `${mode}:${tier}`,
    players: new Map(players.map(player => [player.id, player])),
    fish: new Map(),
    bots: null,
    nextId: 1,
    spawnTimer: 0,
    bossTimer: 45,
    bonusTimer: 0,
    allowance: 1.0,
    stateTimer: 0,
    jackpotTimer: 0,
  };
}

function pickSpecies() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const s of FISH) { roll -= s.weight; if (roll <= 0) return s; }
  return FISH[0];
}

// A random share of regular fish spawn shielded: more armor (slower to soften)
// but a fatter multiplier. The RTP loop keeps the per-hit EV honest.
function maybeShield(def) {
  if (def.boss || def.special || def.variable) return def;
  if (Math.random() >= 0.12) return def;
  return {
    ...def,
    shielded: true,
    armor: (def.armor || 0) * 4,
    mult: Math.round(def.mult * 1.5),
    name: `${def.name} · SHIELD`,
  };
}

function spawnFish(room, def, opts = {}) {
  const shieldedDef = maybeShield(def);
  const path = opts.path || makePath(shieldedDef.r || 20);
  const speed = (shieldedDef.speed || 100) * (0.85 + Math.random() * 0.3);
  const dur = pathLength(path) / speed;
  const id = room.nextId++;
  const f = {
    id, def: shieldedDef, path,
    tStart: Date.now(),
    dur: dur * 1000,
    alive: true,
    hp: 0,
    currentHp: shieldedDef.sharedHp || 0,
    damage: new Map(),   // userId -> damage dealt (for shared boss rewards)
    frozen: 0,
    frozenAt: 0,
  };
  room.fish.set(id, f);
  return f;
}

function spawnBoss(room) {
  const def = BOSS_POOL[Math.floor(Math.random() * BOSS_POOL.length)];
  const path = makeBossPath(def.r);
  const f = spawnFish(room, def, { path });
  f.boss = true;
  return f;
}

function effectiveDamage(bet, armor, armorPierce) {
  const reducedArmor = Math.max(0, armor * (1 - (armorPierce || 0)));
  return Math.max(1, Math.floor(bet - reducedArmor));
}

function fishPosition(f, now = Date.now()) {
  let t;
  if (f.frozen > 0) {
    t = (f.frozenAt - f.tStart) / f.dur;
  } else {
    t = (now - f.tStart) / f.dur;
  }
  if (t >= 1) return null;
  return bezier(f.path, clamp(t, 0, 1));
}

function serializeFish(f) {
  return {
    fishId: f.id, typeId: f.def.id, def: { ...f.def },
    path: f.path, age: Date.now() - f.tStart, dur: f.dur, boss: !!f.boss,
    currentHp: f.currentHp || 0, maxHp: f.def.sharedHp || 0,
  };
}

function serializePlayers(room) {
  return [...room.players.values()].map(player => ({ id: player.id, username: player.username }));
}

function currentRoom(socket) {
  return socket.data.roomKey ? rooms.get(socket.data.roomKey) || null : null;
}

function emitRoomState(socket, room, status = 'active') {
  socket.emit('roomState', {
    mode: room.mode, tier: room.tier, status,
    reset: true,
    players: serializePlayers(room),
    required: room.mode === 'multiplayer' ? MULTIPLAYER_SIZE : 1,
  });
}

async function joinSocketRoom(socket, room) {
  if (socket.data.roomKey && socket.data.roomKey !== room.key) socket.leave(socket.data.roomKey);
  socket.join(room.key);
  socket.data.roomKey = room.key;
  socket.data.gameMode = room.mode;
  emitRoomState(socket, room);
  if (room.mode === 'solo') await ensureBots(room);
  for (const f of room.fish.values()) {
    socket.emit('spawn', serializeFish(f));
    if (f.boss && f.def.sharedHp) {
      socket.emit('bossHp', { fishId: f.id, hp: f.currentHp, maxHp: f.def.sharedHp, name: f.def.name });
    }
  }
  const jp = await jackpot.get();
  socket.emit('jackpotState', { pool: jp.pool });
  const pw = await db.getPowerups(socket.data.userId);
  socket.emit('powerups', pw);
}

async function ensureBots(room) {
  if (room.bots !== null) return;
  const s = await rng.loadSettings();
  if (String(s.ai_bots || 'on') === 'off') { room.bots = []; return; }
  const names = ['Marlin', 'Coral', 'Reef', 'Splash', 'Finley', 'Bubbles'];
  const colors = ['#ff8c5a', '#6acaff', '#9dff8a', '#ffd54a'];
  room.bots = [];
  for (let i = 0; i < 3; i++) {
    room.bots.push({
      id: `bot${i + 1}`,
      username: names[(room.key.length + i) % names.length],
      bet: [1, 2, 5][i % 3],
      cooldown: 1 + i * 0.5,
      color: colors[i % colors.length],
    });
  }
}

function notifyQueuedPlayers(tier) {
  const queue = multiplayerQueues.get(tier) || [];
  queue.forEach((userId, index) => {
    const playerSockets = sockets.get(userId);
    if (!playerSockets) return;
    const status = {
      mode: 'multiplayer', tier, status: 'waiting', reset: true,
      position: index + 1, queued: queue.length, required: MULTIPLAYER_SIZE,
    };
    for (const socket of playerSockets) socket.emit('roomState', status);
  });
}

function startMatchesFromQueue(tier) {
  const queue = multiplayerQueues.get(tier) || [];
  while (queue.length >= MULTIPLAYER_SIZE) {
    const playerIds = queue.splice(0, MULTIPLAYER_SIZE);
    const players = playerIds.map(id => queuedPlayers.get(id)).filter(Boolean);
    if (players.length !== MULTIPLAYER_SIZE) continue;
    for (const player of players) queuedPlayers.delete(player.id);

    const room = getRoom(`multi:${tier}:${nextMatchId++}`, { mode: 'multiplayer', tier, players });
    for (const player of players) {
      multiplayerMatches.set(player.id, room.key);
      const playerSockets = sockets.get(player.id);
      if (playerSockets) for (const socket of playerSockets) joinSocketRoom(socket, room);
    }
  }
  notifyQueuedPlayers(tier);
}

function queueForMultiplayer(socket, tier) {
  const userId = socket.data.userId;
  const existingKey = multiplayerMatches.get(userId);
  const existingRoom = existingKey && rooms.get(existingKey);
  if (existingRoom && existingRoom.players.has(userId)) {
    joinSocketRoom(socket, existingRoom);
    return;
  }
  if (existingKey) multiplayerMatches.delete(userId);

  if (!queuedPlayers.has(userId)) {
    queuedPlayers.set(userId, { id: userId, username: socket.data.username });
    const queue = multiplayerQueues.get(tier) || [];
    queue.push(userId);
    multiplayerQueues.set(tier, queue);
  }
  socket.data.gameMode = 'multiplayer';
  socket.data.roomKey = null;
  notifyQueuedPlayers(tier);
  startMatchesFromQueue(tier);
}

function leaveMatchmaking(userId, roomKey, io) {
  for (const queue of multiplayerQueues.values()) {
    const index = queue.indexOf(userId);
    if (index !== -1) { queue.splice(index, 1); queuedPlayers.delete(userId); }
  }

  const matchKey = multiplayerMatches.get(userId);
  if (!matchKey || matchKey !== roomKey) return;
  multiplayerMatches.delete(userId);
  const room = rooms.get(matchKey);
  if (!room) return;
  room.players.delete(userId);
  if (room.players.size === 0) {
    rooms.delete(matchKey);
    return;
  }
  io.to(matchKey).emit('roomState', {
    mode: 'multiplayer', tier: room.tier, status: 'active',
    players: serializePlayers(room), required: MULTIPLAYER_SIZE,
  });
}

// ---- bonus round ----
function startBonus(room, io) {
  room.bonusTimer = 30;
  room.bonusPicks = new Set();
  io.to(room.key).emit('bonusStart', { duration: 30 });
  io.to(room.key).emit('miniGame', { choices: [0, 1, 2], prompt: 'Pick a chest!' });
  setTimeout(() => {
    room.bonusTimer = 0;
    room.bonusPicks = null;
    io.to(room.key).emit('bonusEnd');
  }, 30000);
}

async function resolveMiniGame(userId, choiceIndex, io, room) {
  const r = Math.random();
  let prize;
  if (r < 0.70) prize = 50 + Math.floor(Math.random() * 151);
  else if (r < 0.95) prize = 300 + Math.floor(Math.random() * 401);
  else prize = 1000 + Math.floor(Math.random() * 2001);
  await win(userId, prize, room.statsKey, io, 'bonus');
  const set = sockets.get(userId);
  if (set) for (const s of set) s.emit('miniGameResult', { choice: choiceIndex, prize, win: prize });
}

// ---- economy helpers ----
async function bet(userId, amount, statsKey, io) {
  const r = await db.adjustPoints(userId, -amount, { type: 'bet', note: 'wager' });
  if (!r.ok) return { ok: false };
  await db.roomStatsAdd(statsKey, amount, 0);
  await jackpot.addRake(amount);
  await progression.processXp(userId, progression.XP_PER_SHOT, io, { wagered: amount });
  broadcastBalance(userId, r.balance);
  return { ok: true, balance: r.balance };
}

async function win(userId, amount, statsKey, io, note = 'payout') {
  const r = await db.adjustPoints(userId, amount, { type: 'win', note });
  if (r.ok) {
    await db.roomStatsAdd(statsKey, 0, amount);
    broadcastBalance(userId, r.balance);
  }
  return r;
}

function broadcastBalance(userId, balance) {
  const set = sockets.get(userId);
  if (set) for (const s of set) s.emit('balance', { points: Number(balance) || 0 });
}

// ---- fury / energy meter ----
// Charges as the player fires; pauses while fury is active. Emits meter updates
// (throttled) plus a one-shot 'furyReady' when full.
function addFury(socket) {
  if (!socket) return;
  if (socket.data.furyUntil && Date.now() < socket.data.furyUntil) return; // paused during fury
  const cur = Math.min(FURY.MAX, (socket.data.fury || 0) + FURY.PER_SHOT);
  socket.data.fury = cur;
  const now = Date.now();
  if (!socket.data.furyEmitAt || now - socket.data.furyEmitAt > 250 || cur >= FURY.MAX) {
    socket.data.furyEmitAt = now;
    socket.emit('furyMeter', { value: cur, max: FURY.MAX });
  }
  if (cur >= FURY.MAX && !socket.data.furyReadyNotified) {
    socket.data.furyReadyNotified = true;
    socket.emit('furyReady', {});
  }
}

// Current payout multiplier for a socket (FURY.MULT while active, else 1).
function furyMultFor(socket) {
  return (socket && socket.data.furyUntil && Date.now() < socket.data.furyUntil) ? FURY.MULT : 1;
}

function kickUser(userId, reason) {
  const set = sockets.get(userId);
  if (set) { for (const s of set) s.emit('banned', { reason }); for (const s of [...set]) s.disconnect(); }
}

// XP / counters / achievements for a real player kill.
async function recordKill(room, io, socket, userId, fish, payout) {
  const boss = !!fish.def.boss;
  const big = (fish.def.mult || 1) >= 30;
  const xp = progression.xpForKill(fish.def.mult, boss);
  await progression.processXp(userId, xp, io, { kill: 1, boss: boss ? 1 : 0, big: big ? 1 : 0, won: payout });
  if (socket) {
    const now = Date.now();
    socket.data.winStreak = (socket.data.lastKillAt && now - socket.data.lastKillAt < 60000)
      ? (socket.data.winStreak || 0) + 1
      : 1;
    socket.data.lastKillAt = now;
    if ((socket.data.winStreak % 5) === 0) await checkAchievements(userId, socket, { winStreak: socket.data.winStreak });
  }
  await checkAchievements(userId, socket, { boss, big });
}

async function checkAchievements(userId, socket, counters = {}) {
  const now = Date.now();
  const forced = counters.boss || counters.big || counters.winStreak;
  if (!forced && socket && socket.data.lastAchCheck && now - socket.data.lastAchCheck < 3000) return;
  if (socket) socket.data.lastAchCheck = now;
  try {
    const fresh = await achievements.check(userId, counters);
    if (fresh.length && socket) {
      for (const a of fresh) {
        const set = sockets.get(userId);
        if (set) for (const s of set) s.emit('achievement', a);
        broadcastBalance(userId, a.points);
      }
    }
  } catch (e) { console.error('[achievement check]', e && e.message); }
}

// ---- core kill handler ----
// winner: { type: 'player', id } | { type: 'bot', id }
// opts: { powerup: bool, socket, payoutOverride }
async function killFish(room, io, fish, pos, winner, betValue, opts = {}) {
  const isBot = winner.type === 'bot';
  let mult = fish.def.mult;
  if (fish.def.variable) mult = rng.rollVariableMult(fish.def);
  // FURY payout factor (<=1): during a feeding frenzy killRoll raises the catch
  // rate and returns a matching payoutFactor that trims each payout so EV stays
  // flat. Applied only to bet-scaled catches (never fixed powerup payouts, and
  // never to HP bosses, which bypass killRoll and pass no furyMult).
  const furyMult = opts.furyMult || 1;
  const p = opts.payoutOverride !== undefined ? opts.payoutOverride : Math.max(1, Math.round(mult * betValue * furyMult));

  let chain = null;
  if (fish.def.special === 'aoe' && !opts.powerup) {
    chain = [];
    for (const other of room.fish.values()) {
      if (other === fish || !other.alive || other.boss) continue;
      const op = fishPosition(other);
      if (!op) continue;
      if (Math.hypot(op.x - pos.x, op.y - pos.y) < 260) {
        other.alive = false;
        chain.push({ fishId: other.id, x: op.x, y: op.y });
      }
    }
  }

  let contributors = null;
  if (fish.def.sharedHp && !isBot) {
    const total = [...fish.damage.values()].reduce((s, v) => s + v, 0);
    if (total > 0) {
      contributors = [];
      for (const [uid, dmg] of fish.damage) {
        const share = dmg / total;
        if (share >= 0.05 && String(uid) !== String(winner.id)) {
          const bonus = Math.round((mult * (betValue || 0)) * share * 0.5);
          if (bonus > 0) contributors.push({ userId: uid, dmg, bonus });
        }
      }
    }
  }

  fish.alive = false;
  if (!isBot) {
    await win(winner.id, p, room.statsKey, io, fish.boss ? 'payout boss' : 'payout');
    if (contributors) {
      for (const c of contributors) await win(c.userId, c.bonus, room.statsKey, io, 'boss contribution');
    }
    await recordKill(room, io, opts.socket || null, winner.id, fish, p);
  }

  io.to(room.key).emit('kill', {
    fishId: fish.id, winnerId: winner.id, mult, payout: p, bet: betValue || 0,
    x: pos.x, y: pos.y, isAoE: !!chain, chain, variable: !!fish.def.variable,
    kind: fish.def.kind, name: fish.def.name, powerup: !!opts.powerup, contributors,
    fury: furyMult !== 1,
  });

  if (!isBot) {
    if (fish.def.special === 'bonus') {
      const bonusTrigger = await rng.bonusTriggerRoll(fish.def);
      if (bonusTrigger) startBonus(room, io);
    }
    try { await jackpot.tryWin(winner.id, io, room); } catch (e) { console.error('[jackpot]', e && e.message); }
  }

  room.fish.delete(fish.id);
  return { killed: true, mult, payout: p, contributors };
}

// clamp a weapon to the highest level the player's level unlocks
function clampWeapon(socket, wl) {
  const level = Number(socket.data.level) || 1;
  let maxUnlocked = 0;
  for (let i = 0; i < WEAPON_LEVELS.length; i++) {
    if (progression.weaponUnlockLevel(i) <= level) maxUnlocked = i;
  }
  return Math.max(0, Math.min(maxUnlocked, Number.isFinite(wl) ? wl : 0));
}

// ============================================================ module exports
module.exports = {
  attach(io) {
    io.on('connection', (socket) => {
      const hand = socket.handshake.auth || {};
      if (!hand.id) { socket.disconnect(); return; }
      const userId = hand.id;
      const role = hand.role;
      if (role !== 'player') {
        socket.emit('error', 'players-only');
        socket.disconnect();
        return;
      }
      if (hand.banned) { socket.emit('error', 'account-banned'); socket.disconnect(); return; }
      if (!sockets.has(userId)) sockets.set(userId, new Set());
      sockets.get(userId).add(socket);
      socket.data.userId = userId;
      socket.data.role = role;
      socket.data.username = hand.username;
      socket.data.level = Number(hand.level) || 1;
      const tier = Object.prototype.hasOwnProperty.call(ROOM_TIERS, hand.tier) ? hand.tier : 'mid';
      socket.data.tier = tier;
      if (hand.vipDenied) socket.emit('banner', { text: 'VIP tier requires more points — moved you to HIGH' });

      if (hand.gameMode === 'multiplayer') {
        queueForMultiplayer(socket, tier);
      } else {
        const room = getRoom(`solo:${tier}:${userId}`, {
          mode: 'solo',
          tier,
          players: [{ id: userId, username: hand.username }],
        });
        room.players.set(userId, { id: userId, username: hand.username });
        joinSocketRoom(socket, room);
      }

      // ---- single-target hit (STD, HEAVY weapons) ----
      socket.on('hit', async (data, ack) => {
        if (typeof ack !== 'function') ack = () => {};
        try {
          const room = currentRoom(socket);
          if (!room) return ack({ ok: false, reason: 'matchmaking' });
          const fid = parseInt(data && data.fishId, 10);
          const betValue = parseInt(data && data.bet, 10);
          const wl = clampWeapon(socket, parseInt(data && data.weaponLevel, 10) || 0);
          const weapon = WEAPON_LEVELS[wl] || WEAPON_LEVELS[0];
          if (!Number.isFinite(fid) || !Number.isFinite(betValue) || betValue <= 0) return ack({ ok: false });
          if (!ROOM_TIERS[room.tier].bets.includes(betValue)) return ack({ ok: false, reason: 'bet-tier' });
          const fish = room.fish.get(fid);
          if (!fish || !fish.alive) return ack({ ok: false, reason: 'gone' });
          const pos = fishPosition(fish);
          if (!pos) return ack({ ok: false, reason: 'gone' });
          if (pos.x < -120 || pos.x > W + 120 || pos.y < -120 || pos.y > H + 120) return ack({ ok: false, reason: 'gone' });

          const debit = await bet(userId, betValue, room.statsKey, io);
          if (!debit.ok) return ack({ ok: false, reason: 'broke' });
          addFury(socket);

          const dmg = effectiveDamage(betValue, fish.def.armor || 0, weapon.armorPierce || 0);

          // freeze effect (FROST weapon)
          if (weapon.type === 'freeze' && fish.frozen <= 0) {
            fish.frozen = (weapon.freezeDuration || 3) * 1000;
            fish.frozenAt = Date.now();
            io.to(room.key).emit('freeze', { fishId: fid, duration: weapon.freezeDuration || 3, x: pos.x, y: pos.y });
          }

          // shared boss HP
          if (fish.def.sharedHp) {
            fish.currentHp -= dmg;
            fish.hp += dmg;
            fish.damage.set(userId, (fish.damage.get(userId) || 0) + dmg);
            io.to(room.key).emit('bossDamage', { fishId: fid, hp: fish.currentHp, maxHp: fish.def.sharedHp, x: pos.x, y: pos.y, dmg });
            if (fish.currentHp > 0) {
              return ack({ ok: true, killed: false, dmg });
            }
            const result = await killFish(room, io, fish, pos, { type: 'player', id: userId }, betValue, { socket });
            return ack({ ok: true, ...result, near: false, dmg });
          }

          fish.hp += dmg;
          const { killed, near, payoutFactor } = await rng.killRoll(fish.def, dmg, { allowance: room.allowance, furyMult: furyMultFor(socket) });
          if (!killed && near) io.to(room.key).emit('nearmiss', { fishId: fid, x: pos.x, y: pos.y });
          if (!killed) return ack({ ok: true, killed: false, dmg });

          const result = await killFish(room, io, fish, pos, { type: 'player', id: userId }, betValue, { socket, furyMult: payoutFactor });
          ack({ ok: true, ...result, near: false, dmg });
        } catch (e) {
          console.error('[hit error]', e && e.message);
          ack({ ok: false, reason: 'error' });
        }
      });

      // ---- multi-target hit (SPREAD, PIERCE weapons) ----
      socket.on('multiHit', async (data, ack) => {
        if (typeof ack !== 'function') ack = () => {};
        try {
          const room = currentRoom(socket);
          if (!room) return ack({ ok: false, reason: 'matchmaking' });
          const fishIds = (data && data.fishIds) || [];
          const betValue = parseInt(data && data.bet, 10);
          const wl = clampWeapon(socket, parseInt(data && data.weaponLevel, 10) || 0);
          const weapon = WEAPON_LEVELS[wl] || WEAPON_LEVELS[0];
          if (weapon.type !== 'spread' && weapon.type !== 'pierce') return ack({ ok: false, reason: 'weapon' });
          if (!Number.isFinite(betValue) || betValue <= 0 || !Array.isArray(fishIds) || fishIds.length === 0) return ack({ ok: false });
          if (!ROOM_TIERS[room.tier].bets.includes(betValue)) return ack({ ok: false, reason: 'bet-tier' });
          const uniqueIds = [...new Set(fishIds.map(id => parseInt(id, 10)).filter(Number.isFinite))];
          const maxTargets = weapon.type === 'spread' ? (weapon.spreadCount || 3) : (weapon.pierceTargets || 5);
          if (uniqueIds.length === 0 || uniqueIds.length > maxTargets) return ack({ ok: false, reason: 'targets' });

          const debit = await bet(userId, betValue, room.statsKey, io);
          if (!debit.ok) return ack({ ok: false, reason: 'broke' });
          addFury(socket);
          const fMult = furyMultFor(socket);

          const results = [];
          for (const id of uniqueIds) {
            const fish = room.fish.get(id);
            if (!fish || !fish.alive) continue;
            const pos = fishPosition(fish);
            if (!pos) continue;
            if (pos.x < -120 || pos.x > W + 120 || pos.y < -120 || pos.y > H + 120) continue;

            const dmg = effectiveDamage(betValue, fish.def.armor || 0, weapon.armorPierce || 0);

            // freeze effect
            if (weapon.type === 'freeze' && fish.frozen <= 0) {
              fish.frozen = (weapon.freezeDuration || 3) * 1000;
              fish.frozenAt = Date.now();
              io.to(room.key).emit('freeze', { fishId: id, duration: weapon.freezeDuration || 3, x: pos.x, y: pos.y });
            }

            fish.hp += dmg;

            // shared boss HP
            if (fish.def.sharedHp) {
              fish.currentHp -= dmg;
              fish.damage.set(userId, (fish.damage.get(userId) || 0) + dmg);
              io.to(room.key).emit('bossDamage', { fishId: id, hp: fish.currentHp, maxHp: fish.def.sharedHp, x: pos.x, y: pos.y, dmg });
              if (fish.currentHp <= 0) {
                const result = await killFish(room, io, fish, pos, { type: 'player', id: userId }, betValue, { socket });
                results.push({ fishId: id, ...result });
              }
              continue;
            }

            const { killed, near, payoutFactor } = await rng.killRoll(fish.def, dmg, { allowance: room.allowance, furyMult: fMult });
            if (!killed && near) io.to(room.key).emit('nearmiss', { fishId: id, x: pos.x, y: pos.y });
            if (killed) {
              const result = await killFish(room, io, fish, pos, { type: 'player', id: userId }, betValue, { socket, furyMult: payoutFactor });
              results.push({ fishId: id, ...result });
            } else {
              results.push({ fishId: id, killed: false, dmg });
            }
          }
          ack({ ok: true, results });
        } catch (e) {
          console.error('[multiHit error]', e && e.message);
          ack({ ok: false, reason: 'error' });
        }
      });

      socket.on('fire', async (data, ack) => {
        if (typeof ack !== 'function') ack = () => {};
        if (!currentRoom(socket)) return ack({ ok: false, reason: 'matchmaking' });
        const now = Date.now();
        const last = socket.data.lastFire || 0;
        const wl = clampWeapon(socket, Number.isFinite(data && data.weaponLevel) ? data.weaponLevel : 0);
        const fireMult = WEAPON_LEVELS[wl].fireMult;
        const minGap = FIRE_INTERVAL * fireMult * 1000 * 0.7;
        if (now - last < minGap) return ack({ ok: false, reason: 'toofast' });
        socket.data.lastFire = now;
        ack({ ok: true, weaponLevel: wl });
      });

      socket.on('selectWeapon', (lvl) => {
        const wl = clampWeapon(socket, parseInt(lvl, 10) || 0);
        socket.data.weaponLevel = wl;
        socket.emit('weapon', wl);
      });

      // ---- fury / energy meter ----
      socket.on('activateFury', (ack) => {
        if (typeof ack !== 'function') ack = () => {};
        const now = Date.now();
        if ((socket.data.fury || 0) < FURY.MAX) return ack({ ok: false, reason: 'not-ready' });
        if (socket.data.furyUntil && now < socket.data.furyUntil) return ack({ ok: false, reason: 'active' });
        socket.data.fury = 0;
        socket.data.furyReadyNotified = false;
        socket.data.furyUntil = now + FURY.MS;
        socket.emit('furyStart', { ms: FURY.MS, mult: FURY.MULT });
        socket.emit('furyMeter', { value: 0, max: FURY.MAX });
        setTimeout(() => {
          if (socket.data.furyUntil && Date.now() >= socket.data.furyUntil) {
            socket.data.furyUntil = 0;
            socket.emit('furyEnd', {});
          }
        }, FURY.MS + 50);
        ack({ ok: true, ms: FURY.MS, mult: FURY.MULT });
      });

      socket.on('miniGamePick', (choice) => {
        const room = currentRoom(socket);
        const pick = parseInt(choice, 10);
        if (!room || room.bonusTimer <= 0 || !Number.isInteger(pick) || pick < 0 || pick > 2) return;
        if (room.bonusPicks && room.bonusPicks.has(userId)) return;
        if (room.bonusPicks) room.bonusPicks.add(userId);
        resolveMiniGame(userId, pick, io, room);
      });

      // ---- power-ups ----
      socket.on('usePowerup', async (data, ack) => {
        if (typeof ack !== 'function') ack = () => {};
        try {
          const room = currentRoom(socket);
          if (!room) return ack({ ok: false, reason: 'matchmaking' });
          const key = String((data && data.key) || '');
          if (!powerups.POWERUPS.some(p => p.key === key)) return ack({ ok: false, reason: 'unknown' });
          const now = Date.now();
          if (socket.data.lastPowerupAt && now - socket.data.lastPowerupAt < 2000) return ack({ ok: false, reason: 'cooldown' });

          const consume = await db.consumePowerup(userId, key);
          if (!consume.ok) return ack({ ok: false, reason: 'none' });
          socket.data.lastPowerupAt = now;
          socket.emit('powerups', consume.powerups);

          if (key === 'freeze') {
            const nowMs = Date.now();
            for (const f of room.fish.values()) {
              if (!f.alive) continue;
              f.frozen = 3000;
              f.frozenAt = nowMs;
            }
            io.to(room.key).emit('freezeAll', { duration: 3 });
            return ack({ ok: true });
          }

          const x = Number(data.x), y = Number(data.y);
          let targets = [];
          if (key === 'laser') {
            const fid = parseInt(data.fishId, 10);
            const fish = room.fish.get(fid);
            if (!fish || !fish.alive || fish.boss) return ack({ ok: false, reason: 'target' });
            const pos = fishPosition(fish);
            if (!pos) return ack({ ok: false, reason: 'target' });
            targets = [{ fish, pos }];
          } else {
            const max = key === 'chain' ? powerups.MAX_CHAIN_TARGETS : powerups.MAX_AOE_TARGETS;
            const scored = [];
            for (const f of room.fish.values()) {
              if (!f.alive || f.boss) continue;
              const op = fishPosition(f);
              if (!op) continue;
              const d = Math.hypot(op.x - x, op.y - y);
              if (d < powerups.MAX_AOE_RADIUS) scored.push({ fish: f, pos: op, d });
            }
            scored.sort((a, b) => a.d - b.d);
            targets = scored.slice(0, max);
          }

          const kills = [];
          let total = 0;
          for (const t of targets) {
            const payout = Math.min(powerups.BASE_UNIT * t.fish.def.mult, powerups.MAX_TOTAL_PAYOUT - total);
            if (payout <= 0) continue;
            const r = await killFish(room, io, t.fish, t.pos, { type: 'player', id: userId }, 0, { powerup: true, socket, payoutOverride: payout });
            total += r.payout;
            kills.push({ fishId: t.fish.id, mult: r.mult, payout: r.payout });
          }
          io.to(room.key).emit('powerup', { key, x, y, kills });
          ack({ ok: true, kills, total });
        } catch (e) {
          console.error('[powerup error]', e && e.message);
          ack({ ok: false, reason: 'error' });
        }
      });

      // ---- chat ----
      socket.on('chat', async (data) => {
        try {
          const room = currentRoom(socket);
          if (!room) return;
          const text = String((data && data.message) || '').trim().slice(0, 200);
          if (!text) return;
          const now = Date.now();
          if (socket.data.lastChatAt && now - socket.data.lastChatAt < 1500) return;
          socket.data.lastChatAt = now;
          await db.insertChat(userId, room.key, text);
          io.to(room.key).emit('chatMsg', { user: socket.data.username, text, at: now });
        } catch (e) { console.error('[chat]', e && e.message); }
      });

      socket.on('disconnect', () => {
        const set = sockets.get(userId);
        if (!set) return;
        set.delete(socket);
        if (set.size > 0) return;
        sockets.delete(userId);
        const roomKey = socket.data.roomKey;
        if (socket.data.gameMode === 'multiplayer') {
          leaveMatchmaking(userId, roomKey, io);
          return;
        }
        const room = roomKey && rooms.get(roomKey);
        if (room && room.mode === 'solo') {
          room.players.delete(userId);
          if (room.players.size === 0) rooms.delete(room.key);
        }
      });
    });
  },

  broadcastBalance,
  kickUser,
  invalidateSettings() { rng.invalidate(); },

  startTick(io) {
    if (this._tickHandle) return;
    this._tickHandle = setInterval(() => tickAll(io), TICK_MS);
    jackpot.startFlusher();
  },

  serializeFish,
  spawnFish,
  pickSpecies,
};

// ============================================================ room tick
function tickAll(io) {
  for (const room of rooms.values()) {
    roomTick(room, io);
    roomController(room);
  }
}

function roomTick(room, io) {
  const now = Date.now();
  const dt = TICK_MS / 1000;

  for (const [id, f] of room.fish) {
    if (!f.alive) { room.fish.delete(id); continue; }
    // tick freeze
    if (f.frozen > 0) {
      f.frozen -= TICK_MS;
      if (f.frozen <= 0) {
        f.frozen = 0;
        const frozenT = (f.frozenAt - f.tStart) / f.dur;
        f.tStart = now - frozenT * f.dur;
      }
    }
    const elapsed = (now - f.tStart) / f.dur;
    if (elapsed >= 1.05) { room.fish.delete(id); io.to(room.key).emit('despawn', { fishId: id }); }
  }

  // AI practice opponents (solo rooms)
  if (room.bots && room.bots.length > 0) botTick(room, io, dt);

  // spawn regular fish
  room.spawnTimer -= dt;
  const aliveCount = [...room.fish.values()].filter(f => f.alive && !f.boss).length;
  const target = room.bonusTimer > 0 ? 22 : 16;
  if (room.spawnTimer <= 0 && aliveCount < target + 6) {
    const f = spawnFish(room, pickSpecies());
    io.to(room.key).emit('spawn', serializeFish(f));
    room.spawnTimer = aliveCount < target ? (0.15 + Math.random() * 0.35) : (0.7 + Math.random() * 0.9);
  }

  // boss cadence
  room.bossTimer -= dt;
  if (room.bossTimer <= 0 && ![...room.fish.values()].some(f => f.boss)) {
    const f = spawnBoss(room);
    io.to(room.key).emit('spawn', serializeFish(f));
    io.to(room.key).emit('banner', { text: '⚠ ' + f.def.name + ' ⚠' });
    if (f.def.sharedHp) io.to(room.key).emit('bossHp', { fishId: f.id, hp: f.currentHp, maxHp: f.def.sharedHp, name: f.def.name });
    room.bossTimer = 60 + Math.random() * 30;
  }

  // bonus timer
  if (room.bonusTimer > 0) room.bonusTimer -= dt;

  // refresh jackpot pool display periodically
  room.jackpotTimer -= dt;
  if (room.jackpotTimer <= 0) {
    room.jackpotTimer = 4;
    jackpot.get().then(j => io.to(room.key).emit('jackpotState', { pool: j.pool })).catch(() => {});
  }
}

// Bots are cosmetic competitors: they fight the same fish as the player but
// their wagers/payouts never touch the ledger or the RTP stats.
function botTick(room, io, dt) {
  for (const bot of room.bots) {
    bot.cooldown -= dt;
    if (bot.cooldown > 0) continue;
    bot.cooldown = 0.7 + Math.random() * 1.4;
    const targets = [...room.fish.values()].filter(f => f.alive && !f.boss && (f.def.mult || 0) <= 60);
    if (targets.length === 0) continue;
    const fish = targets[Math.floor(Math.random() * targets.length)];
    const pos = fishPosition(fish);
    if (!pos) continue;
    const dmg = effectiveDamage(bot.bet, fish.def.armor || 0, 0);
    fish.hp += dmg;
    const angle = Math.atan2(pos.y - (H - 40), (W / 2 + (Math.random() * 300 - 150)) - pos.x) + Math.PI;
    io.to(room.key).emit('botShot', { x: pos.x, y: pos.y, angle, color: bot.color });
    rng.killRoll(fish.def, dmg, room).then(({ killed }) => {
      if (killed) killFish(room, io, fish, pos, { type: 'bot', id: bot.id }, bot.bet, {}).catch(() => {});
    }).catch(() => {});
  }
}

async function roomController(room) {
  room.stateTimer -= TICK_MS / 1000;
  if (room.stateTimer > 0) return;
  room.stateTimer = 2;
  try {
    const stats = await db.roomStatsGet(room.statsKey);
    const s = await rng.loadSettings();
    room.allowance = rng.computeAllowance(stats, s.rtp, room.allowance);
  } catch (e) { /* ignore */ }
}
