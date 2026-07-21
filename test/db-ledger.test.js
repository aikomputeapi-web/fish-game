'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dbPath = path.join(os.tmpdir(), `fire-kirin-ledger-${process.pid}-${Date.now()}.sqlite`);
process.env.SQLITE_PATH = dbPath;
delete process.env.DATABASE_URL;
process.env.ADMIN_USERNAME = 'test_owner';
process.env.ADMIN_PASSWORD = 'test-owner-password';

const db = require('../server/db');

async function createUser(username, role, points, managerId = null) {
  const rows = await db.q(
    'INSERT INTO users (username, password_hash, points, role, manager_id) VALUES (?, ?, ?, ?, ?) RETURNING id',
    [username, 'not-used-in-db-tests', points, role, managerId]
  );
  return rows[0].id;
}

before(async () => {
  await db.migrate();
});

after(async () => {
  await db.close();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch (_) {}
  }
});

test('a player can only be funded by one manager, including concurrent grants', async () => {
  const managerA = await createUser('manager_a', 'manager', 100);
  const managerB = await createUser('manager_b', 'manager', 100);
  const player = await createUser('player_one', 'player', 0);

  const results = await Promise.all([
    db.managerGrantPoints(managerA, player, 25),
    db.managerGrantPoints(managerB, player, 40),
  ]);

  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => !r.ok)[0].reason, 'not_eligible');

  const manager = results[0].ok ? managerA : managerB;
  const grant = results.find(r => r.ok);
  const row = await db.getUser(player);
  assert.equal(row.manager_id, manager);
  assert.equal(Number(row.points), manager === managerA ? 25 : 40);

  const ledger = await db.one(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE type = 'manager_grant' AND user_id IN (?, ?, ?)",
    [managerA, managerB, player]
  );
  assert.equal(Number(ledger.total), 0);
  assert.equal(grant.playerBalance, Number(row.points));
});

test('only one pending redemption can be created and it can only be approved once', async () => {
  const manager = await createUser('manager_c', 'manager', 100);
  const player = await createUser('player_two', 'player', 0);
  const grant = await db.managerGrantPoints(manager, player, 80);
  assert.equal(grant.ok, true);

  const requests = await Promise.all([
    db.createRedeemRequest(player, manager, 30),
    db.createRedeemRequest(player, manager, 30),
  ]);
  assert.equal(requests.filter(r => r.ok).length, 1);
  assert.equal(requests.filter(r => !r.ok)[0].reason, 'pending_exists');

  const requestId = requests.find(r => r.ok).id;
  const approvals = await Promise.all([
    db.approveRedeemRequest(manager, requestId),
    db.approveRedeemRequest(manager, requestId),
  ]);
  assert.equal(approvals.filter(r => r.ok).length, 1);
  assert.equal(approvals.filter(r => !r.ok)[0].reason, 'not_pending');

  const managerRow = await db.getUser(manager);
  const playerRow = await db.getUser(player);
  const request = await db.one('SELECT status FROM redeem_requests WHERE id = ?', [requestId]);
  assert.equal(Number(managerRow.points), 50);
  assert.equal(Number(playerRow.points), 50);
  assert.equal(request.status, 'approved');
});

test('room statistics accumulate atomically under concurrent writes', async () => {
  await Promise.all(Array.from({ length: 20 }, () => db.roomStatsAdd('test-room', 10, 3)));
  const stats = await db.roomStatsGet('test-room');
  const rows = await db.one('SELECT COUNT(*) AS count FROM room_stats WHERE room = ?', ['test-room']);
  assert.deepEqual(stats, { wagered: 200, paid: 60 });
  assert.equal(Number(rows.count), 1);
});

test('demoting a manager releases their players and cancels stranded redemptions', async () => {
  const manager = await createUser('manager_d', 'manager', 100);
  const player = await createUser('player_three', 'player', 0);
  assert.equal((await db.managerGrantPoints(manager, player, 60)).ok, true);
  const request = await db.createRedeemRequest(player, manager, 20);
  assert.equal(request.ok, true);

  const result = await db.changeUserRole(manager, 'player');
  const managerRow = await db.getUser(manager);
  const playerRow = await db.getUser(player);
  const redeem = await db.one('SELECT status FROM redeem_requests WHERE id = ?', [request.id]);
  assert.deepEqual(result, { ok: true, changed: true });
  assert.equal(managerRow.role, 'player');
  assert.equal(playerRow.manager_id, null);
  assert.equal(redeem.status, 'cancelled');
});
