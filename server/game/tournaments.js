/* tournaments.js — scheduled tournament lifecycle.
   Drives signup -> live -> closed transitions on an interval and pays out the
   prize pool when a tournament ends. Payouts go through closeTournament, which
   credits winners via the ledger (type 'tournament_prize'). */
'use strict';

const db = require('../db');

const SWEEP_MS = 15_000;

function statusFrom(dbTs) {
  return new Date(db.tsForDb(dbTs)).getTime();
}

async function sweep() {
  let tours;
  try {
    tours = await db.listTournaments();
  } catch (e) {
    return;
  }
  const now = Date.now();
  for (const t of tours) {
    try {
      if (t.status === 'signup' && statusFrom(t.starts_at) <= now) {
        await db.exec("UPDATE tournaments SET status = 'live' WHERE id = ? AND status = 'signup'", [t.id]);
      } else if (t.status === 'live' && statusFrom(t.ends_at) <= now) {
        const r = await db.closeTournament(t.id);
        if (r && r.ok) console.log(`[tournaments] "${t.name}" closed, pool ${r.pool}, ${r.winners} paid`);
      }
    } catch (e) {
      console.error('[tournaments sweep]', e && e.message);
    }
  }
}

function startScheduler() {
  if (global.__tournamentScheduler) return;
  global.__tournamentScheduler = setInterval(() => sweep().catch(() => {}), SWEEP_MS);
  sweep().catch(() => {});
}

module.exports = { sweep, startScheduler, SWEEP_MS };
