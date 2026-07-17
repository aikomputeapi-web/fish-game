/* manager.js — manager-only REST API.
   Managers distribute points from their own balance to any player (first grant
   claims the player permanently), and resolve player-initiated redeem requests
   (approve -> points return to manager; reject). Strictly zero-sum via
   db.transferPoints — a manager can never issue points they don't hold. */
'use strict';

const express = require('express');
const db = require('./db');
const { requireAuth, requireManager } = require('./auth');
const rooms = require('./game/rooms');

const router = express.Router();
router.use(requireAuth, requireManager);
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/overview', ah(async (req, res) => {
  const pending = await db.one("SELECT COUNT(*) AS c FROM redeem_requests WHERE manager_id = ? AND status = 'pending'", [req.user.id]);
  const stats = await db.userWageredWon(req.user.id);
  res.json({
    id: req.user.id, username: req.user.username, points: req.user.points,
    pendingRequests: Number(pending ? pending.c : 0),
  });
}));

// grant points to a player by username (claims unclaimed players)
router.post('/grant', ah(async (req, res) => {
  const username = String(req.body.username || '').trim();
  let amount = parseInt(req.body.amount, 10);
  const note = req.body.note ? String(req.body.note) : null;
  if (!username) return res.status(400).json({ error: 'username required' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive integer' });
  const target = await db.getUserByName(username);
  if (!target) return res.status(404).json({ error: 'no such player' });
  if (target.role !== 'player') return res.status(400).json({ error: 'can only grant to players' });
  if (target.banned) return res.status(400).json({ error: 'player is banned' });
  const r = await db.transferPoints(req.user.id, target.id, amount, 'manager_grant', { managerId: req.user.id, counterparty: target.username, note });
  if (!r.ok) return res.status(400).json({ error: 'insufficient float: you only have ' + req.user.points });
  // claim the player if unclaimed
  if (!target.manager_id) {
    await db.exec("UPDATE users SET manager_id = ? WHERE id = ? AND manager_id IS NULL", [req.user.id, target.id]);
  }
  rooms.broadcastBalance(target.id, r.toBalance);
  rooms.broadcastBalance(req.user.id, r.fromBalance);
  res.json({ ok: true, player: { id: target.id, username: target.username, points: r.toBalance }, managerBalance: r.fromBalance });
}));

// my claimed players with balances + wagered/won
router.get('/players', ah(async (req, res) => {
  const players = await db.q("SELECT id, username, points, banned, created_at FROM users WHERE manager_id = ? ORDER BY created_at DESC", [req.user.id]);
  const out = [];
  for (const p of players) {
    const ww = await db.userWageredWon(p.id);
    out.push({ id: p.id, username: p.username, points: p.points, banned: !!p.banned, createdAt: p.created_at, wagered: ww.wagered, won: ww.won });
  }
  res.json(out);
}));

// pending + recently resolved redeem requests for me
router.get('/requests', ah(async (req, res) => {
  const rows = await db.q(
    "SELECT r.id, r.user_id, u.username, r.amount, r.status, r.created_at, r.resolved_at " +
    "FROM redeem_requests r JOIN users u ON r.user_id = u.id " +
    "WHERE r.manager_id = ? AND r.status IN ('pending','approved','rejected') ORDER BY (r.status='pending') DESC, r.created_at DESC LIMIT 50",
    [req.user.id]
  );
  res.json(rows.map(r => ({
    id: r.id, userId: r.user_id, username: r.username, amount: r.amount,
    status: r.status, createdAt: r.created_at, resolvedAt: r.resolved_at,
  })));
}));

router.post('/requests/:id/approve', ah(async (req, res) => {
  const rid = parseInt(req.params.id, 10);
  const row = await db.one("SELECT * FROM redeem_requests WHERE id = ? AND manager_id = ? AND status = 'pending'", [rid, req.user.id]);
  if (!row) return res.status(404).json({ error: 'no such pending request' });
  const player = await db.getUser(row.user_id);
  if (!player) return res.status(400).json({ error: 'player missing' });
  const r = await db.transferPoints(player.id, req.user.id, row.amount, 'redeem', { managerId: req.user.id, counterparty: player.username, note: 'redeem request #' + rid });
  if (!r.ok) {
    return res.status(400).json({ error: 'player only has ' + player.points + ' points now — reject instead' });
  }
  await db.exec("UPDATE redeem_requests SET status = 'approved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [rid]);
  rooms.broadcastBalance(player.id, r.fromBalance);
  rooms.broadcastBalance(req.user.id, r.toBalance);
  res.json({ ok: true, playerBalance: r.fromBalance, managerBalance: r.toBalance });
}));

router.post('/requests/:id/reject', ah(async (req, res) => {
  const rid = parseInt(req.params.id, 10);
  const row = await db.one("SELECT * FROM redeem_requests WHERE id = ? AND manager_id = ? AND status = 'pending'", [rid, req.user.id]);
  if (!row) return res.status(404).json({ error: 'no such pending request' });
  await db.exec("UPDATE redeem_requests SET status = 'rejected', resolved_at = CURRENT_TIMESTAMP WHERE id = ?", [rid]);
  res.json({ ok: true });
}));

// my own grant/redeem history
router.get('/history', ah(async (req, res) => {
  const rows = await db.q(
    "SELECT type, amount, balance_after, note, created_at FROM transactions WHERE user_id = ? AND type IN ('manager_grant','redeem') ORDER BY created_at DESC LIMIT 100",
    [req.user.id]
  );
  res.json(rows.map(r => ({ type: r.type, amount: r.amount, balanceAfter: r.balance_after, note: r.note, createdAt: r.created_at })));
}));

module.exports = router;