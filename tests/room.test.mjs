import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJavaStream, readRewMdat, readRewText, readCalFile, readMeasurementFile } from '../public/js/rew.js';
import { GRID, toGrid, powerAverage, smooth, designCorrection, lowLimit, applyCalibration, targetDb, correctionNotes } from '../public/js/roomcorrect.js';
import { bandResponse } from '../public/js/eq.js';
import { channelLines, speakerDelay, firLines, enginePayload } from '../public/js/extras.js';

// ---------- a tiny Java serialisation writer (only what REW's files use) ----------
function javaStream(build) {
  const out = [];
  let handle = 0x7e0000;
  const strings = new Map();
  const u8 = (v) => out.push(v & 255);
  const u16 = (v) => { u8(v >> 8); u8(v); };
  const i32 = (v) => { u16(v >>> 16); u16(v & 0xffff); };
  const i64 = () => { i32(0); i32(1); };
  const utf = (s) => { const b = new TextEncoder().encode(s); u16(b.length); b.forEach(u8); };
  const f32 = (v) => { const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, v); for (let i = 0; i < 4; i++) u8(dv.getUint8(i)); };
  const f64 = (v) => { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v); for (let i = 0; i < 8; i++) u8(dv.getUint8(i)); };
  const string = (s) => {
    if (strings.has(s)) { u8(0x71); i32(strings.get(s)); return; }
    u8(0x74); strings.set(s, handle++); utf(s);
  };
  const classDesc = (name, flags, fields) => {
    u8(0x72); utf(name); i64(); handle++; u8(flags); u16(fields.length);
    for (const [type, fname, cls] of fields) { u8(type.charCodeAt(0)); utf(fname); if (cls) string(cls); }
    u8(0x78); u8(0x70); // no annotation, no super class
  };
  const w = {
    string,
    block: (bytes) => { u8(0x77); u8(bytes.length); bytes.forEach(u8); },
    // An object whose class has a writeObject (flag 0x03) with a block of data after its fields.
    icon: () => { u8(0x73); classDesc('javax.swing.ImageIcon', 0x03, [['I', 'width']]); handle++; i32(16); u8(0x77); u8(2); u8(1); u8(2); u8(0x78); },
    meas: ({ name, start, step, spl }) => {
      u8(0x73);
      classDesc('roomeqwizard.MeasData', 0x02, [['D', 'freqStep'], ['D', 'startFreq'], ['Z', 'isLogSpaced'], ['I', 'sampleRate'], ['[', 'splValues', '[F'], ['L', 'shortDesc', 'Ljava/lang/String;'], ['L', 'meterCal', 'Lroomeqwizard.CalData;']]);
      handle++;
      f64(step); f64(start); u8(0); i32(48000);
      u8(0x75); u8(0x72); utf('[F'); i64(); handle++; u8(0x02); u16(0); u8(0x78); u8(0x70); handle++; i32(spl.length); spl.forEach(f32);
      string(name);
      u8(0x70); // meterCal = null → measured without a calibration file
    },
  };
  u16(0xaced); u16(5);
  build(w);
  return new Uint8Array(out);
}

const flatMeas = (fn) => {
  const step = 1;
  const spl = Array.from({ length: 20000 }, (_, i) => 80 + fn(1 + i * step));
  return { name: 'Stue', start: 1, step, spl };
};

test('reads a REW .mdat (Java serialisation): strings, references, writeObject data, arrays', () => {
  const bytes = javaStream((w) => {
    w.string('REW Measurement Data File V2');
    w.block([0, 0, 0, 5]);
    w.icon();
    w.string('<HTML><style type="text/css">body { margin-left: 3; }</style><BODY>01-01-2026<BR>12:00:00<BR>0 to 20.000 Hz</HTML>');
    w.icon();
    w.string('<HTML><BODY>01-01-2026<BR>12:00:30</HTML>');
    w.meas(flatMeas(() => 0));
    w.meas(flatMeas((f) => (f < 100 ? -6 : 0)));
  });
  const items = readJavaStream(bytes);
  assert.equal(items[0], 'REW Measurement Data File V2');
  const ms = readRewMdat(bytes);
  assert.equal(ms.length, 2);
  // The same name twice (a reference to one string) – told apart by the time.
  assert.deepEqual(ms.map((m) => m.name), ['Stue · 12:00:00', 'Stue · 12:00:30']);
  assert.equal(ms[0].calibrated, false);
  assert.equal(ms[0].freqs[999], 1000);
  assert.equal(ms[1].spl[10], 74);
  assert.equal(readMeasurementFile(bytes).length, 2);
  assert.throws(() => readRewMdat(new Uint8Array([1, 2, 3, 4])));
});

test('reads REW text exports and calibration files', () => {
  const text = '* Measurement data measured by REW V5.40\n* Freq(Hz) SPL(dB) Phase(degrees)\n' + Array.from({ length: 30 }, (_, i) => `${(20 * 1.2 ** i).toFixed(3).replace('.', ',')} ${70 + (i % 3)},5 -120,0`).join('\n');
  const [m] = readRewText(text, 'Stue');
  assert.equal(m.name, 'Stue');
  assert.equal(m.freqs.length, 30);
  assert.equal(m.spl[1], 71.5);
  const cal = readCalFile('"Sens Factor =-1.378dB, SERNO: 0000000"\n' + Array.from({ length: 20 }, (_, i) => `${10 * 2 ** (i / 2)}\t${i > 15 ? 3 : 0}`).join('\n'));
  assert.equal(cal.freqs.length, 20);
  assert.throws(() => readCalFile('hello'));
  const curve = GRID.map(() => 80);
  const fixed = applyCalibration(curve, cal);
  assert.equal(fixed[0], 80);
  assert.equal(fixed[fixed.length - 1], 77);
});

test('grid, average and smoothing', () => {
  const m = { freqs: Array.from({ length: 20000 }, (_, i) => 1 + i), spl: Array.from({ length: 20000 }, () => 70) };
  const g = toGrid(m);
  assert.equal(g.length, GRID.length);
  assert.ok(g.every((v) => Math.abs(v - 70) < 1e-9));
  // Power average: 70 and 80 dB → 77.4 dB (not 75).
  const avg = powerAverage([GRID.map(() => 70), GRID.map(() => 80)]);
  assert.ok(Math.abs(avg[0] - 77.4) < 0.05);
  const s = smooth(GRID.map((_, i) => (i === 200 ? 90 : 70)), 3);
  assert.ok(s[200] < 80 && s[200] > 70);
});

// A speaker with a room: rolls off below 40 Hz, a 10 dB room mode at 80 Hz, a narrow 20 dB null at 200 Hz.
function roomCurve() {
  const mode = bandResponse({ type: 'PK', freq: 80, gain: 10, q: 5 }, GRID);
  const nul = bandResponse({ type: 'PK', freq: 200, gain: -20, q: 12 }, GRID);
  const hp = bandResponse({ type: 'HP', freq: 38, q: 0.7, slope: 24 }, GRID);
  return GRID.map((f, i) => 85 + targetDb(f) + mode[i] + nul[i] + hp[i]);
}

test('room correction cuts the mode, leaves the null and the roll-off alone', () => {
  const r = designCorrection(roomCurve(), { target: 'room', maxBoost: 6 });
  const near = (f, x) => Math.abs(Math.log2(x / f)) < 1 / 6;
  const cut = r.bands.find((b) => near(80, b.freq));
  assert.ok(cut && cut.gain < -6, JSON.stringify(r.bands));
  assert.ok(!r.bands.some((b) => near(200, b.freq) && b.gain > 3), 'the narrow null is not filled');
  assert.ok(r.low >= 30 && r.low <= 50, `low limit ${r.low}`);
  assert.ok(!r.bands.some((b) => b.freq < r.low && b.gain > 0), 'no boost below the low limit');
  const eq = GRID.map(() => 0);
  for (const b of r.bands) bandResponse(b, GRID).forEach((v, i) => { eq[i] += v; });
  assert.ok(Math.max(...eq) <= 6.05, 'never more than the boost limit');
  assert.ok(r.after < r.before);
  assert.ok(r.preamp <= -0.5);
  assert.ok(correctionNotes(r, { calibrated: false }).some((n) => /kalibreringsfil/.test(n)));
});

test('a flat speaker gets (almost) nothing', () => {
  const r = designCorrection(GRID.map((f) => 80 + targetDb(f)), { maxBoost: 6 });
  assert.ok(r.bands.length <= 1, JSON.stringify(r.bands));
});

test('the low limit ignores narrow dips', () => {
  const curve = roomCurve().map((v) => v - 85);
  const low = lowLimit(curve);
  assert.ok(low > 25 && low < 45, String(low));
});

test('speakers: delay from distance, polarity, FIR lines', () => {
  assert.deepEqual(speakerDelay(250, 290), { channel: 'L', ms: 1.166 });
  assert.deepEqual(speakerDelay(300, 300), { channel: null, ms: 0 });
  assert.deepEqual(speakerDelay(0, 300), { channel: null, ms: 0 });
  assert.equal(speakerDelay(100, 5000).ms, 50);
  assert.deepEqual(channelLines({ distL: 290, distR: 250, invertR: true }), ['Channel: R', 'Delay: 1.166 ms', 'Channel: all', 'Channel: all', 'Copy: R=-1*R']);
  assert.deepEqual(firLines({ enabled: true, file: 'fir-stue.wav', rate: 44100 }), ['If: sampleRate == 44100', 'Convolution: fir-stue.wav', 'EndIf:']);
  assert.deepEqual(firLines({ enabled: true, file: '../x.wav' }), []);
  assert.deepEqual(firLines({ enabled: false, file: 'fir-stue.wav' }), []);
  const p = enginePayload({ enabled: true, preamp: 0, bands: [] }, { fir: { enabled: true, file: 'fir-a.wav', rate: 48000 }, channels: { distL: 1, distR: 2 } });
  assert.equal(p.extra[1], 'Convolution: fir-a.wav');
  assert.ok(p.extra.some((l) => l.startsWith('Delay:')));
});
