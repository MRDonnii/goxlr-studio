// Live-spektrum behind the EQ curve: what plays on an output right now (Windows' loopback capture,
// see src-tauri/src/spectrum.rs) or in the Lyttetest. The same 120 bands from 20 Hz to 20 kHz
// (about 12 per octave) either way. Pure helpers, tested in tests/spectrum.test.mjs.
export const SPECTRUM_BANDS = 120;
export const SPECTRUM_FLOOR = -120;
export const SPECTRUM_FREQS = Array.from({ length: SPECTRUM_BANDS }, (_, i) => 20 * Math.pow(1000, i / (SPECTRUM_BANDS - 1)));

// An AnalyserNode's dB are |X|/N with a Blackman window; spectrum.rs reads a full-scale sine as
// 0 dB. This puts the two on the same scale (one-sided power ×2, Blackman Σw² ≈ 0,3046·N, ×2).
const ANALYSER_OFFSET_DB = 10 * Math.log10((2 * 2) / 0.3046);

/** From an AnalyserNode's getFloatFrequencyData (dB per linear bin) to the 120 bands: each bin's
 *  power is shared between the bands it overlaps, as in spectrum.rs. */
export function bandsFromBins(binsDb, rate, fftSize) {
  const df = rate / fftSize;
  const ratio = Math.pow(1000, 0.5 / (SPECTRUM_BANDS - 1));
  const lastBin = binsDb.length - 1;
  return SPECTRUM_FREQS.map((c) => {
    const lo = c / ratio, hi = c * ratio;
    let p = 0;
    for (let k = Math.max(0, Math.floor(lo / df - 0.5)); k <= Math.min(lastBin, Math.ceil(hi / df + 0.5)); k++) {
      const overlap = Math.min(hi, (k + 0.5) * df) - Math.max(lo, (k - 0.5) * df);
      if (overlap > 0 && Number.isFinite(binsDb[k])) p += Math.pow(10, binsDb[k] / 10) * (overlap / df);
    }
    return p > 0 ? Math.max(SPECTRUM_FLOOR, 10 * Math.log10(p) + ANALYSER_OFFSET_DB) : SPECTRUM_FLOOR;
  });
}

/** Up at once, down slowly (`fall` dB per second) – like a real-time analyser. */
export function smoothSpectrum(prev, next, dtMs, fall = 24) {
  if (!next) return prev;
  if (!prev || prev.length !== next.length) return next.slice();
  const drop = (fall * Math.max(0, dtMs)) / 1000;
  return next.map((v, i) => Math.max(v, prev[i] - drop, SPECTRUM_FLOOR));
}

/** "Automatisk": the output that plays loudest (peak levels from the VU meters), but stay on the
 *  current one as long as it plays. null = Windows' default output. */
export function pickSpectrumDevice(levels, candidates, current) {
  const lv = (id) => levels?.[id] ?? 0;
  if (current && candidates.includes(current) && lv(current) > 0.01) return current;
  let best = null;
  let max = 0.01;
  for (const id of candidates) if (lv(id) > max) { max = lv(id); best = id; }
  return best ?? (current && candidates.includes(current) ? current : null);
}

/** The browser demo: something like music on the Music output, moving a little. */
export function demoSpectrum(t) {
  const kick = Math.pow(Math.max(0, Math.sin(t * Math.PI * 1.9)), 8);
  return SPECTRUM_FREQS.map((f, i) => {
    const oct = Math.log2(f / 150);
    let db = -30 - 4.5 * Math.max(0, oct) - 8 * Math.max(0, -oct - 1.3);
    if (f < 130) db += 9 * kick - 4;
    if (f > 2000 && f < 9000) db += 3 * Math.sin(t * 7 + i * 0.4);
    db += 2.2 * Math.sin(i * 1.3 + t * 5) + 1.4 * Math.sin(i * 0.37 - t * 3.1);
    if (f > 16000) db -= (f - 16000) / 250;
    return Math.max(-110, db);
  });
}
