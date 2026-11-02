// Høretest: find the faintest tone you can hear, per ear and frequency, through the headphones you
// listen with – and turn it into a personal EQ (bands per ear). Not a medical test: the levels are
// not calibrated, so only the shape counts (ear against ear, frequency against frequency), compared
// with how a normal ear hears (the threshold of hearing in ISO 226:2003).

export const TEST_FREQS = [250, 500, 1000, 2000, 3000, 4000, 6000, 8000, 10000, 12000];
export const START_DB = -45; // dBFS of the tone when a step starts
export const MIN_DB = -95;
export const MAX_DB = -20; // never louder than this – protects the ears
export const CANT_HEAR = null;

// Threshold of hearing, dB SPL (ISO 226:2003, Tf). Interpolated on a log-frequency axis.
const ISO_TF = [[125, 22.1], [160, 17.9], [200, 14.4], [250, 11.4], [315, 8.6], [400, 6.2], [500, 4.4], [630, 3.0], [800, 2.2], [1000, 2.4],
  [1250, 3.5], [1600, 1.7], [2000, -1.3], [2500, -4.2], [3150, -6.0], [4000, -5.4], [5000, -1.5], [6300, 6.0], [8000, 12.6], [10000, 13.9], [12500, 12.3]];
export function normalThreshold(f) {
  if (f <= ISO_TF[0][0]) return ISO_TF[0][1];
  const last = ISO_TF[ISO_TF.length - 1];
  if (f >= last[0]) return last[1];
  let i = 1;
  while (ISO_TF[i][0] < f) i++;
  const [f0, t0] = ISO_TF[i - 1], [f1, t1] = ISO_TF[i];
  return t0 + ((Math.log(f) - Math.log(f0)) / (Math.log(f1) - Math.log(f0))) * (t1 - t0);
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };

/** How much worse than a normal ear (dB), per ear and frequency, relative to your own middle (the
 *  median of both ears from 500 Hz to 4 kHz). Positive = you hear that tone worse than the rest.
 *  thresholds: { L: [dBFS | null], R: [...] } in TEST_FREQS order; null = could not hear it. */
export function hearingProfile(thresholds, freqs = TEST_FREQS) {
  const raw = {};
  for (const ear of ['L', 'R']) raw[ear] = freqs.map((f, i) => (thresholds?.[ear]?.[i] == null ? null : thresholds[ear][i] - normalThreshold(f)));
  const mid = ['L', 'R'].flatMap((ear) => freqs.map((f, i) => (f >= 500 && f <= 4000 ? raw[ear][i] : null))).filter((v) => v != null);
  const ref = median(mid);
  const out = { ref };
  // "Could not hear it at all" counts as at least as bad as the loudest test level allowed.
  for (const ear of ['L', 'R']) out[ear] = raw[ear].map((v, i) => Math.round((v == null ? MAX_DB - normalThreshold(freqs[i]) : v) * 10 - ref * 10) / 10);
  return out;
}

/** The personal EQ: about half of each difference (the "half-gain rule" from hearing aids), at most
 *  +8 dB lift and −3 dB cut; differences under 1,5 dB are left alone. A band per ear and frequency. */
export function compensationBands(thresholds, { amount = 0.5, maxBoost = 8, maxCut = 3, freqs = TEST_FREQS } = {}) {
  const prof = hearingProfile(thresholds, freqs);
  const bands = [];
  for (const ear of ['L', 'R']) {
    prof[ear].forEach((d, i) => {
      if (Math.abs(d) < 1.5) return;
      const gain = Math.round(Math.max(-maxCut, Math.min(maxBoost, d * amount)) * 10) / 10;
      if (Math.abs(gain) < 0.5) return;
      bands.push({ enabled: true, type: 'PK', freq: freqs[i], gain, q: 1.4, channel: ear });
    });
  }
  return bands;
}

/** A few lines about the result, in plain words. */
export function hearingSummary(thresholds, freqs = TEST_FREQS) {
  const prof = hearingProfile(thresholds, freqs);
  const lines = [];
  const fmt = (f) => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`);
  const missed = (ear) => freqs.filter((f, i) => thresholds?.[ear]?.[i] == null).map(fmt).join(', ');
  if (missed('L')) lines.push(`Kunne ikke høres på venstre øre: ${missed('L')}.`);
  if (missed('R')) lines.push(`Kunne ikke høres på højre øre: ${missed('R')}.`);
  // Ear against ear only where both were heard ("could not hear" is already said above).
  const heard = (i) => thresholds?.L?.[i] != null && thresholds?.R?.[i] != null;
  const diffs = freqs.map((f, i) => ({ f, i, d: prof.L[i] - prof.R[i] })).filter((x) => heard(x.i) && Math.abs(x.d) >= 6);
  for (const x of diffs) lines.push(`${x.d > 0 ? 'Venstre' : 'Højre'} øre hører ${fmt(x.f)} ${Math.round(Math.abs(x.d))} dB dårligere end ${x.d > 0 ? 'højre' : 'venstre'}.`);
  const weak = freqs.map((f, i) => ({ f, d: Math.max(prof.L[i], prof.R[i]) })).filter((x) => x.d >= 10 && x.f >= 2000);
  if (weak.length) lines.push(`Diskanten (${weak.map((x) => fmt(x.f)).join(', ')}) høres svagere end resten – helt almindeligt, især med alderen eller efter meget høj lyd.`);
  if (!lines.length) lines.push('Dine ører hører ens og jævnt – der er ikke meget at rette.');
  return lines;
}
