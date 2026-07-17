/* constants.js — shared logical resolution, bets, weapon levels, tiers. */
'use strict';

const W = 1440, H = 810;                // logical canvas resolution (16:9)
const BETS = [1, 2, 5, 10, 20, 50, 100];
const FIRE_INTERVAL = 0.14;             // seconds between shots when holding
const BULLET_SPEED = 640;
const MAX_BOUNCES = 3;

// Weapon levels — higher = bigger cost/visuals/fire rate, same EV per point.
// level: 0..4. cost multiplier applied to base bet; fire interval shrinks.
const WEAPON_LEVELS = [
  { level: 0, name: 'STD',  costMult: 1,  fireMult: 1.0,  sizeMult: 1.0, color: '#ffd54a' },
  { level: 1, name: 'PWR',  costMult: 2,  fireMult: 0.85, sizeMult: 1.2, color: '#ff9a3a' },
  { level: 2, name: 'HEAVY',costMult: 5,  fireMult: 0.7,  sizeMult: 1.5, color: '#ff5a3a' },
  { level: 3, name: 'LASER',costMult: 10, fireMult: 0.6,  sizeMult: 1.8, color: '#c83aff' },
  { level: 4, name: 'NOVA', costMult: 20, fireMult: 0.5,  sizeMult: 2.2, color: '#3affff' },
];

const FISH_TIERS = {
  minnow: { minMult: 2,  maxMult: 5,   hitRateTarget: 0.27 },
  mid:    { minMult: 10, maxMult: 50,  hitRateTarget: 0.12 },
  mega:   { minMult: 60, maxMult: 250, hitRateTarget: 0.05 },
};

module.exports = { W, H, BETS, FIRE_INTERVAL, BULLET_SPEED, MAX_BOUNCES, WEAPON_LEVELS, FISH_TIERS };