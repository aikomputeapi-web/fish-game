/* fishTypes.js — shared fish table (tiers, AoE specials, bonus pearl,
   variable bosses, armor). Server uses `mult`/`multRange` for the death
   check and `armor` for damage reduction; the client uses `kind` to pick
   a painter. */
'use strict';

// kind: painter key on the client. tier drives spawn weighting + hit-rate.
// special: 'aoe' triggers a fullscreen chain; 'bonus' triggers a bonus round.
// armor: flat damage reduction per hit. High-armor fish need powerful weapons.
const FISH = [
  // ---- minnows (frequent small hits) ---- no armor
  { id: 'guppy',    name: 'Reef Guppy',    mult: 2,   tier: 'minnow', weight: 25, r: 20,  speed: 110, armor: 0,  kind: 'fish',   body: '#ff9d3c', belly: '#ffe0b0', fin: '#ff6a00', stripe: '#e05a00' },
  { id: 'neon',     name: 'Neon Tetra',    mult: 3,   tier: 'minnow', weight: 21, r: 22,  speed: 120, armor: 0,  kind: 'fish',   body: '#3ec9ff', belly: '#d5f4ff', fin: '#0f7fd0', stripe: '#ff4d6d' },
  { id: 'angel',    name: 'Angelfish',     mult: 4,   tier: 'minnow', weight: 17, r: 26,  speed: 95,  armor: 0,  kind: 'fish',   body: '#ffd23c', belly: '#fff3c0', fin: '#e0a000', stripe: '#7a5200' },
  { id: 'clown',    name: 'Clownfish',     mult: 5,   tier: 'minnow', weight: 14, r: 26,  speed: 105, armor: 0,  kind: 'fish',   body: '#ff7330', belly: '#ffd9c0', fin: '#d84e10', stripe: '#ffffff' },
  // ---- mid ---- light to moderate armor
  { id: 'puffer',   name: 'Pufferfish',    mult: 7,   tier: 'mid', weight: 10, r: 30,  speed: 70,  armor: 1,  kind: 'puffer',   body: '#c9e265', belly: '#f2ffd0', fin: '#8aa63c', stripe: '#5d7522' },
  { id: 'mandarin', name: 'Coral Mandarinfish', mult: 9,  tier: 'mid', weight: 9,  r: 30,  speed: 100, armor: 1,  kind: 'mandarin', body: '#1f6dff', belly: '#7dffd8', fin: '#ff8c1a', stripe: '#ffb63c', glow: '#4ec9ff' },
  { id: 'turtle',   name: 'Rune Turtle',   mult: 12,  tier: 'mid', weight: 7,  r: 38,  speed: 55,  armor: 4,  kind: 'turtle',   body: '#3da35d', belly: '#cfe8b0', fin: '#2c7a44', stripe: '#1e5c31' },
  { id: 'serpray',  name: 'Emerald Serpent-Ray', mult: 16, tier: 'mid', weight: 5.5, r: 48, speed: 80, armor: 3, kind: 'serpentray', body: '#12a352', belly: '#8affc0', fin: '#0a6e36', stripe: '#ffd23c', glow: '#4dff9a' },
  { id: 'sword',    name: 'Swordfish',     mult: 20,  tier: 'mid', weight: 5,  r: 42,  speed: 150, armor: 2,  kind: 'fish',     body: '#7f9bb5', belly: '#e6f0f8', fin: '#5a7690', stripe: '#3e556b', nose: true },
  { id: 'octomage', name: 'Gilded Octo-Mage', mult: 25, tier: 'mid', weight: 4, r: 44, speed: 60, armor: 5,  kind: 'octomage', body: '#8a4fd0', belly: '#d9b6ff', fin: '#5c2fa0', stripe: '#ffcf4a', glow: '#c86bff' },
  { id: 'thunder',  name: 'Thunder Hammerhead', mult: 35, tier: 'mid', weight: 3, r: 54, speed: 100, armor: 6,  kind: 'thundershark', body: '#3d5a80', belly: '#dbe8f5', fin: '#28415f', stripe: '#ffd23c', hammer: true, glow: '#9fd8ff' },
  { id: 'shark',    name: 'Tiger Shark',   mult: 45,  tier: 'mid', weight: 2.5, r: 60, speed: 100, armor: 8,  kind: 'shark',    body: '#6e8494', belly: '#dbe6ec', fin: '#51636f', stripe: '#3a4a54' },
  // ---- mega bosses ---- heavy armor
  { id: 'dragonkoi',name: 'Emperor Dragon-Koi', mult: 60,  tier: 'mega', weight: 1.4, r: 42, speed: 120, armor: 10, kind: 'dragonkoi', body: '#c92a4e', belly: '#ffd98a', fin: '#ff8c1a', stripe: '#ffcf24', glow: '#ff9a2a' },
  { id: 'whale',    name: 'Blue Whale',    mult: 80,  tier: 'mega', weight: 0.8, r: 78, speed: 45,  armor: 15, kind: 'whale',    body: '#4a7ba6', belly: '#cfe2f0', fin: '#35597a', stripe: '#27435c' },
  // ---- AoE specials ----
  { id: 'crab',     name: 'Bomb Crab',     mult: 12,  tier: 'mid', weight: 3,  r: 34,  speed: 45,  armor: 3,  kind: 'crab',     body: '#e0483c', belly: '#ffb09e', fin: '#a82f26', stripe: '#701d17', special: 'aoe' },
  { id: 'laser',    name: 'Laser Crab',     mult: 60,  tier: 'mega',weight: 1.0, r: 40, speed: 50,  armor: 12, kind: 'crab',     body: '#b048e0', belly: '#ffb0ff', fin: '#7a2fa0', stripe: '#33ddff', special: 'aoe', laser: true },
  { id: 'eel',      name: 'Electric Eel',   mult: 90,  tier: 'mega',weight: 0.9, r: 46, speed: 75,  armor: 14, kind: 'eel',      body: '#7adfff', belly: '#e6fbff', fin: '#3aa0c8', stripe: '#ffea3a', special: 'aoe', glow: '#aef6ff' },
  { id: 'madshark', name: 'Mad Shark',      mult: 30,  tier: 'mid', weight: 2.0, r: 52, speed: 110, armor: 6,  kind: 'shark',    body: '#c23a2a', belly: '#ffc9a8', fin: '#7a1d10', stripe: '#ffea3a', special: 'aoe', bomb: true },
  { id: 'dynamite', name: 'Dynamite Stick', mult: 20,  tier: 'mid', weight: 2.0, r: 32, speed: 80,  armor: 2,  kind: 'dynamite', body: '#d2483a', belly: '#ffd9c9', fin: '#8a2418', stripe: '#ffd54a', special: 'aoe', bomb: true },
  // ---- bonus pearl ----
  { id: 'pearl',    name: 'Bonus Pearl',    mult: 5,   tier: 'minnow',weight: 0.6, r: 28, speed: 80,  armor: 0,  kind: 'pearl',    body: '#fff3a0', belly: '#ffffff', fin: '#ffcf4a', stripe: '#ff9a3a', special: 'bonus', glow: '#fff6c8' },
];

const BOSS = { id: 'kraken', name: 'KRAKEN', mult: 120, r: 80, speed: 55, kind: 'kraken', tier: 'mega', armor: 20, body: '#5a4a8a', belly: '#c0a0ff', fin: '#3a2a6a', stripe: '#ffd23c', boss: true, sharedHp: 800 };

// variable bosses — display a range; death-check uses the expected mult.
const VARIABLE_BOSSES = [
  { id: 'goldendragon', name: 'GOLDEN DRAGON', multRange: [100, 500], expectedMult: 300, r: 76, speed: 60, kind: 'dragonkoi', tier: 'mega', armor: 25, body: '#ffcf24', belly: '#fff3a0', fin: '#e09010', stripe: '#a05a00', glow: '#ffe680', boss: true, variable: true, sharedHp: 1200 },
  { id: 'kirin', name: 'FIRE KIRIN', multRange: [150, 600], expectedMult: 375, r: 84, speed: 55, kind: 'kirin', tier: 'mega', armor: 28, body: '#ff5a1a', belly: '#ffd9a8', fin: '#c83200', stripe: '#ffe680', glow: '#ff9a2a', boss: true, variable: true, sharedHp: 1600 },
  { id: 'phoenix', name: 'PHOENIX KING', multRange: [200, 800], expectedMult: 500, r: 88, speed: 70, kind: 'phoenix', tier: 'mega', armor: 30, body: '#ff3a6a', belly: '#ffd9a8', fin: '#ff8c1a', stripe: '#fff0c0', glow: '#ffcf4a', boss: true, variable: true, sharedHp: 2000 },
];

function fishTable() {
  return { FISH, BOSS, VARIABLE_BOSSES };
}

module.exports = { FISH, BOSS, VARIABLE_BOSSES, fishTable };
