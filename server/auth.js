/* auth.js — registration/login, JWT in httpOnly cookie, role gates.
   requireAuth (any logged-in), requireOwner (owner only), requireManager. */
'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

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
async function requireAuth(req, res, next) {
  const u = readUser(req);
  if (!u) return res.status(401).json({ error: 'not authenticated' });
  const row = await db.getUser(u.id);
  if (!row) return res.status(401).json({ error: 'user not found' });
  if (row.banned) return res.status(403).json({ error: 'account banned' });
  req.user = row;
  next();
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

router.post('/register', ah(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'username must be 3-20 chars (letters, numbers, _)' });
  if (password.length < 4) return res.status(400).json({ error: 'password must be at least 4 chars' });
  const existing = await db.getUserByName(username);
  if (existing) return res.status(409).json({ error: 'username already taken' });
  const hash = await bcrypt.hash(password, 10);
  const user = await db.createUser(username, hash);
  setAuthCookie(res, user);
  res.json({ id: user.id, username: user.username, points: user.points, role: 'player' });
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
  res.json({
    id: row.id, username: row.username, points: row.points, role: row.role,
    banned: !!row.banned, managerId: row.manager_id,
  });
}));