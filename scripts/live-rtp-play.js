/* live-rtp-play.js — headless gameplay client against the LIVE Railway server.
   Logs in as a player, joins a solo room, fires N real `hit` shots at spawned
   fish, and measures realized RTP from the server's own acks + balance ledger.
   Usage: node scripts/live-rtp-play.js <baseUrl> <user> <pass> <shots> <bet> */
'use strict';
const { io } = require('socket.io-client');

const BASE = process.argv[2] || 'https://fire-kirin-dev-production.up.railway.app';
const USER = process.argv[3] || 'rtptest';
const PASS = process.argv[4] || 'rtptest12345';
const N    = parseInt(process.argv[5] || '8000', 10);
const BET  = parseInt(process.argv[6] || '10', 10);
const CONCURRENCY = 12;

(async () => {
  // 1) login -> capture auth cookie
  const res = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error('login failed: ' + JSON.stringify(body));
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const cookie = setCookies.filter(Boolean).map(c => c.split(';')[0]).join('; ');
  console.log(`logged in as ${body.username} (id ${body.id}, role ${body.role}, points ${body.points})`);

  // 2) connect socket with the cookie
  const socket = io(BASE, {
    transports: ['websocket'],
    extraHeaders: { Cookie: cookie },
    auth: { gameMode: 'solo' },
  });

  const fish = new Map(); // fishId -> { boss, spawnAt, expireAt }
  let balance = Number(body.points);
  socket.on('spawn', (f) => {
    fish.set(f.fishId, { boss: !!f.boss, spawnAt: Date.now() - (f.age || 0), expireAt: Date.now() - (f.age || 0) + (f.dur || 6000) });
  });
  const drop = (id) => fish.delete(id);
  socket.on('kill', (k) => { drop(k.fishId); if (k.chain) k.chain.forEach(c => drop(c.fishId)); });
  socket.on('despawn', (d) => drop(d.fishId));
  socket.on('balance', (b) => { balance = b.points; });
  socket.on('connect_error', (e) => { console.error('connect_error:', e.message); });

  await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 15000);
  });
  console.log('socket connected:', socket.id);
  await new Promise(r => setTimeout(r, 1500)); // let initial fish populate

  const hit = (fishId) => new Promise((resolve) => {
    socket.emit('hit', { fishId, bet: BET, weaponLevel: 0 }, (ack) => resolve(ack || { ok: false }));
  });

  // pick a distinct on-screen, non-boss fish not already chosen this batch
  function pickCandidates(k, taken) {
    const now = Date.now();
    const out = [];
    for (const [id, f] of fish) {
      if (f.boss || taken.has(id)) continue;
      const age = now - f.spawnAt;
      if (age < 500 || now > f.expireAt - 400) continue; // likely on-screen window
      out.push(id); taken.add(id);
      if (out.length >= k) break;
    }
    return out;
  }

  let wagered = 0, paid = 0, bets = 0, kills = 0, goneAcks = 0, broke = 0;
  const multHist = {};
  const t0 = Date.now();
  let lastLog = 0;

  while (bets < N) {
    const taken = new Set();
    const cands = pickCandidates(CONCURRENCY, taken);
    if (cands.length === 0) { await new Promise(r => setTimeout(r, 120)); continue; }
    const acks = await Promise.all(cands.map(hit));
    for (const a of acks) {
      if (!a.ok) { if (a.reason === 'gone') goneAcks++; else if (a.reason === 'broke') broke++; continue; }
      wagered += BET; bets++;
      if (a.killed) { paid += a.payout; kills++; const m = a.mult; multHist[m] = (multHist[m] || 0) + 1; }
    }
    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      const rt = wagered ? paid / wagered : 0;
      process.stdout.write(`  progress bets=${bets} wagered=${wagered} paid=${paid} realized=${rt.toFixed(4)} alive=${fish.size}\n`);
    }
  }

  const realized = wagered ? paid / wagered : 0;
  console.log('\n=== LIVE Gameplay RTP ===');
  console.log('server     :', BASE);
  console.log('bets landed:', bets.toLocaleString(), `(bet size ${BET})`);
  console.log('wagered    :', wagered.toLocaleString());
  console.log('paid       :', paid.toLocaleString());
  console.log('realized   :', realized.toFixed(4), `(house edge ${((1 - realized) * 100).toFixed(2)}%)`);
  console.log('target     : 0.9600');
  console.log('err vs 0.96:', (Math.abs(realized - 0.96) * 100).toFixed(2) + '%');
  console.log('kills      :', kills.toLocaleString(), `(${(kills / bets * 100).toFixed(2)}% hit rate)`);
  console.log('gone acks  :', goneAcks, ' broke:', broke);
  console.log('final bal  :', balance.toLocaleString());
  const top = Object.entries(multHist).map(([m, c]) => [Number(m), c]).sort((a, b) => b[0] - a[0]).slice(0, 8);
  console.log('top mults  :', top.map(([m, c]) => `x${m}:${c}`).join('  '));
  socket.disconnect();
  process.exit(0);
})().catch(e => { console.error('play failed:', e); process.exit(1); });
