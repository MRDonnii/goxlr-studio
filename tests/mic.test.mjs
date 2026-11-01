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

test('K688 and NT1: rumble cut, proximity bass taken down, treble rise tamed, gain from sensitivity', () => {
  const k688m = p.MIC_MODELS.find((m) => m.id === 'fifine-k688');
  const k688 = p.micSettings(k688m);
  const nt1 = p.micSettings(p.MIC_MODELS.find((m) => m.id === 'rode-nt1'));
  const g = (s, band) => s.eq.find((b) => b.band === band).gain;
  assert.ok(g(k688, 'Equalizer31Hz') <= -6 && g(nt1, 'Equalizer31Hz') <= -6);
  assert.ok(g(k688, 'Equalizer125Hz') < g(nt1, 'Equalizer125Hz'), 'proximity bass is taken down');
  // The K688 rises from 3 kHz (review measurement), the NT1 has a peak at 10 kHz: both are tamed at 8 kHz.
  assert.ok(g(k688, 'Equalizer8KHz') < 0 && g(nt1, 'Equalizer8KHz') < 0);
  for (const s of [k688, nt1]) for (const b of s.eq) if (b.freq > 8000) assert.ok(b.gain <= 2, `${b.band} ${b.gain}`);
  assert.equal(k688.type, 'Dynamic');
  assert.equal(nt1.type, 'Condenser');
  assert.ok(nt1.gain < k688.gain, 'the sensitive condenser needs less gain');
  assert.match(p.describeMic(k688m), /^Dynamisk: mindre bas under 100 Hz, nærhedseffekt – mere bas tæt på, lys top over 3 kHz, aftagende top over 15 kHz\.$/);
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
  assert.match(p.describeMic(nt1), /^Kondensator \(\+48V\): løft omkring 5 kHz, løft omkring 10 kHz\.$/);
});

test('the SM7dB gets +48 V for its preamp, USB-only mics are not on the list', () => {
  const sm7db = p.MIC_MODELS.find((m) => m.id === 'shure-sm7db');
  assert.equal(p.micSettings(sm7db).type, 'Condenser');
  assert.match(p.describeMic(sm7db), /forforstærker \(\+48V\)/);
  assert.equal(p.micSettings(p.MIC_MODELS.find((m) => m.id === 'shure-sm7b')).type, 'Dynamic');
  assert.ok(p.USB_ONLY.includes('Fifine K669'));
  assert.ok(!p.MIC_MODELS.some((m) => p.USB_ONLY.includes(m.name)));
  assert.ok(p.MIC_MODELS.length >= 50);
  assert.equal(new Set(p.MIC_MODELS.map((m) => m.id)).size, p.MIC_MODELS.length, 'ids are unique');
});
