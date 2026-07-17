/* paths.js — shared cubic-bezier swim paths. Server evaluates position at any
   time t to validate hits (parametric — no per-frame physics on the server);
   the client interpolates the same paths for smooth rendering. */
'use strict';

const { W, H } = require('./constants');

function rand(min, max) { return min + Math.random() * (max - min); }

function makePath(r) {
  const fromLeft = Math.random() < 0.5;
  const margin = (r || 20) + 60;
  const y0 = rand(60, H - 220), y3 = rand(60, H - 220);
  const p0 = { x: fromLeft ? -margin : W + margin, y: y0 };
  const p3 = { x: fromLeft ? W + margin : -margin, y: y3 };
  const p1 = { x: rand(W * 0.15, W * 0.45), y: rand(40, H - 200) };
  const p2 = { x: rand(W * 0.55, W * 0.85), y: rand(40, H - 200) };
  if (!fromLeft) { const t = p1.x; p1.x = p2.x; p2.x = t; }
  return [p0, p1, p2, p3];
}

function makeBossPath(r) {
  const y = rand(160, H - 300);
  const fromLeft = Math.random() < 0.5;
  const m = 180;
  return [
    { x: fromLeft ? -m : W + m, y },
    { x: W * 0.3, y: y + rand(-120, 120) },
    { x: W * 0.7, y: y + rand(-120, 120) },
    { x: fromLeft ? W + m : -m, y: rand(160, H - 300) },
  ];
}

function bezier(p, t) {
  const u = 1 - t;
  return {
    x: u * u * u * p[0].x + 3 * u * u * t * p[1].x + 3 * u * t * t * p[2].x + t * t * t * p[3].x,
    y: u * u * u * p[0].y + 3 * u * u * t * p[1].y + 3 * u * t * t * p[2].y + t * t * t * p[3].y,
  };
}

function bezierTangent(p, t) {
  const u = 1 - t;
  return {
    x: 3 * u * u * (p[1].x - p[0].x) + 6 * u * t * (p[2].x - p[1].x) + 3 * t * t * (p[3].x - p[2].x),
    y: 3 * u * u * (p[1].y - p[0].y) + 6 * u * t * (p[2].y - p[1].y) + 3 * t * t * (p[3].y - p[2].y),
  };
}

// approximate path length for constant-speed parametrization
function pathLength(p, steps = 24) {
  let len = 0, prev = bezier(p, 0);
  for (let i = 1; i <= steps; i++) {
    const q = bezier(p, i / steps);
    len += Math.hypot(q.x - prev.x, q.y - prev.y);
    prev = q;
  }
  return len;
}

module.exports = { makePath, makeBossPath, bezier, bezierTangent, pathLength };