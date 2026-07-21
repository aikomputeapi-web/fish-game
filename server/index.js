/* index.js — Express + Socket.io bootstrap.
   Serves static public/ files, mounts auth/admin/manager/player REST, and wires
   the game room engine over WebSockets (handshake reuses the JWT cookie). */
'use strict';

// load .env manually (no dotenv dependency)
try { if (!process.env.JWT_SECRET) { const fs = require('fs'); const p = require('path').join(__dirname, '..', '.env'); if (fs.existsSync(p)) fs.readFileSync(p, 'utf8').split('\n').forEach(l => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; }); } } catch (e) {}

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const http = require('http');
const jwt = require('jsonwebtoken');

const db = require('./db');
const { COOKIE, SECRET, router: authRouter } = require('./auth');
const adminRouter = require('./admin');
const managerRouter = require('./manager');
const playerRouter = require('./player');
const rooms = require('./game/rooms');

const PORT = Number(process.env.PORT) || 3000;
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET must be at least 32 characters in production');
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || process.env.APP_URL || `http://localhost:${PORT}`)
  .split(',')
  .map(origin => origin.trim().replace(/\/$/, ''))
  .filter(Boolean);
function socketOriginAllowed(origin) {
  // Non-browser clients do not set Origin; they still need a valid auth cookie.
  return !origin || allowedOrigins.includes(origin.replace(/\/$/, ''));
}

const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, {
  // CORS headers alone do not protect WebSocket upgrades. Apply the same
  // allowlist to every Engine.IO transport before a socket is established.
  allowRequest(req, callback) {
    callback(null, socketOriginAllowed(req.headers.origin));
  },
  cors: {
    origin(origin, callback) {
      const allowed = socketOriginAllowed(origin);
      callback(allowed ? null : new Error('origin not allowed'), allowed);
    },
    credentials: true,
  },
});

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  if (isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// REST routers
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/manager', managerRouter);
app.use('/api/player', playerRouter);
app.get('/api/health', (req, res) => res.json({ ok: true, engine: db.ENGINE }));

// socket auth from cookie JWT
io.use((socket, next) => {
  try {
    const gameMode = socket.handshake.auth && socket.handshake.auth.gameMode === 'multiplayer'
      ? 'multiplayer'
      : 'solo';
    const raw = socket.handshake.headers.cookie;
    if (!raw) return next(new Error('no auth'));
    const cookies = Object.fromEntries(raw.split(';').map(s => s.trim().split('=')));
    const t = cookies[COOKIE] ? decodeURIComponent(cookies[COOKIE]) : null;
    if (!t) return next(new Error('no auth'));
    let payload;
    try { payload = jwt.verify(t, SECRET); } catch { return next(new Error('bad token')); }
    db.getUser(payload.id).then(u => {
      if (!u) return next(new Error('no user'));
      if (u.banned) return next(new Error('banned'));
      if (u.email && !u.email_verified) return next(new Error('email not verified'));
      socket.handshake.auth = { id: u.id, username: u.username, role: u.role, banned: false, gameMode };
      next();
    }).catch(() => next(new Error('db error')));
  } catch (e) { next(new Error('auth failed')); }
});

rooms.attach(io);

// static client
app.use(express.static(path.join(__dirname, '..', 'public')));
// legacy media served too
app.use('/media', express.static(path.join(__dirname, '..', 'MEDIA')));

// route entrypoints (auth handled client-side via role-based redirect)
app.get('/game', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'game.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/manager', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'manager.html')));
app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'auth.html')));
app.get('/', (req, res) => res.redirect('/auth'));

app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const isBadRequest = err instanceof SyntaxError && Object.prototype.hasOwnProperty.call(err, 'body');
  const status = isBadRequest ? 400 : (Number.isInteger(err.status) ? err.status : 500);
  console.error('[request error]', err && err.message);
  res.status(status).json({ error: isBadRequest ? 'invalid JSON body' : 'internal server error' });
});

(async () => {
  try {
    await db.migrate();
  } catch (e) {
    console.error('[migrate failed]', e);
    process.exitCode = 1;
    return;
  }
  rooms.startTick(io);
  server.listen(PORT, () => console.log(`Fire Kirin server listening on port ${PORT} (engine: ${db.ENGINE})`));
})();

server.on('error', (err) => {
  console.error('[server error]', err.message);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal} received`);
  const forceExit = setTimeout(() => process.exit(1), 10_000);
  forceExit.unref();
  io.close();
  server.close(async (err) => {
    try { await db.close(); } catch (closeErr) { console.error('[database close failed]', closeErr.message); }
    clearTimeout(forceExit);
    process.exit(err ? 1 : 0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
