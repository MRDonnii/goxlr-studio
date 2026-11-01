// The whole playback chain as the engine plays it – your EQ plus Loudness and Crossfeed – for the
// headroom display, "Klip-beskyttelse", the "Auto" preamp and the loudness-matched A/B.
// Pure functions, tested in tests/eqchain.test.mjs.
import { coefficients, magnitudeDb, logFreqs, totalResponse } from './eq.js';
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
export function chainResponse(eq, extras = {}, freqs = CHAIN_FREQS, offset = 0) {
  if (!eq?.enabled) return freqs.map(() => 0);
  const r = totalResponse(enginePayload(eq, extras || {}, null, offset), freqs);
  const cf = extras?.crossfeed;
  if (cf?.enabled) for (let i = 0; i < freqs.length; i++) r[i] += crossfeedDb(cf, freqs[i]);
  return r;
}

export const chainPeak = (eq, extras, freqs = CHAIN_FREQS) => Math.max(...chainResponse(eq, extras, freqs));

/** "Klip-beskyttelse": how much the engine lowers the preamp, so the chain never goes above 0 dB
 *  (0 when it doesn't need to). The stored preset is left as it is. */
export function clipGuard(eq, extras) {
  if (!eq?.enabled) return 0;
  const peak = chainPeak(eq, extras);
  return peak > 0.05 ? -Math.ceil(peak * 10) / 10 : 0;
}

/** "Auto": the preamp that puts the loudest point of the whole chain at 0 dB – never above 0 dB. */
export function safePreamp(eq, extras) {
  const peak = chainPeak({ ...eq, enabled: true }, extras);
  return Math.min(0, Math.floor(((eq.preamp || 0) - peak) * 10 + 1e-6) / 10) || 0;
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

/** The preamp offset the engine adds for the active slot (see app.js applyOutputEq). */
export function playbackOffset(state) {
  const eq = state?.slots?.[state.active];
  if (!eq) return 0;
  return state.clipGuard !== false ? clipGuard(eq, state.extras) : 0;
}
