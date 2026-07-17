/* rooms.js — server-authoritative game room engine.
   Spawns fish on parametric paths, validates hits/score on demand, runs the
   death-check + RTP allowance controller, triggers bonus rounds + AoE chains,
   and pushes balance/kill/spawn events to clients. Solo room now; the same path
   broadcast would support shared tables later. */
'use strict';

const { W, H, WEAPON_LEVELS, BETS, FIRE_INTERVAL } = require('./constants');
const { FISH, BOSS, VARIABLE_BOSSES } = require('./fishTypes');
const { makePath, makeBossPath, bezier, pathLength } = require('./paths');
const rng = require('./rng');
const paths = require('./paths');

const TOTAL_WEIGHT = FISH.reduce((s, x) => s + x.weight, 0);

const rooms = new Map();   // roomKey -> Room
const sockets = new Map(); // userId -> Set<socket>

function getRoom(key = 'default') {
  let r = rooms.get(key);
  if (!r) { r = createRoom(key); rooms.set(key, r); }
  return r;
}

function createRoom(key) {
  const r = {
    key,
    fish: new Map(),     // fishId -> { def, path, tStart, dur, x, y, alive }
    nextId: 1,
    spawnTimer: 0,
    bossTimer: 45,
    spawnAccs: {},
    bonusTimer: 0,       // >0 = bonus active
    allowance: 1.0,      // RTP allowance (controller)
    stateTimer: 0,
    spawnBossPending: false,
  };
  return r;
}

function pickSpecies() {
  let roll = Math.random() * TOTAL_WEIGHT;
  for (const s of FISH) { roll -= s.weight; if (roll <= 0) return s; }
  return FISH[0];
}

function spawnFish(room, def, opts = {}) {
  const path = opts.path || paths.makePath(def.r || 20);
  const speed = (def.speed || 100) * (0.85 + Math.random() * 0.3);
  const dur = pathLength(path) / speed;
  const id = room.nextId++;
  const f = {
    id, def, path,
    tStart: Date.now(),
    dur: dur * 1000,        // ms
    x: path[0].x, y: path[0].y,
    alive: true,
    hp: 0,                  // cosmetic HP accumulator
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

// compute current position of a fish by time (parametric)
function fishPosition(f, now = Date.now()) {
  const elapsed = (now - f.tStart) / f.dur;
  if (elapsed >= 1) return null;       // off-screen
  const p = bezier(f.path, rng.clamp(elapsed, 0, 1));
  return p;
}

// ============================================================ socket handlers
module.exports = {
  attach(io) {
    io.on('connection', (socket) => {
      // attach authenticated user from handshake
      const hand = socket.handshake.auth || {};
      if (!hand.id) { socket.disconnect(); return; }
      const userId = hand.id;
      const role = hand.role;
      if (role === 'manager') {
        socket.emit('error', 'managers-cannot-play');
        socket.disconnect();
        return;
      }
      if (hand.banned) { socket.emit('error', 'account-banned'); socket.disconnect(); return; }
      if (!sockets.has(userId)) sockets.set(userId, new Set());
      sockets.get(userId).add(socket);
      socket.data.userId = userId;
      socket.data.role = role;

      const room = getRoom('default');
      socket.join(room.key);
      socket.data.roomKey = room.key;

      // replay current fish to the new client
      for (const f of room.fish.values()) {
        socket.emit('spawn', serializeFish(f));
      }

      socket.on('hit', async (data, ack) => {
        if (typeof ack !== 'function') ack = () => {};
        try {
          const fid = parseInt(data && data.fishId, 10);
          const betValue = parseInt(data && data.bet, 10);
          const boss = role === 'owner';
          if (!Number.isFinite(fid) || !Number.isFinite(betValue) || betValue <= 0) return ack({ ok: false });
          const fish = room.fish.get(fid);
          if (!fish || !fish.alive) return ack({ ok: false, reason: 'gone' });
          const pos = fishPosition(fish);
          if (!pos) return ack({ ok: false, reason: 'gone' });
          // quick sanity: fish must be reasonably on-screen
          if (pos.x < -120 || pos.x > W + 120 || pos.y < -120 || pos.y > H + 120) return ack({ ok: false, reason: 'gone' });

          // bullet validated & debited *once* at fire time on the server (we keep
          // an optimistic model: bet is debited server-side here before the roll;
          // the client already moved its balance optimistically at fire).
          const debit = await mod.bet(userId, betValue);
          if (!debit.ok) return ack({ ok: false, reason: 'broke' });

          fish.hp += betValue; // cosmetic accumulation
          const { killed, near, p } = await rng.killRoll(fish.def, betValue, room);
          if (!killed && near) io.to(room.key).emit('nearmiss', { fishId: fid, x: pos.x, y: pos.y });
          if (!killed) {
            return ack({ ok: true, killed: false });
          }
          // ---- KILL ----
          fish.alive = false;
          let mult = fish.def.mult;
          if (fish.def.variable) mult = rng.rollVariableMult(fish.def);
          let payout = mult * betValue;
          // AoE chain: visually clears nearby fish; player paid the single bundled mult
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
          // bonus trigger?
          let bonusTrigger = await rng.bonusTriggerRoll(fish.def);
          const killEvent = {
            fishId: fid, winnerId: userId, mult, payout, bet: betValue,
            x: pos.x, y: pos.y, isAoE: !!chain, chain, variable: !!fish.def.variable,
            kind: fish.def.kind, name: fish.def.name,
          };
          // credit the win
          await mod.win(userId, payout);
          io.to(room.key).emit('kill', killEvent);
          if (bonusTrigger) startBonus(room, io);
          room.fish.delete(fid);
          ack({ ok: true, killed: true, mult, payout, near: false });
        } catch (e) {
          console.error('[hit error]', e && e.message);
          ack({ ok: false, reason: 'error' });
        }
      });

      socket.on('fire', async (data, ack) => {
        // server-side fire-rate cap per socket (defends against spam)
        if (typeof ack !== 'function') ack = () => {};
        const now = Date.now();
        const last = socket.data.lastFire || 0;
        const wl = (data && Number.isFinite(data.weaponLevel)) ? Math.max(0, Math.min(WEAPON_LEVELS.length - 1, data.weaponLevel)) : 0;
        const fireMult = WEAPON_LEVELS[wl].fireMult;
        const minGap = FIRE_INTERVAL * fireMult * 1000 * 0.7;
        if (now - last < minGap) return ack({ ok: false, reason: 'toofast' });
        socket.data.lastFire = now;
        // bet for this fire = base beat * weapon costMult (but the actual debit
        // happens on hit to keep one atomic path; here we just ack OK so the
        // client renders the bullet). Balance is debited per hit.
        ack({ ok: true, weaponLevel: wl });
      });

      socket.on('selectWeapon', (lvl) => {
        socket.data.weaponLevel = Math.max(0, Math.min(WEAPON_LEVELS.length - 1, parseInt(lvl, 10) || 0));
        socket.emit('weapon', socket.data.weaponLevel);
      });

      socket.on('disconnect', () => {
        const set = sockets.get(userId);
        if (set) { set.delete(socket); if (set.size === 0) sockets.delete(userId); }
      });
    });
  },

  broadcastBalance(userId, balance) {
    const set = sockets.get(userId);
    if (set) for (const s of set) s.emit('balance', { points: balance });
  },

  kickUser(userId, reason) {
    const set = sockets.get(userId);
    if (set) { for (const s of set) s.emit('banned', { reason }); set.forEach(s => s.disconnect()); sockets.delete(userId); }
  },

  invalidateSettings() { rng.invalidate(); },
};

// bonus round: high-volatility surge for ~30s; capped by RTP loop overall
function startBonus(room, io) {
  room.bonusTimer = 30;
  io.to(room.key).emit('bonusStart', { duration: 30 });
  // mini-game: pick one of 3 chests. Server pre-decides prize from RTP-controlled dist.
  // (player triggers are broadcast; each player gets one mini-game pick via REST-ish protocol.)
  io.to(room.key).emit('miniGame', { choices: [0, 1, 2], prompt: 'Pick a chest!' });
  setTimeout(() => {
    room.bonusTimer = 0;
    io.to(room.key).emit('bonusEnd');
  }, 30000);
}

// a player picks a chest -> server rolls prize, credits, broadcasts result
async function resolveMiniGame(userId, choiceIndex, io) {
  // prize distribution: EV bounded by RTP; choices cosmetic (equal EV).
  // 70% small (50-200), 25% medium (300-700), 5% huge (1000-3000)
  const r = Math.random();
  let prize;
  if (r < 0.70) prize = 50 + Math.floor(Math.random() * 151);
  else if (r < 0.95) prize = 300 + Math.floor(Math.random() * 401);
  else prize = 1000 + Math.floor(Math.random() * 2001);
  await mod.win(userId, prize);
  const set = sockets.get(userId);
  if (set) for (const s of set) s.emit('miniGameResult', { choice: choiceIndex, prize, win: prize });
  // mini-game prizes are treated as bonus wins (counted in roomStats paid)
  const room = getRoom('default');
  await db.roomStatsAdd(room.key, 0, prize);
}

const mod = module.exports;
mod.resolveMiniGame = resolveMiniGame;

// ============================================================ room tick
// a server-side interval spawns fish and periodically recomputes the allowance.
const db = require('../db');

function serializeFish(f) {
  return {
    fishId: f.id, typeId: f.def.id, def: stripDef(f.def),
    path: f.path, age: Date.now() - f.tStart, dur: f.dur, boss: !!f.boss,
  };
}
function stripDef(def) {
  const d = { ...def };
  return d;
}

function tickAll(io) {
  for (const room of rooms.values()) {
    roomSpawn(room, io);
    roomController(room);
  }
}

function roomSpawn(room, io) {
  // despawn fish that have left the screen
  const now = Date.now();
  for (const [id, f] of room.fish) {
    if (!f.alive) { room.fish.delete(id); continue; }
    const elapsed = (now - f.tStart) / f.dur;
    if (elapsed >= 1.05) { room.fish.delete(id); io.to(room.key).emit('despawn', { fishId: id }); }
  }
  // spawn regular fish
  room.spawnTimer -= TICK_MS / 1000;
  const aliveCount = [...room.fish.values()].filter(f => f.alive && !f.boss).length;
  const target = room.bonusTimer > 0 ? 22 : 16;
  if (room.spawnTimer <= 0 && aliveCount < target + 6) {
    const f = spawnFish(room, pickSpecies());
    io.to(room.key).emit('spawn', serializeFish(f));
    room.spawnTimer = aliveCount < target ? (0.15 + Math.random() * 0.35) : (0.7 + Math.random() * 0.9);
  }
  // boss cadence
  room.bossTimer -= TICK_MS / 1000;
  if (room.bossTimer <= 0 && ![...room.fish.values()].some(f => f.boss)) {
    const f = spawnBoss(room);
    io.to(room.key).emit('spawn', serializeFish(f));
    io.to(room.key).emit('banner', { text: '⚠ ' + f.def.name + ' ⚠' });
    room.bossTimer = 60 + Math.random() * 30;
  }
}

async function roomController(room) {
  room.stateTimer -= TICK_MS / 1000;
  if (room.stateTimer > 0) return;
  room.stateTimer = 2; // recompute every ~2s
  try {
    const stats = await db.roomStatsGet(room.key);
    const s = await rng.loadSettings();
    room.allowance = rng.computeAllowance(stats, s.rtp, room.allowance);
  } catch (e) { /* ignore transient db errors in the controller */ }
}

const TICK_MS = 500;
let tickHandle = null;
function startTick(io) {
  if (tickHandle) return;
  tickHandle = setInterval(() => tickAll(io), TICK_MS);
}

// bet & win helpers (used by the hit handler): debits/credits via db.
const mod2 = {
  async bet(userId, amount) {
    const r = await db.adjustPoints(userId, -amount, { type: 'bet', note: 'wager' });
    if (!r.ok) return { ok: false };
    await db.roomStatsAdd('default', amount, 0);
    module.exports.broadcastBalance(userId, r.balance);
    return { ok: true, balance: r.balance };
  },
  async win(userId, amount) {
    const r = await db.adjustPoints(userId, amount, { type: 'win', note: 'payout' });
    if (r.ok) {
      await db.roomStatsAdd('default', 0, amount);
      module.exports.broadcastBalance(userId, r.balance);
    }
    return r;
  },
};
mod.bet = mod2.bet;
mod.win = mod2.win;
mod.startTick = startTick;
mod.serializeFish = serializeFish;
mod.spawnFish = spawnFish;
mod.pickSpecies = pickSpecies;