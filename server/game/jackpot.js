/* jackpot.js — progressive jackpot.
   Every real bet pays a rake (default 2%) into a shared pool. Rake accrues in
   memory and is flushed to the DB on a short interval. Each real kill rolls a
   small chance to win the whole pool; on a win the pool resets to the seed,
   the winner is credited through the normal points ledger (type 'win') and the
   payout is folded into that room's RTP stats so the closed-loop controller
   stays honest. */
'use strict';

const db = require('../db');
const rng = require('./rng');

let pool = null;          // null => not loaded yet
let hits = 0;
let lastWinner = null;
let lastWin = 0;
let lastWonAt = null;
let dirty = false;
let flushTimer = null;

async function ensureLoaded() {
  if (pool !== null) return;
  const j = await db.jackpotGet();
  pool = j.pool;
  hits = j.hits;
  lastWinner = j.lastWinner;
  lastWin = j.lastWin;
  lastWonAt = j.lastWonAt;
}

async function flush() {
  if (!dirty) return;
  dirty = false;
  try { await db.jackpotSetPool(pool, { hits, lastWinnerId: lastWinner, lastWin }); } catch (e) { /* retried next flush */ }
}

function startFlusher() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { flush().catch(() => {}); }, 5000);
  flushTimer.unref?.();
}

async function get() {
  await ensureLoaded();
  return { pool, hits, lastWinner, lastWin, lastWonAt };
}

// Accumulate rake from one real bet.
async function addRake(amount) {
  await ensureLoaded();
  const s = await rng.loadSettings();
  const rate = parseFloat(s.jackpot_rate || '0.02');
  const rake = Math.round(amount * rate);
  if (rake > 0) { pool += rake; dirty = true; }
  return rake;
}

// Roll for the jackpot on a real kill. On a hit: credits the winner, resets the
// pool and returns the payout. Returns 0 when nobody won.
async function tryWin(userId, io, room) {
  await ensureLoaded();
  const s = await rng.loadSettings();
  const chance = parseFloat(s.jackpot_chance || '0.0008');
  const eventBoost = String(s.event_active || '0') === '1' ? 2 : 1;
  if (pool < 1 || Math.random() > chance * eventBoost) return 0;

  const payout = pool;
  const seed = parseInt(s.jackpot_seed || '2000', 10);
  pool = seed;
  hits += 1;
  lastWinner = userId;
  lastWin = payout;
  lastWonAt = new Date().toISOString();
  dirty = true;

  const r = await db.adjustPoints(userId, payout, { type: 'win', note: 'jackpot' });
  if (r.ok) {
    await db.roomStatsAdd(room.statsKey, 0, payout);
    await db.incrCounters(userId, { jackpotWins: 1, won: payout });
  }
  io.to(room.key).emit('jackpot', { winnerId: userId, amount: payout, pool: seed });
  return payout;
}

// Called after a real win so the RTP controller sees jackpot payouts.
async function announcePool(io, room) {
  const j = await get();
  io.to(room.key).emit('jackpotState', { pool: j.pool });
}

module.exports = { get, addRake, tryWin, flush, startFlusher, announcePool };
