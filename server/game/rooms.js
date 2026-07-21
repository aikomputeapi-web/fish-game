/* rooms.js — server-authoritative game room engine.
   Spawns fish on parametric paths, validates hits/score on demand, runs the
   death-check + RTP allowance controller, triggers bonus rounds + AoE chains,
   and pushes balance/kill/spawn events to clients.

   Features: armor damage reduction, 5 unique weapon types (single/spread/
   pierce/freeze/heavy), shared boss HP pools, freeze status effects. */
'use strict';

const db = require('../db');
const { W, H, WEAPON_LEVELS, BETS, FIRE_INTERVAL } = require('./constants');
const { FISH, BOSS, VARIABLE_BOSSES } = require('./fishTypes');
const { makePath, makeBossPath, bezier, bezierTangent, pathLength } = require('./paths');
const rng = require('./rng');

const TICK_MS = 500;
const MULTIPLAYER_SIZE = 4;

const TOTAL_WEIGHT = FISH.reduce((s, x) => s + x.weight, 0);

const rooms = new Map();   // roomKey -> Room
const sockets = new Map(); // userId -> Set<socket>
const multiplayerQueue = []; // unique user ids, matched in arrival order
const queuedPlayers = new Map(); // userId -> { id, username }
const multiplayerMatches = new Map(); // userId -> roomKey
let nextMatchId = 1;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function getRoom(key, opts = {}) {
  let r = rooms.get(key);
  if (!r) { r = createRoom(key, opts); rooms.set(key, r); }
  return r;
}

function createRoom(key, { mode = 'solo', players = [] } = {}) {
  return {
    key,
    mode,
    statsKey: mode,
    players: new Map(players.map(player => [player.id, player])),
    fish: new Map(),
    nextId: 1,
    spawnTimer: 0,
    bossTimer: 45,
    bonusTimer: 0,
    allowance: 1.0,
    stateTimer: 0,
  };
}

function pickSpecies() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const s of FISH) { roll -= s.weight; if (roll <= 0) return s; }
  return FISH[0];
}

function spawnFish(room, def, opts = {}) {
  const path = opts.path || makePath(def.r || 20);
  const speed = (def.speed || 100) * (0.85 + Math.random() * 0.3);
  const dur = pathLength(path) / speed;
  const id = room.nextId++;
  const f = {
    id, def, path,
    tStart: Date.now(),
    dur: dur * 1000,
    alive: true,
    hp: 0,
    currentHp: def.sharedHp || 0,
    frozen: 0,
    frozenAt: 0,
  };
  room.fish.set(id, f);
  return f;
}

function spawnBoss(room) {
  let def;
  if (Math.random() < 0.25) {
    def = VARIABLE_BOSSES[Math.floor(Math.random() * VARIABLE_BOSSES.length)];
  } else {
    def = BOSS;
  }
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
    mode: room.mode,
    status,
    reset: true,
    players: serializePlayers(room),
    required: room.mode === 'multiplayer' ? MULTIPLAYER_SIZE : 1,
  });
}

function joinSocketRoom(socket, room) {
  if (socket.data.roomKey && socket.data.roomKey !== room.key) socket.leave(socket.data.roomKey);
  socket.join(room.key);
  socket.data.roomKey = room.key;
  socket.data.gameMode = room.mode;
  emitRoomState(socket, room);
  for (const f of room.fish.values()) {
    socket.emit('spawn', serializeFish(f));
    if (f.boss && f.def.sharedHp) {
      socket.emit('bossHp', { fishId: f.id, hp: f.currentHp, maxHp: f.def.sharedHp, name: f.def.name });
    }
  }
}

function notifyQueuedPlayers() {
  multiplayerQueue.forEach((userId, index) => {
    const playerSockets = sockets.get(userId);
    if (!playerSockets) return;
    const status = {
      mode: 'multiplayer',
      status: 'waiting',
      reset: true,
      position: index + 1,
      queued: multiplayerQueue.length,
      required: MULTIPLAYER_SIZE,
    };
    for (const socket of playerSockets) socket.emit('roomState', status);
  });
}

function startMatchesFromQueue() {
  while (multiplayerQueue.length >= MULTIPLAYER_SIZE) {
    const playerIds = multiplayerQueue.splice(0, MULTIPLAYER_SIZE);
    const players = playerIds.map(id => queuedPlayers.get(id)).filter(Boolean);
    if (players.length !== MULTIPLAYER_SIZE) continue;
    for (const player of players) queuedPlayers.delete(player.id);

    const room = getRoom(`multiplayer:${nextMatchId++}`, { mode: 'multiplayer', players });
    for (const player of players) {
      multiplayerMatches.set(player.id, room.key);
      const playerSockets = sockets.get(player.id);
      if (playerSockets) for (const socket of playerSockets) joinSocketRoom(socket, room);
    }
  }
  notifyQueuedPlayers();
}

function queueForMultiplayer(socket) {
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
    multiplayerQueue.push(userId);
  }
  socket.data.gameMode = 'multiplayer';
  socket.data.roomKey = null;
  notifyQueuedPlayers();
  startMatchesFromQueue();
}

function leaveMatchmaking(userId, roomKey, io) {
  const queueIndex = multiplayerQueue.indexOf(userId);
  if (queueIndex !== -1) {
    multiplayerQueue.splice(queueIndex, 1);
    queuedPlayers.delete(userId);
    notifyQueuedPlayers();
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
    mode: 'multiplayer',
    status: 'active',
    players: serializePlayers(room),
    required: MULTIPLAYER_SIZE,
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
  await win(userId, prize, room.statsKey);
  const set = sockets.get(userId);
  if (set) for (const s of set) s.emit('miniGameResult', { choice: choiceIndex, prize, win: prize });
}

// ---- economy helpers ----
async function bet(userId, amount, statsKey) {
  const r = await db.adjustPoints(userId, -amount, { type: 'bet', note: 'wager' });
  if (!r.ok) return { ok: false };
  await db.roomStatsAdd(statsKey, amount, 0);
  broadcastBalance(userId, r.balance);
  return { ok: true, balance: r.balance };
}

async function win(userId, amount, statsKey) {
  const r = await db.adjustPoints(userId, amount, { type: 'win', note: 'payout' });
  if (r.ok) {
    await db.roomStatsAdd(statsKey, 0, amount);
    broadcastBalance(userId, r.balance);
  }
  return r;
}

function broadcastBalance(userId, balance) {
  const set = sockets.get(userId);
  if (set) for (const s of set) s.emit('balance', { points: balance });
}

function kickUser(userId, reason) {
  const set = sockets.get(userId);
  if (set) { for (const s of set) s.emit('banned', { reason }); for (const s of [...set]) s.disconnect(); }
}

// ---- shared boss HP kill logic ----
async function handleBossKill(fish, userId, betValue, pos, room, io, weapon) {
  fish.alive = false;
  let mult = fish.def.mult;
  if (fish.def.variable) mult = rng.rollVariableMult(fish.def);
  const payout = mult * betValue;
  await win(userId, payout, room.statsKey);
  io.to(room.key).emit('kill', {
    fishId: fish.id, winnerId: userId, mult, payout, bet: betValue,
    x: pos.x, y: pos.y, isAoE: false, chain: null,
    variable: !!fish.def.variable, kind: fish.def.kind, name: fish.def.name,
  });
  room.fish.delete(fish.id);
  return { killed: true, mult, payout };
}

// ---- normal fish kill logic (with AoE chain) ----
async function handleNormalKill(fish, userId, betValue, pos, room, io) {
  fish.alive = false;
  let mult = fish.def.mult;
  if (fish.def.variable) mult = rng.rollVariableMult(fish.def);
  const payout = mult * betValue;
  let chain = null;
  if (fish.def.special === 'aoe') {
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
  const bonusTrigger = await rng.bonusTriggerRoll(fish.def);
  await win(userId, payout, room.statsKey);
  io.to(room.key).emit('kill', {
    fishId: fish.id, winnerId: userId, mult, payout, bet: betValue,
    x: pos.x, y: pos.y, isAoE: !!chain, chain, variable: !!fish.def.variable,
    kind: fish.def.kind, name: fish.def.name,
  });
  if (bonusTrigger) startBonus(room, io);
  room.fish.delete(fish.id);
  return { killed: true, mult, payout };
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

      if (hand.gameMode === 'multiplayer') {
        queueForMultiplayer(socket);
      } else {
        const room = getRoom(`solo:${userId}`, {
          mode: 'solo',
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
          const wl = parseInt(data && data.weaponLevel, 10) || 0;
          const weapon = WEAPON_LEVELS[wl] || WEAPON_LEVELS[0];
          if (!Number.isFinite(fid) || !Number.isFinite(betValue) || betValue <= 0) return ack({ ok: false });
          const fish = room.fish.get(fid);
          if (!fish || !fish.alive) return ack({ ok: false, reason: 'gone' });
          const pos = fishPosition(fish);
          if (!pos) return ack({ ok: false, reason: 'gone' });
          if (pos.x < -120 || pos.x > W + 120 || pos.y < -120 || pos.y > H + 120) return ack({ ok: false, reason: 'gone' });

          const debit = await bet(userId, betValue, room.statsKey);
          if (!debit.ok) return ack({ ok: false, reason: 'broke' });

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
            io.to(room.key).emit('bossDamage', { fishId: fid, hp: fish.currentHp, maxHp: fish.def.sharedHp, x: pos.x, y: pos.y, dmg });
            if (fish.currentHp > 0) {
              return ack({ ok: true, killed: false, dmg });
            }
            const result = await handleBossKill(fish, userId, betValue, pos, room, io, weapon);
            return ack({ ok: true, ...result, near: false, dmg });
          }

          fish.hp += dmg;
          const { killed, near } = await rng.killRoll(fish.def, dmg, room);
          if (!killed && near) io.to(room.key).emit('nearmiss', { fishId: fid, x: pos.x, y: pos.y });
          if (!killed) return ack({ ok: true, killed: false, dmg });

          const result = await handleNormalKill(fish, userId, betValue, pos, room, io);
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
          const wl = parseInt(data && data.weaponLevel, 10) || 0;
          const weapon = WEAPON_LEVELS[wl] || WEAPON_LEVELS[0];
          if (weapon.type !== 'spread' && weapon.type !== 'pierce') return ack({ ok: false, reason: 'weapon' });
          if (!Number.isFinite(betValue) || betValue <= 0 || !Array.isArray(fishIds) || fishIds.length === 0) return ack({ ok: false });
          const uniqueIds = [...new Set(fishIds.map(id => parseInt(id, 10)).filter(Number.isFinite))];
          const maxTargets = weapon.type === 'spread' ? (weapon.spreadCount || 3) : (weapon.pierceTargets || 5);
          if (uniqueIds.length === 0 || uniqueIds.length > maxTargets) return ack({ ok: false, reason: 'targets' });

          const debit = await bet(userId, betValue, room.statsKey);
          if (!debit.ok) return ack({ ok: false, reason: 'broke' });

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
              io.to(room.key).emit('bossDamage', { fishId: id, hp: fish.currentHp, maxHp: fish.def.sharedHp, x: pos.x, y: pos.y, dmg });
              if (fish.currentHp <= 0) {
                const result = await handleBossKill(fish, userId, betValue, pos, room, io, weapon);
                results.push({ fishId: id, ...result });
              }
              continue;
            }

            const { killed, near } = await rng.killRoll(fish.def, dmg, room);
            if (!killed && near) io.to(room.key).emit('nearmiss', { fishId: id, x: pos.x, y: pos.y });
            if (killed) {
              const result = await handleNormalKill(fish, userId, betValue, pos, room, io);
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
        const wl = (data && Number.isFinite(data.weaponLevel)) ? Math.max(0, Math.min(WEAPON_LEVELS.length - 1, data.weaponLevel)) : 0;
        const fireMult = WEAPON_LEVELS[wl].fireMult;
        const minGap = FIRE_INTERVAL * fireMult * 1000 * 0.7;
        if (now - last < minGap) return ack({ ok: false, reason: 'toofast' });
        socket.data.lastFire = now;
        ack({ ok: true, weaponLevel: wl });
      });

      socket.on('selectWeapon', (lvl) => {
        socket.data.weaponLevel = Math.max(0, Math.min(WEAPON_LEVELS.length - 1, parseInt(lvl, 10) || 0));
        socket.emit('weapon', socket.data.weaponLevel);
      });

      socket.on('miniGamePick', (choice) => {
        const room = currentRoom(socket);
        const pick = parseInt(choice, 10);
        if (!room || room.bonusTimer <= 0 || !Number.isInteger(pick) || pick < 0 || pick > 2) return;
        if (room.bonusPicks && room.bonusPicks.has(userId)) return;
        if (room.bonusPicks) room.bonusPicks.add(userId);
        resolveMiniGame(userId, pick, io, room);
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
