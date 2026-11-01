// Høreværn: a reminder after a long time of loud listening in the headphones, and an optional
// ceiling for the GoXLR's headphone volume (e.g. for children). The GoXLR can't know how loud your
// headphones really are, so "loud" is the headphone volume you choose as the limit, counted only
// while sound is playing.
import { h, toggle, slider } from './ui.js';

export const HEARING_DEFAULTS = { reminder: true, threshold: 80, minutes: 60, cap: false, max: 85 };

/** One step of the loud-listening clock (seconds). Loud listening adds time; quiet or silence lets
 *  the ears recover twice as fast. Returns { loud, remind }. */
export function exposureStep(loud, { pct, playing, dt, threshold, minutes }) {
  const isLoud = playing && pct >= threshold;
  const next = isLoud ? loud + dt : Math.max(0, loud - dt * 2);
  if (isLoud && next >= minutes * 60) return { loud: 0, remind: true };
  return { loud: next, remind: false };
}

/** The headphone volume (0–255) to set when the ceiling is on and the volume is above it; null otherwise. */
export function capVolume(volume, { cap, max }) {
  if (!cap || !Number.isFinite(volume)) return null;
  const limit = Math.round((max / 100) * 255);
  return volume > limit ? limit : null;
}

export function startHearing(ctx) {
  let loud = 0;
  let last = performance.now();
  let lastCapNote = 0;
  const tick = () => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    const p = { ...HEARING_DEFAULTS, ...(ctx.prefs.hearing || {}) };
    ctx.wantLevels = p.reminder;
    const m = ctx.conn.mixer;
    const vol = m?.levels?.volumes?.Headphones;
    if (m && Number.isFinite(vol)) {
      const to = capVolume(vol, p);
      if (to != null) {
        ctx.conn.command('SetVolume', 'Headphones', to);
        if (now - lastCapNote > 30000) { lastCapNote = now; ctx.notify(`Høreværn: hovedtelefonerne er begrænset til ${p.max} %`, 'info'); }
      }
      if (p.reminder) {
        const playing = Object.values(ctx.levels || {}).some((x) => x > 0.02);
        const r = exposureStep(loud, { pct: (vol / 255) * 100, playing, dt, threshold: p.threshold, minutes: p.minutes });
        loud = r.loud;
        if (r.remind) ctx.notify(`Du har lyttet højt i ${p.minutes} minutter – giv ørerne en pause, eller skru lidt ned`, 'info');
      }
    }
    ctx.hearingLoud = loud;
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 3000);
}

export function hearingCard(ctx) {
  const { binder } = ctx;
  const p = () => (ctx.prefs.hearing = { ...HEARING_DEFAULTS, ...(ctx.prefs.hearing || {}) });
  const set = (k) => (v) => { p()[k] = v; ctx.savePrefs(); };
  const state = h('div', { class: 'hint', 'data-testid': 'hearing-state' });
  binder.add(() => { state.textContent = p().reminder ? `Lyttet højt lige nu: ${Math.round((ctx.hearingLoud || 0) / 60)} af ${p().minutes} min` : ''; });
  return h('div', { class: 'card' }, h('h2', {}, 'Høreværn'),
    toggle(binder, { label: 'Påmind mig efter lang tid med høj lyd', get: () => p().reminder, set: set('reminder') }),
    slider(binder, { label: 'Højt er over', min: 40, max: 100, get: () => p().threshold, set: set('threshold'), fmt: (v) => `${v} %` }),
    slider(binder, { label: 'Påmind efter', min: 15, max: 180, step: 15, get: () => p().minutes, set: set('minutes'), fmt: (v) => `${v} min` }),
    toggle(binder, { label: 'Loft for hovedtelefonerne', get: () => p().cap, set: set('cap') }),
    slider(binder, { label: 'Højst', min: 30, max: 100, get: () => p().max, set: set('max'), fmt: (v) => `${v} %` }),
    state,
    h('div', { class: 'hint' }, 'Procent er GoXLR’ens lydstyrke for hovedtelefonerne. Tiden tæller kun, mens der spiller lyd, og stille perioder trækker fra. Loftet skruer automatisk ned, hvis knappen drejes højere – fx til børn.'));
}
