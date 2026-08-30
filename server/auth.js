/* auth.js — registration/login, JWT in httpOnly cookie, role gates.
   requireAuth (any logged-in), requireOwner (owner only), requireManager. */
'use strict';

const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { xpNeeded } = require('./game/progression');
const { sendVerificationEmail } = require('./mailer');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const COOKIE = 'fk_token';
const TOKEN_TTL = '7d';

const router = express.Router();

function sign(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, SECRET, { expiresIn: TOKEN_TTL });
}

function setAuthCookie(res, user) {
  res.cookie(COOKIE, sign(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function readUser(req) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return null;
  try { return jwt.verify(token, SECRET); } catch { return null; }
}

// middleware gates
function requireAuth(req, res, next) {
  try {
    const u = readUser(req);
    if (!u) return res.status(401).json({ error: 'not authenticated' });
    db.getUser(u.id).then((row) => {
      if (!row) return res.status(401).json({ error: 'user not found' });
      if (row.banned) return res.status(403).json({ error: 'account banned' });
      req.user = row;
      next();
    }).catch(next);
  } catch (err) {
    next(err);
  }
}

function requireOwner(req, res, next) {
  if (!req.user || req.user.role !== 'owner') return res.status(403).json({ error: 'owner only' });
  next();
}
function requireManager(req, res, next) {
  if (!req.user || req.user.role !== 'manager') return res.status(403).json({ error: 'manager only' });
  next();
}
function requirePlayer(req, res, next) {
  if (!req.user || req.user.role !== 'player') return res.status(403).json({ error: 'player only' });
  next();
}

module.exports = { COOKIE, SECRET, sign, setAuthCookie, readUser, requireAuth, requireOwner, requireManager, requirePlayer, router };

// ---- routes ----
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function newVerifyToken() {
  return {
    token: crypto.randomBytes(32).toString('hex'),
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
  };
}

router.post('/register', ah(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim(); // email optional now
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'username must be 3-20 chars (letters, numbers, _)' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email format' });
  if (password.length < 8) return res.status(400).json({ error: 'password must be at least 8 chars' });
  const existing = await db.getUserByName(username);
  if (existing) return res.status(409).json({ error: 'username already taken' });
  if (email) {
    const emailTaken = await db.getUserByEmail(email);
    if (emailTaken) return res.status(409).json({ error: 'email already registered' });
  }
  const hash = await bcrypt.hash(password, 12);
  // Auto-verify: no email link needed. If email provided, store it verified.
  const user = await db.createUser(username, hash, email ? { email, verifyToken: null, verifyExpires: null } : {});
  // optional referral code — never blocks signup; invalid codes are ignored
  let referralApplied = false;
  const referralCode = String(req.body.referralCode || '').trim();
  if (referralCode) {
    const r = await db.applyReferral(user.id, referralCode);
    referralApplied = !!(r && r.ok);
  }
  // Log the user in immediately
  await db.touchLogin(user.id);
  // If email provided, mark it as verified
  if (email) await db.markEmailVerified(user.id);
  const fullUser = await db.getUser(user.id);
  setAuthCookie(res, fullUser);
  res.json({ id: user.id, username: user.username, points: fullUser.points, role: fullUser.role, referralApplied });
}));

// email link target: verifies the account, logs the user in, sends them to the app
router.get('/verify', ah(async (req, res) => {
  const token = String(req.query.token || '');
  const fail = (msg) => res.status(400).send(`<p>${msg}</p><p><a href="/auth">Back to sign in</a></p>`);
  if (!token) return fail('Missing verification token.');
  const user = await db.getUserByVerifyToken(token);
  if (!user) return fail('This verification link is invalid or was already used.');
  if (user.verify_expires && new Date(user.verify_expires).getTime() < Date.now()) {
    return fail('This verification link has expired. Log in to request a new one.');
  }
  await db.markEmailVerified(user.id);
  await db.touchLogin(user.id);
  setAuthCookie(res, user);
  res.redirect('/auth');
}));

// re-send the verification email; requires valid credentials so it can't be
// used to spam arbitrary addresses
router.post('/resend', ah(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const user = await db.getUserByName(username);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  if (!user.email) return res.status(400).json({ error: 'no email on this account' });
  if (user.email_verified) return res.status(400).json({ error: 'email already verified' });
  const { token, expires } = newVerifyToken();
  await db.setVerifyToken(user.id, token, expires);
  await sendVerificationEmail(user.email, user.username, token);
  res.json({ ok: true, email: user.email });
}));

router.post('/login', ah(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const user = await db.getUserByName(username);
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  if (user.banned) return res.status(403).json({ error: 'account banned' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  await db.touchLogin(user.id);
  setAuthCookie(res, user);
  res.json({ id: user.id, username: user.username, points: user.points, role: user.role, managerId: user.manager_id });
}));

router.post('/logout', ah(async (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
}));

router.get('/me', ah(async (req, res) => {
  const u = readUser(req);
  if (!u) return res.json(null);
  const row = await db.getUser(u.id);
  if (!row) return res.json(null);
  const level = Number(row.level) || 1;
  const [referral, powerups, achievements] = await Promise.all([
    db.getReferralInfo(row.id),
    db.getPowerups(row.id),
    db.getUserAchievements(row.id),
  ]);
  res.json({
    id: row.id, username: row.username, points: row.points, role: row.role,
    banned: !!row.banned, managerId: row.manager_id,
    level, xp: Number(row.xp) || 0, xpNeeded: xpNeeded(level),
    dailyStreak: Number(row.daily_streak) || 0,
    lastDailyClaim: row.last_daily_claim || null,
    referralCode: referral.code, referred: referral.referred,
    referredCount: referral.referredCount, referralBonus: referral.totalBonus,
    powerups,
    achievements,
  });
}));
