/* player.js — player-facing REST API.
   Redemption requests (player-initiated, manager-approved), daily login bonus,
   referral codes, promo-code redemption, and the power-up shop. */
'use strict';

const express = require('express');
const db = require('./db');
const { requireAuth, requirePlayer } = require('./auth');
const rooms = require('./game/rooms');
const { POWERUPS } = require('./game/powerups');
const jackpot = require('./game/jackpot');

const router = express.Router();
router.use(requireAuth, requirePlayer);
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Lobby summary for the multi-game launcher shell.
router.get('/lobby', ah(async (req, res) => {
  const [row, jp] = await Promise.all([db.getUser(req.user.id), jackpot.get().catch(() => ({ pool: 0 }))]);
  res.json({
    username: req.user.username,
    balance: row ? Number(row.points) : 0,
    level: row ? Number(row.level) || 1 : 1,
    jackpot: jp ? Number(jp.pool) || 0 : 0,
  });
}));

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

// ---- daily login bonus ----
router.get('/daily', ah(async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.json({
    claimable: req.user.last_daily_claim !== today,
    streak: Number(req.user.daily_streak) || 0,
    lastClaim: req.user.last_daily_claim || null,
  });
}));

router.post('/daily', ah(async (req, res) => {
  const r = await db.claimDailyBonus(req.user.id);
  if (!r.ok) return res.status(400).json({ error: r.reason === 'already_claimed' ? 'already claimed today' : 'claim failed', streak: r.streak || 0 });
  res.json({ ok: true, bonus: r.bonus, streak: r.streak, points: r.points });
}));

// ---- referrals ----
router.get('/referral', ah(async (req, res) => {
  res.json(await db.getReferralInfo(req.user.id));
}));

router.post('/referral', ah(async (req, res) => {
  const r = await db.applyReferral(req.user.id, String(req.body.code || ''));
  if (!r.ok) {
    if (r.reason === 'invalid') return res.status(400).json({ error: 'invalid referral code' });
    if (r.reason === 'self') return res.status(400).json({ error: 'you cannot refer yourself' });
    return res.status(400).json({ error: 'this account already has a referral' });
  }
  res.json({ ok: true, bonus: r.bonus });
}));

// ---- promo codes ----
router.post('/promo', ah(async (req, res) => {
  const r = await db.redeemPromo(req.user.id, String(req.body.code || ''));
  if (!r.ok) {
    if (r.reason === 'already_redeemed') return res.status(400).json({ error: 'code already redeemed' });
    if (r.reason === 'expired') return res.status(400).json({ error: 'code has expired' });
    return res.status(400).json({ error: 'invalid promo code' });
  }
  res.json({ ok: true, points: r.points, balance: r.balance, code: r.code });
}));

// ---- power-ups ----
router.get('/powerups', ah(async (req, res) => {
  const [inv, settings] = await Promise.all([db.getPowerups(req.user.id), db.getSettings(POWERUPS.map(p => p.priceSetting))]);
  res.json({
    inventory: inv,
    catalog: POWERUPS.map(p => ({ key: p.key, name: p.name, icon: p.icon, desc: p.desc, color: p.color, price: Number(settings[p.priceSetting]) || 0 })),
  });
}));

router.post('/powerups/buy', ah(async (req, res) => {
  const key = String(req.body.key || '');
  const def = POWERUPS.find(p => p.key === key);
  if (!def) return res.status(400).json({ error: 'unknown power-up' });
  const settings = await db.getSettings([def.priceSetting]);
  const price = parseInt(settings[def.priceSetting] || '0', 10);
  if (!Number.isSafeInteger(price) || price <= 0) return res.status(400).json({ error: 'power-up is not for sale' });
  const r = await db.buyPowerup(req.user.id, key, price);
  if (!r.ok) return res.status(400).json({ error: 'insufficient points' });
  res.json({ ok: true, key, price, points: r.points, inventory: r.powerups });
}));

module.exports = router;
