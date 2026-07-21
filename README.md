# Reef Fortune — Server-Authoritative Arcade Fish Shooter

An arcade fish-shooter in the style of the coin-op "fish game" genre with
a full owner → manager → player role hierarchy, real-time multiplayer
gameplay, and a server-authoritative economy. All artwork is drawn
procedurally on `<canvas>` and all sound is synthesised with the Web Audio
API — there are no external assets and no copyrighted material.

## Features

- **Server-authoritative gameplay** — all kill rolls, balance updates and
  point transfers are decided by the server; the client is a renderer only.
- **Three-tier role hierarchy** — Owner (single account, sets RTP target,
  full control) → Managers (distribute funds, approve redemptions) → Players
  (play, redeem via manager).
- **Solo and 4-player multiplayer modes** — Solo gives each player a private
  table. Multiplayer uses simple FIFO matchmaking: every four queued players
  are placed into an isolated shared fish table.
- **Closed-loop RTP control** — a proportional-integral allowance controller
  keeps realised RTP tracking the owner-set target over time. Same EV per
  point regardless of bet size or weapon level.
- **19 fish species** including minnows, mid-range, mega bosses (x60–x250),
  variable bosses (goldendragon x100–x500 with random roll), AoE specials
  (Bomb Crab, Laser Crab, Electric Eel), and a Bonus Pearl that triggers a
  30-second pick-a-chest bonus round.
- **5 weapon levels** (STD → PWR → HEAVY → LASER → NOVA) — higher levels
  cost more per shot but fire faster and produce larger bullets. Same EV per
  point spent.
- **Visual reward feedback loop** — hit-stop freeze frames, screen shake,
  coin-cascade burst animations, rolling odometer balance counter, mega-win
  banners, bonus-mode tint overlay, and near-miss flashes on close rolls.
- **Full audit trail** — every point movement is a database row with a
  ledger that must always balance to zero.

## Tech Stack

| Layer | Technology |
|---|---|
| Server | Node.js 22.13+, Express, Socket.io |
| Database | PostgreSQL (production via Neon) / SQLite (local dev) |
| Client | Vanilla HTML5 Canvas, Web Audio API |
| Hosting | Render free tier (web service) + Neon Postgres (free tier) |

## Run locally

### Prerequisites

- Node.js ≥ 22.13
- npm

### Quick start (SQLite, no database setup needed)

```bash
npm install
cp .env.example .env        # edit JWT_SECRET at minimum
npm start                   # starts on port 3000
```

Open **http://localhost:3000**.

The default `.env.example` has no `DATABASE_URL`, so SQLite is used
automatically (file: `dev.sqlite`).

### First boot

On first start the owner account is seeded from `ADMIN_USERNAME` /
`ADMIN_PASSWORD`. Set a strong value before the first production boot;
production refuses the default password. Log in at `/auth.html` with those
credentials.

### RTP simulation

```bash
npm run simulate
```

Runs 200,000 shots at each RTP target (50%, 96%, 120%) and asserts
realised RTP is within 3% of target.

### Tests

```bash
npm test
```

Runs isolated SQLite transaction tests covering manager ownership, redemption
idempotency, room-stat updates, four-player matchmaking, and server startup.

## Pages

| Path | Description |
|---|---|
| `/auth.html` | Login / register |
| `/` (game) | Fish-shooter game (players only) |
| `/admin.html` | Owner panel — users, points, ban/promote, RTP, stats |
| `/manager.html` | Manager dashboard — overview, players, grant, redeem requests |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | Server port |
| `DATABASE_URL` | *(empty — SQLite)* | Postgres connection string |
| `JWT_SECRET` | — | Secret for JWT tokens (change in production) |
| `ALLOWED_ORIGINS` | `APP_URL` | Comma-separated browser origins allowed to open Socket.IO connections |
| `ADMIN_USERNAME` | `admin` | Owner account username |
| `ADMIN_PASSWORD` | `changeme123` locally | Owner account password (must be non-default in production) |
| `SIGNUP_BONUS` | `2000` | Points given to new player accounts |

## Code Layout

```
server/
  index.js          Express + Socket.io bootstrap, route mounts, auth middleware
  auth.js           Register / login / JWT cookie flow, requireAuth/Owner/Manager
  db.js             Dual-engine (pg/sqlite) database, migrations, adjustPoints,
                    transferPoints, settings
  admin.js          Owner REST API (users, points, ban, promote, RTP, stats)
  manager.js        Manager REST API (overview, players, grant, requests, history)
  player.js         Player REST API (redeem request/cancel)
  game/
    rooms.js        Server-authoritative room engine — spawn, death-check, protocol,
                    balance push, bonus/AoE/mini-game, allowance tick
    rng.js          killRoll, rollVariableMult, bonusTriggerRoll, computeAllowance,
                    loadSettings
    fishTypes.js    19 species + Kraken boss + variable bosses
    constants.js    Resolution, bets, weapon levels, fish tiers
    paths.js        Cubic bezier paths, boss paths, pathLength

public/
  game.html         Game page shell
  game.js           Socket-driven procedural canvas renderer, VFX, weapon selector,
                    redeem modal, mini-game overlay
  auth.html         Login / register page
  admin.html        Owner panel SPA
  manager.html      Manager dashboard SPA
  style.css         Shared styles (auth, panels, game HUD, VFX classes)
  auth.js           Shared auth client (me, login, register, logout, redirect)
  sfx.js            Web Audio synthesised sound effects

scripts/
  simulate.js       RTP simulation (200k shots, 3% tolerance)
```

## How to Play

1. **Aim** — move the mouse; the cannon tracks the pointer.
2. **Fire** — hold the mouse button. Each shot costs `bet × weapon costMult`.
3. **BET − / +** — cycle bet tiers: 1, 2, 5, 10, 20, 50, 100.
4. **Weapon level** — click the weapon indicator to cycle STD → PWR → HEAVY →
   LASER → NOVA. Higher levels fire faster with bigger bullets but cost more.
5. **AUTO** — continuous fire at current aim.
6. **TARGET** — lock mode: tap a fish to auto-aim and auto-fire until caught.
7. Bullets bounce off walls up to 3 times.
8. Each hit rolls probabilistically — expected payout per hit is
   `RTP × bet × weaponCostMult`. A caught fish pays `multiplier × bet × weaponCostMult`.
9. **MULTI** queues you until four players are ready; those four share the same
   fish, bosses, and bonus events. Each player’s balance remains separate.

## Species Table

| Fish | Mult | Tier | | Fish | Mult | Tier |
|---|---|---|---|---|---|---|
| Reef Guppy | x2 | minnow | | Rune Turtle | x12 | mid |
| Neon Tetra | x3 | minnow | | Bomb Crab | x12 | mid (AoE) |
| Angelfish | x4 | minnow | | Emerald Serpent-Ray | x16 | mid |
| Clownfish | x5 | minnow | | Swordfish | x20 | mid |
| Pufferfish | x7 | mid | | Gilded Octo-Mage | x25 | mid |
| Coral Mandarinfish | x9 | mid | | Thunder Hammerhead | x35 | mid |
| | | | | Tiger Shark | x45 | mid |
| Emperor Dragon-Koi | x60 | mega | | **Kraken (boss)** | **x250** | mega |
| Blue Whale | x80 | mega | | Golden Dragon | x100–500 | mega (variable) |
| Laser Crab | x60 | mega (AoE) | | Electric Eel | x90 | mega (AoE) |
| Bonus Pearl | — | triggers bonus round | | | | |

## License

Private — not for public distribution.
