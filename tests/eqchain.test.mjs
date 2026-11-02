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

test('Auto puts the loudest point of the whole chain at −0,5 dB, never above 0 dB preamp', () => {
  const eq = eqOf(0, [pk(1000, 3)]);
  assert.equal(c.safePreamp(eq, {}), -3.5);
  const peak = c.chainPeak({ ...eq, preamp: c.safePreamp(eq, {}) }, {});
  assert.ok(peak <= -0.5 && peak > -0.61, String(peak));
  // Nothing boosted: 0 dB preamp, no margin needed.
  assert.equal(c.safePreamp(eqOf(-2, [pk(500, -4)]), {}), 0);
  // Only cuts: the preamp goes back to 0, not above.
  assert.equal(c.safePreamp(eqOf(-6, [pk(1000, -3)]), {}), 0);
  // Loudness on top of a bass boost needs more.
  const bass = eqOf(0, [{ enabled: true, type: 'LSC', freq: 100, gain: 4, q: 0.7 }]);
  assert.ok(c.safePreamp(bass, { loudness: { enabled: true, amount: 4 } }) <= -4);
});

test('klip-beskyttelse lowers just enough, and only when needed', () => {
  assert.equal(c.clipGuard(eqOf(0, [pk(1000, -3)]), {}), 0);
  const g = c.clipGuard(eqOf(0, [pk(1000, 5)]), {});
  assert.ok(g <= -5.5 && g >= -5.6, String(g));
  // The offset makes the played chain stay at or below 0 dB.
  const eq = eqOf(-1, [pk(250, 4), pk(3000, 6, 2)]);
  const off = c.clipGuard(eq, {});
  assert.ok(Math.max(...c.chainResponse(eq, {}, undefined, off)) <= -0.499);
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
  assert.match(c.headroomInfo(eqOf(0, [pk(1000, 2)]), {}, true).text, /^Klip-beskyttelse −2,5 dB$/);
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

test('loudness: flat is 0 dB, a level change counts fully, the deep bass hardly counts', () => {
  const flat = c.CHAIN_FREQS.map(() => 0);
  assert.ok(Math.abs(c.loudnessDb(flat)) < 1e-9);
  assert.ok(Math.abs(c.loudnessDb(flat.map(() => -6)) + 6) < 1e-9);
  const sub = c.chainResponse(eqOf(0, [pk(30, 6, 2)]), {});
  const presence = c.chainResponse(eqOf(0, [pk(3000, 6, 2)]), {});
  assert.ok(c.loudnessDb(presence) > c.loudnessDb(sub) + 1, 'the ear hears 3 kHz louder than 30 Hz');
});

test('A/B match lowers the louder slot, never raises the quieter', () => {
  const st = { active: 'A', clipGuard: false, slots: { A: eqOf(-6, []), B: eqOf(0, []) }, extras: {} };
  const m = c.abMatch(st);
  assert.equal(m.diff, 6);
  assert.deepEqual(m.match, { A: 0, B: -6 });
  assert.equal(c.abText(m), 'B er 6,0 dB højere – udlignet');
  assert.equal(c.abText(m, false), 'B er 6,0 dB højere (den højeste lyder tit bedst)');
  assert.equal(c.playbackOffset(st), 0);
  assert.equal(c.playbackOffset({ ...st, active: 'B' }), -6);
  assert.equal(c.playbackOffset({ ...st, active: 'B', abMatch: false }), 0);
  // Same loudness: nothing to do.
  assert.equal(c.abText(c.abMatch({ ...st, slots: { A: eqOf(0, []), B: eqOf(0, []) } })), 'A og B spiller lige højt');
});

test('A/B match counts the clip guard, and needs the EQ on in both slots', () => {
  // B boosts 6 dB at 1 kHz: the guard takes it down 6 dB first, so B ends up quieter than flat A.
  const st = { active: 'B', slots: { A: eqOf(0, []), B: eqOf(0, [pk(1000, 6)]) }, extras: {} };
  const m = c.abMatch(st);
  assert.ok(m.diff < 0, String(m.diff));
  assert.ok(m.match.A < 0 && m.match.B === 0);
  assert.ok(c.playbackOffset(st) <= -6.4 && c.playbackOffset(st) >= -6.6, 'B plays with the guard only');
  const off = c.abMatch({ ...st, slots: { A: { ...eqOf(0, []), enabled: false }, B: eqOf(-6, []) } });
  assert.equal(off.unmatched, true);
  assert.deepEqual(off.match, { A: 0, B: 0 });
  assert.match(c.abText(off), /kan kun udlignes, når EQ er slået til i både A og B/);
});

test('blind test verdicts', () => {
  assert.match(c.blindVerdict(['B', 'B', 'B', 'B', 'B']).text, /B hver gang/);
  const four = c.blindVerdict(['A', 'B', 'B', 'B', 'B']);
  assert.equal(four.winner, 'B');
  assert.equal(four.clear, true);
  assert.match(four.text, /4 af 5 gange – B lyder bedst/);
  const three = c.blindVerdict(['A', 'A', 'B', 'A', 'B']);
  assert.equal(three.clear, false);
  assert.match(three.text, /ingen tydelig forskel/);
  assert.equal(c.blindVerdict(['A', 'B']).winner, null);
});

test('slotsEqual ignores ids and switched-off bands', () => {
  const a = eqOf(-3, [{ ...pk(1000, 2), id: 'x' }, { ...pk(500, 9), enabled: false }]);
  const b = eqOf(-3, [{ ...pk(1000, 2), id: 'y' }]);
  assert.equal(c.slotsEqual(a, b), true);
  assert.equal(c.slotsEqual(a, eqOf(-2, b.bands)), false);
});

test('Balance: a boost lowers the whole floor as much, lowering it again raises the floor', async () => {
  const { floorComp, floorBase, balancedPreamp } = await import('../public/js/eqchain.js');
  const pk = (gain, channel) => ({ enabled: true, type: 'PK', freq: 1000, gain, q: 1, ...(channel ? { channel } : {}) });
  const cutOnly = { enabled: true, preamp: 0, bands: [pk(-4)] };
  assert.equal(floorComp(cutOnly), 0);
  assert.equal(balancedPreamp(cutOnly, 0), 0, 'cuts never raise the floor above 0 dB');
  const boost = { enabled: true, preamp: 0, bands: [pk(3)] };
  assert.equal(balancedPreamp(boost, 0), -3.5);
  // Your own lower floor is kept on top of the balance; a floor above the balance is not possible.
  const own = { ...boost, preamp: -6 };
  assert.equal(floorBase(own), -2.5);
  assert.equal(balancedPreamp({ ...own, bands: [pk(5)] }, floorBase(own)), -8);
  assert.equal(floorBase({ ...boost, preamp: 0 }), 0);
  // One ear's boost and a GraphicEQ curve count too.
  assert.equal(balancedPreamp({ enabled: true, preamp: 0, bands: [pk(4, 'R')] }, 0), -4.5);
  assert.equal(balancedPreamp({ enabled: true, preamp: 0, bands: [], graphic: [[100, 2], [1000, 6]] }, 0), -6.5);
});
