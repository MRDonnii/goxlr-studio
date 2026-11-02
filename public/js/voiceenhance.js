// Stemme-forbedrer: one click for "more body" or "more clarity" in your voice, like BEACN's
// enhancer or RØDE's Big Bottom / Aural Exciter – made with the GoXLR's own mic EQ (in the
// hardware, so no CPU and no delay). Each one adds a few dB on the right bands of what you already
// have, and switching it off takes exactly that away again.
import { h } from './ui.js';
import { EQ_BANDS, MINI_EQ_BANDS } from './demo.js';

// [full GoXLR bands, Mini bands] → whole dB (so off takes exactly the same away)
export const ENHANCERS = [
  { id: 'body', label: 'Mere fylde', why: 'Varmere, dybere stemme (125–250 Hz).', full: { Equalizer125Hz: 2, Equalizer250Hz: 1 }, mini: { Equalizer90Hz: 1, Equalizer250Hz: 2 } },
  { id: 'clarity', label: 'Mere klarhed', why: 'Tydeligere ord og mere luft (4–8 kHz).', full: { Equalizer4KHz: 2, Equalizer8KHz: 1 }, mini: { Equalizer3KHz: 2, Equalizer8KHz: 1 } },
  { id: 'less-nasal', label: 'Mindre næset', why: 'Tager lidt af "tud"-lyden omkring 1 kHz.', full: { Equalizer1KHz: -2 }, mini: { Equalizer1KHz: -2 } },
  { id: 'less-mud', label: 'Mindre mudder', why: 'Renere, når rummet giver buldren (250–500 Hz).', full: { Equalizer250Hz: -1, Equalizer500Hz: -2 }, mini: { Equalizer250Hz: -1, Equalizer500Hz: -2 } },
];
const MAX = 9; // the GoXLR's mic EQ: −9 … +9 dB

/** The commands to switch one enhancer on (sign 1) or off (sign −1), from the current gains. */
export function enhanceCommands(gains, enh, mini, sign) {
  const deltas = mini ? enh.mini : enh.full;
  const cmd = mini ? 'SetEqMiniGain' : 'SetEqGain';
  const valid = mini ? MINI_EQ_BANDS : EQ_BANDS;
  return Object.entries(deltas).filter(([b]) => valid.includes(b)).map(([b, d]) => {
    const v = Math.round(Math.max(-MAX, Math.min(MAX, (Number(gains?.[b]) || 0) + sign * d))) + 0; // whole dB (the GoXLR's steps); +0 = no -0
    return [cmd, b, v];
  });
}

export function voiceEnhanceCard(ctx) {
  const { conn, binder } = ctx;
  ctx.prefs.voiceEnhance ??= {};
  const on = ctx.prefs.voiceEnhance;
  const mini = () => conn.mixer?.hardware?.device_type === 'Mini';
  const gains = () => (mini() ? conn.mixer?.mic_status?.equaliser_mini?.gain : conn.mixer?.mic_status?.equaliser?.gain);
  const row = h('div', { class: 'fx-toggle', 'data-testid': 'voice-enhance' });
  for (const e of ENHANCERS) {
    const b = h('button', { class: 'btn sm', title: e.why, 'data-testid': `voice-${e.id}`, onclick: async () => {
      const sign = on[e.id] ? -1 : 1;
      for (const c of enhanceCommands(gains(), e, mini(), sign)) await conn.command(...c);
      on[e.id] = sign > 0;
      ctx.savePrefs?.(); binder.run();
    } }, e.label);
    binder.add(() => b.classList.toggle('on', !!on[e.id]));
    row.append(b);
  }
  return h('div', { class: 'card' }, h('h2', {}, 'Stemme-forbedrer'), row,
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Ét klik lægger et par dB på de rigtige bånd i mikrofon-EQ’en – oven i det, du har. Klik igen, og præcis det tages af igen. Kører i GoXLR’en, så det koster hverken CPU eller forsinkelse. Gem mikrofonprofilen, hvis du vil beholde det.'));
}
