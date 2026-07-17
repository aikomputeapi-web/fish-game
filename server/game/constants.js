/* constants.js — shared logical resolution, bets, weapon levels, tiers. */
'use strict';

const W = 1440, H = 810;                // logical canvas resolution (16:9)
const BETS = [1, 2, 5, 10, 20, 50, 100];
const FIRE_INTERVAL = 0.14;             // seconds between shots when holding
const BULLET_SPEED = 640;
const MAX_BOUNCES = 3;

// Weapon levels — each has a unique mechanic, not just stat scaling.
// type: 'single' | 'spread' | 'pierce' | 'freeze' | 'heavy'
const WEAPON_LEVELS = [
  { level: 0, name: 'STD',    type: 'single',  costMult: 1,  fireMult: 1.0,  sizeMult: 1.0, color: '#ffd54a', desc: 'Standard cannon' },
  { level: 1, name: 'SPREAD', type: 'spread',   costMult: 2,  fireMult: 0.9,  sizeMult: 1.0, color: '#ff9a3a', desc: '3-shot fan', spreadCount: 3, spreadAngle: 0.18 },
  { level: 2, name: 'PIERCE', type: 'pierce',   costMult: 4,  fireMult: 0.8,  sizeMult: 0.9, color: '#ff5a3a', desc: 'Piercing beam', pierceTargets: 5, armorPierce: 0.5 },
  { level: 3, name: 'FROST',  type: 'freeze',   costMult: 6,  fireMult: 0.6,  sizeMult: 1.1, color: '#6acaff', desc: 'Freezes target', freezeDuration: 3.0, armorPierce: 0.3 },
  { level: 4, name: 'HEAVY',  type: 'heavy',    costMult: 12, fireMult: 0.45, sizeMult: 1.6, color: '#c83aff', desc: 'Massive damage', armorPierce: 0.8 },
];

const FISH_TIERS = {
  minnow: { minMult: 2,  maxMult: 5,   hitRateTarget: 0.27 },
  mid:    { minMult: 10, maxMult: 50,  hitRateTarget: 0.12 },
  mega:   { minMult: 60, maxMult: 250, hitRateTarget: 0.05 },
};

module.exports = { W, H, BETS, FIRE_INTERVAL, BULLET_SPEED, MAX_BOUNCES, WEAPON_LEVELS, FISH_TIERS };
