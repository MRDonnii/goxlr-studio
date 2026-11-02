import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
const { parseApoConfigReport, coefficients, magnitudeDb, bandResponse, expandBands, toApoConfig, logFreqs, apoShelf } = await import('../public/js/eq.js');

// Equalizer APO 1.4.2's BiQuad (filters/BiQuad.cpp + BiQuadFilter.cpp), ported for reference.
function apoBiquadDb({ type, gain, freq, val, isS, corner }, f, fs = 48000) {
  const shelf = type === 'LS' || type === 'HS';
  let bq = freq;
  if (corner && shelf) {
    let s = val;
    if (!isS) { const a = 10 ** (gain / 40); s = 1 / ((1 / (val * val) - 2) / (a + 1 / a) + 1); }
    const k = 10 ** (Math.abs(gain) / 80 / s);
    bq = type === 'LS' ? bq * k : bq / k;
  }
  const A = 10 ** (gain / 40);
  const w = 2 * Math.PI * bq / fs, sn = Math.sin(w), cs = Math.cos(w);
  const alpha = !isS ? sn / (2 * val) : sn / 2 * Math.sqrt((A + 1 / A) * (1 / val - 1) + 2);
  const beta = 2 * Math.sqrt(A) * alpha;
  let b0, b1, b2, a0, a1, a2;
  if (type === 'LS') { b0 = A * ((A + 1) - (A - 1) * cs + beta); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - beta); a0 = (A + 1) + (A - 1) * cs + beta; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - beta; }
  else { b0 = A * ((A + 1) + (A - 1) * cs + beta); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - beta); a0 = (A + 1) - (A - 1) * cs + beta; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - beta; }
  return magnitudeDb({ b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }, f, fs);
}

const FREQS = logFreqs(60);
const maxDiff = (band, ref) => Math.max(...FREQS.map((f, i) => Math.abs(bandResponse(band, [f])[0] - ref(f))));

test('APO shelves (LS/HS with corner frequency, slope in dB, Q) import as the same curve', () => {
  const cases = [
    ['Filter: ON LS Fc 100 Hz Gain 6 dB', { type: 'LS', gain: 6, freq: 100, val: 0.9, isS: true, corner: false }],
    ['Filter: ON HS Fc 8000 Hz Gain -4 dB', { type: 'HS', gain: -4, freq: 8000, val: 0.9, isS: true, corner: false }],
    ['Filter: ON LS 6dB Fc 120 Hz Gain 5 dB', { type: 'LS', gain: 5, freq: 120, val: 0.5, isS: true, corner: true }],
    ['Filter: ON HS 12dB Fc 6000 Hz Gain 3 dB', { type: 'HS', gain: 3, freq: 6000, val: 1, isS: true, corner: true }],
    ['Filter: ON LS Fc 90 Hz Gain -5 dB Q 0.71', { type: 'LS', gain: -5, freq: 90, val: 0.71, isS: false, corner: true }],
    ['Filter: ON LSC 6dB Fc 150 Hz Gain 4 dB', { type: 'LS', gain: 4, freq: 150, val: 0.5, isS: true, corner: false }],
  ];
  for (const [line, ref] of cases) {
    const { eq, ignored } = parseApoConfigReport(line);
    assert.equal(ignored.length, 0, line);
    assert.equal(eq.bands.length, 1, line);
    const d = maxDiff(eq.bands[0], (f) => apoBiquadDb(ref, f));
    assert.ok(d < 0.01, `${line}: off by ${d.toFixed(3)} dB`);
  }
});

test('numbers as Peace and Room EQ Wizard write them: comma decimals and "1.000 Hz"', () => {
  const { eq } = parseApoConfigReport('Preamp: -3,5 dB\nFilter 1: ON PK Fc 1.000 Hz Gain -2,5 dB Q 1,41\nFilter 2: ON PK Fc 12.500 Hz Gain 1 dB Q 2\nFilter 3: ON PK Fc 250.5 Hz Gain 1 dB Q 1');
  assert.equal(eq.preamp, -3.5);
  assert.deepEqual(eq.bands.map((b) => [b.freq, b.gain, b.q]), [[1000, -2.5, 1.41], [12500, 1, 2], [250.5, 1, 1]]);
});

test('defaults as in the engine: notch Q 30, cuts Q 0.707, peaks need Q', () => {
  const { eq, ignored } = parseApoConfigReport('Filter: ON NO Fc 60 Hz\nFilter: ON HP Fc 30 Hz\nFilter: ON PK Fc 100 Hz Gain 3 dB\nFilter: ON None\nFilter: ON BP Fc 1000 Hz Q 2\nFilter: ON AP Fc 500 Hz Q 0.7');
  assert.deepEqual(eq.bands.map((b) => [b.type, b.q]), [['NO', 30], ['HP', 0.7071], ['BP', 2], ['AP', 0.7]]);
  assert.equal(ignored.length, 1);
  assert.match(ignored[0].reason, /Q/);
});

test('band-pass peaks at 0 dB and all-pass leaves the level alone', () => {
  assert.ok(Math.abs(magnitudeDb(coefficients({ type: 'BP', freq: 1000, gain: 0, q: 2 }), 1000)) < 1e-6);
  const ap = coefficients({ type: 'AP', freq: 500, gain: 0, q: 0.7 });
  for (const f of [20, 500, 5000, 20000]) assert.ok(Math.abs(magnitudeDb(ap, f)) < 1e-6);
});

test('steep cuts are Butterworth: −3 dB at the corner, the slope per octave below', () => {
  for (const slope of [24, 36, 48]) {
    const b = { type: 'HP', freq: 100, gain: 0, q: 0.707, slope, enabled: true };
    assert.equal(expandBands([b]).length, slope / 12);
    const at = bandResponse(b, [100, 25])[0];
    assert.ok(Math.abs(at + 3.01) < 0.05, `${slope}: ${at}`);
    const twoOct = bandResponse(b, [25])[0];
    assert.ok(Math.abs(twoOct + 2 * slope) < 1.5, `${slope} dB/okt: ${twoOct} dB two octaves down`);
  }
  assert.equal((toApoConfig({ preamp: 0, bands: [{ type: 'LP', freq: 15000, gain: 0, q: 0.7, slope: 24, enabled: true }] }).match(/LPQ/g) || []).length, 2);
});

test('lines that are not imported are reported, and only the first device section is used', () => {
  const { eq, ignored } = parseApoConfigReport([
    'Device: Speakers', 'Preamp: -2 dB', 'Filter: ON PK Fc 100 Hz Gain 2 dB Q 1',
    'Copy: L=R', 'Delay: 10 ms', 'Convolution: room.wav', 'Filter: ON IIR Order 2 Coefficients 1 0 0 1 0 0',
    'Device: Headphones', 'Filter: ON PK Fc 3000 Hz Gain 5 dB Q 1',
  ].join('\n'));
  assert.equal(eq.bands.length, 1);
  assert.deepEqual(ignored.map((x) => x.reason), ['Copy: blander kanalerne', 'Delay: forsinkelse', 'Convolution: impulssvar (convolution)', 'filtertypen IIR kendes ikke', 'filen har EQ til flere enheder – kun den første blev importeret']);
});

test('a shelf too steep for its gain is reported, not imported as nonsense', () => {
  assert.equal(apoShelf({ type: 'LS', freq: 100, gain: 20, slope: 48 }), null);
});
