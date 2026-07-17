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
  await db.exec("UPDATE users SET role = ? WHERE id = ?", [role, id]);
  if (role === 'player') rooms.kickUser(id, 'demoted'); // drop live manager session if was manager
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
  // clamp RTP into a sane range
  if (key === 'rtp') {
    const n = parseFloat(val);
    if (!Number.isFinite(n) || n < 0.1 || n > 1.2) return res.status(400).json({ error: 'rtp must be between 0.10 and 1.20' });
  }
  if (key === 'bullet_factor') {
    const n = parseFloat(val);
    if (!Number.isFinite(n) || n < 0.5 || n > 2) return res.status(400).json({ error: 'bullet_factor must be between 0.5 and 2.0' });
  }
  await db.setSetting(key, val);
  rooms.invalidateSettings();
  res.json({ key, value: val });
}));

// global stats
router.get('/stats', ah(async (req, res) => {
  res.json(await db.globalStats());
}));

module.exports = router;