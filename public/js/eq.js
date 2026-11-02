export const FILTER_TYPES = {
  PK: { label: 'Peak', gain: true, q: true },
  LSC: { label: 'Low shelf', gain: true, q: true },
  HSC: { label: 'High shelf', gain: true, q: true },
  HP: { label: 'Low cut', gain: false, q: true, slope: true },
  LP: { label: 'High cut', gain: false, q: true, slope: true },
  NO: { label: 'Notch', gain: false, q: true },
  BP: { label: 'Band-pass', gain: false, q: true },
  AP: { label: 'All-pass', gain: false, q: true },
};

/** Low/high cut steepness in dB per octave. 12 = one filter with your Q; steeper = Butterworth. */
export const SLOPES = [12, 24, 36, 48];

/** Q of each 2nd-order section of a Butterworth filter of the given order (2, 4, 6, 8). */
export function butterworthQs(order) {
  const n = Math.max(1, Math.round(order / 2));
  return Array.from({ length: n }, (_, k) => 1 / (2 * Math.cos((Math.PI * (2 * k + 1)) / (4 * n))));
}

/** The filters the engine really runs for a band: a steep low/high cut is several sections. */
export function expandBand(b) {
  if ((b.type === 'HP' || b.type === 'LP') && b.slope > 12) {
    return butterworthQs(b.slope / 6).map((q) => ({ ...b, q: Math.round(q * 10000) / 10000, slope: 12 }));
  }
  return [b];
}
export const expandBands = (bands) => bands.flatMap(expandBand);

export const SAMPLE_RATE = 48000;

export function newBand(freq = 1000, type = 'PK') {
  return { id: crypto.randomUUID(), enabled: true, type, freq, gain: 0, q: type === 'PK' ? 1.0 : 0.707 };
}

export function defaultOutputEq() {
  return { enabled: true, preamp: 0, bands: [newBand(60, 'LSC'), newBand(250), newBand(1000), newBand(4000), newBand(10000, 'HSC')] };
}

// RBJ Audio EQ Cookbook, normalised so a0 = 1.
export function coefficients(band, fs = SAMPLE_RATE) {
  const f = Math.min(Math.max(band.freq, 10), fs / 2 - 1);
  const w0 = (2 * Math.PI * f) / fs;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const q = Math.max(band.q, 0.05);
  const alpha = sin / (2 * q);
  const A = Math.pow(10, band.gain / 40);
  let b0, b1, b2, a0, a1, a2;
  switch (band.type) {
    case 'LSC': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) - (A - 1) * cos + s);
      b1 = 2 * A * ((A - 1) - (A + 1) * cos);
      b2 = A * ((A + 1) - (A - 1) * cos - s);
      a0 = (A + 1) + (A - 1) * cos + s;
      a1 = -2 * ((A - 1) + (A + 1) * cos);
      a2 = (A + 1) + (A - 1) * cos - s;
      break;
    }
    case 'HSC': {
      const s = 2 * Math.sqrt(A) * alpha;
      b0 = A * ((A + 1) + (A - 1) * cos + s);
      b1 = -2 * A * ((A - 1) + (A + 1) * cos);
      b2 = A * ((A + 1) + (A - 1) * cos - s);
      a0 = (A + 1) - (A - 1) * cos + s;
      a1 = 2 * ((A - 1) - (A + 1) * cos);
      a2 = (A + 1) - (A - 1) * cos - s;
      break;
    }
    case 'HP':
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'LP':
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'NO':
      b0 = 1; b1 = -2 * cos; b2 = 1;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'BP':
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    case 'AP':
      b0 = 1 - alpha; b1 = -2 * cos; b2 = 1 + alpha;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
      break;
    default:
      b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
      a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

export function magnitudeDb(c, freq, fs = SAMPLE_RATE) {
  const w = (2 * Math.PI * freq) / fs;
  const cos1 = Math.cos(w), sin1 = Math.sin(w), cos2 = Math.cos(2 * w), sin2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const ni = -(c.b1 * sin1 + c.b2 * sin2);
  const dr = 1 + c.a1 * cos1 + c.a2 * cos2;
  const di = -(c.a1 * sin1 + c.a2 * sin2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

export function bandResponse(band, freqs) {
  const cs = expandBand(band).map((b) => coefficients(b));
  return freqs.map((f) => cs.reduce((sum, c) => sum + magnitudeDb(c, f), 0));
}

// Venstre/højre øre: a band can apply to both ears (no channel / 'all') or one of them.
export const EAR_LABEL = { all: 'Begge', L: 'Venstre', R: 'Højre' };
export const onEar = (b, ear) => !b.channel || b.channel === 'all' || b.channel === ear;
/** True when some band is for one ear only (then left and right differ). */
export const usesEars = (eq) => !!eq?.bands?.some((b) => b.enabled !== false && (b.channel === 'L' || b.channel === 'R'));

// ---------- GraphicEQ (Peace's sliders, AutoEQ's GraphicEQ.txt) ----------
// Equalizer APO plays "GraphicEQ: f g; f g …" as a filter that follows the points exactly: straight
// lines between them on a log-frequency axis, the end values beyond them (helpers/GainIterator.cpp).
export function graphicGain(points, f) {
  if (!points?.length) return 0;
  if (f <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (f >= last[0]) return last[1];
  let i = 1;
  while (points[i][0] < f) i++;
  const [f0, g0] = points[i - 1], [f1, g1] = points[i];
  if (g0 === g1) return g0;
  return g0 + ((Math.log(f) - Math.log(f0)) / (Math.log(f1) - Math.log(f0))) * (g1 - g0);
}

/** Slider frequencies: 10 bands an octave apart, 15 at 2/3 octave, 31 at 1/3 octave (ISO). */
export const SLIDER_SETS = {
  10: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
  15: [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000],
  31: [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000],
};

/** The curve sampled at other frequencies (e.g. a 127-point AutoEQ curve on 31 sliders). */
export const resampleGraphic = (points, freqs) => freqs.map((f) => [f, Math.round(graphicGain(points, f) * 10) / 10]);
export const graphicActive = (eq) => !!eq?.graphic?.some((p) => Math.abs(p[1]) > 0.001);
/** True when the curve's points are exactly a slider set's frequencies. */
export const graphicOnSet = (points, set) => !!points?.length && points.length === set.length && points.every((p, i) => Math.abs(p[0] - set[i]) < 0.01);

/** "f g; f g" numbers as Equalizer APO reads them (a comma is a decimal mark only if no period is used). */
export function parseGraphic(text) {
  const value = String(text).includes('.') ? String(text) : String(text).replace(/,/g, '.');
  const nums = (value.match(/[-+0-9.eE]+/g) || []).map(Number);
  const pts = [];
  for (let i = 0; i + 1 < nums.length; i += 2) if (Number.isFinite(nums[i]) && Number.isFinite(nums[i + 1])) pts.push([nums[i], nums[i + 1]]);
  return pts.sort((a, b) => a[0] - b[0]);
}

/** Two GraphicEQ lines one after the other add up – as one curve on all their points. */
export function addGraphic(a, b) {
  if (!a?.length) return b;
  const fs = [...new Set([...a, ...b].map((p) => p[0]))].sort((x, y) => x - y);
  return fs.map((f) => [f, Math.round((graphicGain(a, f) + graphicGain(b, f)) * 100) / 100]);
}

/** dB response for one ear ('L' or 'R'); bands for both ears count for both. */
export function totalResponse(eq, freqs, ear = 'L') {
  const out = new Array(freqs.length).fill(eq.preamp || 0);
  if (eq.graphic?.length) for (let i = 0; i < out.length; i++) out[i] += graphicGain(eq.graphic, freqs[i]);
  for (const band of eq.bands) {
    if (!band.enabled || !onEar(band, ear)) continue;
    const r = bandResponse(band, freqs);
    for (let i = 0; i < out.length; i++) out[i] += r[i];
  }
  return out;
}

export function logFreqs(n = 256, lo = 20, hi = 20000) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(lo * Math.pow(hi / lo, i / (n - 1)));
  return out;
}

export function suggestedPreamp(eq) {
  const peak = Math.max(...totalResponse({ ...eq, preamp: 0 }, logFreqs(400)));
  return peak > 0 ? -Math.ceil(peak * 10) / 10 : 0;
}

const APO_EXPORT_TYPE = { HP: 'HPQ', LP: 'LPQ' };

// Equalizer APO's filter names (BiQuadFilterFactory.cpp). LS/HS become our LSC/HSC below.
const APO_TYPES = { PK: 'PK', PEQ: 'PK', MODAL: 'PK', LP: 'LP', LPQ: 'LP', HP: 'HP', HPQ: 'HP', BP: 'BP', LS: 'LS', HS: 'HS', LSC: 'LSC', HSC: 'HSC', NO: 'NO', AP: 'AP' };

// Commands GoXLR Studio doesn't import, and what they do (for the warning after an import).
const NOT_IMPORTED = {
  copy: 'blander kanalerne', delay: 'forsinkelse', convolution: 'impulssvar (convolution)', vstplugin: 'VST-plugin',
  include: 'henviser til en anden fil', stage: 'trin i lydmotoren', if: 'betingelse', elseif: 'betingelse', else: 'betingelse',
  endif: 'betingelse', eval: 'udregning', loudnesscorrection: 'Loudness Correction',
};

/** Fc as Equalizer APO reads it – including Room EQ Wizard's "1.000" = 1000 Hz. */
function apoFreq(text) {
  const s = text.replace(/ /g, '');
  let f = parseFloat(s);
  if (s.length >= 5 && !/[eE]/.test(s) && s[s.length - 4] === '.') f *= 1000;
  return f;
}

/** Q from "BW Oct n" exactly as the engine computes it (at 48 kHz). */
export function bwToQ(bw, freq, fs = SAMPLE_RATE) {
  const w = (2 * Math.PI * Math.min(freq, fs / 2 - 1)) / fs;
  return 1 / (2 * Math.sinh((Math.LN2 / 2) * bw * (w / Math.sin(w))));
}

/** Equalizer APO's shelf ("LS"/"HS" with corner frequency, "LSC"/"HSC" with centre frequency, Q or
 *  slope in dB) as the same filter written as our LSC/HSC with centre frequency and Q. */
export function apoShelf({ type, freq, gain, q = null, slope = null }) {
  const center = type === 'LSC' || type === 'HSC';
  const low = type === 'LS' || type === 'LSC';
  const A = Math.pow(10, gain / 40);
  let isS = true, val = 0.9, corner = false; // no Q and no slope: S 0.9 at the centre (APO's default)
  if (slope != null) { val = slope / 12; corner = !center; }
  else if (q != null) { isS = false; val = q; corner = !center; }
  let outQ = val, s = val;
  if (isS) {
    const r = (A + 1 / A) * (1 / val - 1) + 2;
    if (!(r > 0)) return null;
    outQ = 1 / Math.sqrt(r);
  } else {
    s = 1 / ((1 / (val * val) - 2) / (A + 1 / A) + 1);
  }
  let f = freq;
  if (corner) {
    const factor = Math.pow(10, Math.abs(gain) / 80 / s);
    f = low ? f * factor : f / factor;
  }
  return { type: low ? 'LSC' : 'HSC', freq: f, gain, q: outQ };
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Parses Equalizer APO / Peace / AutoEQ / Room EQ Wizard text the way Equalizer APO reads it.
 *  `ignored` lists the lines that are not imported, with the reason, so nothing disappears silently. */
export function parseApoConfigReport(text) {
  const eq = { enabled: true, preamp: 0, bands: [] };
  const ignored = [];
  const skip = (line, reason) => ignored.push({ line: line.length > 90 ? `${line.slice(0, 87)}…` : line, reason });
  let device = null, stopped = false;
  let ear = 'all'; // after "Channel: L" the filters are for the left ear only
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const cmd = line.match(/^([A-Za-z]+)\s*\d*\s*:\s*(.*)$/);
    if (!cmd) continue;
    const name = cmd[1].toLowerCase();
    let rest = cmd[2];
    if (name === 'device') {
      // Peace/APO configs can hold one section per device; only the first one is imported.
      if (device !== null && rest.trim() !== device && (eq.bands.length || eq.preamp)) {
        if (!stopped) skip(line, 'filen har EQ til flere enheder – kun den første blev importeret');
        stopped = true;
      }
      device ??= rest.trim();
      continue;
    }
    if (stopped) continue;
    if (name === 'channel') {
      const words = rest.toUpperCase().split(/\s+/).filter(Boolean);
      const set = new Set(words.map((w) => ({ 1: 'L', 2: 'R' })[w] || w));
      if (set.has('ALL') || (set.has('L') && set.has('R') && set.size === 2)) ear = 'all';
      else if (set.size === 1 && (set.has('L') || set.has('R'))) ear = [...set][0];
      else { ear = 'skip'; skip(line, 'filtre til andre kanaler end venstre/højre importeres ikke'); }
      continue;
    }
    if (ear === 'skip') continue;
    if (name === 'preamp' && ear !== 'all') { skip(line, 'Preamp for kun ét øre (fx balance) – brug Balance under Lytte-forbedringer'); continue; }
    if (name === 'preamp') {
      const pre = rest.replace(/,/g, '.').match(/^([-+0-9.eE]+)\s*dB/i);
      if (pre) eq.preamp = round(eq.preamp + Number(pre[1]), 2); else skip(line, 'kunne ikke læse værdien');
      continue;
    }
    if (name === 'graphiceq' && ear !== 'all') { skip(line, 'GraphicEQ for kun ét øre importeres ikke'); continue; }
    if (name === 'graphiceq') {
      // Kept as the exact curve (before 0.5.8 it was approximated with peaks – up to 9 dB off).
      const pts = parseGraphic(rest);
      if (pts.length) eq.graphic = addGraphic(eq.graphic, pts); else skip(line, 'kunne ikke læse værdien');
      continue;
    }
    if (name !== 'filter') {
      skip(line, NOT_IMPORTED[name] ? `${cmd[1]}: ${NOT_IMPORTED[name]}` : `${cmd[1]}: kendes ikke`);
      continue;
    }
    const p = rest.replace(/,/g, '.');
    const tm = p.match(/^\s*(ON|OFF)\s+([A-Za-z]+)/i);
    if (!tm) { skip(line, 'kunne ikke læse filteret'); continue; }
    if (/^none$/i.test(tm[2])) continue;
    const apoType = APO_TYPES[tm[2].toUpperCase()];
    if (!apoType) { skip(line, `filtertypen ${tm[2]} kendes ikke`); continue; }
    const after = p.slice(tm[0].length);
    const fc = after.match(/\s+Fc\s*([-+0-9.eE ]+)\s*(k?)H\s*z/i);
    if (!fc) { skip(line, 'mangler Fc (frekvens)'); continue; }
    const freq = apoFreq(fc[1]) * (fc[2] ? 1000 : 1);
    const gainM = after.match(/\s+Gain\s*([-+0-9.eE]+)\s*dB/i);
    const qM = after.match(/\s+Q\s*([-+0-9.eE]+)/i);
    const bwM = after.match(/\s+BW\s+Oct\s*([-+0-9.eE]+)/i);
    const slopeM = after.match(/^\s*([-+0-9.eE]+)\s*dB/i);
    const gain = gainM ? Number(gainM[1]) : 0;
    const shelf = apoType === 'LS' || apoType === 'HS' || apoType === 'LSC' || apoType === 'HSC';
    const hasGain = shelf || apoType === 'PK';
    if (hasGain && !gainM) { skip(line, 'mangler Gain'); continue; }
    let band;
    if (shelf) {
      const q = qM ? Number(qM[1]) : null;
      band = apoShelf({ type: apoType, freq, gain, q: q || null, slope: slopeM ? Number(slopeM[1]) : null });
      if (!band) { skip(line, 'hældningen er for stejl til den forstærkning'); continue; }
    } else {
      let q = qM ? Number(qM[1]) : 0;
      if (bwM) q = bwToQ(Number(bwM[1]), freq);
      if (!q) {
        if (apoType === 'PK' || apoType === 'AP') { skip(line, 'mangler Q eller båndbredde'); continue; }
        q = apoType === 'NO' ? 30 : Math.SQRT1_2;
      }
      band = { type: apoType, freq, gain: hasGain ? gain : 0, q };
    }
    eq.bands.push({ ...newBand(round(band.freq, 2), band.type), gain: round(band.gain, 2), q: round(band.q, 4), enabled: tm[1].toUpperCase() === 'ON', ...(ear !== 'all' ? { channel: ear } : {}) });
  }
  return { eq, ignored };
}

/** Parses Equalizer APO / AutoEQ "ParametricEQ.txt" text; see parseApoConfigReport for what is left out. */
export const parseApoConfig = (text) => parseApoConfigReport(text).eq;

/** One line for a toast: what an import left out. */
export function ignoredText(ignored, max = 3) {
  if (!ignored?.length) return '';
  const shown = ignored.slice(0, max).map((x) => `"${x.line}" (${x.reason})`).join(', ');
  return ignored.length > max ? `${shown} og ${ignored.length - max} mere` : shown;
}

export function toApoConfig(eq) {
  const fmt = (n, d = 2) => Number(n.toFixed(d)).toString();
  const lines = [`Preamp: ${fmt(eq.preamp, 1)} dB`];
  if (eq.graphic?.length) lines.push(`GraphicEQ: ${eq.graphic.map(([f, g]) => `${fmt(f)} ${fmt(g)}`).join('; ')}`);
  let i = 0;
  const filter = (b) => {
    let line = `Filter ${++i}: ${b.enabled ? 'ON' : 'OFF'} ${APO_EXPORT_TYPE[b.type] || b.type} Fc ${fmt(b.freq, 1)} Hz`;
    if (FILTER_TYPES[b.type].gain) line += ` Gain ${fmt(b.gain, 1)} dB`;
    line += ` Q ${fmt(b.q, 3)}`;
    lines.push(line);
  };
  const bands = expandBands(eq.bands);
  bands.filter((b) => !b.channel || b.channel === 'all').forEach(filter);
  // One ear only: Equalizer APO's "Channel:" applies the following filters to that channel.
  for (const ear of ['L', 'R']) {
    const own = bands.filter((b) => b.channel === ear);
    if (own.length) { lines.push(`Channel: ${ear}`); own.forEach(filter); }
  }
  if (bands.some((b) => b.channel === 'L' || b.channel === 'R')) lines.push('Channel: all');
  return lines.join('\n') + '\n';
}

export function formatFreq(f) {
  return f >= 1000 ? `${Number((f / 1000).toFixed(f >= 10000 ? 1 : 2))} kHz` : `${Math.round(f)} Hz`;
}

export const BUILTIN_PRESETS = {
  'Flad': { enabled: true, preamp: 0, bands: [] },
  'Bas-boost': { enabled: true, preamp: -4, bands: [{ type: 'LSC', freq: 105, gain: 4, q: 0.7 }] },
  'Tale / podcast': { enabled: true, preamp: -2, bands: [{ type: 'HP', freq: 80, gain: 0, q: 0.707 }, { type: 'PK', freq: 250, gain: -2, q: 1 }, { type: 'PK', freq: 3000, gain: 2, q: 1 }] },
  'Fodtrin (FPS)': { enabled: true, preamp: -4.4, bands: [{ type: 'LSC', freq: 120, gain: -4, q: 0.7 }, { type: 'PK', freq: 2500, gain: 4, q: 1.2 }, { type: 'PK', freq: 5000, gain: 2, q: 1.5 }] },
  'Mindre skarp': { enabled: true, preamp: 0, bands: [{ type: 'PK', freq: 6500, gain: -3, q: 2 }, { type: 'HSC', freq: 10000, gain: -2, q: 0.7 }] },
  'Film / serier': { enabled: true, preamp: -2.5, bands: [{ type: 'LSC', freq: 80, gain: 1.5, q: 0.7 }, { type: 'PK', freq: 2500, gain: 2.5, q: 1 }, { type: 'PK', freq: 6500, gain: -1, q: 2 }] },
  'Musik': { enabled: true, preamp: -3, bands: [{ type: 'LSC', freq: 90, gain: 2.5, q: 0.7 }, { type: 'PK', freq: 2500, gain: -1, q: 1 }, { type: 'HSC', freq: 9000, gain: 2, q: 0.7 }] },
  'Sen aften': { enabled: true, preamp: 0, bands: [{ type: 'LSC', freq: 120, gain: -4, q: 0.7 }, { type: 'PK', freq: 3000, gain: -2, q: 1.2 }] },
  // Spil-presets: starting points for game types (the preamp = the highest boost + 0,5 dB, Balance).
  'Spil: CS2 / Valorant': { enabled: true, preamp: -4, bands: [{ type: 'HP', freq: 40, gain: 0, q: 0.707 }, { type: 'LSC', freq: 150, gain: -5, q: 0.7 }, { type: 'PK', freq: 300, gain: -2, q: 1 }, { type: 'PK', freq: 2000, gain: 3, q: 1.2 }, { type: 'PK', freq: 4000, gain: 3.5, q: 1.4 }, { type: 'HSC', freq: 9000, gain: -2, q: 0.7 }] },
  'Spil: Warzone / Battlefield': { enabled: true, preamp: -3.5, bands: [{ type: 'LSC', freq: 100, gain: -4, q: 0.7 }, { type: 'PK', freq: 250, gain: -2, q: 1 }, { type: 'PK', freq: 2500, gain: 3, q: 1 }, { type: 'PK', freq: 5000, gain: 2, q: 1.5 }] },
  'Spil: Fortnite / Apex': { enabled: true, preamp: -3.5, bands: [{ type: 'PK', freq: 200, gain: -2, q: 1 }, { type: 'PK', freq: 1500, gain: 2, q: 1 }, { type: 'PK', freq: 3500, gain: 3, q: 1.3 }, { type: 'HSC', freq: 8000, gain: 1, q: 0.7 }] },
  'Spil: Racing / sport': { enabled: true, preamp: -3.5, bands: [{ type: 'LSC', freq: 80, gain: 3, q: 0.7 }, { type: 'PK', freq: 400, gain: -1.5, q: 1 }, { type: 'PK', freq: 2500, gain: 1.5, q: 1 }] },
  'Spil: RPG / eventyr': { enabled: true, preamp: -2.5, bands: [{ type: 'LSC', freq: 90, gain: 2, q: 0.7 }, { type: 'PK', freq: 2500, gain: 1, q: 1 }, { type: 'HSC', freq: 10000, gain: 1.5, q: 0.7 }] },
};

// What each built-in preset is for (shown when it is chosen).
export const PRESET_INFO = {
  'Flad': 'Ingen EQ – lyden som den er.',
  'Bas-boost': 'Mere bas til musik og spil. Preamp er sænket, så intet klipper.',
  'Tale / podcast': 'Klar tale: dybe brum skæres væk, lidt mindre mudder og lidt mere tydelighed.',
  'Fodtrin (FPS)': 'Til skydespil: mindre buldren fra eksplosioner og mere af fodtrin og genladning (2–5 kHz).',
  'Mindre skarp': 'Tager toppen af skarpe s-lyde og diskant, der gør ondt ved høj lydstyrke.',
  'Film / serier': 'Tydeligere dialog og lidt mere fylde i bunden – godt til film, serier og YouTube.',
  'Musik': 'En let "smil-kurve": lidt mere bas og luft i toppen, som de fleste kan lide til musik.',
  'Sen aften': 'Til lav lydstyrke, når andre sover: mindre bas, der går gennem væggene, og blødere top.',
  'Spil: CS2 / Valorant': 'Konkurrence-skydespil: buldren og granater skæres ned, fodtrin og genladning (2–4 kHz) frem, skarp top dæmpet.',
  'Spil: Warzone / Battlefield': 'Store slag med meget bas: eksplosioner tæmmes, så fodtrin og skud tæt på kan høres.',
  'Spil: Fortnite / Apex': 'Hurtige skydespil med lyse lyde: lidt mindre mudder, mere af fodtrin, skjolde og genladning.',
  'Spil: Racing / sport': 'Mere motor og stemning i bunden, lidt klarere kommentator.',
  'Spil: RPG / eventyr': 'Fylde og luft til musik og stemninger – til historie-spil, hvor du ikke jagter fodtrin.',
};

// "Det lyder forkert": a problem → one EQ move. Applied on top of the current EQ (fixMove).
export const SOUND_FIXES = [
  { id: 'boomy', label: 'For meget bas / buldrer', move: { type: 'LSC', freq: 120, gain: -3, q: 0.7 }, why: 'Sænker bassen under ca. 120 Hz.' },
  { id: 'thin', label: 'Tynd / mangler bas', move: { type: 'LSC', freq: 100, gain: 3, q: 0.7 }, why: 'Løfter bassen under ca. 100 Hz.' },
  { id: 'muddy', label: 'Mudret / uklar', move: { type: 'PK', freq: 300, gain: -3, q: 1 }, why: 'Fjerner lidt af området omkring 300 Hz, hvor lyd klumper sammen.' },
  { id: 'boxy', label: 'Hul / lyder som i en dåse', move: { type: 'PK', freq: 600, gain: -2.5, q: 1.2 }, why: 'Sænker "kasse-lyden" omkring 600 Hz.' },
  { id: 'nasal', label: 'Næset / tudet', move: { type: 'PK', freq: 1200, gain: -2, q: 1.4 }, why: 'Sænker området omkring 1,2 kHz.' },
  { id: 'harsh', label: 'Skarp / skinger / gør ondt', move: { type: 'PK', freq: 3200, gain: -3, q: 1.4 }, why: 'Sænker 3 kHz, hvor øret er mest følsomt.' },
  { id: 'sibilant', label: 'S-lyde hvæser', move: { type: 'PK', freq: 7000, gain: -3, q: 2 }, why: 'Et smalt dyk omkring 7 kHz, hvor s-lydene ligger.' },
  { id: 'dull', label: 'Mat / mangler luft', move: { type: 'HSC', freq: 10000, gain: 3, q: 0.7 }, why: 'Løfter toppen over 10 kHz.' },
  { id: 'dialog', label: 'Svært at høre stemmer', move: { type: 'PK', freq: 2500, gain: 3, q: 1 }, why: 'Løfter 2,5 kHz, hvor stemmer er tydelige.' },
  { id: 'footsteps', label: 'Svært at høre fodtrin', move: { type: 'PK', freq: 4000, gain: 3, q: 1.2 }, why: 'Løfter 3–5 kHz, hvor fodtrin og genladning ligger.' },
];

/** The EQ with one move from SOUND_FIXES: a band of the same type within a third of an octave is
 *  adjusted (gain added, limited to ±12 dB); otherwise a new band is added. */
export function fixMove(eq, move) {
  const out = { ...eq, bands: eq.bands.map((b) => ({ ...b })) };
  const near = out.bands.find((b) => b.enabled !== false && onEar(b, 'all') && b.type === move.type && Math.abs(Math.log2(b.freq / move.freq)) <= 1 / 3);
  if (near) near.gain = Math.max(-12, Math.min(12, Math.round(((near.gain || 0) + move.gain) * 10) / 10));
  else out.bands.push({ ...newBand(move.freq, move.type), gain: move.gain, q: move.q });
  return out;
}
