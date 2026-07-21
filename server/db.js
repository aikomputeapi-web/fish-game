/* db.js — dual-engine database layer.
   Postgres (pg) in production via DATABASE_URL; node:sqlite for zero-setup
   local dev. All SQL uses ? placeholders; for pg we convert ? -> $N on the fly.
   Every point movement is atomic and logged to the transactions audit trail. */
'use strict';

const path = require('path');

const ENGINE = process.env.DATABASE_URL ? 'pg' : 'sqlite';
let pgPool = null;
let sqliteDb = null;
let sqliteTransactionQueue = Promise.resolve();

if (ENGINE === 'pg') {
  const { Pool } = require('pg');
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  pgPool.on('error', (err) => console.error('[pg pool error]', err.message));
} else {
  const { DatabaseSync } = require('node:sqlite');
  // SQLITE_PATH is primarily useful for isolated tests and disposable local
  // environments. Production always uses DATABASE_URL.
  const dbFile = process.env.SQLITE_PATH
    ? path.resolve(process.env.SQLITE_PATH)
    : path.join(__dirname, '..', 'dev.sqlite');
  sqliteDb = new DatabaseSync(dbFile);
  sqliteDb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
}

function convertSql(sql) {
  if (ENGINE !== 'pg') return sql;
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// q(sql, params) -> Promise<rows>
async function q(sql, params = []) {
  if (ENGINE === 'pg') {
    const { rows } = await pgPool.query(convertSql(sql), params);
    return rows;
  }
  const stmt = sqliteDb.prepare(sql);
  // sqlite: use .all() for SELECT/WITH/PRAGMA and any INSERT...RETURNING.
  const upper = sql.toUpperCase();
  const returnsRows = /^\s*(SELECT|WITH|PRAGMA|VALUES)\b/.test(upper) || /\bRETURNING\b/.test(upper);
  if (returnsRows) return stmt.all(...params);
  const info = stmt.run(...params);
  if (info && info.lastInsertRowid !== undefined && info.lastInsertRowid !== 0) return [{ id: Number(info.lastInsertRowid) }];
  return [];
}

// Run a query and expect a single row (or null).
async function one(sql, params = []) {
  const rows = await q(sql, params);
  return rows[0] || null;
}

async function exec(sql, params = []) {
  if (ENGINE === 'pg') {
    await pgPool.query(convertSql(sql), params);
  } else {
    const stmt = sqliteDb.prepare(sql);
    stmt.run(...params);
  }
}

// ============================================================ migrations
// Engine-aware type helpers: Postgres uses SERIAL/TIMESTAMPTZ/now(); SQLite uses
// INTEGER PK AUTOINCREMENT / TEXT / CURRENT_TIMESTAMP. Both support `ON CONFLICT`.
const PK = ENGINE === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
const TS = ENGINE === 'pg' ? 'TIMESTAMPTZ' : 'TEXT';
const NOW = 'CURRENT_TIMESTAMP'; // valid on both engines

function buildMigrations() {
  return [
    `CREATE TABLE IF NOT EXISTS users (
       id ${PK},
       username TEXT NOT NULL UNIQUE,
       password_hash TEXT NOT NULL,
       email TEXT,
       email_verified BOOLEAN NOT NULL DEFAULT false,
       verify_token TEXT,
       verify_expires ${TS},
       points BIGINT NOT NULL DEFAULT 2000,
       role TEXT NOT NULL DEFAULT 'player',
       manager_id INTEGER,
       banned BOOLEAN NOT NULL DEFAULT false,
       created_at ${TS} NOT NULL DEFAULT ${NOW},
       last_login ${TS}
     )`,
    `CREATE TABLE IF NOT EXISTS settings (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at ${TS} NOT NULL DEFAULT ${NOW}
     )`,
    `CREATE TABLE IF NOT EXISTS transactions (
       id ${PK},
       user_id INTEGER NOT NULL REFERENCES users(id),
       type TEXT NOT NULL,
       amount BIGINT NOT NULL,
       balance_after BIGINT NOT NULL,
       admin_id INTEGER,
       manager_id INTEGER,
       note TEXT,
       created_at ${TS} NOT NULL DEFAULT ${NOW}
     )`,
    `CREATE TABLE IF NOT EXISTS redeem_requests (
       id ${PK},
       user_id INTEGER NOT NULL REFERENCES users(id),
       manager_id INTEGER NOT NULL REFERENCES users(id),
       amount BIGINT NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending',
       created_at ${TS} NOT NULL DEFAULT ${NOW},
       resolved_at ${TS}
     )`,
    `CREATE TABLE IF NOT EXISTS room_stats (
       id ${PK},
       room TEXT NOT NULL,
       total_wagered BIGINT NOT NULL DEFAULT 0,
       total_paid BIGINT NOT NULL DEFAULT 0,
       updated_at ${TS} NOT NULL DEFAULT ${NOW}
     )`,
  ];
}
const MIGRATIONS = buildMigrations();

// For ALTER statements that may already have been applied (sqlite lacks IF NOT EXISTS on ADD COLUMN)
const SAFEMIGRATIONS = [
  "ALTER TABLE users ADD COLUMN manager_id INTEGER",
  "ALTER TABLE users ADD COLUMN banned BOOLEAN NOT NULL DEFAULT false",
  "ALTER TABLE users ADD COLUMN email TEXT",
  "ALTER TABLE users ADD COLUMN email_verified BOOLEAN NOT NULL DEFAULT false",
  "ALTER TABLE users ADD COLUMN verify_token TEXT",
  `ALTER TABLE users ADD COLUMN verify_expires ${TS}`,
];

async function migrate() {
  for (const sql of MIGRATIONS) {
    try { await exec(sql); } catch (e) { console.warn('[migration skip]', e.message); }
  }
  for (const sql of SAFEMIGRATIONS) {
    try { await exec(sql); } catch (e) { /* duplicate column: ignore */ }
  }
  // rename admin -> owner if any legacy rows exist
  try { await exec("UPDATE users SET role = 'owner' WHERE role = 'admin'"); } catch (e) {}
  // case-insensitive email uniqueness (partial index so legacy NULL emails are fine)
  try { await exec("CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email)) WHERE email IS NOT NULL"); } catch (e) { console.warn('[email index skip]', e.message); }
  // Historical versions could create duplicate pending requests during a race.
  // Keep the oldest request and close any duplicates before enforcing the invariant.
  try {
    await exec(
      "UPDATE redeem_requests SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP " +
      "WHERE status = 'pending' AND id NOT IN (SELECT MIN(id) FROM redeem_requests WHERE status = 'pending' GROUP BY user_id)"
    );
  } catch (e) { console.warn('[redeem cleanup skip]', e.message); }
  // Aggregate any duplicate room records created by older read-modify-write
  // code before adding the uniqueness guarantee needed for atomic upserts.
  try {
    const duplicates = await q(
      "SELECT room, MIN(id) AS keep_id, SUM(total_wagered) AS total_wagered, SUM(total_paid) AS total_paid " +
      "FROM room_stats GROUP BY room HAVING COUNT(*) > 1"
    );
    for (const row of duplicates) {
      await exec("UPDATE room_stats SET total_wagered = ?, total_paid = ? WHERE id = ?", [row.total_wagered, row.total_paid, row.keep_id]);
      await exec("DELETE FROM room_stats WHERE room = ? AND id != ?", [row.room, row.keep_id]);
    }
  } catch (e) { console.warn('[room stats cleanup skip]', e.message); }
  try { await exec("CREATE UNIQUE INDEX IF NOT EXISTS redeem_requests_one_pending_user ON redeem_requests (user_id) WHERE status = 'pending'"); } catch (e) { console.warn('[redeem pending index skip]', e.message); }
  try { await exec("CREATE INDEX IF NOT EXISTS users_manager_idx ON users (manager_id)"); } catch (e) { console.warn('[users manager index skip]', e.message); }
  try { await exec("CREATE INDEX IF NOT EXISTS transactions_user_created_idx ON transactions (user_id, created_at DESC)"); } catch (e) { console.warn('[transactions index skip]', e.message); }
  try { await exec("CREATE INDEX IF NOT EXISTS redeem_requests_manager_status_idx ON redeem_requests (manager_id, status, created_at DESC)"); } catch (e) { console.warn('[redeem requests index skip]', e.message); }
  try { await exec("CREATE UNIQUE INDEX IF NOT EXISTS room_stats_room_unique ON room_stats (room)"); } catch (e) { console.warn('[room stats index skip]', e.message); }
  await seedOwner();
  await seedDefaults();
}

async function seedOwner() {
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'changeme123';
  if (process.env.NODE_ENV === 'production' && (!process.env.ADMIN_PASSWORD || adminPass === 'changeme123')) {
    throw new Error('ADMIN_PASSWORD must be set to a non-default value in production');
  }
  const existing = await one("SELECT id FROM users WHERE username = ?", [adminUser]);
  if (existing) {
    await exec("UPDATE users SET role = 'owner' WHERE id = ?", [existing.id]);
    return;
  }
  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash(adminPass, 10);
  const rows = await q(
    "INSERT INTO users (username, password_hash, points, role) VALUES (?, ?, 0, 'owner') RETURNING id",
    [adminUser, hash]
  );
  const id = rows[0].id;
  await q(
    "INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, 'admin_grant', 0, 0, 'owner seed')",
    [id]
  );
  console.log(`[seed] owner account '${adminUser}' created`);
}

async function seedDefaults() {
  const defaults = {
    rtp: '0.96',
    bullet_factor: '1.0',
    bonus_rate: '0.004',
  };
  for (const [k, v] of Object.entries(defaults)) {
    try { await exec("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING", [k, v]); } catch (e) { }
  }
}

// ============================================================ user helpers
async function getUser(id) {
  return one("SELECT * FROM users WHERE id = ?", [id]);
}
async function getUserByName(username) {
  return one("SELECT * FROM users WHERE lower(username) = lower(?)", [username]);
}
async function getUserByEmail(email) {
  return one("SELECT * FROM users WHERE lower(email) = lower(?)", [email]);
}
async function getUserByVerifyToken(token) {
  return one("SELECT * FROM users WHERE verify_token = ?", [token]);
}
async function setVerifyToken(id, token, expiresIso) {
  await exec("UPDATE users SET verify_token = ?, verify_expires = ? WHERE id = ?", [token, expiresIso, id]);
}
async function markEmailVerified(id) {
  await exec("UPDATE users SET email_verified = true, verify_token = NULL, verify_expires = NULL WHERE id = ?", [id]);
}
async function listUsers() {
  return q(
    "SELECT u.id, u.username, u.points, u.role, u.banned, u.created_at, u.last_login, " +
    "m.username AS manager_name " +
    "FROM users u LEFT JOIN users m ON u.manager_id = m.id ORDER BY u.created_at DESC"
  );
}
async function createUser(username, passwordHash, { email = null, verifyToken = null, verifyExpires = null } = {}) {
  const bonus = parseInt(process.env.SIGNUP_BONUS || '2000', 10);
  return q(
    "INSERT INTO users (username, password_hash, email, verify_token, verify_expires, points, role) VALUES (?, ?, ?, ?, ?, ?, 'player') RETURNING id",
    [username, passwordHash, email, verifyToken, verifyExpires, bonus]
  ).then(async (rows) => {
    const id = rows[0].id;
    await q("INSERT INTO transactions (user_id, type, amount, balance_after, note) VALUES (?, 'signup_bonus', ?, ?, 'signup')", [id, bonus, bonus]);
    await exec("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", [id]);
    return { id, username, points: bonus, role: 'player' };
  });
}
async function touchLogin(id) {
  await exec("UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?", [id]);
}

// ============================================================ transactions
// withTransaction(fn) runs `fn(tx)` inside one atomic transaction on either
// engine. `tx.query(sql, params)` uses ? placeholders and returns rows, just
// like q() — but bound to this transaction's connection (pg) or the shared
// sqlite handle. Committing on normal return; rolling back on any throw.
//
// To roll back but still return a value (e.g. a failed money guard that has
// already written a row this transaction), call rollback(value): it unwinds
// the transaction and withTransaction returns `value` instead of throwing.
class Rollback { constructor(value) { this.value = value; } }
function rollback(value) { throw new Rollback(value); }

async function withTransaction(fn) {
  if (ENGINE === 'pg') {
    const client = await pgPool.connect();
    const tx = {
      async query(sql, params = []) {
        const { rows } = await client.query(convertSql(sql), params);
        return rows;
      },
    };
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      if (e instanceof Rollback) return e.value;
      throw e;
    } finally {
      client.release();
    }
  } else {
    // node:sqlite has one synchronous connection. Async route handlers can
    // otherwise interleave at an `await` while that connection is inside a
    // transaction, so serialize transactions explicitly for SQLite dev mode.
    const run = async () => {
      const tx = { query: (sql, params = []) => q(sql, params) };
      sqliteDb.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(tx);
        sqliteDb.exec('COMMIT');
        return result;
      } catch (e) {
        try { sqliteDb.exec('ROLLBACK'); } catch (_) {}
        if (e instanceof Rollback) return e.value;
        throw e;
      }
    };
    const queued = sqliteTransactionQueue.then(run, run);
    // Preserve a healthy queue after an expected rollback or an unexpected
    // database error; the caller still receives the original rejection.
    sqliteTransactionQueue = queued.catch(() => {});
    return queued;
  }
}

// ============================================================ points ledger
// adjustPoints: single-account, atomic conditional (used by bets/wins/owner grants).
// amount is signed; positive adds, negative subtracts (with funds guard if negative).
// Returns { balance, ok } or { ok: false } if a debit failed for insufficient funds.
// A failed debit affects zero rows and writes nothing, so it needs no rollback.
async function adjustPoints(userId, amount, { type, adminId = null, managerId = null, note = null } = {}) {
  if (amount === 0) {
    const u = await getUser(userId);
    return { balance: u ? u.points : 0, ok: true };
  }
  return withTransaction(async (tx) => {
    let rows;
    if (amount < 0) {
      rows = await tx.query(
        "UPDATE users SET points = points + ? WHERE id = ? AND points + ? >= 0 RETURNING points",
        [amount, userId, amount]
      );
      if (rows.length === 0) return { ok: false, reason: 'insufficient' };
    } else {
      rows = await tx.query(
        "UPDATE users SET points = points + ? WHERE id = ? RETURNING points",
        [amount, userId]
      );
      if (rows.length === 0) return { ok: false, reason: 'no_user' };
    }
    const newBal = rows[0].points;
    await tx.query(
      "INSERT INTO transactions (user_id, type, amount, balance_after, admin_id, manager_id, note) VALUES (?,?,?,?,?,?,?)",
      [userId, type, amount, newBal, adminId, managerId, note]
    );
    return { balance: newBal, ok: true };
  });
}

// transferPoints: two-account atomic, zero-sum. Debit `fromId`, credit `toId`.
// amount > 0. Fails if `fromId` has insufficient points. Logs a row on each side.
// If the credit target is missing, the debit already happened — rollback() undoes it.
async function transferPoints(fromId, toId, amount, type, meta = {}) {
  if (amount <= 0) throw new Error('amount must be positive');
  if (fromId === toId) throw new Error('cannot transfer to self');
  const { adminId = null, managerId = null, note = null } = meta;
  return withTransaction(async (tx) => {
    const dr = await tx.query(
      "UPDATE users SET points = points - ? WHERE id = ? AND points - ? >= 0 RETURNING points",
      [amount, fromId, amount]
    );
    if (dr.length === 0) return { ok: false, reason: 'insufficient' };
    const fromBal = dr[0].points;
    const cr = await tx.query(
      "UPDATE users SET points = points + ? WHERE id = ? RETURNING points",
      [amount, toId]
    );
    if (cr.length === 0) return rollback({ ok: false, reason: 'no_user' });
    const toBal = cr[0].points;
    await tx.query(
      "INSERT INTO transactions (user_id, type, amount, balance_after, admin_id, manager_id, note) VALUES (?,?,?,?,?,?,?)",
      [fromId, type, -amount, fromBal, adminId, managerId, `to:${meta.counterparty}`]
    );
    await tx.query(
      "INSERT INTO transactions (user_id, type, amount, balance_after, admin_id, manager_id, note) VALUES (?,?,?,?,?,?,?)",
      [toId, type, amount, toBal, adminId, managerId, `from:${meta.counterparty}`]
    );
    return { ok: true, fromBalance: fromBal, toBalance: toBal };
  });
}

// Manager grants are more restrictive than a generic transfer: the player is
// claimed by the granting manager inside the same transaction. This prevents a
// second manager from funding a player that belongs to somebody else, even when
// two grant requests arrive at the same time.
async function managerGrantPoints(managerId, playerId, amount, { note = null } = {}) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('amount must be a positive safe integer');
  if (managerId === playerId) throw new Error('cannot transfer to self');

  return withTransaction(async (tx) => {
    const claim = await tx.query(
      "UPDATE users SET manager_id = ? " +
      "WHERE id = ? AND role = 'player' AND banned = false " +
      "AND (manager_id IS NULL OR manager_id = ?) RETURNING id, username",
      [managerId, playerId, managerId]
    );
    if (claim.length === 0) return rollback({ ok: false, reason: 'not_eligible' });

    const debit = await tx.query(
      "UPDATE users SET points = points - ? " +
      "WHERE id = ? AND role = 'manager' AND points - ? >= 0 RETURNING points",
      [amount, managerId, amount]
    );
    if (debit.length === 0) return rollback({ ok: false, reason: 'insufficient' });

    const credit = await tx.query(
      "UPDATE users SET points = points + ? " +
      "WHERE id = ? AND role = 'player' AND manager_id = ? RETURNING points",
      [amount, playerId, managerId]
    );
    if (credit.length === 0) return rollback({ ok: false, reason: 'not_eligible' });

    const managerBalance = debit[0].points;
    const playerBalance = credit[0].points;
    const playerName = claim[0].username;
    await tx.query(
      "INSERT INTO transactions (user_id, type, amount, balance_after, manager_id, note) VALUES (?, 'manager_grant', ?, ?, ?, ?)",
      [managerId, -amount, managerBalance, managerId, `to:${playerName}`]
    );
    await tx.query(
      "INSERT INTO transactions (user_id, type, amount, balance_after, manager_id, note) VALUES (?, 'manager_grant', ?, ?, ?, ?)",
      [playerId, amount, playerBalance, managerId, note || `from:manager:${managerId}`]
    );
    return { ok: true, managerBalance, playerBalance, playerName };
  });
}

// A player may have only one pending redemption. The partial unique index
// reinforces this across processes; the transaction gives callers a useful
// result instead of exposing a database conflict as a 500 response.
async function createRedeemRequest(userId, managerId, amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('amount must be a positive safe integer');

  return withTransaction(async (tx) => {
    const rows = await tx.query(
      "INSERT INTO redeem_requests (user_id, manager_id, amount, status) " +
      "SELECT ?, ?, ?, 'pending' WHERE EXISTS (" +
      "SELECT 1 FROM users WHERE id = ? AND role = 'player' AND manager_id = ? AND points >= ?" +
      ") AND EXISTS (SELECT 1 FROM users WHERE id = ? AND role = 'manager' AND banned = false) " +
      "ON CONFLICT DO NOTHING RETURNING id",
      [userId, managerId, amount, userId, managerId, amount, managerId]
    );
    if (rows.length > 0) return { ok: true, id: rows[0].id };

    const pending = await tx.query(
      "SELECT id FROM redeem_requests WHERE user_id = ? AND status = 'pending'",
      [userId]
    );
    if (pending.length > 0) return rollback({ ok: false, reason: 'pending_exists' });
    return rollback({ ok: false, reason: 'not_eligible' });
  });
}

// Marking the request approved and moving both balances happen in one
// transaction. The conditional status update acts as the concurrency claim, so
// concurrent approve requests cannot redeem the same request twice.
async function approveRedeemRequest(managerId, requestId) {
  return withTransaction(async (tx) => {
    const request = await tx.query(
      "UPDATE redeem_requests SET status = 'approved', resolved_at = CURRENT_TIMESTAMP " +
      "WHERE id = ? AND manager_id = ? AND status = 'pending' " +
      "RETURNING user_id, amount",
      [requestId, managerId]
    );
    if (request.length === 0) return rollback({ ok: false, reason: 'not_pending' });

    const { user_id: playerId, amount } = request[0];
    const player = await tx.query(
      "UPDATE users SET points = points - ? " +
      "WHERE id = ? AND role = 'player' AND manager_id = ? AND points - ? >= 0 RETURNING points, username",
      [amount, playerId, managerId, amount]
    );
    if (player.length === 0) return rollback({ ok: false, reason: 'insufficient' });

    const manager = await tx.query(
      "UPDATE users SET points = points + ? WHERE id = ? AND role = 'manager' RETURNING points",
      [amount, managerId]
    );
    if (manager.length === 0) return rollback({ ok: false, reason: 'not_manager' });

    const playerBalance = player[0].points;
    const managerBalance = manager[0].points;
    const playerName = player[0].username;
    await tx.query(
      "INSERT INTO transactions (user_id, type, amount, balance_after, manager_id, note) VALUES (?, 'redeem', ?, ?, ?, ?)",
      [playerId, -amount, playerBalance, managerId, `to:manager:${managerId}`]
    );
    await tx.query(
      "INSERT INTO transactions (user_id, type, amount, balance_after, manager_id, note) VALUES (?, 'redeem', ?, ?, ?, ?)",
      [managerId, amount, managerBalance, managerId, `from:${playerName}`]
    );
    return { ok: true, playerId, playerBalance, managerBalance };
  });
}

// Role changes alter the ownership graph. Release a demoted manager's players
// and cancel requests that no longer have an eligible manager, all atomically.
async function changeUserRole(userId, role) {
  if (!['player', 'manager'].includes(role)) throw new Error('invalid operational role');

  return withTransaction(async (tx) => {
    const current = await tx.query("SELECT role FROM users WHERE id = ?", [userId]);
    if (current.length === 0) return rollback({ ok: false, reason: 'no_user' });
    const previousRole = current[0].role;
    if (previousRole === 'owner') return rollback({ ok: false, reason: 'owner' });
    if (previousRole === role) return { ok: true, changed: false };

    const changed = await tx.query(
      "UPDATE users SET role = ?, manager_id = NULL WHERE id = ? AND role = ? RETURNING id",
      [role, userId, previousRole]
    );
    if (changed.length === 0) return rollback({ ok: false, reason: 'conflict' });

    if (previousRole === 'manager') {
      await tx.query("UPDATE users SET manager_id = NULL WHERE manager_id = ?", [userId]);
      await tx.query(
        "UPDATE redeem_requests SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP " +
        "WHERE manager_id = ? AND status = 'pending'",
        [userId]
      );
    }
    if (previousRole === 'player') {
      await tx.query(
        "UPDATE redeem_requests SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP " +
        "WHERE user_id = ? AND status = 'pending'",
        [userId]
      );
    }
    return { ok: true, changed: true };
  });
}

// ============================================================ settings
async function getSettings(keys) {
  const placeholders = keys.map(() => '?').join(',');
  const rows = await q(`SELECT key, value FROM settings WHERE key IN (${placeholders})`, keys);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
async function getAllSettings() {
  return q("SELECT key, value FROM settings");
}
async function setSetting(key, value) {
  await exec("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP", [key, value]);
}

// ============================================================ stats / aggregates
async function userWageredWon(userId) {
  const rows = await q(
    "SELECT type, COALESCE(SUM(amount), 0) AS total FROM transactions WHERE user_id = ? GROUP BY type",
    [userId]
  );
  let wagered = 0, won = 0;
  for (const r of rows) {
    if (r.type === 'bet') wagered += Math.abs(r.total);
    if (r.type === 'win') won += Math.max(0, r.total);
    if (r.type === 'admin_grant') won += Math.max(0, r.total);
    if (r.type === 'manager_grant') won += Math.max(0, r.total);
  }
  return { wagered, won };
}

async function globalStats() {
  const users = await one("SELECT COUNT(*) AS c FROM users WHERE role != 'owner'");
  const circ = await one("SELECT COALESCE(SUM(points), 0) AS s FROM users WHERE role != 'owner'");
  const wagered = await one("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type='bet'");
  const paid = await one("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type='win'");
  return {
    users: Number(users ? users.c : 0),
    inCirculation: Number(circ ? circ.s : 0),
    totalWagered: Math.abs(Number(wagered ? wagered.s : 0)),
    totalPaid: Math.max(0, Number(paid ? paid.s : 0)),
    houseProfit: Math.abs(Number(wagered ? wagered.s : 0)) - Math.max(0, Number(paid ? paid.s : 0)),
  };
}

// room stats for the RTP closed-loop allowance controller
async function roomStatsGet(room = 'default') {
  const row = await one("SELECT * FROM room_stats WHERE room = ?", [room]);
  if (row) return { wagered: Number(row.total_wagered), paid: Number(row.total_paid) };
  return { wagered: 0, paid: 0 };
}
async function roomStatsAdd(room, wager, payout) {
  const rows = await q(
    "INSERT INTO room_stats (room, total_wagered, total_paid) VALUES (?, ?, ?) " +
    "ON CONFLICT (room) DO UPDATE SET " +
    "total_wagered = room_stats.total_wagered + EXCLUDED.total_wagered, " +
    "total_paid = room_stats.total_paid + EXCLUDED.total_paid, updated_at = CURRENT_TIMESTAMP " +
    "RETURNING total_wagered, total_paid",
    [room, wager, payout]
  );
  return { wagered: Number(rows[0].total_wagered), paid: Number(rows[0].total_paid) };
}

async function close() {
  if (ENGINE === 'pg') await pgPool.end();
  else if (sqliteDb) sqliteDb.close();
}

module.exports = {
  ENGINE,
  migrate,
  q, one, exec, withTransaction,
  getUser, getUserByName, getUserByEmail, getUserByVerifyToken, setVerifyToken, markEmailVerified,
  listUsers, createUser, touchLogin,
  adjustPoints, transferPoints, managerGrantPoints, createRedeemRequest, approveRedeemRequest, changeUserRole,
  getSettings, getAllSettings, setSetting,
  userWageredWon, globalStats,
  roomStatsGet, roomStatsAdd,
  close,
};
