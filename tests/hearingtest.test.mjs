import { test } from 'node:test';
import assert from 'node:assert/strict';
const { TEST_FREQS, normalThreshold, hearingProfile, compensationBands, hearingSummary } = await import('../public/js/hearingtest.js');

// A listener whose thresholds follow the normal ear exactly (offset −60 dBFS).
const normal = (shift = {}) => Object.fromEntries(['L', 'R'].map((ear) => [ear, TEST_FREQS.map((f) => -60 + normalThreshold(f) + (shift[ear]?.[f] || 0))]));

test('the normal threshold follows ISO 226 (best around 3–4 kHz)', () => {
  assert.equal(normalThreshold(1000), 2.4);
  assert.ok(normalThreshold(3500) < normalThreshold(1000));
  assert.ok(normalThreshold(250) > 10);
});

test('a normal ear needs no EQ', () => {
  assert.deepEqual(compensationBands(normal()), []);
  assert.match(hearingSummary(normal())[0], /ens og jævnt/);
});

test('a weaker left ear at 4 kHz gets about half the difference as a left-only band', () => {
  const t = normal({ L: { 4000: 10 } });
  const bands = compensationBands(t);
  assert.equal(bands.length, 1);
  assert.deepEqual([bands[0].channel, bands[0].freq, bands[0].gain], ['L', 4000, 5]);
  assert.ok(hearingSummary(t).some((l) => /Venstre øre hører 4 kHz 10 dB dårligere/.test(l)));
});

test('lifts and cuts are limited, and a tone you cannot hear counts as the loudest level', () => {
  const t = normal({ R: { 8000: 40 }, L: { 500: -12 } });
  t.L[TEST_FREQS.indexOf(12000)] = null;
  const bands = compensationBands(t);
  const r8 = bands.find((b) => b.channel === 'R' && b.freq === 8000);
  assert.equal(r8.gain, 8);
  assert.equal(bands.find((b) => b.channel === 'L' && b.freq === 500).gain, -3);
  assert.ok(bands.some((b) => b.channel === 'L' && b.freq === 12000 && b.gain > 0));
  assert.equal(hearingSummary(t)[0], 'Kunne ikke høres på venstre øre: 12 kHz.');
  assert.ok(Number.isFinite(hearingProfile(t).ref));
});
