// Microphone presets for the GoXLR's own mic EQ, gate, compressor and de-esser.
//
// Like AutoEQ for headphones: EQ = a target curve for speech − the microphone's own deviations
// from flat (from the maker's frequency-response graph), fitted to the GoXLR's fixed bands
// (10 on the full GoXLR, 6 on the Mini) by least squares, since the bands overlap. Gain, gate,
// compressor and de-esser follow from the mic's type and sensitivity. They are a starting point:
// rooms, voices and distance differ, so listen and adjust.
import { coefficients, magnitudeDb } from './eq.js';
import { EQ_BANDS, MINI_EQ_BANDS } from './demo.js';
import { MIC_MODELS, USB_ONLY } from './micmodels.js';

export { MIC_MODELS, USB_ONLY };

export const FULL_CENTERS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
// The Mini's lowest band can sit anywhere from 30 to 90 Hz: at 60 Hz it takes rumble, not the voice.
export const MINI_CENTERS = [60, 250, 500, 1000, 3000, 8000];
// The hardware doesn't expose Q; the same approximation as the drawing on the Mikrofon page.
const HW_Q = 1.3;
const LIMIT = 9;

// What speech should sound like after mic + EQ: rumble and plosive thumps gone, a little less mud,
// a little more presence and air.
export const VOICE_TARGET = [
  { kind: 'lowcut', freq: 60, db: -15 },
  { kind: 'peak', freq: 300, db: -2, q: 0.9 },
  { kind: 'peak', freq: 3500, db: 2, q: 0.8 },
  { kind: 'highshelf', freq: 10000, db: 1 },
];

const FILTER = { lowcut: 'LSC', lowshelf: 'LSC', highcut: 'HSC', highshelf: 'HSC', peak: 'PK' };

/** dB of a list of response features at frequency f. */
export function featuresDb(features, f) {
  let sum = 0;
  for (const x of features || []) {
    const type = FILTER[x.kind];
    if (!type || !x.freq || !x.db) continue;
    sum += magnitudeDb(coefficients({ type, freq: x.freq, gain: x.db, q: type === 'PK' ? x.q || 1 : 0.7 }), f);
  }
  return sum;
}

const GRID = Array.from({ length: 64 }, (_, i) => 35 * Math.pow(16000 / 35, i / 63));

/** Least-squares gains (dB, whole numbers, ±9) for bands at `centers` that best give `want(f)`. */
export function fitBands(want, centers, q = HW_Q) {
  const shape = centers.map((c) => {
    const k = coefficients({ type: 'PK', freq: c, gain: 6, q });
    return GRID.map((f) => magnitudeDb(k, f) / 6);
  });
  // Speech matters most between 100 Hz and 8 kHz; a little ridge keeps neighbours from fighting.
  const w = GRID.map((f) => (f >= 100 && f <= 8000 ? 1 : 0.4));
  const target = GRID.map(want);
  const n = centers.length;
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => GRID.reduce((s, _f, k) => s + w[k] * shape[i][k] * shape[j][k], 0) + (i === j ? 0.05 : 0)));
  const b = Array.from({ length: n }, (_, i) => GRID.reduce((s, _f, k) => s + w[k] * shape[i][k] * target[k], 0));
  return solve(A, b).map((g) => Math.max(-LIMIT, Math.min(LIMIT, Math.round(g))) || 0);
}

function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c || !M[c][c]) continue;
      const k = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
    }
  }
  return M.map((row, i) => (row[i] ? row[n] / row[i] : 0));
}

/** The EQ a mic needs: target − mic, with boosts limited – a mic's roll-off is not fought with
 *  big boosts, and above 8 kHz more than +3 dB mostly adds hiss and sharp s-sounds. */
export function wantedEq(model) {
  return (f) => Math.max(-15, Math.min(f > 8000 ? 3 : 6, featuresDb(VOICE_TARGET, f) - featuresDb(model.features, f)));
}

/** Everything the preset sets, for the full GoXLR or the Mini. */
export function micSettings(model, mini = false) {
  const condenser = model.type === 'condenser';
  // +48 V: condensers, and dynamics with a built-in preamp (SM7dB) – the GoXLR's "Condenser" type.
  const phantom = condenser || !!model.phantom;
  const centers = mini ? MINI_CENTERS : FULL_CENTERS;
  // Bands above 8 kHz never more than +2 dB, also when the fit leans on them for their neighbours:
  // up there a mic has little to give, and a dynamic at 50+ dB gain mostly gives hiss.
  const gains = fitBands(wantedEq(model), centers).map((g, i) => (centers[i] > 8000 ? Math.min(g, 2) : g));
  const bright = (model.features || []).some((x) => (x.kind === 'peak' || x.kind === 'highshelf') && x.freq >= 4000 && x.db >= 3);
  const sens = Number.isFinite(model.sensitivity_dbv) ? model.sensitivity_dbv : condenser ? -34 : -55;
  return {
    type: phantom ? 'Condenser' : 'Dynamic',
    // Roughly: a quiet mic needs more gain. GoXLR's mic gain goes to 72 dB.
    gain: Math.max(10, Math.min(68, Math.round(-sens - 2))),
    eq: centers.map((freq, i) => ({ band: (mini ? MINI_EQ_BANDS : EQ_BANDS)[i], freq, gain: gains[i] })),
    // A condenser hears the room too, so its gate opens a little later.
    gate: { threshold: condenser ? -40 : -45, attenuation: 80, attack: 'Gate10ms', release: 'Gate250ms' },
    comp: { threshold: -20, ratio: 'Ratio3_2', attack: 'Comp5ms', release: 'Comp100ms', makeup: condenser ? 3 : 5 },
    deess: (condenser ? 35 : 20) + (bright ? 10 : 0),
  };
}

/** The GoXLR commands for a preset; `parts` chooses what is set (gain is off unless asked for). */
export function micPresetCommands(model, mini, parts = {}) {
  const s = micSettings(model, mini);
  const p = { type: true, eq: true, gate: true, comp: true, deess: true, gain: false, ...parts };
  const out = [];
  if (p.type) out.push(['SetMicrophoneType', s.type]);
  if (p.gain) out.push(['SetMicrophoneGain', s.type, s.gain]);
  if (p.eq) {
    for (const b of s.eq) {
      out.push([mini ? 'SetEqMiniFreq' : 'SetEqFreq', b.band, b.freq]);
      out.push([mini ? 'SetEqMiniGain' : 'SetEqGain', b.band, b.gain]);
    }
  }
  if (p.gate) {
    out.push(['SetGateActive', true], ['SetGateThreshold', s.gate.threshold], ['SetGateAttenuation', s.gate.attenuation],
      ['SetGateAttack', s.gate.attack], ['SetGateRelease', s.gate.release]);
  }
  if (p.comp) {
    out.push(['SetCompressorThreshold', s.comp.threshold], ['SetCompressorRatio', s.comp.ratio], ['SetCompressorAttack', s.comp.attack],
      ['SetCompressorReleaseTime', s.comp.release], ['SetCompressorMakeupGain', s.comp.makeup]);
  }
  if (p.deess) out.push(['SetDeeser', s.deess]);
  return out;
}

const hz = (f) => (f >= 1000 ? `${String(Math.round(f / 100) / 10).replace('.', ',')} kHz` : `${Math.round(f)} Hz`);

/** A short Danish description of the mic's sound, from its response features. */
export function describeMic(model) {
  const parts = [];
  for (const x of model.features || []) {
    if (x.kind === 'lowcut') parts.push(`mindre bas under ${hz(x.freq)}`);
    else if (x.kind === 'lowshelf') parts.push(x.db > 0 ? `${model.type === 'dynamic' ? 'nærhedseffekt – mere bas tæt på' : `mere bas under ${hz(x.freq)}`}` : `mindre bas under ${hz(x.freq)}`);
    else if (x.kind === 'peak') parts.push(x.db > 0 ? `løft omkring ${hz(x.freq)}` : `dyk omkring ${hz(x.freq)}`);
    else if (x.kind === 'highshelf') parts.push(x.db > 0 ? `lys top over ${hz(x.freq)}` : `mørkere top over ${hz(x.freq)}`);
    else if (x.kind === 'highcut') parts.push(`aftagende top over ${hz(x.freq)}`);
  }
  const kind = model.type === 'condenser' ? 'Kondensator (+48V)' : model.phantom ? 'Dynamisk med indbygget forforstærker (+48V)' : 'Dynamisk';
  return parts.length ? `${kind}: ${parts.join(', ')}.` : `${kind}: neutral.`;
}
