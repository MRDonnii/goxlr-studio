export const FILTER_TYPES = {
  PK: { label: 'Peak', gain: true, q: true },
  LSC: { label: 'Low shelf', gain: true, q: true },
  HSC: { label: 'High shelf', gain: true, q: true },
  HP: { label: 'Low cut', gain: false, q: true },
  LP: { label: 'High cut', gain: false, q: true },
  NO: { label: 'Notch', gain: false, q: true },
};

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
  const c = coefficients(band);
  return freqs.map((f) => magnitudeDb(c, f));
}

export function totalResponse(eq, freqs) {
  const out = new Array(freqs.length).fill(eq.preamp || 0);
  for (const band of eq.bands) {
    if (!band.enabled) continue;
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

const APO_TYPE_ALIASES = { PK: 'PK', PEQ: 'PK', LS: 'LSC', LSC: 'LSC', HS: 'HSC', HSC: 'HSC', HP: 'HP', HPQ: 'HP', LP: 'LP', LPQ: 'LP', NO: 'NO' };

const APO_EXPORT_TYPE = { HP: 'HPQ', LP: 'LPQ' };

// Parses the Equalizer APO / AutoEQ "ParametricEQ.txt" filter syntax.
export function parseApoConfig(text) {
  const eq = { enabled: true, preamp: 0, bands: [] };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const pre = line.match(/^Preamp:\s*(-?[\d.]+)\s*dB/i);
    if (pre) { eq.preamp += Number(pre[1]); continue; }
    const geq = line.match(/^GraphicEQ:\s*(.*)$/i);
    if (geq) { eq.bands.push(...graphicEqToBands(geq[1])); continue; }
    const m = line.match(/^Filter\s*\d*:\s*(ON|OFF)\s+(\w+)(.*)$/i);
    if (!m) continue;
    const type = APO_TYPE_ALIASES[m[2].toUpperCase()];
    if (!type) continue;
    const rest = m[3];
    const fc = rest.match(/Fc\s+(-?[\d.]+)\s*(k?)Hz/i);
    if (!fc) continue;
    const gain = rest.match(/Gain\s+(-?[\d.]+)\s*dB/i);
    const q = rest.match(/\bQ\s+([\d.]+)/i);
    const bw = rest.match(/BW\s+Oct\s+([\d.]+)/i);
    const band = newBand(Number(fc[1]) * (fc[2] ? 1000 : 1), type);
    band.enabled = m[1].toUpperCase() === 'ON';
    band.gain = gain ? Number(gain[1]) : 0;
    if (q) band.q = Number(q[1]);
    else if (bw) {
      const n = Number(bw[1]);
      band.q = Math.sqrt(Math.pow(2, n)) / (Math.pow(2, n) - 1);
    } else if (type === 'LSC' || type === 'HSC' || type === 'HP' || type === 'LP') band.q = 0.707;
    eq.bands.push(band);
  }
  return eq;
}

// GraphicEQ lists "freq gain" points; approximate each non-flat point with a peak sized to its neighbours.
function graphicEqToBands(spec) {
  const pts = spec.split(';').map((p) => p.trim().split(/\s+/).map(Number)).filter((p) => p.length >= 2 && p.every(Number.isFinite));
  const out = [];
  pts.forEach(([f, g], i) => {
    if (Math.abs(g) < 0.05 || f < 15 || f > 22000) return;
    const lo = pts[i - 1]?.[0] ?? f / 2;
    const hi = pts[i + 1]?.[0] ?? f * 2;
    const n = Math.max(Math.log2(hi / lo) / 2, 0.1);
    const band = newBand(f, 'PK');
    band.gain = g;
    band.q = Math.round((Math.sqrt(Math.pow(2, n)) / (Math.pow(2, n) - 1)) * 1000) / 1000;
    out.push(band);
  });
  return out;
}

export function toApoConfig(eq) {
  const fmt = (n, d = 2) => Number(n.toFixed(d)).toString();
  const lines = [`Preamp: ${fmt(eq.preamp, 1)} dB`];
  eq.bands.forEach((b, i) => {
    let line = `Filter ${i + 1}: ${b.enabled ? 'ON' : 'OFF'} ${APO_EXPORT_TYPE[b.type] || b.type} Fc ${fmt(b.freq, 1)} Hz`;
    if (FILTER_TYPES[b.type].gain) line += ` Gain ${fmt(b.gain, 1)} dB`;
    line += ` Q ${fmt(b.q, 3)}`;
    lines.push(line);
  });
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
  const near = out.bands.find((b) => b.enabled !== false && b.type === move.type && Math.abs(Math.log2(b.freq / move.freq)) <= 1 / 3);
  if (near) near.gain = Math.max(-12, Math.min(12, Math.round(((near.gain || 0) + move.gain) * 10) / 10));
  else out.bands.push({ ...newBand(move.freq, move.type), gain: move.gain, q: move.q });
  return out;
}
