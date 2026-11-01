import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
const { coefficients, magnitudeDb, parseApoConfig, toApoConfig, suggestedPreamp } = await import('../public/js/eq.js');
const { applyPatch } = await import('../public/js/api.js');

test('peaking filter hits its gain at the centre frequency', () => {
  for (const gain of [-12, -3, 3, 6, 12]) {
    const c = coefficients({ type: 'PK', freq: 1000, gain, q: 1 });
    assert.ok(Math.abs(magnitudeDb(c, 1000) - gain) < 1e-6);
  }
});

test('shelves reach full gain far from the corner', () => {
  const lo = coefficients({ type: 'LSC', freq: 100, gain: 6, q: 0.707 });
  assert.ok(Math.abs(magnitudeDb(lo, 20) - 6) < 0.3);
  assert.ok(Math.abs(magnitudeDb(lo, 10000)) < 0.05);
  const hi = coefficients({ type: 'HSC', freq: 8000, gain: -4, q: 0.707 });
  assert.ok(Math.abs(magnitudeDb(hi, 20000) + 4) < 0.5);
});

test('low cut is -3 dB at corner with Q 0.707', () => {
  const c = coefficients({ type: 'HP', freq: 80, gain: 0, q: Math.SQRT1_2 });
  assert.ok(Math.abs(magnitudeDb(c, 80) + 3.01) < 0.05);
});

test('APO config round-trips', () => {
  const src = 'Preamp: -6.2 dB\nFilter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70\nFilter 2: ON PK Fc 2.5 kHz Gain -3 dB Q 1.41\nFilter 3: OFF HPQ Fc 30 Hz Q 0.5\n# comment\nFilter: ON PK Fc 1000 Hz Gain 2 dB BW Oct 1\nDevice: all';
  const eq = parseApoConfig(src);
  assert.equal(eq.preamp, -6.2);
  assert.equal(eq.bands.length, 4);
  assert.deepEqual(eq.bands.map((b) => b.type), ['LSC', 'PK', 'HP', 'PK']);
  assert.equal(eq.bands[1].freq, 2500);
  assert.equal(eq.bands[2].enabled, false);
  assert.ok(Math.abs(eq.bands[3].q - 1.414) < 0.01);
  const again = parseApoConfig(toApoConfig(eq));
  assert.deepEqual(again.bands.map((b) => [b.type, b.freq, b.gain, b.enabled]), eq.bands.map((b) => [b.type, b.freq, b.gain, b.enabled]));
});

test('suggested preamp prevents clipping', () => {
  const eq = { enabled: true, preamp: 0, bands: [{ enabled: true, type: 'PK', freq: 100, gain: 6, q: 1 }] };
  assert.ok(suggestedPreamp(eq) <= -6);
});

test('JSON patch applies daemon updates', () => {
  const doc = { mixers: { S1: { levels: { volumes: { Mic: 10 } }, list: [1, 2] } } };
  applyPatch(doc, [
    { op: 'replace', path: '/mixers/S1/levels/volumes/Mic', value: 200 },
    { op: 'add', path: '/mixers/S1/list/-', value: 3 },
    { op: 'remove', path: '/mixers/S1/list/0' },
    { op: 'add', path: '/mixers/S1~1x', value: true },
  ]);
  assert.equal(doc.mixers.S1.levels.volumes.Mic, 200);
  assert.deepEqual(doc.mixers.S1.list, [2, 3]);
  assert.equal(doc.mixers['S1/x'], true);
});
