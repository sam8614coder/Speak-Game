/* ==========================================================================
   SPEAK - sound effects
   Everything is synthesised with the Web Audio API, so there are no audio
   files to download and nothing plays until the player has tapped something
   (browsers block autoplay). Sound can be muted from the start screen or the
   in-game menu.
   ========================================================================== */
(function (root) {
  'use strict';

  let ctx = null;
  let master = null;
  let enabled = true;
  let volume = 0.7;

  function ensure() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
    const AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    } catch (e) { ctx = null; }
    return ctx;
  }

  function now() { return ctx.currentTime; }

  function tone(freq, start, dur, opts) {
    opts = opts || {};
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(freq, start);
    if (opts.slideTo) o.frequency.exponentialRampToValueAtTime(opts.slideTo, start + dur);
    const peak = opts.gain == null ? 0.25 : opts.gain;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + (opts.attack || 0.01));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g); g.connect(opts.dest || master);
    o.start(start); o.stop(start + dur + 0.05);
  }

  function noise(start, dur, opts) {
    opts = opts || {};
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = opts.filter || 'bandpass';
    f.frequency.setValueAtTime(opts.from || 1200, start);
    if (opts.to) f.frequency.exponentialRampToValueAtTime(opts.to, start + dur);
    f.Q.value = opts.q || 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(opts.gain || 0.2, start + (opts.attack || 0.02));
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(start); src.stop(start + dur + 0.05);
  }

  const SFX = {
    click() { const t = now(); tone(520, t, 0.06, { type: 'triangle', gain: 0.12 }); },
    tap() { const t = now(); tone(320, t, 0.05, { type: 'sine', gain: 0.1 }); },
    select() { const t = now(); tone(440, t, 0.06, { type: 'triangle', gain: 0.12 }); tone(660, t + 0.05, 0.08, { type: 'triangle', gain: 0.1 }); },
    order() { const t = now(); tone(280, t, 0.09, { type: 'square', gain: 0.07 }); tone(420, t + 0.06, 0.1, { type: 'square', gain: 0.07 }); },
    ring() {
      const t = now();
      for (let burst = 0; burst < 2; burst++) {
        const b = t + burst * 0.55;
        for (let i = 0; i < 8; i++) {
          const s = b + i * 0.05;
          tone(i % 2 ? 1180 : 1420, s, 0.05, { type: 'square', gain: 0.07 });
        }
      }
    },
    tick() { const t = now(); tone(900, t, 0.03, { type: 'square', gain: 0.06 }); },
    timeup() {
      const t = now();
      tone(220, t, 0.35, { type: 'sawtooth', gain: 0.16 });
      tone(180, t + 0.4, 0.5, { type: 'sawtooth', gain: 0.16 });
    },
    pass() { const t = now(); tone(330, t, 0.1, { type: 'triangle', gain: 0.14 }); tone(494, t + 0.1, 0.16, { type: 'triangle', gain: 0.14 }); },
    lock() {
      const t = now();
      tone(110, t, 0.16, { type: 'sine', gain: 0.35, slideTo: 60 });
      noise(t, 0.06, { from: 3000, gain: 0.12, filter: 'highpass' });
      tone(660, t + 0.12, 0.1, { type: 'triangle', gain: 0.1 });
    },
    reveal() {
      const t = now();
      noise(t, 0.45, { from: 400, to: 5000, q: 0.8, gain: 0.22, attack: 0.15, filter: 'bandpass' });
      tone(196, t + 0.3, 0.2, { type: 'triangle', gain: 0.12 });
    },
    move() { const t = now(); tone(180, t, 0.12, { type: 'sine', gain: 0.22, slideTo: 90 }); noise(t, 0.08, { from: 600, gain: 0.08, filter: 'lowpass' }); },
    bounce() { const t = now(); tone(260, t, 0.16, { type: 'sine', gain: 0.22, slideTo: 520 }); tone(520, t + 0.16, 0.18, { type: 'sine', gain: 0.18, slideTo: 200 }); },
    knock() {
      const t = now();
      tone(150, t, 0.14, { type: 'square', gain: 0.22, slideTo: 60 });
      noise(t, 0.12, { from: 1800, gain: 0.14, filter: 'highpass' });
      [880, 1175, 1568].forEach((f, i) => tone(f, t + 0.14 + i * 0.07, 0.12, { type: 'sine', gain: 0.1 }));
    },
    capture() {
      const t = now();
      [523, 659, 784].forEach((f, i) => tone(f, t + i * 0.09, 0.2, { type: 'triangle', gain: 0.17 }));
    },
    spawn() { const t = now(); tone(300, t, 0.1, { type: 'sine', gain: 0.2, slideTo: 700 }); },
    disband() { const t = now(); tone(500, t, 0.18, { type: 'sine', gain: 0.14, slideTo: 200 }); },
    round() {
      const t = now();
      [392, 523].forEach((f, i) => tone(f, t + i * 0.12, 0.22, { type: 'triangle', gain: 0.15 }));
    },
    win() {
      const t = now();
      [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => {
        tone(f, t + i * 0.13, 0.28, { type: 'triangle', gain: 0.2 });
        tone(f / 2, t + i * 0.13, 0.28, { type: 'sine', gain: 0.1 });
      });
    },
    error() { const t = now(); tone(200, t, 0.12, { type: 'square', gain: 0.1 }); tone(160, t + 0.1, 0.14, { type: 'square', gain: 0.1 }); },
  };

  const Sound = {
    /** Call from any user gesture so the audio context may start. */
    unlock() { ensure(); },
    play(name) {
      if (!enabled) return;
      if (!ensure()) return;
      const fn = SFX[name];
      if (!fn) return;
      try { fn(); } catch (e) { /* never let audio break the game */ }
    },
    setEnabled(on) { enabled = !!on; },
    isEnabled() { return enabled; },
    setVolume(v) {
      volume = Math.max(0, Math.min(1, v));
      if (master) master.gain.value = volume;
    },
    getVolume() { return volume; },
  };

  root.SpeakSound = Sound;
})(typeof self !== 'undefined' ? self : this);
