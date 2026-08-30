/* progression.js — XP / level / weapon-unlock model.
   XP is a player-retention loop, not an economy lever: it never touches the
   RTP math. Level rewards are fixed point grants. Weapon levels unlock at
   thresholds so high-tier cannons feel like progression, and the server
   rejects locked weapons (the client also hides them). */
'use strict';

const db = require('../db');

// XP required to advance from `level` to `level + 1`.
function xpNeeded(level) {
  return 100 + (level - 1) * 50;
}

// Points granted on reaching a new level.
function levelReward(level) {
  return level * 100;
}

// Weapon level (index into WEAPON_LEVELS) unlocked at each player level.
// 1..5 map to player levels [1, 3, 5, 10, 15].
function weaponUnlockLevel(weaponIndex) {
  const table = [1, 3, 5, 10, 15];
  return table[weaponIndex] !== undefined ? table[weaponIndex] : Infinity;
}

// XP granted for a kill (scales mildly with multiplier, capped).
function xpForKill(mult, boss) {
  const base = 3 + Math.floor((mult || 1) / 10);
  return Math.min(boss ? 30 : 24, base);
}

// XP granted per shot fired.
const XP_PER_SHOT = 1;

// Add XP (+optional other counters), detect level-ups, pay level rewards and
// broadcast them. `io` is optional (unit tests call without it).
// Returns { row, levelUps: [{level, reward}] }.
async function processXp(userId, xp, io, { kill = 0, boss = 0, big = 0, wagered = 0, won = 0, winStreak = 0 } = {}) {
  const row = await db.incrCounters(userId, { xp, kill, boss, big, wagered, won, winStreak });
  if (!row) return { row: null, levelUps: [] };

  if (row.best_win_streak !== undefined && row.win_streak !== undefined && Number(row.win_streak) > Number(row.best_win_streak)) {
    await db.bumpBestStreak(userId, Number(row.win_streak));
  }

  let level = Number(row.level);
  let xpTotal = Number(row.xp);
  const levelUps = [];
  while (xpTotal >= xpNeeded(level)) {
    xpTotal -= xpNeeded(level);
    level += 1;
    const reward = levelReward(level);
    const r = await db.adjustPoints(userId, reward, { type: 'levelup', note: `reached level ${level}` });
    levelUps.push({ level, reward, points: r.balance });
  }
  if (levelUps.length > 0) {
    await db.exec("UPDATE users SET level = ?, xp = ? WHERE id = ?", [level, xpTotal, userId]);
    if (io) {
      const set = sockets(io, userId);
      for (const s of set) {
        s.emit('levelup', { level, xp: xpTotal, xpNeeded: xpNeeded(level), reward: levelUps[levelUps.length - 1].reward });
        for (const lu of levelUps) s.emit('banner', { text: `⭐ LEVEL ${lu.level}!  +${lu.reward} points` });
      }
    }
  }
  return { row: { ...row, level, xp: xpTotal }, levelUps };
}

// Same socket registry as rooms.js (kept here to avoid a circular require).
let socketRegistry = null;
function setSocketRegistry(reg) { socketRegistry = reg; }
function sockets(io, userId) {
  if (socketRegistry && socketRegistry.get) {
    const set = socketRegistry.get(userId);
    if (set) return [...set];
  }
  return [];
}

module.exports = { xpNeeded, levelReward, weaponUnlockLevel, xpForKill, XP_PER_SHOT, processXp, setSocketRegistry };
