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
  const amount = Number(req.body.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive integer' });
  if (!req.user.manager_id) return res.status(400).json({ error: 'you have no manager yet — points can be redeemed once a manager has granted you points' });
  const result = await db.createRedeemRequest(req.user.id, req.user.manager_id, amount);
  if (!result.ok) {
    if (result.reason === 'pending_exists') return res.status(400).json({ error: 'you already have a pending redeem request' });
    return res.status(400).json({ error: 'insufficient balance or manager is unavailable' });
  }
  res.json({ ok: true, id: result.id });
}));

router.post('/redeem/cancel', ah(async (req, res) => {
  await db.exec("UPDATE redeem_requests SET status = 'cancelled', resolved_at = CURRENT_TIMESTAMP WHERE user_id = ? AND status = 'pending'", [req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
