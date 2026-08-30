'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const dbPath = path.join(os.tmpdir(), `fire-kirin-economy-${process.pid}-${Date.now()}.sqlite`);
process.env.SQLITE_PATH = dbPath;
delete process.env.DATABASE_URL;
process.env.ADMIN_USERNAME = 'test_owner';
process.env.ADMIN_PASSWORD = 'test-owner-password';

const db = require('../server/db');
const jackpot = require('../server/game/jackpot');
const achievements = require('../server/game/achievements');

function daysFromNow(days) {
  return new Date(Date.now() + days * 86400000);
}

async function createUser(username, points = 0) {
  const u = await db.createUser(username, 'not-used-in-db-tests', {});
  await db.exec("UPDATE users SET points = ? WHERE id = ?", [points, u.id]);
  return u;
}

before(async () => {
  await db.migrate();
  await db.seedAchievements(achievements.DEFS);
});

after(async () => {
  await jackpot.flush();
  await db.close();
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.rmSync(dbPath + suffix, { force: true }); } catch (_) {}
  }
});

// ============================================================ daily login bonus
test('daily login bonus pays out and refuses a second claim the same day', async () => {
  const user = await createUser('daily_user');
  const first = await db.claimDailyBonus(user.id);
  assert.equal(first.ok, true);
  assert.equal(first.bonus, 100); // daily_base default
  assert.equal(first.streak, 1);
  assert.equal(first.points, 100);

  const second = await db.claimDailyBonus(user.id);
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'already_claimed');

  // simulate a fresh day: streak continues only if the previous claim was yesterday
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await db.exec("UPDATE users SET last_daily_claim = ? WHERE id = ?", [yesterday, user.id]);
  const day2 = await db.claimDailyBonus(user.id);
  assert.equal(day2.ok, true);
  assert.equal(day2.streak, 2);
  assert.equal(day2.bonus, 200); // daily_base + daily_step
});

// ============================================================ referrals
test('referral credits both parties once and blocks self/duplicate/invalid', async () => {
  const referrer = await createUser('ref_giver');
  const newcomer = await createUser('ref_taker');

  const info = await db.getReferralInfo(referrer.id);
  assert.ok(info.code);

  const invalid = await db.applyReferral(newcomer.id, 'NOPE-XX');
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'invalid');

  const self = await db.applyReferral(referrer.id, info.code);
  assert.equal(self.ok, false);
  assert.equal(self.reason, 'self');

  const ok = await db.applyReferral(newcomer.id, info.code);
  assert.equal(ok.ok, true);
  assert.equal(ok.bonus, 500); // referral_bonus default

  const referrerRow = await db.getUser(referrer.id);
  assert.equal(Number(referrerRow.points), 500); // base points were 0

  const duplicate = await db.applyReferral(newcomer.id, info.code);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'already_referred');

  const refInfo = await db.getReferralInfo(referrer.id);
  assert.equal(refInfo.referredCount, 1);
  assert.equal(refInfo.totalBonus, 500);
});

// ============================================================ promo codes
test('promo code redeems once per user and expires', async () => {
  const user = await createUser('promo_user');
  await db.createPromoCode({ code: 'HELLO10', points: 250, uses: 2, expiresAt: daysFromNow(1).toISOString() });

  const first = await db.redeemPromo(user.id, 'hello10'); // case-insensitive
  assert.equal(first.ok, true);
  assert.equal(first.points, 250);
  assert.equal(first.balance, 250);

  const dup = await db.redeemPromo(user.id, 'HELLO10');
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'already_redeemed');

  // a second user can still use the code (uses = 2)
  const other = await createUser('promo_user2');
  const second = await db.redeemPromo(other.id, 'HELLO10');
  assert.equal(second.ok, true);

  // a third user is locked out: uses exhausted
  const third = await createUser('promo_user3');
  const exhausted = await db.redeemPromo(third.id, 'HELLO10');
  assert.equal(exhausted.ok, false);

  // expired code is rejected
  await db.createPromoCode({ code: 'TEMP1', points: 100, uses: 5, expiresAt: daysFromNow(-1).toISOString() });
  const expired = await db.redeemPromo(user.id, 'TEMP1');
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');
});

// ============================================================ power-ups
test('power-up purchase debits points and consume decrements inventory', async () => {
  const user = await createUser('pw_user', 1000);
  const prices = await db.getSettings(['pw_missile', 'pw_freeze', 'pw_chain', 'pw_laser']);

  const broke = await db.buyPowerup(user.id, 'missile', 999999);
  assert.equal(broke.ok, false);
  assert.equal(broke.reason, 'insufficient');

  const price = Number(prices.pw_missile); // 400 default
  const bought = await db.buyPowerup(user.id, 'missile', price);
  assert.equal(bought.ok, true);
  assert.equal(bought.points, 1000 - price);
  assert.equal(bought.powerups.missile, 1);

  const again = await db.buyPowerup(user.id, 'missile', price);
  assert.equal(again.powerups.missile, 2);

  const consumed = await db.consumePowerup(user.id, 'missile');
  assert.equal(consumed.ok, true);
  assert.equal(consumed.powerups.missile, 1);

  const none = await db.consumePowerup(user.id, 'laser');
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'none');
});

// ============================================================ tournaments
test('tournament lifecycle: join, standings, close pays top three', async () => {
  const alice = await createUser('tourney_alice', 5000);
  const bob = await createUser('tourney_bob', 5000);
  const carol = await createUser('tourney_carol', 5000);

  const id = await db.createTournament({
    name: 'Test Cup',
    entryFee: 500,
    startsAt: daysFromNow(1),
    endsAt: daysFromNow(2),
    winnerPcts: [50, 30, 20],
  });
  assert.ok(id);

  const joined = await db.joinTournament(id, alice.id);
  assert.equal(joined.ok, true);
  assert.equal(joined.balance, 4500);

  const dupJoin = await db.joinTournament(id, alice.id);
  assert.equal(dupJoin.ok, false);
  assert.equal(dupJoin.reason, 'already_joined');

  await db.joinTournament(id, bob.id);
  await db.joinTournament(id, carol.id);

  // advance the tournament into the live window so play counts toward it
  await db.exec("UPDATE tournaments SET starts_at = ?, ends_at = ? WHERE id = ?",
    [db.tsForDb(daysFromNow(-1)), db.tsForDb(daysFromNow(1)), id]);

  // seed some winnings inside the window so standings are non-trivial
  for (const uid of [alice.id, bob.id, carol.id]) {
    await db.adjustPoints(uid, -100, { type: 'bet', note: 'wager' });
  }
  await db.adjustPoints(alice.id, 400, { type: 'win', note: 'payout' });
  await db.adjustPoints(bob.id, 300, { type: 'win', note: 'payout' });

  const leaderboard = await db.tournamentLeaderboard(id);
  assert.equal(leaderboard.length, 3);
  assert.equal(leaderboard[0].username, 'tourney_alice');
  assert.equal(leaderboard[1].username, 'tourney_bob');

  const closed = await db.closeTournament(id);
  assert.equal(closed.ok, true);
  assert.equal(closed.pool, 1500); // 3 × 500

  const afterAlice = await db.getUser(alice.id);
  const afterBob = await db.getUser(bob.id);
  // pool = 1500, alice 50% (750) + her 300 payout net of 100 wagered
  assert.equal(Number(afterAlice.points), 4500 - 100 + 400 + 750);
  assert.equal(Number(afterBob.points), 4500 - 100 + 300 + 450);

  // closing again is a no-op
  const reclose = await db.closeTournament(id);
  assert.equal(reclose.ok, false);
});

// ============================================================ jackpot
test('jackpot rake accrues into the pool and persists through flush', async () => {
  await jackpot.flush();
  const before = await jackpot.get();
  const rake = await jackpot.addRake(1000);
  assert.equal(rake, 20); // 2% of 1000
  const after = await jackpot.get();
  assert.equal(after.pool, before.pool + 20);
  await jackpot.flush();
  const persisted = await db.jackpotGet();
  assert.equal(persisted.pool, after.pool);
});

// ============================================================ achievements
test('achievement definition seeding and unlock award points once', async () => {
  const user = await createUser('ach_user');
  // mirrors rooms.js recordKill: counters are persisted first, then checked
  await db.incrCounters(user.id, { kill: 1 });
  const fresh = await achievements.check(user.id, {});
  assert.ok(fresh.length > 0);
  const firstKill = fresh.find(a => a.key === 'first_kill');
  assert.ok(firstKill);
  assert.equal(firstKill.reward, 100);

  const row = await db.getUser(user.id);
  assert.equal(Number(row.points), firstKill.reward);
  assert.equal(Number(row.total_kills), 1);

  // second kill does not re-award first_kill
  await db.incrCounters(user.id, { kill: 1 });
  const again = await achievements.check(user.id, {});
  assert.equal(again.some(a => a.key === 'first_kill'), false);
});
