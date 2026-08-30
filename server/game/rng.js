/* rng.js — kill/death check + closed-loop RTP allowance controller.
   P(kill) = clamp( (RTP / M) * A * f(B), 0, 0.95 )
   A (allowance) is a controller that pulls realized RTP back toward the owner's
   target: if the table has under-paid recently, A > 1 forces payouts; if over-
   paying, A < 1 suppresses them. Long-run realized RTP converges to RTP.
   f(B) is a mild bullet-feel boost kept from breaking the math by the loop. */
'use strict';

const db = require('../db');

let settingsCache = { at: 0, ttl: 5000, data: { rtp: 0.96, bullet_factor: 1.0, bonus_rate: 0.004 } };

async function loadSettings() {
  const now = Date.now();
  if (now - settingsCache.at < settingsCache.ttl) return settingsCache.data;
  const rows = await db.getSettings(['rtp', 'bullet_factor', 'bonus_rate']);
  const d = {
    rtp: parseFloat(rows.rtp || '0.96'),
    bullet_factor: parseFloat(rows.bullet_factor || '1.0'),
    bonus_rate: parseFloat(rows.bonus_rate || '0.004'),
  };
  settingsCache = { at: now, ttl: 5000, data: d };
  return d;
}

function invalidate() { settingsCache.at = 0; }

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

// bullet feel: an admin-tunable GLOBAL lethality multiplier (default 1.0). It is
// deliberately INDEPENDENT of the bet value so that EV per point wagered stays
// flat across bet sizes (otherwise big bullets would be +EV — an exploit hole).
// Bigger bullets feel impactful because the payout scales with bet × mult, not
// because the odds change. Setting bullet_factor=1.0 reproduces the pure recap
// math exactly: P = (RTP/M) × A.
function bulletFeel(bulletFactor = 1.0) {
  return clamp(bulletFactor, 0.5, 2.0);
}

// ---- closed-loop allowance controller ----
// Given recent (wagered, paid), compute realized RTP. Steer allowance toward
// target so that sustained play lands on RTP. Soft band ±3% means no correction
// while inside; outside the band, scale proportionally.
function computeAllowance(roomStats, target, previousAllowance) {
  const { wagered, paid } = roomStats;
  if (wagered < 200) return 1.0; // warm-up: trust base math
  const realized = paid / wagered;
  const diff = target - realized;            // positive => under-paying => boost
  // proportional-integral-ish: blend previous with new correction
  const correction = 1 + clamp(diff * 2.0, -0.5, 0.9);
  return clamp(correction * 0.6 + (previousAllowance || 1) * 0.4, 0.2, 2.0);
}

// the core death check
async function killRoll(def, betValue, roomState) {
  const s = await loadSettings();
  const target = s.rtp;
  const M = def.mult || (def.expectedMult ? def.expectedMult : 1);
  const f = bulletFeel(s.bullet_factor);   // constant — keeps EV flat in betValue
  const A = roomState.allowance || 1.0;
  const base = (target / M) * A * f;
  const pNormal = clamp(base, 0.0005, 0.95);

  // FURY MODE — feeding-frenzy overdrive. When furyMult > 1 we raise the catch
  // rate by that factor and shrink each payout by the SAME realised factor
  // (payoutFactor). Expected value per shot = p × payoutFactor × M × bet =
  // pNormal × M × bet — IDENTICAL to normal play, and clamp-safe. Fury changes
  // the feel (rapid catches, smaller each), never the RTP. So realised RTP is
  // unaffected no matter how often fury is used.
  const furyMult = roomState.furyMult || 1;
  let p = pNormal, payoutFactor = 1;
  if (furyMult > 1) {
    p = clamp(base * furyMult, 0.0005, 0.95);
    payoutFactor = p > 0 ? pNormal / p : 1;
  }

  const roll = Math.random();
  const killed = roll < p;
  const near = !killed && roll < p * 1.5; // near-miss flag for client teases
  return { killed, near, p, payoutFactor };
}

// roll the actual multiplier for a variable boss (uniform in range)
function rollVariableMult(def) {
  if (!def.variable || !def.multRange) return def.mult || 1;
  const [lo, hi] = def.multRange;
  return Math.round(lo + Math.random() * (hi - lo));
}

// should a bonus trigger on this kill? (rare)
async function bonusTriggerRoll(def) {
  if (def.special !== 'bonus') return false;
  const s = await loadSettings();
  return Math.random() < (s.bonus_rate * 200); // bonus pearl is itself rare; amplify
}

module.exports = { loadSettings, invalidate, killRoll, rollVariableMult, bonusTriggerRoll, computeAllowance, bulletFeel, clamp };