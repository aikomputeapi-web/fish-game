/* Reef Fortune — original synthesized sound effects (Web Audio API). */
'use strict';

const SFX = (() => {
  let ctx = null;
  let enabled = true;
  let noiseBuf = null;

  function ac() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      // 1s of white noise, reused by percussive effects
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(freq, endFreq, type, dur, vol, when = 0) {
    if (!enabled) return;
    const a = ac();
    const t = a.currentTime + when;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (endFreq && endFreq !== freq) {
      o.frequency.exponentialRampToValueAtTime(Math.max(1, endFreq), t + dur);
    }
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  function noise(dur, vol, filterFreq, when = 0, endFilter = null) {
    if (!enabled) return;
    const a = ac();
    const t = a.currentTime + when;
    const src = a.createBufferSource();
    src.buffer = noiseBuf;
    const f = a.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(filterFreq, t);
    if (endFilter) f.frequency.exponentialRampToValueAtTime(endFilter, t + dur);
    const g = a.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(a.destination);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  return {
    unlock() { ac(); },
    get enabled() { return enabled; },
    toggle() { enabled = !enabled; if (enabled) ac(); return enabled; },

    shoot() {
      tone(360, 90, 'square', 0.09, 0.12);
      noise(0.06, 0.10, 3000, 0, 600);
    },
    hit() {
      noise(0.05, 0.14, 1800, 0, 400);
    },
    kill() {
      tone(240, 520, 'triangle', 0.12, 0.18);
      noise(0.15, 0.12, 1200, 0, 300);
    },
    coin(i = 0) {
      tone(920, 920, 'sine', 0.09, 0.10, i * 0.04);
      tone(1380, 1380, 'sine', 0.12, 0.08, i * 0.04 + 0.05);
    },
    bigWin() {
      const notes = [523, 659, 784, 1047, 1319, 1568];
      notes.forEach((n, i) => tone(n, n, 'triangle', 0.22, 0.16, i * 0.09));
      noise(0.5, 0.05, 4000, 0, 800);
    },
    boom() {
      tone(120, 30, 'sine', 0.5, 0.35);
      noise(0.55, 0.30, 900, 0, 80);
    },
    bossAlert() {
      tone(180, 180, 'sawtooth', 0.30, 0.14);
      tone(240, 240, 'sawtooth', 0.30, 0.14, 0.35);
      tone(180, 360, 'sawtooth', 0.55, 0.16, 0.7);
    },
    click() {
      tone(700, 500, 'square', 0.05, 0.08);
    },
    denied() {
      tone(200, 140, 'square', 0.15, 0.10);
    },
  };
})();
