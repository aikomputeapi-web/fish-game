# Fire Kirin Dev — Server-Authoritative Rebuild Plan

> Status: **DRAFT for approval** — no code written yet.

## What "recreate" means here

The current directory holds a *client-only* canvas fish shooter ("Reef Fortune")
with Supabase auth/balance. The agreed target is a **full server-authoritative
rebuild** that combines:

1. The **owner / manager / player** hierarchy + admin/manager panels from the
   prior spec (carried over *exactly* — single manager balance, float
   accounting, player-initiated redeem approved by manager, RTP owner-only,
   managers can't play, ban+kick).
2. The **rich procedural canvas engine** already in this repo (the 1850-line
   `js/game.js` with its fish painters + synth audio) — *reused as the renderer*,
   not thrown away.
3. **All 7 new game systems** from the research dump.

## Architecture (the key decision)

Server-authoritative, but using a **hybrid that keeps the game responsive**:

- **Server is the source of truth for**: spawning fish, kill/death checks,
  balance/points, RTP, bonus triggers, mini-game prizes, bans.
- **Client is authoritative only for rendering + input feel**: it spawns bullets
  *optimistically* for instant feedback, emits hits to the server, and animates
  purely on server-driven events. Balance numbers update only from server pushes.
- **Fish positions are parametric** (`position = f(path, t)`), shared via
  `server/game/paths.js`. The server never runs per-frame physics — it computes a
  fish's position on demand to validate a hit. This keeps CPU tiny (free-tier
  friendly) and makes 4-player shared tables a drop-in later (same path broadcast
  to N clients).

Stack: **Node + Express + Socket.io** (REST for auth/admin/manager, WebSocket for
the game room), **Postgres via `pg`** in prod (Neon) with a **SQLite (`node:sqlite`)
fallback for zero-setup local dev** (same `db.js` abstraction as the prior build).
Free hosting: **Render web service + Neon Postgres** (sleeps after 15 min idle).

---

## The 7 new game systems (design)

### 1. Dynamic death-check HP system (the math core)

Per bullet of value `B` hitting alive fish `F` (multiplier `M`) in a room with
owner-set RTP target `T`, closed-loop allowance `A`, and bullet-feel factor `f(B)`:

```
P(kill) = clamp( (T / M) * A * f(B), 0, 0.95 )
payout  = M * B        (or rolled mult for variable bosses)
EV      = P * payout   → converges to T*B over time (via A)
```

- **`A` (allowance) is a closed-loop controller**: from a rolling window of the
  room's `(totalWagered, totalPaid)` we compute `realizedRTP`; if the table is
  under-paying, `A > 1` boosts kill chances to force payout; if over-paying,
  `A < 1` suppresses them. Long-run realized RTP converges to the owner's `T`.
  This is the research's "dynamic probability scaling to force a payout."
- **`f(B)` (bullet feel)** is a *mild* lethality bump for bigger bets
  (`f = 1 + 0.5*ln(B/B_ref)`, clamped). Because `A` is a closed loop, any
  systematic bias from `f` is countered — realized RTP still lands on `T`.
  `f` is admin-tunable; setting it to `1.0` reproduces the pure recap math
  exactly. So bigger bullets *feel* more lethal without becoming an
  exploitable high-roller loophole.
- Optional **visible HP bar** per fish for "softening" feel — cosmetic only,
  *does not affect `P`* (the death check is probabilistic, per the research).
- Settings (RTP, `f`, weapon costs) live in the `settings` table, read live.

### 2. Bonus mode + interactive mini-games

- **Base mode** = low volatility: frequent small hits (minnows 2×–5×) keep the
  balance stable. Hit-rate retuned so ~25–30% of shots land *something*.
- **Bonus trigger**: rare "Bonus Pearl" fish / accumulator; on capture, server
  enters a **bonus round** (~20–45 s): room reconfigures to high-volatility
  (mega-fish spawn surge, payout multiplier active), capped by RTP overall.
- **Mini-game** (v1: *pick-a-chest*; wheel = stretch): on trigger, client shows
  3 chests. The **server pre-decides the prize** from an RTP-controlled
  distribution; the player's pick is cosmetic (all chests equal EV — the
  "illusion of choice"). Server credits the win; client animates the reveal.

### 3. AoE weapons — Laser Crab & Electric Eel

- New special fish with a **large bundled multiplier**. On capture the server
  broadcasts a **fullscreen chain** that visually "clears" every fish in radius
  (they despawn with the chain animation). **The player is paid the single big
  multiplier**, not the sum of the cleared fish — so the books stay honest
  (matches the research: "just batching fifty minnow payouts into one spectacle").
- Despawning softens other players' investment → the "sniper-tax" friction later.
- AoE fish payout accounted like any fish → RTP stays exact via `A`.

### 4. Weapon upgrades (high-roller / switchable model)

- 5 cannon levels. Higher level = **higher cost per shot** + bigger visuals +
  faster fire rate + the `f(B)` lethality bump. EV per point wagered stays `T`
  (the odds formula is normalized), so upgrades change *stakes + feel*, not the
  house edge — the math-honest cabinet model from the research.
- Free to switch in this arcade build (no grind unlock). A purchased-unlock
  progression model is a documented later option.

### 5. Visual reward feedback loop (all client-side VFX)

- **Hitstop**: on big kills (mult ≥ 50) freeze the frame ~120 ms + flash fish white.
- **Screen shake**: decaying sine, amplitude scales with win size (capped).
- **Radial blur + chromatic aberration**: brief full-screen overlay on mega wins.
- **Coin cascade**: physical coins erupt from the kill, bounce, fly to the counter.
- **Rolling odometer**: balance/score ticks up over ~1 s instead of instantly.
- **Mega-win banner**: metallic/fire "MEGA WIN 500×" overlay; dims the rest 1–2 s.
- Audio driven by the existing synth `sfx.js` + a new escalating big-win fanfare.

### 6. Near-miss teases

- On a non-killing hit against a **big** fish where the roll was *close*
  (`r` just above `P`), the client plays a near-miss: bright flash + the fish
  "escapes" with a speed burst. Feels like an almost-jackpot. Cosmetic only.

### 7. Variable boss multipliers

- Mega bosses display a **range** (e.g. 100×–500×) instead of a fixed value.
- The **death-check `P` uses the expected multiplier** `M_eff = (lo+hi)/2`, so EV
  stays honest: `EV = (T/M_eff)·A · (E[rolledMult]·B) = T·A·B`.
- On death the server rolls the actual mult in `[lo,hi]` and broadcasts it; the
  client shows a **cycling counter that dramatically slows** to reveal the result.

## Aquarium ecology (fish tiers)

| Tier | Examples | Mult | Spawn wt | Role |
|---|---|---|---|---|
| Minnows | Guppy, Tetra, Angelfish, Clownfish | 2×–5× | high | frequent small hits |
| Mid | Turtle, Serpent-Ray, Swordfish, Octo-Mage, Sharks | 10×–50× | med | balance swings |
| Mega bosses | Dragon-Koi, Whale, Abyss-Lord, **Kraken (new)** | 60×–250× | low | the big thrill |
| Variable bosses | **Golden Dragon (100×–500×)** | range | very low | jackpot chase |
| AoE specials | **Laser Crab, Electric Eel** | big bundled | rare | chain spectacle |
| Bonus | **Bonus Pearl** | triggers bonus | very rare | bonus mode entry |

(Existing 15 species + boss kept; 3–4 new types added.)

---

## Roles & panels (carried over exactly from the prior spec)

- **Owner** (renamed from `admin`): mint/deduct any points to anyone, ban/unban
  (kicks live sockets), RTP slider (10–120%), promote/demote managers, global
  stats. One account seeded from `ADMIN_USERNAME`/`ADMIN_PASSWORD`.
- **Manager** (new role): back-office only — **cannot play** (game socket
  refuses managers). Holds a single balance ("float") issued by the owner.
  Grants points from float to any player (first grant **claims** the player
  permanently). Approves/rejects player **redeem requests** (approved points
  return to the manager). Sees only their claimed players + wager/win totals +
  their own grant/recover history. Never sees RTP/global stats/other managers.
- **Player**: unchanged + **💎 Redeem** button → request to their claiming
  manager (cancellable). Balance updates live on approval.
- All point moves are **atomic DB transfers** with a full `transactions` audit
  trail; ledger must always balance.

## Database schema (Postgres + SQLite dual, `CREATE TABLE IF NOT EXISTS`)

```
users            id, username UNIQUE, password_hash, points BIGINT DEFAULT 2000,
                 role TEXT DEFAULT 'player',   -- player|manager|owner
                 manager_id INT NULL,          -- claiming manager
                 banned BOOL DEFAULT false, created_at, last_login
settings         key PK, value                  -- rtp=0.96, bullet_factor=1.0, ...
transactions     id, user_id, type,             -- bet|win|admin_grant|signup_bonus|
                                                    manager_grant|redeem|bonus|aoe
                 amount, balance_after, admin_id NULL, manager_id NULL,
                 note NULL, created_at
redeem_requests  id, user_id, manager_id, amount, status,  -- pending|approved|rejected|cancelled
                 created_at, resolved_at
```

## Socket protocol (client optimistic, server authoritative)

Client→Server: `fire{weaponLevel}` · `hit{fishId,bet}` · `selectWeapon{level}` ·
`miniGamePick{choice}` · (redeem via REST)
Server→Client: `spawn{fishId,typeId,path,duration,spawnTime}` · `despawn` ·
`kill{fishId,winnerId,mult,payout,isAoE,chain[]}` · `balance{points}` ·
`bonusStart{duration}` · `miniGameResult{choice,prizeMult,win}` · `bonusEnd` ·
`banned` (kick)

REST (cookie-JWT): `/api/auth/*`, `/api/admin/*` (owner), `/api/manager/*`
(manager), `/api/player/*` (redeem).

## File structure

```
fire-kirin-dev/
  package.json  render.yaml  .env.example  DEPLOY.md  README.md  PLAN.md
  server/
    index.js            express + socket.io bootstrap, static host, route mounts
    db.js               pg|sqlite pool, migrations, seedOwner, adjustPoints, transferPoints
    auth.js             register/login, JWT httpOnly cookie, requireAuth/Owner/Manager, rate limit
    admin.js            owner REST: users, mint/deduct, ban, promote/demote, RTP/settings, stats
    manager.js          manager REST: overview, players(+wager/win), grant, requests, history
    player.js           player REST: redeem request/cancel, my manager
    game/
      constants.js      shared W/H, BETS, weapon levels, tier defs
      fishTypes.js      shared fish table (tiers, AoE, bonus pearl, variable bosses)
      paths.js          shared bezier (server validates, client renders)
      rooms.js          room lifecycle, spawning, death checks, allowance controller, bonus logic
      rng.js            kill rolls, settings cache, rolling-RTP allowance
  public/
    index.html  auth.html  auth.js   (role-based redirect: owner→/admin, manager→/manager, player→/game)
    game.html  game.js  sfx.js  style.css   (the canvas client — ported from existing game.js + new VFX)
    admin.html  admin.js            (owner panel)
    manager.html  manager.js        (manager dashboard)
  scripts/simulate.js   RTP simulation (fires N bullets, asserts realized ≈ target)
```

The existing `js/game.js`, `js/sfx.js`, `css/style.css` are the **starting point**
for `public/game.js`, `public/sfx.js`, `public/style.css` — local kill math gets
gutted and rewired to socket events; all new VFX/weapon/bonus/AoE UI is added.

## Milestones (build order)

1. **Scaffold + backend**: package.json, db.js (dual-engine migrations +
   seedOwner + adjustPoints + transferPoints), auth.js, index.js, render.yaml,
   .env.example. Migrate the repo to a Node app.
2. **Roles & panels**: admin.js + manager.js + player.js REST + admin/manager/auth
   pages. Full owner/manager/player + redeem + ban flow (carries over prior spec).
3. **Game core (server-authoritative)**: constants.js, fishTypes.js, paths.js,
   rng.js (RTP controller), rooms.js (spawn + death check + balance push).
   Port client to socket-driven render (optimistic fire, server kills).
4. **Death-check + ecology**: tiers, minnow hit-rate tuning, HP bar, bullet feel.
5. **Bonus mode + mini-game + AoE + variable bosses + weapon upgrades**: the
   spectacle systems.
6. **Visual reward feedback loop**: hitstop, screen shake, radial blur, coin
   cascade, odometer, mega banners, near-miss teases.
7. **Hardening**: fire-rate caps, hit validation, banned-user enforcement
   everywhere, settings cache, edge cases (over-spend mid-flight, bonus during
   zero balance, demoted manager with active requests).
8. **Deploy**: render.yaml, DEPLOY.md, README; `scripts/simulate.js` +
   browser end-to-end verification.

## Verification

- **RTP simulation** (`node scripts/simulate.js`): fire ~200k bullets against
  the room engine at RTP 0.96 → assert realized payout within ~2% of target;
  repeat at 0.50 and 1.20.
- **Role/ledger API tests** (PowerShell): promote player→manager, grant float,
  grant+claim, over-float rejection, redeem request→approve (and approve-after-
  gamble failure), permission 403s, manager socket refused.
- **Ledger audit**: `sum(transactions.amount) per user == users.points - signup_bonus`.
- **Browser end-to-end (wmux)**: register → play (shoot, kill, watch balance) →
  redeem request → manager approve → balance updates live → owner changes RTP →
  behavior changes within seconds → ban player → kicked.

## Out of scope for v1 (documented follow-ups)

- Last-hit sniper tax and matchmaking beyond simple four-player FIFO queues.
- Weapon "grind unlock" progression model; real art assets; real money.
- Push notifications for managers (dashboard auto-refresh only).

## Notes / constraints

- **Virtual points only, no real money** — UI says "redeem points", never
  currency/cashout. No payment features.
- Render free tier sleeps after 15 min idle (~30–60 s cold start).
- Bet tiers / weapon levels and starting balance (2000) TBD-confirm in build.
