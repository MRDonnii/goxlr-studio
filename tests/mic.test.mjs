import { test } from 'node:test';
import assert from 'node:assert/strict';
const p = await import('../public/js/micpresets.js');
const await_eq = await import('../public/js/eq.js');

test('fitBands reproduces a curve the bands can make', () => {
  // A curve made of the bands themselves (2 dB at 250 Hz, -4 dB at 4 kHz) is found again.
  const { coefficients, magnitudeDb } = await_eq;
  const k1 = coefficients({ type: 'PK', freq: 250, gain: 2, q: 1.3 });
  const k2 = coefficients({ type: 'PK', freq: 4000, gain: -4, q: 1.3 });
  const gains = p.fitBands((f) => magnitudeDb(k1, f) + magnitudeDb(k2, f), p.FULL_CENTERS);
  assert.deepEqual(gains, [0, 0, 0, 2, 0, 0, 0, -4, 0, 0]);
});

test('every preset stays within the GoXLR limits on both models', () => {
  for (const m of p.MIC_MODELS) {
    for (const mini of [false, true]) {
      const s = p.micSettings(m, mini);
      assert.equal(s.eq.length, mini ? 6 : 10, m.name);
      for (const b of s.eq) assert.ok(Number.isInteger(b.gain) && b.gain >= -9 && b.gain <= 9, `${m.name} ${b.band} ${b.gain}`);
      assert.ok(s.gain >= 10 && s.gain <= 68, m.name);
      assert.ok(['Dynamic', 'Condenser'].includes(s.type));
    }
  }
});

test('a dark dynamic gets more presence than a flat condenser, and both lose the rumble', () => {
  const k688 = p.micSettings(p.MIC_MODELS.find((m) => m.id === 'fifine-k688'));
  const nt1 = p.micSettings(p.MIC_MODELS.find((m) => m.id === 'rode-nt1'));
  const g = (s, band) => s.eq.find((b) => b.band === band).gain;
  assert.ok(g(k688, 'Equalizer31Hz') <= -6 && g(nt1, 'Equalizer31Hz') <= -6);
  assert.ok(g(k688, 'Equalizer8KHz') > g(nt1, 'Equalizer8KHz'));
  assert.ok(g(k688, 'Equalizer125Hz') < g(nt1, 'Equalizer125Hz'), 'proximity bass is taken down');
  assert.equal(k688.type, 'Dynamic');
  assert.equal(nt1.type, 'Condenser');
  assert.ok(nt1.gain < k688.gain, 'the sensitive condenser needs less gain');
});

test('preset commands: mic type first, gain only when asked for, Mini uses its own bands', () => {
  const nt1 = p.MIC_MODELS.find((m) => m.id === 'rode-nt1');
  const full = p.micPresetCommands(nt1, false);
  assert.deepEqual(full[0], ['SetMicrophoneType', 'Condenser']);
  assert.ok(!full.some((c) => c[0] === 'SetMicrophoneGain'));
  assert.equal(full.filter((c) => c[0] === 'SetEqGain').length, 10);
  const mini = p.micPresetCommands(nt1, true, { gain: true, gate: false });
  assert.ok(mini.some((c) => c[0] === 'SetMicrophoneGain' && c[1] === 'Condenser'));
  assert.equal(mini.filter((c) => c[0] === 'SetEqMiniGain').length, 6);
  assert.ok(!mini.some((c) => c[0].startsWith('SetGate')));
  assert.match(p.describeMic(nt1), /^Kondensator \(\+48V\): løft omkring 5,5 kHz\.$/);
});
