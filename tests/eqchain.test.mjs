import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
const c = await import('../public/js/eqchain.js');
const { totalResponse } = await import('../public/js/eq.js');

const pk = (freq, gain, q = 1) => ({ enabled: true, type: 'PK', freq, gain, q });
const eqOf = (preamp, bands) => ({ enabled: true, preamp, bands });

test('crossfeed never lifts a centred sound above 0 dB', () => {
  for (const f of [20, 100, 700, 2000, 10000]) {
    const db = c.crossfeedDb({ level: -8, cutoff: 700 }, f);
    assert.ok(db <= 1e-6, `${f} Hz: ${db}`);
  }
  // Up high the copy is gone, so only the compensation is left.
  assert.ok(Math.abs(c.crossfeedDb({ level: -8, cutoff: 700 }, 15000) + 20 * Math.log10(1 + 10 ** (-8 / 20))) < 0.05);
});

test('the chain includes Loudness: its shelves count, its preamp too', () => {
  const eq = eqOf(0, [{ enabled: true, type: 'LSC', freq: 100, gain: 4, q: 0.7 }]);
  // EQ alone: +4 dB in the bass. With Loudness 4 dB: −4 preamp, +4 shelf of its own → still +4.
  assert.ok(Math.abs(c.chainPeak(eq, {}) - 4) < 0.15);
  assert.ok(Math.abs(c.chainPeak(eq, { loudness: { enabled: true, amount: 4 } }) - 4) < 0.15);
  // A switched-off EQ plays flat.
  assert.equal(c.chainPeak({ ...eq, enabled: false }, {}), 0);
});

test('Auto puts the loudest point of the whole chain at 0 dB, never above 0 dB preamp', () => {
  const eq = eqOf(0, [pk(1000, 3)]);
  assert.equal(c.safePreamp(eq, {}), -3);
  const peak = c.chainPeak({ ...eq, preamp: c.safePreamp(eq, {}) }, {});
  assert.ok(peak <= 0 && peak > -0.11, String(peak));
  // Only cuts: the preamp goes back to 0, not above.
  assert.equal(c.safePreamp(eqOf(-6, [pk(1000, -3)]), {}), 0);
  // Loudness on top of a bass boost needs more.
  const bass = eqOf(0, [{ enabled: true, type: 'LSC', freq: 100, gain: 4, q: 0.7 }]);
  assert.ok(c.safePreamp(bass, { loudness: { enabled: true, amount: 4 } }) <= -4);
});

test('klip-beskyttelse lowers just enough, and only when needed', () => {
  assert.equal(c.clipGuard(eqOf(0, [pk(1000, -3)]), {}), 0);
  const g = c.clipGuard(eqOf(0, [pk(1000, 5)]), {});
  assert.ok(g <= -5 && g >= -5.1, String(g));
  // The offset makes the played chain stay at or below 0 dB.
  const eq = eqOf(-1, [pk(250, 4), pk(3000, 6, 2)]);
  const off = c.clipGuard(eq, {});
  assert.ok(Math.max(...c.chainResponse(eq, {}, undefined, off)) <= 0.001);
  assert.equal(c.clipGuard({ ...eq, enabled: false }, {}), 0);
});

test('playbackOffset follows the klip-beskyttelse setting', () => {
  const st = { active: 'A', slots: { A: eqOf(0, [pk(1000, 5)]) }, extras: {} };
  assert.ok(c.playbackOffset(st) < -4.9);
  assert.equal(c.playbackOffset({ ...st, clipGuard: false }), 0);
});

test('headroom badge texts', () => {
  assert.equal(c.headroomInfo(eqOf(-3, []), {}).text, 'Headroom 3,0 dB');
  assert.equal(c.headroomInfo(eqOf(0, [pk(1000, 2)]), {}, false).kind, 'clip');
  assert.match(c.headroomInfo(eqOf(0, [pk(1000, 2)]), {}, false).text, /^Kan klippe \+2,0 dB$/);
  assert.match(c.headroomInfo(eqOf(0, [pk(1000, 2)]), {}, true).text, /^Klip-beskyttelse −2,0 dB$/);
  assert.equal(c.headroomInfo({ ...eqOf(0, []), enabled: false }, {}).kind, 'off');
});

test('band warnings: big boosts and narrow boosts', () => {
  assert.deepEqual(c.bandWarnings(pk(1000, 6)), []);
  assert.equal(c.bandWarnings(pk(1000, 7)).length, 1);
  assert.equal(c.bandWarnings({ ...pk(100, 8), type: 'LSC' }).length, 1);
  assert.equal(c.bandWarnings(pk(3000, 4, 8)).length, 1);
  // A narrow cut is fine (that is what narrow bands are for); a switched-off band says nothing.
  assert.deepEqual(c.bandWarnings(pk(3000, -8, 10)), []);
  assert.deepEqual(c.bandWarnings({ ...pk(1000, 12), enabled: false }), []);
});

test('chain response equals the plain EQ without extras or offset', () => {
  const eq = eqOf(-2, [pk(500, 3), pk(4000, -2, 2)]);
  const a = c.chainResponse(eq, {});
  const b = totalResponse(eq, c.CHAIN_FREQS);
  assert.ok(a.every((v, i) => Math.abs(v - b[i]) < 1e-9));
});
