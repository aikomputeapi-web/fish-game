# Reef Fortune — Browser Arcade Fish Shooter

An original arcade fish-shooter in the style of the coin-op "fish game" genre
(rotating cannon, bet-scaled bullets, odds-based fish payouts). All artwork is
drawn procedurally on `<canvas>` and all sound is synthesized with the Web Audio
API — there are no external assets and no copyrighted material.

## Run it

Any static file server works. From this directory:

```
npx serve -l 8137 .
```

Then open http://localhost:8137. (Opening `index.html` directly from disk also
works — there are no network requests.)

## How to play

- **Aim** — move the mouse / drag a finger; the cannon tracks the pointer.
- **Fire** — hold the mouse button / touch. Each shot costs the current BET.
- **BET − / +** — cycle bet tiers 1, 2, 5, 10, 20, 50, 100. The cannon barrel
  grows with the bet and bullets get bigger.
- **AUTO** — continuous fire at the current aim.
- **TARGET** — toggle lock mode, then tap a fish: the cannon auto-aims and
  auto-fires at it until it's caught or leaves the screen.
- Bullets bounce off the left/right/top walls up to 3 times.
- Each hit throws a net; the catch is probabilistic — expected payout per hit
  is `RTP × bet` (RTP is 0.94, set in `js/game.js`). A caught fish pays
  `multiplier × bet`.
- **Bomb Crab** (x12) explodes when caught and catches every normal fish in a
  230 px radius.
- **Colossal Abyss-Lord boss** (x250) — a three-headed gilded hydra with
  orb-bearing tentacles — sweeps through periodically; banner + siren announce it.
- Free-play economy: you start with 2,000 coins and a "+1000 COINS" button
  appears whenever you go broke. No real money is involved anywhere.

## Species table

| Fish | Multiplier | | Fish | Multiplier |
|---|---|---|---|---|
| Reef Guppy | x2 | | Rune Turtle | x12 |
| Neon Tetra | x3 | | Bomb Crab | x12 (AoE) |
| Angelfish | x4 | | Emerald Serpent-Stingray | x16 |
| Clownfish | x5 | | Swordfish | x20 |
| Pufferfish | x7 | | Gilded Octo-Mage | x25 |
| Neon Coral Mandarinfish | x9 | | Thunder-Crest Hammerhead | x35 |
| Emperor Dragon-Koi | x60 | | Tiger Shark | x45 |
| Blue Whale | x80 | | **Colossal Abyss-Lord (boss)** | **x250** |

## Code layout

- `index.html` — page shell + DOM HUD (balance / win / bet / mode buttons)
- `css/style.css` — HUD styling, responsive down to phone widths
- `js/sfx.js` — synthesized sound effects (shoot, hit, coin, big win, boss…)
- `js/game.js` — everything else: species table, bezier swim paths, bullets &
  wall bounces, nets, catch odds, coin/text/particle effects, boss cadence,
  procedural painters for every species, cannon, render loop

The game renders at a fixed 1440×810 logical resolution letterboxed into any
window, so gameplay coordinates are identical on every screen.

## Mobile app path (next phase)

The game is pure HTML5 with pointer events (mouse + touch already work), so the
planned Android/iOS build is a thin wrapper: Capacitor (recommended) or Cordova
around this exact codebase, landscape-locked, with the fullscreen button hidden.
No gameplay code changes should be needed.
