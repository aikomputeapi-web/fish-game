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

const app = express();
const server = http.createServer(app);
const { Server } = require('socket.io');
const io = new Server(server, { cors: { origin: true, credentials: true } });

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
      socket.handshake.auth = { id: u.id, username: u.username, role: u.role, banned: false };
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

const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await db.migrate();
  } catch (e) {
    console.error('[migrate failed]', e);
  }
  rooms.startTick(io);
  server.listen(PORT, () => console.log(`Fire Kirin dev server on http://localhost:${PORT} (engine: ${db.ENGINE})`));
})();