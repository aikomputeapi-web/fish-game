/* simulate.js — fires N bullets against the room engine's death-check and asserts
   realized RTP converges to the configured target. Run: npm run simulate
   Usage: node scripts/simulate.js [shots] [rtp] */
'use strict';

(async () => {
  // load .env manually (no dotenv dependency)
  try {
    const fs = require('fs'), path = require('path');
    const p = path.join(__dirname, '..', '.env');
    if (fs.existsSync(p)) fs.readFileSync(p, 'utf8').split('\n').forEach(l => { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; });
  } catch (e) {}

  const db = require('../server/db');
  const rng = require('../server/game/rng');
  const constants = require('../server/game/constants');
  const { BETS } = constants;

  const SHOTS = parseInt(process.argv[2] || '200000', 10);
  const TARGET = parseFloat(process.argv[3] || '0.96');

  await db.migrate();
  if (TARGET) await db.setSetting('rtp', String(TARGET));
  rng.invalidate();

  const { FISH } = require('../server/game/fishTypes');
  const TOTAL_W = FISH.reduce((s, x) => s + x.weight, 0);
  function pick() {
    let r = Math.random() * TOTAL_W;
    for (const f of FISH) { r -= f.weight; if (r <= 0) return f; }
    return FISH[0];
  }

  // simulate the per-bullet death check exactly as the server does it, using the
  // same closed-loop allowance controller. We keep a wagered/paid tally and let
  // the allowance recompute every ~2 sim-seconds, mirroring rooms.js.
  let wagered = 0, paid = 0, allowance = 1.0, kills = 0;
  const t0 = Date.now();
  const M = 300; // mult-classes sample
  const multHist = {};
  for (let i = 0; i < SHOTS; i++) {
    if (i % 2000 === 0) {
      const s = { wagered, paid };
      const set = await rng.loadSettings();
      allowance = rng.computeAllowance(s, set.rtp, allowance);
    }
    const bet = BETS[2 + (i % 5)];                  // cycle bets 5..100
    const def = pick();
    wagered += bet;
    const roomState = { allowance };
    const roll = await rng.killRoll(def, bet, roomState);
    if (roll.killed) {
      let mult = def.mult;
      if (def.variable) mult = rng.rollVariableMult(def);
      const payout = mult * bet;
      paid += payout;
      kills++;
      multHist[def.id] = (multHist[def.id] || 0) + 1;
    }
  }

  const realized = wagered > 0 ? paid / wagered : 0;
  const err = Math.abs(realized - TARGET);
  const pass = err < 0.03;  // within 3% tolerance
  console.log(`\n=== Fire Kirin RTP Simulation ===`);
  console.log(`shots      : ${SHOTS.toLocaleString()}`);
  console.log(`target RTP : ${TARGET.toFixed(4)}  (target house edge ${( (1-TARGET)*100).toFixed(2)}%)`);
  console.log(`wagered    : ${wagered.toLocaleString()}`);
  console.log(`paid       : ${paid.toLocaleString()}`);
  console.log(`realized   : ${realized.toFixed(4)}  (realized house edge ${((1-realized)*100).toFixed(2)}%)`);
  console.log(`err        : ${(err*100).toFixed(2)}%`);
  console.log(`kills      : ${kills.toLocaleString()}  (${(kills/SHOTS*100).toFixed(2)}% hit rate)`);
  console.log(`time       : ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`result     : ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('simulate failed:', e); process.exit(2); });