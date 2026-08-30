/* tournaments.js — player-facing tournament REST API.
   List open/scheduled tournaments, join by paying the entry fee, and read live
   standings (net score = winnings - wagering during the tournament window). */
'use strict';

const express = require('express');
const db = require('./db');
const { requireAuth, requirePlayer } = require('./auth');

const router = express.Router();
router.use(requireAuth, requirePlayer);
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function toClient(t) {
  return {
    id: t.id, name: t.name, status: t.status, entryFee: Number(t.entry_fee),
    prizePool: Number(t.prize_pool), startsAt: db.tsForDb(t.starts_at),
    endsAt: db.tsForDb(t.ends_at),
    winnerPcts: (() => { try { return JSON.parse(t.winner_pcts); } catch (_) { return [50, 30, 20]; } })(),
  };
}

router.get('/', ah(async (req, res) => {
  const tours = await db.listTournaments();
  const entries = await db.q("SELECT tournament_id FROM tournament_entries WHERE user_id = ?", [req.user.id]);
  const joined = new Set(entries.map(e => e.tournament_id));
  res.json(tours.map(t => ({ ...toClient(t), joined: joined.has(t.id) })));
}));

router.get('/:id', ah(async (req, res) => {
  const t = await db.one("SELECT * FROM tournaments WHERE id = ?", [parseInt(req.params.id, 10)]);
  if (!t) return res.status(404).json({ error: 'tournament not found' });
  const leaderboard = await db.tournamentLeaderboard(t.id);
  const joined = await db.one("SELECT 1 FROM tournament_entries WHERE tournament_id = ? AND user_id = ?", [t.id, req.user.id]);
  res.json({ ...toClient(t), joined: !!joined, leaderboard });
}));

router.post('/:id/join', ah(async (req, res) => {
  const r = await db.joinTournament(parseInt(req.params.id, 10), req.user.id);
  if (!r.ok) {
    if (r.reason === 'no_tournament') return res.status(404).json({ error: 'tournament not found' });
    if (r.reason === 'not_signup') return res.status(400).json({ error: 'tournament is not accepting entries' });
    if (r.reason === 'already_joined') return res.status(400).json({ error: 'already joined' });
    return res.status(400).json({ error: 'insufficient points to pay the entry fee' });
  }
  res.json({ ok: true, fee: r.fee, balance: r.balance });
}));

module.exports = router;
