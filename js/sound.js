/* =========================================================================
   SoundFX — звуки на Web Audio API, без внешних файлов.
   ========================================================================= */
const SoundFX = (function () {
  'use strict';

  let ctx = null;
  let master = null;
  let enabled = true;
  let noiseBuf = null;

  function ensure() {
    if (!enabled) return null;
    try {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
      }
      if (ctx.state === 'suspended') ctx.resume();
      return ctx;
    } catch (e) {
      return null;
    }
  }

  function getNoise() {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(ctx.sampleRate * 0.3);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  function tone(freq, dur, opts) {
    opts = opts || {};
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + (opts.delay || 0);
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, t0 + dur);
    const peak = opts.gain == null ? 0.12 : opts.gain;
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function noise(dur, opts) {
    opts = opts || {};
    const c = ensure();
    if (!c) return;
    const t0 = c.currentTime + (opts.delay || 0);
    const src = c.createBufferSource();
    src.buffer = getNoise();
    const filter = c.createBiquadFilter();
    filter.type = opts.filter || 'bandpass';
    filter.frequency.value = opts.freq || 1400;
    filter.Q.value = opts.q || 0.9;
    const gain = c.createGain();
    gain.gain.setValueAtTime(opts.gain == null ? 0.22 : opts.gain, t0);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(gain).connect(master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  const sounds = {
    move() {
      noise(0.075, { freq: 1500, gain: 0.26, q: 1.2 });
      tone(150, 0.07, { gain: 0.1, type: 'triangle', to: 90 });
    },
    capture() {
      noise(0.11, { freq: 950, gain: 0.4, q: 0.7 });
      tone(110, 0.11, { gain: 0.16, type: 'triangle', to: 60 });
    },
    castle() {
      noise(0.06, { freq: 1600, gain: 0.22, q: 1.2 });
      noise(0.07, { freq: 1300, gain: 0.24, q: 1.2, delay: 0.09 });
      tone(140, 0.06, { gain: 0.08, type: 'triangle', delay: 0.09 });
    },
    promote() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone(f, 0.16, { gain: 0.07, type: 'sine', delay: i * 0.06 })
      );
    },
    check() {
      tone(880, 0.12, { gain: 0.1, type: 'triangle' });
      tone(1320, 0.16, { gain: 0.07, type: 'sine', delay: 0.08 });
    },
    end() {
      tone(440, 0.22, { gain: 0.09, type: 'triangle' });
      tone(330, 0.26, { gain: 0.08, type: 'triangle', delay: 0.16 });
      tone(220, 0.4, { gain: 0.09, type: 'sine', delay: 0.32 });
    },
    win() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
        tone(f, 0.28, { gain: 0.09, type: 'triangle', delay: i * 0.1 })
      );
    },
    lose() {
      [392, 330, 262, 196].forEach((f, i) =>
        tone(f, 0.3, { gain: 0.09, type: 'triangle', delay: i * 0.12 })
      );
    },
    illegal() {
      tone(120, 0.1, { gain: 0.07, type: 'square' });
      tone(95, 0.12, { gain: 0.05, type: 'square', delay: 0.06 });
    },
    notify() {
      tone(740, 0.12, { gain: 0.06, type: 'sine' });
      tone(988, 0.16, { gain: 0.05, type: 'sine', delay: 0.09 });
    },
    tick() {
      tone(1200, 0.035, { gain: 0.035, type: 'square' });
    },
  };

  function play(name) {
    if (!enabled) return;
    const fn = sounds[name];
    if (!fn) return;
    if (!ensure()) return;
    try { fn(); } catch (e) { /* нет аудио — не страшно */ }
  }

  function setEnabled(v) {
    enabled = !!v;
    if (enabled) ensure();
  }

  return {
    play,
    setEnabled,
    isEnabled: () => enabled,
    unlock: ensure,
  };
})();
