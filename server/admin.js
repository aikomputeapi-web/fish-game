/* admin.js — owner-only REST API.
   Mint/deduct any points to anyone, ban/unban (kicks live sockets), promote/demote
   managers, RTP + global settings slider, global stats. */
'use strict';

const express = require('express');
const db = require('./db');
const { requireAuth, requireOwner } = require('./auth');
const rooms = require('./game/rooms');

const router = express.Router();
router.use(requireAuth, requireOwner);
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// list all users
router.get('/users', ah(async (req, res) => {
  const users = await db.listUsers();
  res.json(users.map(u => ({
    id: u.id, username: u.username, points: u.points, role: u.role,
    banned: !!u.banned, manager: u.manager_name || null,
    createdAt: u.created_at, lastLogin: u.last_login,
  })));
}));

// grant/deduct points to ANY user (owner mints from thin air)
router.post('/users/:id/points', ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  let amount = parseInt(req.body.amount, 10);
  const note = req.body.note ? String(req.body.note) : null;
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'amount must be a non-zero integer' });
  const target = await db.getUser(id);
  if (!target || target.role === 'owner') return res.status(400).json({ error: 'cannot adjust own/owner account this way' });
  const r = await db.adjustPoints(id, amount, { type: 'admin_grant', adminId: req.user.id, note: note || (amount < 0 ? 'owner deduct' : 'owner grant') });
  if (!r.ok) return res.status(400).json({ error: 'insufficient points to deduct' });
  rooms.broadcastBalance(id, r.balance);
  res.json({ id, points: r.balance });
}));

// ban / unban (banning kicks live sockets)
router.post('/users/:id/ban', ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const banned = !!req.body.banned;
  const target = await db.getUser(id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.role === 'owner') return res.status(400).json({ error: 'cannot ban the owner' });
  await db.exec("UPDATE users SET banned = ? WHERE id = ?", [banned ? 1 : 0, id]);
  if (banned) rooms.kickUser(id, 'banned');
  res.json({ id, banned });
}));

// promote to manager / demote to player
router.post('/users/:id/role', ah(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const role = String(req.body.role || '');
  if (!['player', 'manager'].includes(role)) return res.status(400).json({ error: 'role must be player or manager' });
  const target = await db.getUser(id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.role === 'owner') return res.status(400).json({ error: 'cannot change owner role' });
  const result = await db.changeUserRole(id, role);
  if (!result.ok) return res.status(409).json({ error: 'role changed concurrently; refresh and try again' });
  // Existing sockets retain their authenticated role for their lifetime.
  // Force a reconnect for both promotion and demotion so the new role applies.
  if (result.changed) rooms.kickUser(id, role === 'manager' ? 'promoted' : 'demoted');
  res.json({ id, role });
}));

// global settings (RTP, bullet_factor, etc.)
router.get('/settings', ah(async (req, res) => {
  const rows = await db.getAllSettings();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  res.json(out);
}));

router.post('/settings', ah(async (req, res) => {
  const key = String(req.body.key || '');
  const val = String(req.body.value || '');
  if (!/^[a-z_]+$/.test(key)) return res.status(400).json({ error: 'invalid key' });
  // clamp known numeric settings into sane ranges
  const numeric = {
    rtp: [0.1, 1.2], bullet_factor: [0.5, 2], bonus_rate: [0, 0.05],
    jackpot_rate: [0, 0.1], jackpot_chance: [0, 0.01], jackpot_seed: [0, 100000],
    daily_base: [0, 100000], daily_step: [0, 100000], daily_cap_streak: [1, 365],
    referral_bonus: [0, 100000], vip_min_points: [0, 100000000],
    pw_missile: [1, 100000], pw_freeze: [1, 100000], pw_chain: [1, 100000], pw_laser: [1, 100000],
  };
  if (numeric[key]) {
    const n = parseFloat(val);
    const [lo, hi] = numeric[key];
    if (!Number.isFinite(n) || n < lo || n > hi) return res.status(400).json({ error: `${key} must be between ${lo} and ${hi}` });
  }
  if (key === 'ai_bots' && !['on', 'off'].includes(val)) return res.status(400).json({ error: "ai_bots must be 'on' or 'off'" });
  if (key === 'event_active' && !['0', '1'].includes(val)) return res.status(400).json({ error: 'event_active must be 0 or 1' });
  await db.setSetting(key, val);
  rooms.invalidateSettings();
  res.json({ key, value: val });
}));

// ---- promo codes ----
router.get('/promos', ah(async (req, res) => {
  res.json(await db.listPromoCodes());
}));

router.post('/promos', ah(async (req, res) => {
  const code = String(req.body.code || '').trim();
  const points = parseInt(req.body.points, 10);
  const uses = parseInt(req.body.uses, 10);
  const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt).toISOString() : null;
  if (!/^[A-Z0-9]{3,24}$/.test(code.toUpperCase())) return res.status(400).json({ error: 'code must be 3-24 uppercase letters/numbers' });
  if (!Number.isSafeInteger(points) || points <= 0) return res.status(400).json({ error: 'points must be a positive integer' });
  if (!Number.isSafeInteger(uses) || uses < 1) return res.status(400).json({ error: 'uses must be a positive integer' });
  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) return res.status(400).json({ error: 'invalid expiry date' });
  try {
    const created = await db.createPromoCode({ code, points, uses, expiresAt });
    res.json({ ok: true, code: created });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}));

// ---- tournaments ----
router.post('/tournaments', ah(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const entryFee = parseInt(req.body.entryFee, 10);
  const startsAt = new Date(req.body.startsAt);
  const endsAt = new Date(req.body.endsAt);
  let winnerPcts = req.body.winnerPcts;
  if (!name || name.length > 60) return res.status(400).json({ error: 'name required (max 60 chars)' });
  if (!Number.isSafeInteger(entryFee) || entryFee < 0) return res.status(400).json({ error: 'entryFee must be a non-negative integer' });
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) return res.status(400).json({ error: 'valid startsAt and endsAt required' });
  if (endsAt.getTime() <= startsAt.getTime()) return res.status(400).json({ error: 'endsAt must be after startsAt' });
  if (!Array.isArray(winnerPcts) || winnerPcts.length === 0 || winnerPcts.some(p => !Number.isFinite(p) || p < 0)) {
    winnerPcts = [50, 30, 20];
  }
  const id = await db.createTournament({ name, entryFee, startsAt, endsAt, winnerPcts });
  res.json({ ok: true, id });
}));

// global stats
router.get('/stats', ah(async (req, res) => {
  res.json(await db.globalStats());
}));

module.exports = router;
