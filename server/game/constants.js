/* constants.js — shared logical resolution, bets, weapon levels, tiers. */
'use strict';

const W = 1440, H = 810;                // logical canvas resolution (16:9)
const FIRE_INTERVAL = 0.14;             // seconds between shots when holding
const BULLET_SPEED = 640;
const MAX_BOUNCES = 3;

// Stake tiers. Each room is built around one tier; the bet buttons on the
// client are limited to that tier's list and the server rejects off-tier bets.
const ROOM_TIERS = {
  low:  { id: 'low',  label: 'LOW',  desc: 'Starter table · bets 1–5',   bets: [1, 2, 5],             vip: false },
  mid:  { id: 'mid',  label: 'MID',  desc: 'Standard table · bets 1–20', bets: [1, 2, 5, 10, 20],     vip: false },
  high: { id: 'high', label: 'HIGH', desc: 'High-stakes · bets 5–100',   bets: [5, 10, 20, 50, 100],  vip: false },
  vip:  { id: 'vip',  label: 'VIP',  desc: 'VIP table · bets 20–500',    bets: [20, 50, 100, 200, 500], vip: true },
};

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

// Fury / energy meter. Builds as the player fires; when full the player unleashes
// FURY MODE — a short window where their catch payouts are boosted by FURY_MULT.
// The boost is FOLDED INTO room stats via the normal win() path, so the closed-
// loop RTP controller compensates afterward and long-run realised RTP is
// UNCHANGED. Fury only redistributes wins into exciting bursts; it is not +EV.
const FURY = {
  MAX: 100,          // meter capacity
  PER_SHOT: 3.5,     // fill per shot fired (~29 shots to charge)
  MS: 8000,          // active window in ms
  MULT: 1.5,         // payout multiplier while active
};

module.exports = { W, H, ROOM_TIERS, FIRE_INTERVAL, BULLET_SPEED, MAX_BOUNCES, WEAPON_LEVELS, FISH_TIERS, FURY };
