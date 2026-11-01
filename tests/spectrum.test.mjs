import { test } from 'node:test';
import assert from 'node:assert/strict';
const s = await import('../public/js/spectrum.js');

test('120 bands from 20 Hz to 20 kHz', () => {
  assert.equal(s.SPECTRUM_FREQS.length, 120);
  assert.ok(Math.abs(s.SPECTRUM_FREQS[0] - 20) < 1e-9);
  assert.ok(Math.abs(s.SPECTRUM_FREQS[119] - 20000) < 1e-6);
});

test('analyser bins: one strong bin lands in its band, white noise rises 3 dB per octave', () => {
  const rate = 48000, size = 8192, n = size / 2;
  const df = rate / size;
  const bins = new Float32Array(n).fill(-200);
  const k = Math.round(1000 / df);
  bins[k] = -20;
  const bands = s.bandsFromBins(bins, rate, size);
  const loudest = bands.indexOf(Math.max(...bands));
  assert.ok(Math.abs(s.SPECTRUM_FREQS[loudest] / (k * df) - 1) < 0.07, String(s.SPECTRUM_FREQS[loudest]));
  const white = s.bandsFromBins(new Float32Array(n).fill(-60), rate, size);
  const avg = (a, b) => white.slice(a, b).reduce((x, y) => x + y, 0) / (b - a);
  assert.ok(Math.abs(avg(96, 108) - avg(72, 84) - 6) < 0.5);
});

test('smoothing: up at once, down slowly', () => {
  const prev = [-20, -20];
  const out = s.smoothSpectrum(prev, [-10, -80], 100, 24);
  assert.equal(out[0], -10);
  assert.ok(Math.abs(out[1] - -22.4) < 1e-9);
  assert.deepEqual(s.smoothSpectrum(null, [-5], 50), [-5]);
});

test('automatic output: the one playing, and stay while it plays', () => {
  const ids = ['music', 'system', 'chat'];
  assert.equal(s.pickSpectrumDevice({ music: 0.5, system: 0.2 }, ids, null), 'music');
  // Stays on system while it plays, even if music is louder.
  assert.equal(s.pickSpectrumDevice({ music: 0.5, system: 0.2 }, ids, 'system'), 'system');
  // System stopped: move to what plays.
  assert.equal(s.pickSpectrumDevice({ music: 0.5, system: 0 }, ids, 'system'), 'music');
  // Nothing plays: keep the current one; none yet → Windows' default output.
  assert.equal(s.pickSpectrumDevice({}, ids, 'chat'), 'chat');
  assert.equal(s.pickSpectrumDevice(null, ids, null), null);
});

test('demo spectrum looks like music: more bass than treble', () => {
  const d = s.demoSpectrum(1.2);
  assert.equal(d.length, 120);
  assert.ok(d[30] > d[110]);
  assert.ok(d.every((v) => v <= 0 && v >= -110));
});
