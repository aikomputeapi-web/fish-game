/* powerups.js — purchasable special weapons.
   These are tactical consumables with a FIXED payout (mult × baseUnit), NOT
   scaled by the player's current bet — that prevents a "buy powerup, laser a
   500× boss at bet 100" exploit. Costs are admin-tunable settings. */
'use strict';

const POWERUPS = [
  { key: 'missile', name: 'Missile', icon: '🚀', desc: 'Blast every fish within range for a fixed payout each.', priceSetting: 'pw_missile', type: 'aim', color: '#ff6a3a' },
  { key: 'freeze', name: 'Freeze Bomb', icon: '❄️', desc: 'Freeze all fish in the tank for 3 seconds.', priceSetting: 'pw_freeze', type: 'instant', color: '#6acaff' },
  { key: 'chain', name: 'Chain Lightning', icon: '⚡', desc: 'Chain through up to 6 nearby fish, paying a fixed amount each.', priceSetting: 'pw_chain', type: 'aim', color: '#ffd54a' },
  { key: 'laser', name: 'Laser', icon: '🔦', desc: 'Instantly catch one targeted fish for a fixed payout.', priceSetting: 'pw_laser', type: 'target', color: '#c86bff' },
];

// Fixed base unit paid per caught fish, independent of bet size.
const BASE_UNIT = 2;
const MAX_AOE_TARGETS = 8;
const MAX_CHAIN_TARGETS = 6;
const MAX_AOE_RADIUS = 320;
const MAX_TOTAL_PAYOUT = 2000;

module.exports = { POWERUPS, BASE_UNIT, MAX_AOE_TARGETS, MAX_CHAIN_TARGETS, MAX_AOE_RADIUS, MAX_TOTAL_PAYOUT };
