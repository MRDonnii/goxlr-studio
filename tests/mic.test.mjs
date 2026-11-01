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

test('gate and compressor times go to the engine as list positions (serde_repr u8), not names', async () => {
  const e = await import('../public/js/micenums.js');
  // Same lengths as goxlr-types' enums.
  assert.deepEqual([e.GATE_TIMES.length, e.RATIOS.length, e.ATTACKS.length, e.RELEASES.length], [46, 15, 20, 20]);
  const cmds = Object.fromEntries(p.micPresetCommands(p.MIC_MODELS[0], false).map(([n, ...a]) => [n, a]));
  assert.deepEqual(cmds.SetGateAttack, [0]); // Gate10ms
  assert.deepEqual(cmds.SetGateRelease, [20]); // Gate250ms
  assert.deepEqual(cmds.SetCompressorRatio, [8]); // Ratio3_2
  assert.deepEqual(cmds.SetCompressorAttack, [4]); // Comp5ms
  assert.deepEqual(cmds.SetCompressorReleaseTime, [9]); // Comp100ms
  for (const [n, a] of Object.entries(cmds)) if (/^Set(Gate|Compressor)/.test(n)) assert.equal(typeof a[0] === 'string', false, n);
  assert.equal(e.enumIndex(e.GATE_TIMES, 20), 20);
  assert.equal(e.enumIndex(e.GATE_TIMES, 'Gate250ms'), 20);
  assert.equal(e.enumIndex(e.RATIOS, 99), 14);
  assert.equal(e.enumIndex(e.RATIOS, 'nope'), 0);
});

const a = await import('../public/js/micassist.js');

test('mic assistant: gain to speech ≈ −15 dB with peaks below −6, gate above the room', () => {
  // Quiet room (−62 dB), speech around −30 dB with peaks at −22 dB, gain 40 dB.
  const silence = Array.from({ length: 30 }, (_, i) => -63 + (i % 3));
  const speech = Array.from({ length: 60 }, (_, i) => -40 + (i % 11));
  const r = a.analyzeMicTest({ silence, speech, gain: 40 });
  assert.equal(r.noise, -61);
  assert.equal(r.talk, -31);
  assert.equal(r.delta, 16);
  assert.equal(r.newGain, 56);
  assert.ok(r.peak + r.delta <= a.PEAK_LIMIT);
  assert.equal(r.gate, -37); // noise −45 after +16 dB, +8 → −37; speech −15 − 12 = −27
  assert.deepEqual(r.warnings, []);
  // Peaks decide when they would clip: speech at −20 but a peak at −4 → gain down.
  const loud = a.analyzeMicTest({ silence, speech: [-22, -21, -20, -20, -4], gain: 30 });
  assert.ok(loud.delta < 0 && loud.peak + loud.delta <= a.PEAK_LIMIT);
  // A weak mic at full gain is told so; no difference between silence and speech is an error.
  assert.match(a.analyzeMicTest({ silence, speech: speech.map((x) => x - 20), gain: 70 }).warnings[0], /svag/);
  assert.ok(a.analyzeMicTest({ silence, speech: silence, gain: 40 }).error);
  assert.ok(a.analyzeMicTest({ silence: [], speech: [], gain: 40 }).error);
});

test('snapshot of the mic settings puts everything back, also from names in older demo data', async () => {
  const mixer = {
    mic_status: {
      mic_type: 'Condenser', mic_gains: { Dynamic: 50, Condenser: 31, Jack: 20 },
      equaliser: { gain: { Equalizer31Hz: -3 }, frequency: { Equalizer31Hz: 31.5 } },
      equaliser_mini: { gain: { Equalizer90Hz: 2 }, frequency: { Equalizer90Hz: 90 } },
      noise_gate: { threshold: -40, attack: 0, release: 'Gate250ms', enabled: true, attenuation: 80 },
      compressor: { threshold: -20, ratio: 8, attack: 4, release: 9, makeup_gain: 3 },
    },
    levels: { deess: 35 },
  };
  const s = a.micSnapshot(mixer);
  mixer.mic_status.mic_gains.Condenser = 60; // a later change does not touch the snapshot
  const full = a.snapshotCommands(s, false);
  assert.deepEqual(full[0], ['SetMicrophoneType', 'Condenser']);
  assert.deepEqual(full[1], ['SetMicrophoneGain', 'Condenser', 31]);
  assert.ok(full.some((c) => c[0] === 'SetEqGain' && c[1] === 'Equalizer31Hz' && c[2] === -3));
  assert.ok(full.some((c) => c[0] === 'SetGateRelease' && c[1] === 20));
  assert.ok(full.some((c) => c[0] === 'SetCompressorRatio' && c[1] === 8));
  assert.ok(full.some((c) => c[0] === 'SetDeeser' && c[1] === 35));
  const mini = a.snapshotCommands(s, true);
  assert.ok(mini.some((c) => c[0] === 'SetEqMiniGain' && c[2] === 2));
  assert.ok(!mini.some((c) => c[0] === 'SetEqGain'));
});
