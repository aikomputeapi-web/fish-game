/* manager.js — manager-only REST API.
   Managers distribute points from their own balance to any player (first grant
   claims the player permanently), and resolve player-initiated redeem requests
   (approve -> points return to manager; reject). The database operations are
   atomic and zero-sum, so a manager can never issue points they don't hold. */
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
  const amount = Number(req.body.amount);
  const note = req.body.note == null ? null : String(req.body.note).trim();
  if (!username) return res.status(400).json({ error: 'username required' });
  if (!Number.isSafeInteger(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive integer' });
  if (note && note.length > 500) return res.status(400).json({ error: 'note must be 500 characters or fewer' });
  const target = await db.getUserByName(username);
  if (!target) return res.status(404).json({ error: 'no such player' });
  if (target.role !== 'player') return res.status(400).json({ error: 'can only grant to players' });
  if (target.banned) return res.status(400).json({ error: 'player is banned' });
  if (target.manager_id && target.manager_id !== req.user.id) {
    return res.status(403).json({ error: 'this player belongs to another manager' });
  }
  const r = await db.managerGrantPoints(req.user.id, target.id, amount, { note });
  if (!r.ok) {
    if (r.reason === 'not_eligible') return res.status(409).json({ error: 'player is no longer eligible for this manager' });
    return res.status(400).json({ error: 'insufficient float' });
  }
  rooms.broadcastBalance(target.id, r.playerBalance);
  rooms.broadcastBalance(req.user.id, r.managerBalance);
  res.json({ ok: true, player: { id: target.id, username: target.username, points: r.playerBalance }, managerBalance: r.managerBalance });
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
  if (!Number.isSafeInteger(rid) || rid <= 0) return res.status(400).json({ error: 'invalid request id' });
  const r = await db.approveRedeemRequest(req.user.id, rid);
  if (!r.ok) {
    if (r.reason === 'insufficient') return res.status(400).json({ error: 'player balance no longer covers this redemption — reject instead' });
    if (r.reason === 'not_manager') return res.status(403).json({ error: 'manager role required' });
    return res.status(404).json({ error: 'no such pending request' });
  }
  rooms.broadcastBalance(r.playerId, r.playerBalance);
  rooms.broadcastBalance(req.user.id, r.managerBalance);
  res.json({ ok: true, playerBalance: r.playerBalance, managerBalance: r.managerBalance });
}));

router.post('/requests/:id/reject', ah(async (req, res) => {
  const rid = parseInt(req.params.id, 10);
  if (!Number.isSafeInteger(rid) || rid <= 0) return res.status(400).json({ error: 'invalid request id' });
  const rows = await db.q(
    "UPDATE redeem_requests SET status = 'rejected', resolved_at = CURRENT_TIMESTAMP " +
    "WHERE id = ? AND manager_id = ? AND status = 'pending' RETURNING id",
    [rid, req.user.id]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'no such pending request' });
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
