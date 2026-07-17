/* player.js — player-facing redemption REST API.
   A player asks their claiming manager to take back N points (player-initiated,
   manager-approved). Player can have at most one pending request; cancellable. */
'use strict';

const express = require('express');
const db = require('./db');
const { requireAuth, requirePlayer } = require('./auth');
const rooms = require('./game/rooms');

const router = express.Router();
router.use(requireAuth, requirePlayer);
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.get('/redeem', ah(async (req, res) => {
  const pending = await db.one("SELECT * FROM redeem_requests WHERE user_id = ? AND status = 'pending'", [req.user.id]);
  let mgr = null;
  if (req.user.manager_id) {
    const m = await db.getUser(req.user.manager_id);
    mgr = m ? { id: m.id, username: m.username } : null;
  }
  res.json({
    manager: mgr,
    pendingRequest: pending ? { id: pending.id, amount: pending.amount, createdAt: pending.created_at } : null,
  });
}));

router.post('/redeem', ah(async (req, res) => {
  const amount = parseInt(req.body.amount, 10);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be positive' });
  if (!req.user.manager_id) return res.status(400).json({ error: 'you have no manager yet — points can be redeemed once a manager has granted you points' });
  const existing = await db.one("SELECT id FROM redeem_requests WHERE user_id = ? AND status = 'pending'", [req.user.id]);
  if (existing) return res.status(400).json({ error: 'you already have a pending redeem request' });
  if (req.user.points < amount) return res.status(400).json({ error: 'insufficient balance' });
  const rows = await db.q(
    "INSERT INTO redeem_requests (user_id, manager_id, amount, status) VALUES (?, ?, ?, 'pending') RETURNING id",
    [req.user.id, req.user.manager_id, amount]
  );
  res.json({ ok: true, id: rows[0].id });
}));

router.post('/redeem/cancel', ah(async (req, res) => {
  await db.exec("UPDATE redeem_requests SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = 'pending'", [req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;