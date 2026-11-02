// Rumkorrektion: an EQ made from REW measurements of your speakers where you sit – like REW's own
// "Auto EQ", with the rules room correction needs to sound good:
//  • peaks are cut (also narrow ones in the bass, where the room's modes are);
//  • dips are NOT filled: a narrow dip is a cancellation that more power cannot fix, so only broad
//    shortfalls (1/3 octave) get a limited boost;
//  • no boost below what the speakers can play (the low limit), so the woofers and the amplifier are spared;
//  • above ~300 Hz only broad, gentle corrections (the room's reflections must not be "corrected");
//  • the top is left alone by default (the microphone's own roll-off, its 0°/90° calibration).
// Pure functions on a log grid (1/48 octave, 20 Hz–20 kHz). Bands are ordinary PK filters, so the
// result is an ordinary preset (and Balance lowers the floor as much as anything is lifted).
import { bandResponse } from './eq.js';

export const PPO = 48;
export const GRID = Array.from({ length: Math.round(PPO * Math.log2(20000 / 20)) + 1 }, (_, i) => 20 * 2 ** (i / PPO));
const SCHROEDER = 300;
// Above it, the room's reflections dominate: only gentle, broad corrections.
const MID_BOOST = 3;
const MID_CUT = 4;

const toPow = (db) => 10 ** (db / 10);
const toDb = (p) => 10 * Math.log10(Math.max(p, 1e-30));

/** A measurement (freqs, spl) on the grid: power average of the points in each grid step, or interpolated where it is sparse. */
export function toGrid(m) {
  const { freqs, spl } = m;
  const out = new Array(GRID.length).fill(NaN);
  const half = 2 ** (1 / (2 * PPO));
  let j = 0;
  for (let i = 0; i < GRID.length; i++) {
    const lo = GRID[i] / half, hi = GRID[i] * half;
    while (j < freqs.length && freqs[j] < lo) j++;
    let k = j, sum = 0, n = 0;
    while (k < freqs.length && freqs[k] < hi) { sum += toPow(spl[k]); n++; k++; }
    if (n) out[i] = toDb(sum / n);
  }
  // Sparse data (a text export at 1/24 octave …): interpolate on log frequency.
  for (let i = 0; i < GRID.length; i++) {
    if (Number.isFinite(out[i])) continue;
    const f = GRID[i];
    let a = 0;
    while (a < freqs.length - 1 && freqs[a + 1] < f) a++;
    if (freqs[a] > f || a >= freqs.length - 1) { out[i] = spl[freqs[a] > f ? 0 : freqs.length - 1]; continue; }
    const t = Math.log(f / freqs[a]) / Math.log(freqs[a + 1] / freqs[a]);
    out[i] = spl[a] + t * (spl[a + 1] - spl[a]);
  }
  return out;
}

/** A measurement made without the microphone's calibration file, corrected afterwards (cal = readCalFile). */
export function applyCalibration(curve, cal) {
  const { freqs, db } = cal;
  return curve.map((v, i) => {
    const f = GRID[i];
    if (f <= freqs[0]) return v - db[0];
    if (f >= freqs[freqs.length - 1]) return v - db[db.length - 1];
    let a = 0;
    while (freqs[a + 1] < f) a++;
    const t = Math.log(f / freqs[a]) / Math.log(freqs[a + 1] / freqs[a]);
    return v - (db[a] + t * (db[a + 1] - db[a]));
  });
}

/** Power average of several curves (several microphone positions = what the whole listening area hears). */
export function powerAverage(curves) {
  if (!curves.length) return [];
  return curves[0].map((_, i) => toDb(curves.reduce((s, c) => s + toPow(c[i]), 0) / curves.length));
}

/** 1/frac-octave power smoothing on the grid. */
export function smooth(curve, frac) {
  const w = Math.max(0, Math.round(PPO / (2 * frac)));
  return curve.map((_, i) => {
    let s = 0, n = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(curve.length - 1, i + w); k++) { s += toPow(curve[k]); n++; }
    return toDb(s / n);
  });
}

/** The highest value within ±1/(2·frac) octave of each point. */
export function upperEnvelope(curve, frac) {
  const w = Math.max(0, Math.round(PPO / (2 * frac)));
  return curve.map((_, i) => Math.max(...curve.slice(Math.max(0, i - w), i + w + 1)));
}

const idx = (f) => Math.max(0, Math.min(GRID.length - 1, Math.round(PPO * Math.log2(f / 20))));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

/** The level of the midrange (500 Hz–2 kHz, 1/3 octave) – what "0 dB" means. */
export function referenceLevel(curve) {
  const b = smooth(curve, 3);
  return mean(b.slice(idx(500), idx(2000) + 1));
}

// 0.10.1: less bass than 0.10.0 (+4/+7 felt heavy on real speakers – especially close up or outdoors).
export const TARGETS = {
  room: { label: 'Rum-kurve (anbefalet)', bass: 2, tilt: -0.5 },
  bass: { label: 'Rum-kurve med ekstra bas', bass: 4, tilt: -0.7 },
  flat: { label: 'Helt flad', bass: 0, tilt: 0 },
};

export const DEFAULT_MAX_BOOST = 3;
// Under the low limit the filters' skirts may lift at most this much in total.
const BELOW_LOW_MAX = 1.5;
// A bass peak this much over the bass around it is a room mode (it booms).
const MODE_MIN = 3;
// … and is cut at most this much (a deeper cut on a mode that is under the target thins the bass out).
const MODE_MAX = 6;

/**
 * The target in dB at f: a gentle bass lift (half of it at 120 Hz) and a gentle fall above 1 kHz.
 * Speakers measured where you sit sound right with this, not with a flat line (more treble arrives
 * straight from the speaker than bass, which the room adds to).
 */
export function targetDb(f, { bass = 2, tilt = -0.5 } = {}) {
  return bass / (1 + (f / 120) ** 2) + (f > 1000 ? tilt * Math.log2(f / 1000) : 0);
}

/**
 * The lowest frequency worth correcting: where the speakers roll off. Scanning down from 300 Hz, it
 * stops where the curve (1/6 octave, against the target) stays more than `drop` dB under its usual
 * bass level for over half an octave – a dip (a cancellation at 200 Hz …) is passed over. Boosting
 * below it only costs headroom and woofer excursion.
 */
export function lowLimit(curve, target = GRID.map((f) => targetDb(f)), drop = 10) {
  const c = smooth(curve, 6).map((v, i) => v - target[i]);
  const bass = c.slice(idx(40), idx(300) + 1).sort((a, b) => a - b);
  const level = bass[Math.floor(bass.length * 0.75)];
  let low = 300, below = 0;
  for (let i = idx(300); i >= 0; i--) {
    if (c[i] < level - drop) {
      if (++below > PPO / 2) break;
    } else { below = 0; low = GRID[i]; }
  }
  return Math.max(20, Math.round(low));
}

const peakQ = (bwOct) => { const r = 2 ** Math.max(bwOct, 0.05); return Math.sqrt(r) / (r - 1); };

/**
 * The correction: { bands, preamp, low, high, target[], measured[], predicted[], before, after }.
 * measured = one curve on GRID (dB SPL or relative). opts: target ('room'|'bass'|'flat' or {bass, tilt}),
 * maxBoost (dB, total), maxCut, maxFilters, low ('auto' or Hz), high (Hz).
 */
export function designCorrection(measured, opts = {}) {
  const t = typeof opts.target === 'object' ? opts.target : TARGETS[opts.target || 'room'];
  const maxBoost = opts.maxBoost ?? DEFAULT_MAX_BOOST;
  const maxCut = opts.maxCut ?? 12;
  const maxFilters = opts.maxFilters ?? 12;
  // Room modes: 'surround' = cut towards the bass around them (less boom, also when the bass as a
  // whole is under the target), 'target' = only what is over the target (like any other peak).
  const modeMode = opts.modes === 'target' ? 'target' : 'surround';
  const modeMax = opts.modeMax ?? MODE_MAX;
  const high = Math.min(20000, opts.high ?? 8000);
  const ref = referenceLevel(measured);
  const m = measured.map((x) => x - ref);
  const fine = smooth(m, 12);
  // For boosts: the upper edge of the curve (max over ±1/6 octave), then 1/3 octave – a narrow null
  // disappears in it, a broad shortfall does not.
  const broad = smooth(upperEnvelope(fine, 3), 3);
  const third = smooth(m, 3);
  const target = GRID.map((f) => targetDb(f, t));
  const low = opts.low && opts.low !== 'auto' ? Number(opts.low) : lowLimit(m, target);
  const lo = idx(low), hi = idx(high);

  const bands = [];
  const eqAt = new Array(GRID.length).fill(0);
  const addResp = (b, sign = 1) => { const r = bandResponse(b, GRID); for (let i = 0; i < GRID.length; i++) eqAt[i] += sign * r[i]; };
  const devFine = (i) => fine[i] + eqAt[i] - target[i];
  const devBroad = (i) => broad[i] + eqAt[i] - target[i];
  // Below the Schroeder frequency the room's modes are narrow peaks; above it only broad trends count.
  const peakDev = (i) => (GRID[i] < SCHROEDER ? devFine(i) : third[i] + eqAt[i] - target[i]);
  const maxEq = () => Math.max(...eqAt);
  // How far the boosts go over their limits: the total, and (from their skirts) below the low limit.
  const overLimit = () => Math.max(maxEq() - maxBoost, lo > 0 ? Math.max(...eqAt.slice(0, lo)) - BELOW_LOW_MAX : -Infinity);

  const width = (i, dev, sign) => {
    const d0 = dev(i);
    let a = i, b = i;
    while (a > 0 && sign * dev(a - 1) > sign * d0 / 2) a--;
    while (b < GRID.length - 1 && sign * dev(b + 1) > sign * d0 / 2) b++;
    return Math.max((b - a + 1) / PPO, 0.1);
  };

  // No new filter right next to one that is there (the fine-tuning adjusts that one), and no boost
  // within 1/3 octave of a room mode (it would lift the boom again).
  const dist = (i, b) => Math.abs(Math.log2(GRID[i] / b.freq));
  const near = (i) => bands.some((b) => dist(i, b) < (b.mode ? 1 / 5 : 1 / 8));
  const nearMode = (i) => bands.some((b) => b.mode && dist(i, b) < 1 / 3);

  // Room modes first: bass peaks that stand out from the bass around them (1-octave average) boom
  // and ring – they are cut towards their surroundings even when the bass as a whole is under the
  // target, and boosts are never centred on them.
  const base = smooth(m, 1);
  const prom = (i) => fine[i] - base[i];
  const modeIdx = [];
  for (let i = Math.max(lo, idx(25)); modeMode === 'surround' && i <= idx(SCHROEDER); i++) {
    const p = prom(i);
    if (p > MODE_MIN && p >= prom(i - 1) && p >= prom(i + 1) && p >= prom(i - 2) && p >= prom(i + 2)) modeIdx.push(i);
  }
  modeIdx.sort((a, b) => prom(b) - prom(a));
  for (const i of modeIdx) {
    if (bands.filter((b) => b.mode).length >= 4 || bands.some((b) => Math.abs(Math.log2(GRID[i] / b.freq)) < 1 / 3)) continue;
    const p = prom(i);
    let a = i, b = i;
    while (a > 0 && prom(a - 1) > p / 2) a--;
    while (b < GRID.length - 1 && prom(b + 1) > p / 2) b++;
    const q = Math.min(10, Math.max(2, peakQ((b - a + 1) / PPO)));
    const under = fine[i] < target[i];
    const band = { enabled: true, type: 'PK', freq: GRID[i], gain: -Math.min(under ? modeMax : maxCut, maxCut, p - 1), q, mode: true, under };
    addResp(band);
    bands.push(band);
  }

  for (let n = 0; n < maxFilters; n++) {
    let best = null;
    for (let i = lo; i <= hi; i++) {
      const p = peakDev(i);
      if (near(i)) continue; // a filter sits here already – the fine-tuning below adjusts it
      const mid = GRID[i] >= SCHROEDER;
      // Above the Schroeder frequency small wiggles are left alone (they change with every step you take).
      if (p > (mid ? 2 : 1) && (!best || p > best.score)) best = { score: p, i, kind: 'cut' };
      const d = devBroad(i) + (mid ? 1 : 0);
      const room = Math.min(maxBoost, GRID[i] < SCHROEDER ? maxBoost : MID_BOOST) - eqAt[i];
      // A broad shortfall only, and some room left under the boost limit; cuts go first.
      // No boost right above the roll-off either: the filter's skirt would reach below it.
      if (d < -1.5 && room > 0.5 && GRID[i] >= low * 1.25 && !nearMode(i)) { const s = Math.min(-d, room) * 0.8; if (!best || s > best.score) best = { score: s, i, kind: 'boost' }; }
    }
    if (!best || best.score < 1) break;
    const { i, kind } = best;
    const f = GRID[i];
    let band;
    if (kind === 'cut') {
      const above = f >= SCHROEDER;
      const q = Math.min(above ? 2.5 : 8, Math.max(above ? 0.7 : 0.8, peakQ(width(i, peakDev, 1))));
      band = { enabled: true, type: 'PK', freq: f, gain: -Math.min(peakDev(i), above ? MID_CUT : maxCut), q };
    } else {
      const q = Math.min(2, Math.max(0.7, peakQ(width(i, devBroad, -1))));
      band = { enabled: true, type: 'PK', freq: f, gain: Math.min(-devBroad(i), (f < SCHROEDER ? maxBoost : MID_BOOST) - eqAt[i]) * 0.9, q };
    }
    addResp(band);
    // Never more than maxBoost in total (neighbouring boosts add up).
    const over = overLimit();
    if (over > 0 && band.gain > 0) { addResp(band, -1); band.gain = Math.max(0, band.gain - over); addResp(band); }
    if (Math.abs(band.gain) < 0.5) { addResp(band, -1); break; }
    bands.push(band);
  }

  // Fine-tune: each filter's gain so its own frequency ends on target (filters overlap).
  for (let pass = 0; pass < 4; pass++) {
    for (const b of bands) {
      const i = idx(b.freq);
      if (b.mode) {
        // A room mode: down to the bass around it (+1 dB) – and not over the target either.
        const r = Math.max(peakDev(i), fine[i] + eqAt[i] - base[i] - 1);
        addResp(b, -1);
        b.gain = Math.max(-Math.min(maxCut, b.under ? modeMax : maxCut), Math.min(0, b.gain - 0.7 * r));
        addResp(b);
        continue;
      }
      const dev = b.gain < 0 ? peakDev(i) : devBroad(i);
      addResp(b, -1);
      const g = b.gain - 0.7 * dev;
      const mid = b.freq >= SCHROEDER;
      b.gain = b.gain < 0 ? Math.max(mid ? -MID_CUT : -maxCut, Math.min(0, g)) : Math.max(0, Math.min(mid ? MID_BOOST : maxBoost, g));
      addResp(b);
      const over = overLimit();
      if (over > 0 && b.gain > 0) { addResp(b, -1); b.gain = Math.max(0, b.gain - over); addResp(b); }
    }
  }

  const out = bands.filter((b) => Math.abs(b.gain) >= 0.5)
    .map((b) => ({ enabled: true, type: 'PK', freq: Math.round(b.freq), gain: Math.round(b.gain * 10) / 10, q: Math.round(b.q * 100) / 100 }))
    .sort((a, b) => a.freq - b.freq);
  const eq = new Array(GRID.length).fill(0);
  for (const b of out) bandResponse(b, GRID).forEach((v, i) => { eq[i] += v; });
  const predicted = m.map((x, i) => x + eq[i]);
  const err = (curve) => { const s = smooth(curve, 6); const d = []; for (let i = lo; i <= hi; i++) d.push((s[i] - target[i]) ** 2); return Math.sqrt(mean(d)); };
  const boost = Math.max(0, ...eq);
  return {
    bands: out,
    modes: bands.filter((b) => b.mode && b.gain <= -0.5).map((b) => Math.round(b.freq)).sort((a, b) => a - b),
    // Room modes cut although they are under the target (they stand out from the bass around them).
    modesUnder: bands.filter((b) => b.mode && b.gain <= -0.5 && b.under).map((b) => Math.round(b.freq)).sort((a, b) => a - b),
    preamp: -Math.round((boost + 0.5) * 10) / 10,
    low, high, reference: ref, target, measured: m, predicted,
    before: Math.round(err(m) * 10) / 10,
    after: Math.round(err(predicted) * 10) / 10,
  };
}

/** A plain-language summary of what the measurement shows and what the correction does. */
export function correctionNotes(res, { calibrated = null } = {}) {
  const notes = [];
  if (calibrated === false) notes.push('Målingen er lavet uden mikrofonens kalibreringsfil – frekvensgangen over ca. 8 kHz er ikke til at stole på, så den rettes ikke.');
  const b = smooth(res.measured, 3);
  const low = b.slice(idx(40), idx(150) + 1);
  if (mean(low) < -8) notes.push(`Bassen ligger ca. ${Math.round(-mean(low))} dB under mellemtonen (40–150 Hz). Det er typisk for højttalere uden et rum omkring sig (udendørs, eller langt fra væggene) – det kan EQ kun hjælpe lidt på uden at tage al forstærkerens luft. Flyt dem tættere på en væg eller et hjørne, hvis du kan.`);
  notes.push(`Retter fra ${res.low} Hz til ${res.high >= 1000 ? `${Math.round(res.high / 100) / 10} kHz` : `${res.high} Hz`}.`);
  if (res.low > 40) notes.push('Længere nede kan højttalerne ikke spille det, så der løftes ikke.');
  if (res.modes?.length) notes.push(`Rumtoppe i bassen ved ${res.modes.join(', ')} Hz dæmpes – det er dem, der får bassen til at runge.`);
  if (res.modesUnder?.length) notes.push(`Rumtoppene ved ${res.modesUnder.join(', ')} Hz ligger under målkurven, men stikker op over bassen omkring dem – derfor dæmpes de alligevel (højst ${MODE_MAX} dB). Vil du hellere beholde dem, så vælg "Rumtoppe: kun over målkurven".`);
  const cuts = res.bands.filter((x) => x.gain < 0).length, boosts = res.bands.length - cuts;
  notes.push(`${res.bands.length} filtre: ${cuts} dæmper toppe, ${boosts} løfter brede huller (højst så meget, som du har valgt). Smalle huller fyldes ikke op – dem kan EQ ikke rette.`);
  notes.push(`Afvigelse fra målkurven: ${String(res.before).replace('.', ',')} dB før → ${String(res.after).replace('.', ',')} dB efter (1/6 oktav).`);
  return notes;
}

// ---------- Several measurements: left/right, check measurements, timing ----------

/** Which speaker a measurement is of, from its name ("L", "Left", "Venstre", "R 2" …); 'LR' when unsure. */
export function guessChannel(name) {
  const n = String(name || '').toLowerCase();
  if (/l\s*\+\s*r|\blr\b|both|begge|stereo/.test(n)) return 'LR';
  if (/(^|[^a-zæøå])(l|left|venstre|v)([^a-zæøå]|$)/.test(n)) return 'L';
  if (/(^|[^a-zæøå])(r|right|højre|h)([^a-zæøå]|$)/.test(n)) return 'R';
  return 'LR';
}

/**
 * The correction from all measurements: meas = [{ curve, channel: 'LR'|'L'|'R', role: 'design'|'check', on }].
 * With measurements of both speakers on their own, each side gets its own filters (band.channel L/R);
 * otherwise one correction from all of them. Check measurements (made with the EQ on) are only shown.
 * Returns { stereo, sides: { all|L|R: result }, bands, preamp, levelDiff (R − L dB), checks: { side: curve } }.
 */
export function designRoom(meas, opts = {}) {
  const use = meas.filter((m) => m.on !== false && m.role !== 'check');
  const of = (ch) => use.filter((m) => (m.channel || 'LR') === ch).map((m) => m.curve);
  const L = of('L'), R = of('R');
  const stereo = L.length > 0 && R.length > 0;
  const sides = {};
  let bands = [];
  if (stereo) {
    sides.L = designCorrection(powerAverage(L), opts);
    sides.R = designCorrection(powerAverage(R), opts);
    bands = [...sides.L.bands.map((b) => ({ ...b, channel: 'L' })), ...sides.R.bands.map((b) => ({ ...b, channel: 'R' }))];
  } else if (use.length) {
    sides.all = designCorrection(powerAverage(use.map((m) => m.curve)), opts);
    bands = sides.all.bands;
  }
  const res = Object.values(sides);
  const checks = {};
  for (const ch of ['LR', 'L', 'R']) {
    const c = meas.filter((m) => m.on !== false && m.role === 'check' && (m.channel || 'LR') === ch).map((m) => m.curve);
    if (c.length) { const avg = powerAverage(c); const ref = referenceLevel(avg); checks[ch === 'LR' ? 'all' : ch] = avg.map((v) => v - ref); }
  }
  return {
    stereo,
    combinedOnly: !stereo && use.length > 0,
    sides,
    bands,
    preamp: res.length ? Math.min(...res.map((r) => r.preamp)) : 0,
    levelDiff: stereo ? Math.round((referenceLevel(powerAverage(R)) - referenceLevel(powerAverage(L))) * 10) / 10 : null,
    checks,
  };
}

/** Notes for the whole set: L/R level difference, only L+R measurements. */
export function roomNotes(room) {
  const notes = [];
  if (room.combinedOnly) notes.push('Alle målinger er af begge højttalere på én gang (L+R) – forskelle mellem dem kan gemme sig. Mål venstre og højre hver for sig og markér dem, så får hver side sin egen korrektion.');
  if (room.stereo) notes.push('Venstre og højre er målt hver for sig – hver side får sine egne filtre.');
  if (room.levelDiff != null && Math.abs(room.levelDiff) >= 1) {
    const d = String(Math.abs(room.levelDiff)).replace('.', ',');
    notes.push(room.levelDiff > 0
      ? `Højre spiller ${d} dB højere end venstre i mellemtonen – ret det med Balance under Lytte-forbedringer (eller med forstærkeren).`
      : `Venstre spiller ${d} dB højere end højre i mellemtonen – ret det med Balance under Lytte-forbedringer (eller med forstærkeren).`);
  }
  return notes;
}

/**
 * Arrival times from measurements made with a timing reference (REW: loopback or acoustic) →
 * distances in cm for the Højttalere card (sound travels 343 m/s). null when there is nothing to go on.
 */
export function measuredDistances(meas) {
  const t = (ch) => {
    const ts = meas.filter((m) => m.channel === ch && m.timing?.usedRef && Number.isFinite(m.timing.peak)).map((m) => m.timing.peak);
    return ts.length ? ts.reduce((a, b) => a + b, 0) / ts.length : null;
  };
  const tl = t('L'), tr = t('R');
  if (tl == null || tr == null) return null;
  let distL = tl * 34300, distR = tr * 34300;
  // A sound card's own delay can be in the times: keep only the difference, from a normal distance.
  if (Math.max(distL, distR) > 2000 || Math.min(distL, distR) <= 0) {
    const diff = (tr - tl) * 34300;
    distL = 300 - Math.min(0, diff);
    distR = 300 + Math.max(0, diff);
  }
  return { distL: Math.round(distL), distR: Math.round(distR), diffMs: Math.round((tr - tl) * 100000) / 100 };
}
