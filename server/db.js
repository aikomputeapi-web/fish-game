/* db.js — dual-engine database layer.
   Postgres (pg) in production via DATABASE_URL; node:sqlite for zero-setup
   local dev. All SQL uses ? placeholders; for pg we convert ? -> $N on the fly.
   Every point movement is atomic and logged to the transactions audit trail. */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ENGINE = process.env.DATABASE_URL ? 'pg' : 'sqlite';
let pgPool = null;
let sqliteDb = null;

if (ENGINE === 'pg') {
  const { Pool } = require('pg');
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  pgPool.on('error', (err) => console.error('[pg pool error]', err.message));
} else {
  const { DatabaseSync } = require('node:sqlite');
  const dbFile = path.join(__dirname, '..', 'dev.sqlite');
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
  await seedOwner();
  await seedDefaults();
}

async function seedOwner() {
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'changeme123';
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
async function listUsers() {
  return q(
    "SELECT u.id, u.username, u.points, u.role, u.banned, u.created_at, u.last_login, " +
    "m.username AS manager_name " +
    "FROM users u LEFT JOIN users m ON u.manager_id = m.id ORDER BY u.created_at DESC"
  );
}
async function createUser(username, passwordHash) {
  const bonus = parseInt(process.env.SIGNUP_BONUS || '2000', 10);
  return q(
    "INSERT INTO users (username, password_hash, points, role) VALUES (?, ?, ?, 'player') RETURNING id",
    [username, passwordHash, bonus]
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

// ============================================================ points ledger
// adjustPoints: single-account, atomic conditional (used by bets/wins/owner grants).
// amount is signed; positive adds, negative subtracts (with funds guard if negative).
// Returns { balance, ok } or { ok: false } if a debit failed for insufficient funds.
async function adjustPoints(userId, amount, { type, adminId = null, managerId = null, note = null } = {}) {
  if (amount === 0) {
    const u = await getUser(userId);
    return { balance: u ? u.points : 0, ok: true };
  }
  if (ENGINE === 'pg') {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      let newBal;
      if (amount < 0) {
        const r = await client.query(
          "UPDATE users SET points = points + $1 WHERE id = $2 AND points + $1 >= 0 RETURNING points",
          [amount, userId]
        );
        if (r.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'insufficient' }; }
        newBal = r.rows[0].points;
      } else {
        const r = await client.query(
          "UPDATE users SET points = points + $1 WHERE id = $2 RETURNING points",
          [amount, userId]
        );
        if (r.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'no_user' }; }
        newBal = r.rows[0].points;
      }
      await client.query(
        "INSERT INTO transactions (user_id, type, amount, balance_after, admin_id, manager_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [userId, type, amount, newBal, adminId, managerId, note]
      );
      await client.query('COMMIT');
      return { balance: newBal, ok: true };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  } else {
    // sqlite: synchronous transaction
    sqliteDb.exec('BEGIN IMMEDIATE');
    try {
      const cur = sqliteDb.prepare("SELECT points FROM users WHERE id = ?").get(userId);
      if (!cur) { sqliteDb.exec('ROLLBACK'); return { ok: false, reason: 'no_user' }; }
      const np = cur.points + amount;
      if (np < 0) { sqliteDb.exec('ROLLBACK'); return { ok: false, reason: 'insufficient' }; }
      sqliteDb.prepare("UPDATE users SET points = ? WHERE id = ?").run(np, userId);
      sqliteDb.prepare(
        "INSERT INTO transactions (user_id, type, amount, balance_after, admin_id, manager_id, note) VALUES (?,?,?,?,?,?,?)"
      ).run(userId, type, amount, np, adminId, managerId, note);
      sqliteDb.exec('COMMIT');
      return { balance: np, ok: true };
    } catch (e) {
      try { sqliteDb.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }
}

// transferPoints: two-account atomic, zero-sum. Debit `fromId`, credit `toId`.
// amount > 0. Fails if `fromId` has insufficient points. Logs a row on each side.
async function transferPoints(fromId, toId, amount, type, meta = {}) {
  if (amount <= 0) throw new Error('amount must be positive');
  if (fromId === toId) throw new Error('cannot transfer to self');
  const { adminId = null, managerId = null, note = null } = meta;
  if (ENGINE === 'pg') {
    const client = await pgPool.connect();
    try {
      await client.query('BEGIN');
      const dr = await client.query(
        "UPDATE users SET points = points - $1 WHERE id = $2 AND points - $1 >= 0 RETURNING points",
        [amount, fromId]
      );
      if (dr.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'insufficient' }; }
      const fromBal = dr.rows[0].points;
      const cr = await client.query(
        "UPDATE users SET points = points + $1 WHERE id = $2 RETURNING points",
        [amount, toId]
      );
      if (cr.rowCount === 0) { await client.query('ROLLBACK'); return { ok: false, reason: 'no_user' }; }
      const toBal = cr.rows[0].points;
      await client.query(
        "INSERT INTO transactions (user_id, type, amount, balance_after, admin_id, manager_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [fromId, type, -amount, fromBal, adminId, managerId, `to:${meta.counterparty}`]
      );
      await client.query(
        "INSERT INTO transactions (user_id, type, amount, balance_after, admin_id, manager_id, note) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [toId, type, amount, toBal, adminId, managerId, `from:${meta.counterparty}`]
      );
      await client.query('COMMIT');
      return { ok: true, fromBalance: fromBal, toBalance: toBal };
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
  } else {
    sqliteDb.exec('BEGIN IMMEDIATE');
    try {
      const f = sqliteDb.prepare("SELECT points FROM users WHERE id = ?").get(fromId);
      if (!f) { sqliteDb.exec('ROLLBACK'); return { ok: false, reason: 'no_user' }; }
      if (f.points - amount < 0) { sqliteDb.exec('ROLLBACK'); return { ok: false, reason: 'insufficient' }; }
      const t = sqliteDb.prepare("SELECT points FROM users WHERE id = ?").get(toId);
      if (!t) { sqliteDb.exec('ROLLBACK'); return { ok: false, reason: 'no_user' }; }
      const fb = f.points - amount, tb = t.points + amount;
      sqliteDb.prepare("UPDATE users SET points = ? WHERE id = ?").run(fb, fromId);
      sqliteDb.prepare("UPDATE users SET points = ? WHERE id = ?").run(tb, toId);
      sqliteDb.prepare("INSERT INTO transactions (user_id, type, amount, balance_after, admin_id, manager_id, note) VALUES (?,?,?,?,?,?,?)")
        .run(fromId, type, -amount, fb, adminId, managerId, `to:${meta.counterparty}`);
      sqliteDb.prepare("INSERT INTO transactions (user_id, type, amount, balance_after, admin_id, manager_id, note) VALUES (?,?,?,?,?,?,?)")
        .run(toId, type, amount, tb, adminId, managerId, `from:${meta.counterparty}`);
      sqliteDb.exec('COMMIT');
      return { ok: true, fromBalance: fb, toBalance: tb };
    } catch (e) {
      try { sqliteDb.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }
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
  const cur = await roomStatsGet(room);
  const w = cur.wagered + wager, p = cur.paid + payout;
  const existing = await one("SELECT room FROM room_stats WHERE room = ?", [room]);
  if (existing) {
    await exec("UPDATE room_stats SET total_wagered = ?, total_paid = ?, updated_at = CURRENT_TIMESTAMP WHERE room = ?", [w, p, room]);
  } else {
    await exec("INSERT INTO room_stats (room, total_wagered, total_paid) VALUES (?, ?, ?)", [room, w, p]);
  }
  return { wagered: w, paid: p };
}

module.exports = {
  ENGINE,
  migrate,
  q, one, exec,
  getUser, getUserByName, listUsers, createUser, touchLogin,
  adjustPoints, transferPoints,
  getSettings, getAllSettings, setSetting,
  userWageredWon, globalStats,
  roomStatsGet, roomStatsAdd,
};