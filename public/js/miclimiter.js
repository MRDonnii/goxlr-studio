// Mikrofon-limiter: a shout or a laugh never clips or blows out the listeners' ears. Made with the
// GoXLR's own compressor (it runs in the hardware, before everything – stream, Discord, recording):
// 64:1, 0 ms attack, threshold near the top. Your own compressor settings are saved first and put
// back when the limiter is switched off. If the compressor is changed while the limiter is on (by
// hand, or a mic profile is loaded), the limiter steps aside and keeps the new settings.
import { h, toast } from './ui.js';
import { RATIOS, ATTACKS, RELEASES, enumIndex } from './micenums.js';

export const LIMITER_DEFAULTS = { enabled: false, threshold: -8, saved: null };
const RATIO = RATIOS.indexOf('Ratio64_0');
const ATTACK = ATTACKS.indexOf('Comp0ms');
const RELEASE = RELEASES.indexOf('Comp100ms');

export function limiterSettings(ctx) {
  return (ctx.prefs.micLimiter = { ...LIMITER_DEFAULTS, ...(ctx.prefs.micLimiter || {}) });
}

/** The compressor as the engine reports it → the values we save (times/ratio as list positions). */
export function compSnapshot(c) {
  return { threshold: c.threshold, ratio: enumIndex(RATIOS, c.ratio), attack: enumIndex(ATTACKS, c.attack), release: enumIndex(RELEASES, c.release), makeup_gain: c.makeup_gain };
}

/** Is the compressor set as the limiter? */
export function isLimited(c, threshold) {
  return !!c && c.threshold === threshold && enumIndex(RATIOS, c.ratio) === RATIO && enumIndex(ATTACKS, c.attack) === ATTACK;
}

/** Commands for the limiter. The make-up gain stays as it was, so normal speech is as loud as before. */
export function limiterCommands(threshold) {
  return [['SetCompressorThreshold', threshold], ['SetCompressorRatio', RATIO], ['SetCompressorAttack', ATTACK], ['SetCompressorReleaseTime', RELEASE]];
}

export function restoreCommands(saved) {
  if (!saved) return [];
  return [['SetCompressorThreshold', saved.threshold], ['SetCompressorRatio', saved.ratio], ['SetCompressorAttack', saved.attack],
    ['SetCompressorReleaseTime', saved.release], ['SetCompressorMakeupGain', saved.makeup_gain]].filter((c) => c[1] != null);
}

let applyingUntil = 0;
const comp = (ctx) => ctx.conn.mixer?.mic_status?.compressor;

export async function setLimiter(ctx, on) {
  const s = limiterSettings(ctx);
  const c = comp(ctx);
  if (!c) { toast('GoXLR’en er ikke forbundet', 'info'); return; }
  applyingUntil = Date.now() + 3000;
  if (on) {
    if (!isLimited(c, s.threshold)) s.saved = compSnapshot(c);
    s.enabled = true;
    ctx.savePrefs?.();
    for (const cmd of limiterCommands(s.threshold)) await ctx.conn.command(...cmd);
  } else {
    s.enabled = false;
    const back = s.saved;
    s.saved = null;
    ctx.savePrefs?.();
    for (const cmd of restoreCommands(back)) await ctx.conn.command(...cmd);
  }
  ctx.notify?.(on ? `Mikrofon-limiter til (${s.threshold} dB)` : 'Mikrofon-limiter fra – din kompressor er tilbage', on ? 'ok' : 'info');
}

export async function setLimiterThreshold(ctx, v) {
  const s = limiterSettings(ctx);
  s.threshold = v;
  ctx.savePrefs?.();
  if (s.enabled) { applyingUntil = Date.now() + 3000; await ctx.conn.command('SetCompressorThreshold', v); }
}

/** Watches the compressor: changed by something else while on → the limiter steps aside. */
export function startMicLimiter(ctx) {
  setInterval(() => {
    const s = limiterSettings(ctx);
    const c = comp(ctx);
    if (!s.enabled || !c || Date.now() < applyingUntil) return;
    if (!isLimited(c, s.threshold)) {
      s.enabled = false;
      s.saved = null;
      ctx.savePrefs?.();
      ctx.notify?.('Mikrofon-limiter er slået fra, fordi kompressoren blev ændret (fx en anden mikrofonprofil)', 'info');
      ctx.binder?.run();
    }
  }, 1000);
}

/** The switch and threshold, for the Kompressor card on the Mic page. */
export function limiterBox(ctx, binder) {
  const s = () => limiterSettings(ctx);
  const sw = h('input', { type: 'checkbox', 'data-testid': 'mic-limiter' });
  sw.addEventListener('change', () => setLimiter(ctx, sw.checked));
  const range = h('input', { type: 'range', min: -20, max: -1, step: 1, 'data-testid': 'mic-limiter-threshold', 'aria-label': 'Limiterens loft' });
  const val = h('span', { class: 'val' });
  range.addEventListener('input', () => { val.textContent = `${range.value} dB`; });
  range.addEventListener('change', () => setLimiterThreshold(ctx, Number(range.value)));
  binder.add(() => {
    sw.checked = s().enabled;
    if (document.activeElement !== range) { range.value = s().threshold; val.textContent = `${s().threshold} dB`; }
  });
  return h('div', { class: 'limiter-box' },
    h('div', { class: 'row' }, h('label', {}, 'Limiter (beskyt mod råb)'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, sw, h('span'))),
    h('div', { class: 'row' }, h('label', {}, 'Loft'), range, val),
    h('div', { class: 'hint' }, 'Bruger GoXLR’ens kompressor som limiter (64:1, 0 ms), så råb og grin ikke klipper – hverken på stream, i Discord eller i optagelser. Dine kompressor-indstillinger gemmes og kommer tilbage, når den slås fra. Gemmer du mikrofonprofilen imens, gemmes limiteren med.'));
}
