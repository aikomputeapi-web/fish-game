'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const dbPath = path.join(os.tmpdir(), `fire-kirin-matchmaking-${process.pid}-${Date.now()}.sqlite`);
process.env.SQLITE_PATH = dbPath;
delete process.env.DATABASE_URL;

const db = require('../server/db');
const rooms = require('../server/game/rooms');

class FakeSocket {
  constructor(id, username, gameMode = 'multiplayer') {
    this.handshake = { auth: { id, username, role: 'player', gameMode, banned: false } };
    this.data = {};
    this.rooms = new Set();
    this.handlers = new Map();
    this.events = [];
  }

  join(room) { this.rooms.add(room); }
  leave(room) { this.rooms.delete(room); }
  on(event, handler) { this.handlers.set(event, handler); }
  emit(event, payload) { this.events.push({ event, payload }); }
  disconnect() { const handler = this.handlers.get('disconnect'); if (handler) handler(); }
  last(event) { return [...this.events].reverse().find(entry => entry.event === event)?.payload; }
}

class FakeIo {
  constructor() { this.connectionHandler = null; this.sockets = new Set(); }
  on(event, handler) { if (event === 'connection') this.connectionHandler = handler; }
  connect(socket) { this.sockets.add(socket); this.connectionHandler(socket); }
  to(room) {
    return {
      emit: (event, payload) => {
        for (const socket of this.sockets) if (socket.rooms.has(room)) socket.emit(event, payload);
      },
    };
  }
}

after(async () => {
  await db.close();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch (_) {}
  }
});

test('multiplayer matchmaking groups exactly four queued players into one room', () => {
  const io = new FakeIo();
  rooms.attach(io);
  const players = [
    new FakeSocket(101, 'alpha'),
    new FakeSocket(102, 'bravo'),
    new FakeSocket(103, 'charlie'),
    new FakeSocket(104, 'delta'),
  ];

  for (const player of players) io.connect(player);

  const roomKeys = new Set(players.map(player => player.data.roomKey));
  assert.equal(roomKeys.size, 1);
  assert.match([...roomKeys][0], /^multiplayer:\d+$/);
  for (const player of players) {
    const state = player.last('roomState');
    assert.equal(state.mode, 'multiplayer');
    assert.equal(state.status, 'active');
    assert.equal(state.required, 4);
    assert.equal(state.players.length, 4);
    assert.deepEqual(state.players.map(member => member.username).sort(), ['alpha', 'bravo', 'charlie', 'delta']);
  }
});

test('a fifth player stays queued until another full group can be formed', () => {
  const io = new FakeIo();
  rooms.attach(io);
  const player = new FakeSocket(201, 'echo');
  io.connect(player);

  assert.equal(player.data.roomKey, null);
  assert.deepEqual(player.last('roomState'), {
    mode: 'multiplayer', status: 'waiting', reset: true, position: 1, queued: 1, required: 4,
  });

  let fireResult = null;
  player.handlers.get('fire')({}, (result) => { fireResult = result; });
  assert.deepEqual(fireResult, { ok: false, reason: 'matchmaking' });
});
