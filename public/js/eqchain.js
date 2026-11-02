// The whole playback chain as the engine plays it – your EQ plus Loudness and Crossfeed – for the
// headroom display, "Klip-beskyttelse", the "Auto" preamp and the loudness-matched A/B.
// Pure functions, tested in tests/eqchain.test.mjs.
import { coefficients, magnitudeDb, logFreqs, totalResponse, usesEars } from './eq.js';
import { enginePayload } from './extras.js';

export const CHAIN_FREQS = logFreqs(240);

export const fmtDb = (v) => (Math.round(Math.abs(v) * 10) / 10).toFixed(1).replace('.', ',');

/** Crossfeed's effect on a centred (mono) sound – the loudest case: the sound plus its low-passed
 *  copy from the other side, times the compensation in crossfeedLines. Never above 0 dB. */
export function crossfeedDb(cf, f) {
  const g = Math.pow(10, (cf.level ?? -8) / 20);
  const lp = Math.pow(10, magnitudeDb(coefficients({ type: 'LP', freq: cf.cutoff ?? 700, gain: 0, q: Math.SQRT1_2 }), f) / 20);
  return 20 * Math.log10((1 + g * lp) / (1 + g));
}

/** dB response of everything the engine plays for this slot. A switched-off EQ plays flat (0 dB). */
export function chainResponse(eq, extras = {}, freqs = CHAIN_FREQS, offset = 0, ear = 'L') {
  if (!eq?.enabled) return freqs.map(() => 0);
  const r = totalResponse(enginePayload(eq, extras || {}, null, offset), freqs, ear);
  const cf = extras?.crossfeed;
  if (cf?.enabled && !extras?.surround?.enabled) for (let i = 0; i < freqs.length; i++) r[i] += crossfeedDb(cf, freqs[i]);
  return r;
}

/** The loudest point of the chain – of either ear when left and right differ. */
export const chainPeak = (eq, extras, freqs = CHAIN_FREQS) => Math.max(...chainResponse(eq, extras, freqs),
  ...(usesEars(eq) ? chainResponse(eq, extras, freqs, 0, 'R') : []));

/** How loud the chain sounds (dB, see loudnessDb) – the average of the two ears when they differ. */
export function chainLoudness(eq, extras, offset = 0) {
  const l = loudnessDb(chainResponse(eq, extras, CHAIN_FREQS, offset));
  return usesEars(eq) ? (l + loudnessDb(chainResponse(eq, extras, CHAIN_FREQS, offset, 'R'))) / 2 : l;
}

// A boosted signal can peak a little higher between the samples than the curve shows, so a chain
// that boosts is taken down to −0,5 dB, not 0 dB.
export const SAFETY_MARGIN = 0.5;

/** "Klip-beskyttelse": how much the engine lowers the preamp when the chain would go above 0 dB –
 *  down to −0,5 dB (0 when it doesn't need to). The stored preset is left as it is. */
export function clipGuard(eq, extras, margin = SAFETY_MARGIN) {
  if (!eq?.enabled) return 0;
  const peak = chainPeak(eq, extras);
  return peak > 0.05 ? -Math.ceil((peak + margin) * 10) / 10 : 0;
}

// ---------- Balance: hæv aldrig uden at sænke gulvet ----------
// A boost only adds level; real balance is that the rest goes down as much as the highest boost
// goes up. The preamp is the "floor": it follows the EQ's highest boost (both ears, GraphicEQ
// included; Loudness/Crossfeed are left to the clip guard). Lowering a boost raises the floor again.

/** How far the floor must go down for this EQ: its highest boost plus the margin (0 when it only cuts). */
export function floorComp(eq) {
  const boost = chainPeak({ ...eq, preamp: 0, enabled: true }, {});
  return boost > 0.05 ? Math.ceil((boost + SAFETY_MARGIN) * 10 - 1e-6) / 10 : 0;
}

/** Your own floor on top of the balance (≤ 0): what is left of the preamp after the compensation. */
export const floorBase = (eq) => Math.min(0, Math.round(((eq.preamp || 0) + floorComp(eq)) * 10) / 10);

/** The preamp that keeps the EQ in balance: your own floor minus the highest boost. */
export const balancedPreamp = (eq, base = 0) => Math.round((Math.min(0, base) - floorComp(eq)) * 10) / 10 || 0;

/** "Auto": the preamp that puts the loudest point of the whole chain at −0,5 dB – or 0 dB preamp
 *  when nothing is boosted. Never above 0 dB. */
export function safePreamp(eq, extras, margin = SAFETY_MARGIN) {
  const boost = chainPeak({ ...eq, preamp: 0, enabled: true }, extras);
  if (boost <= 0.05) return 0;
  const peak = chainPeak({ ...eq, enabled: true }, extras);
  return Math.min(0, Math.floor(((eq.preamp || 0) - peak - margin) * 10 + 1e-6) / 10) || 0;
}

/** For the toolbar badge: headroom, or what the clip guard does, or a warning when it is off. */
export function headroomInfo(eq, extras, guardOn = true) {
  if (!eq?.enabled) return { kind: 'off', text: 'EQ fra – lyden spiller uændret' };
  const peak = chainPeak(eq, extras);
  if (peak <= 0.05) return { kind: 'ok', peak, guard: 0, text: `Headroom ${fmtDb(Math.min(0, peak))} dB` };
  if (guardOn) {
    const guard = clipGuard(eq, extras);
    return { kind: 'guard', peak, guard, text: `Klip-beskyttelse −${fmtDb(guard)} dB` };
  }
  return { kind: 'clip', peak, guard: 0, text: `Kan klippe +${fmtDb(peak)} dB` };
}

/** Warnings for one band: big boosts distort and tire the ears; very narrow boosts "ring". */
export function bandWarnings(b) {
  if (!b || b.enabled === false) return [];
  const out = [];
  const hasGain = b.type === 'PK' || b.type === 'LSC' || b.type === 'HSC';
  if (hasGain && b.gain > 6) out.push(`Løft på +${fmtDb(b.gain)} dB: mere end +6 dB kan give forvrængning og trætte ørerne. Skær hellere lidt ned andre steder.`);
  if (b.type === 'PK' && b.gain > 2 && b.q > 5) out.push(`Meget smalt løft (Q ${String(Math.round(b.q * 10) / 10).replace('.', ',')}) kan "ringe". Smalle bånd bruges mest til at skære én bestemt tone væk.`);
  return out;
}

// K-weighting from ITU-R BS.1770 (the loudness standard behind LUFS): roughly a high-pass at 38 Hz
// and +4 dB above 1,7 kHz – how loud the ear finds each part of the spectrum.
const K_FILTERS = [coefficients({ type: 'HP', freq: 38, gain: 0, q: 0.5 }), coefficients({ type: 'HSC', freq: 1681, gain: 4, q: 0.71 })];
const kWeight = (f) => Math.pow(10, K_FILTERS.reduce((s, k) => s + magnitudeDb(k, f), 0) / 10);
const K_CHAIN = CHAIN_FREQS.map(kWeight);

/** How loud a chain sounds, in dB (0 = as without EQ): pink noise through it, K-weighted. */
export function loudnessDb(resp, freqs = CHAIN_FREQS) {
  const w = freqs === CHAIN_FREQS ? K_CHAIN : freqs.map(kWeight);
  let num = 0, den = 0;
  for (let i = 0; i < freqs.length; i++) { num += w[i] * Math.pow(10, resp[i] / 10); den += w[i]; }
  return 10 * Math.log10(num / den);
}

/** Loudness-matched A/B: how much louder B is than A (dB), and the preamp offsets that lower the
 *  louder slot to the quieter one – never the other way, that could clip. Both slots must have
 *  the EQ on (a switched-off EQ has no preamp to lower). */
export function abMatch(state) {
  const extras = state.extras || {};
  const guard = state.clipGuard !== false;
  const { A, B } = state.slots || {};
  if (!A || !B) return { diff: 0, match: { A: 0, B: 0 }, unmatched: true };
  const level = (eq) => {
    const g = guard ? clipGuard(eq, extras) : 0;
    return chainLoudness(eq, extras, g);
  };
  const diff = Math.round((level(B) - level(A)) * 10) / 10 || 0;
  const unmatched = !A.enabled || !B.enabled;
  return { diff, unmatched, match: unmatched ? { A: 0, B: 0 } : { A: Math.min(0, diff), B: Math.min(0, -diff) } };
}

/** The line next to the A/B buttons. */
export function abText(m, matchOn = true) {
  const d = Math.abs(m.diff);
  if (d < 0.1) return 'A og B spiller lige højt';
  const louder = m.diff > 0 ? 'B' : 'A';
  if (matchOn && m.unmatched) return `${louder} er ${fmtDb(d)} dB højere – kan kun udlignes, når EQ er slået til i både A og B`;
  return matchOn ? `${louder} er ${fmtDb(d)} dB højere – udlignet` : `${louder} er ${fmtDb(d)} dB højere (den højeste lyder tit bedst)`;
}

/** The preamp offset the engine adds for the active slot (see app.js applyOutputEq): the clip
 *  guard, and the loudness match when "Udlign lydstyrke" is on. */
export function playbackOffset(state) {
  const eq = state?.slots?.[state.active];
  if (!eq) return 0;
  let off = state.clipGuard !== false ? clipGuard(eq, state.extras) : 0;
  if (state.abMatch !== false) off += abMatch(state).match[state.active] || 0;
  return Math.round(off * 10) / 10 || 0;
}

/** Blind test result: picks are the real slots ('A'/'B') chosen in each round. */
export function blindVerdict(picks) {
  const n = picks.length;
  const a = picks.filter((p) => p === 'A').length;
  const b = n - a;
  if (!n) return { n, a, b, winner: null, clear: false, text: 'Ingen runder.' };
  const winner = a === b ? null : a > b ? 'A' : 'B';
  const top = Math.max(a, b);
  const clear = !!winner && top / n >= 0.8;
  const text = !winner ? `Du valgte A og B lige mange gange – ingen tydelig forskel.`
    : top === n ? `Du valgte ${winner} hver gang – ${winner} lyder klart bedst for dig.`
      : clear ? `Du valgte ${winner} ${top} af ${n} gange – ${winner} lyder bedst for dig.`
        : `Du valgte ${winner} ${top} af ${n} gange – ingen tydelig forskel. Vælg den, du bedst kan lide, eller tag testen igen.`;
  return { n, a, b, winner, clear, text };
}

/** True when the two slots would sound the same (nothing to compare). */
export function slotsEqual(a, b) {
  const key = (eq) => JSON.stringify([!!eq?.enabled, +(eq?.preamp || 0), (eq?.bands || []).filter((x) => x.enabled !== false).map((x) => [x.type, +x.freq, +(x.gain || 0), +x.q, +(x.slope || 12), x.channel || 'all']), eq?.graphic || []]);
  return key(a) === key(b);
}
