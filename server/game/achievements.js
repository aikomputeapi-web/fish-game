/* achievements.js — achievement definitions + evaluation.
   Each achievement reads a counter off the users row (or a simple query) and
   unlocks when the target is crossed. Unlocks are idempotent (DB unique
   constraint) and award a fixed point reward recorded as type 'achievement'. */
'use strict';

const db = require('../db');

const DEFS = [
  // ---- combat ----
  { key: 'first_kill', name: 'First Blood', desc: 'Catch your first fish.', category: 'combat', target: 1, reward: 100 },
  { key: 'kills_100', name: 'Angler', desc: 'Catch 100 fish.', category: 'combat', target: 100, reward: 300 },
  { key: 'kills_1000', name: 'Fishmonger', desc: 'Catch 1,000 fish.', category: 'combat', target: 1000, reward: 1000 },
  { key: 'kills_5000', name: 'Whale of a Time', desc: 'Catch 5,000 fish.', category: 'combat', target: 5000, reward: 3000 },
  { key: 'boss_slayer', name: 'Boss Slayer', desc: 'Down your first boss.', category: 'combat', target: 1, reward: 500 },
  { key: 'boss_10', name: 'Boss Hunter', desc: 'Down 10 bosses.', category: 'combat', target: 10, reward: 1500 },
  { key: 'big_win', name: 'Jackhammer', desc: 'Land a 30×+ payout.', category: 'combat', target: 1, reward: 200 },
  { key: 'big_wins_50', name: 'Heavy Hitter', desc: 'Land 50 big (30×+) wins.', category: 'combat', target: 50, reward: 2000 },
  { key: 'win_streak_10', name: 'On Fire', desc: 'Win on 10 kills in a row.', category: 'combat', target: 10, reward: 1500 },
  { key: 'total_wagered_100k', name: 'High Roller', desc: 'Wager 100,000 points total.', category: 'progression', target: 100000, reward: 2500 },
  // ---- progression ----
  { key: 'level_5', name: 'Rising Star', desc: 'Reach level 5.', category: 'progression', target: 5, reward: 500 },
  { key: 'level_10', name: 'Veteran', desc: 'Reach level 10.', category: 'progression', target: 10, reward: 1500 },
  { key: 'level_20', name: 'Legend', desc: 'Reach level 20.', category: 'progression', target: 20, reward: 5000 },
  // ---- social ----
  { key: 'refer_1', name: 'Recruiter', desc: 'Refer your first friend.', category: 'social', target: 1, reward: 500 },
  { key: 'refer_5', name: 'Pied Piper', desc: 'Refer 5 friends.', category: 'social', target: 5, reward: 2500 },
  // ---- collection ----
  { key: 'jackpot_win', name: 'Jackpot!', desc: 'Win the progressive jackpot.', category: 'collection', target: 1, reward: 2000 },
  { key: 'daily_5', name: 'Regular', desc: 'Claim a 5-day daily streak.', category: 'collection', target: 5, reward: 500 },
  { key: 'tournament_win', name: 'Champion', desc: 'Place 1st in a tournament.', category: 'collection', target: 1, reward: 2000 },
  { key: 'promo_use', name: 'Deal Seeker', desc: 'Redeem a promo code.', category: 'collection', target: 1, reward: 100 },
];

let seeded = false;
async function ensureSeeded() {
  if (seeded) return;
  await db.seedAchievements(DEFS);
  seeded = true;
}

async function defsByKey() {
  await ensureSeeded();
  const rows = await db.allAchievementDefs();
  const out = {};
  for (const r of rows) out[r.key] = r;
  return out;
}

// Evaluate a user's counters against the achievement set. Returns the list of
// newly unlocked achievements (already paid) as { key, name, reward }.
async function check(userId, counters = {}) {
  await ensureSeeded();
  const defs = await defsByKey();
  const unlocked = await db.q("SELECT achievement_id FROM user_achievements WHERE user_id = ?", [userId]);
  const have = new Set(unlocked.map(r => Number(r.achievement_id)));
  const row = await db.one("SELECT * FROM users WHERE id = ?", [userId]);
  if (!row) return [];

  const values = {
    kills: Number(row.total_kills) + (counters.kills || 0),
    boss: Number(row.boss_kills) + (counters.boss || 0),
    big: Number(row.big_wins) + (counters.big || 0),
    level: Number(row.level),
    wagered: Number(row.total_wagered) + (counters.wagered || 0),
    winStreak: Math.max(Number(row.win_streak) + (counters.winStreak || 0), Number(row.win_streak)),
    referred: counters.referred || 0,
    jackpot: Number(row.jackpot_wins) + (counters.jackpot || 0),
    daily: counters.dailyStreak || Number(row.daily_streak) || 0,
    tournament: counters.tournamentWins || 0,
  };

  const fresh = [];
  for (const def of Object.values(defs)) {
    if (have.has(def.id)) continue;
    let met = false;
    switch (def.key) {
      case 'first_kill': case 'kills_100': case 'kills_1000': case 'kills_5000':
        met = values.kills >= def.target; break;
      case 'boss_slayer': case 'boss_10': met = values.boss >= def.target; break;
      case 'big_win': case 'big_wins_50': met = values.big >= def.target; break;
      case 'win_streak_10': met = values.winStreak >= def.target; break;
      case 'total_wagered_100k': met = values.wagered >= def.target; break;
      case 'level_5': case 'level_10': case 'level_20': met = values.level >= def.target; break;
      case 'refer_1': case 'refer_5': met = values.referred >= def.target; break;
      case 'jackpot_win': met = values.jackpot >= def.target; break;
      case 'daily_5': met = values.daily >= def.target; break;
      case 'tournament_win': met = values.tournament >= def.target; break;
      case 'promo_use': met = (await db.q("SELECT 1 FROM promo_redemptions WHERE user_id = ? LIMIT 1", [userId])).length > 0; break;
      default: break;
    }
    if (met) {
      const res = await db.unlockAchievement(userId, def);
      if (res) fresh.push({ key: def.key, name: def.name, reward: res.reward });
    }
  }
  return fresh;
}

module.exports = { DEFS, check, ensureSeeded };
