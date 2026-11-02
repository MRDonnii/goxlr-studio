// Lige lydniveau: the game, the music and the chat often come in at very different levels, so the
// music drowns the footsteps. Measure each GoXLR channel while things play, then lower the louder
// ones in the EQ engine (a preamp per channel) – never raise anything (the balance principle: lower
// the floor instead of adding gain). The GoXLR's faders stay yours; this evens out what comes in.
// Stored in the output-eq state: levelMatch = { enabled, channels: ['Game', 'Music'], offsets: { Music: -6 } }.
import { h, toast } from './ui.js';
import { channelEndpoint } from './extras.js';
import { listAudioDevices } from './native.js';

export const LEVEL_CHANNELS = ['Game', 'Music', 'Chat', 'System'];
export const MEASURE_SECONDS = 30;
const ACTIVE_DB = -50; // quieter than this = not playing
const MIN_SECONDS = 5; // a channel needs this much sound to count
export const MAX_CUT = 12;

export function levelSettings(state) {
  const s = (state.levelMatch ??= {});
  s.enabled ??= false;
  s.channels ??= ['Game', 'Music'];
  s.offsets ??= {};
  return s;
}

/** The per-channel cuts in effect now ({} when switched off or while measuring). */
export function levelOffsets(state) {
  const s = state?.levelMatch;
  if (!s?.enabled || s.measuring) return {};
  return Object.fromEntries(Object.entries(s.offsets || {}).filter(([ch, v]) => LEVEL_CHANNELS.includes(ch) && Number(v) < 0).map(([ch, v]) => [ch, Math.max(-MAX_CUT, Number(v))]));
}

/** A running measurement: add(channel, peak 0–1, seconds) while playing; result() → { ch: { db, secs } }.
 *  The level is the power average of the peaks while the channel plays (silence doesn't count). */
export function createLevelMeter() {
  const acc = {};
  return {
    add(ch, peak, dt) {
      if (!(peak > 0)) return;
      const db = 20 * Math.log10(peak);
      if (db < ACTIVE_DB) return;
      const a = (acc[ch] ??= { power: 0, secs: 0 });
      a.power += peak * peak * dt;
      a.secs += dt;
    },
    result() {
      return Object.fromEntries(Object.entries(acc).map(([ch, a]) => [ch, { db: Math.round(10 * Math.log10(a.power / a.secs) * 10) / 10, secs: Math.round(a.secs * 10) / 10 }]));
    },
  };
}

/** The cuts that bring the chosen channels down to the quietest of them (0,5 dB steps; under 1 dB
 *  is left alone; at most MAX_CUT). Channels with too little sound are not touched (missing). */
export function levelCuts(measured, channels) {
  const ok = channels.filter((ch) => measured[ch] && measured[ch].secs >= MIN_SECONDS);
  if (ok.length < 2) return { offsets: {}, measuredChannels: ok, target: null };
  const target = Math.min(...ok.map((ch) => measured[ch].db));
  const offsets = {};
  for (const ch of ok) {
    const cut = Math.min(MAX_CUT, measured[ch].db - target);
    if (cut >= 1) offsets[ch] = -Math.round(cut * 2) / 2;
  }
  return { offsets, measuredChannels: ok, target };
}

const fmt = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${String(Math.abs(v)).replace('.', ',')} dB`;

/** The card on the EQ page. opts: { state, save(), apply(), label(ch) } */
export function levelMatchCard(ctx, opts) {
  const s = levelSettings(opts.state);
  const body = h('div', { 'data-testid': 'level-match' });
  let running = null;
  const stop = () => { if (running) { clearInterval(running.timer); running = null; } ctx.levelMeasuring = false; };
  ctx.cleanup?.push(() => { if (running) { s.measuring = false; stop(); opts.apply(); } });

  const enabledBox = () => {
    const i = h('input', { type: 'checkbox', 'data-testid': 'level-enabled', checked: s.enabled, onchange: () => { s.enabled = i.checked; opts.save(); opts.apply(); render(); } });
    return h('div', { class: 'row' }, h('label', {}, 'Udlign niveauet mellem kanalerne'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, i, h('span')));
  };
  const channelBoxes = () => h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '12px' } },
    h('span', { class: 'hint' }, 'Udlign:'),
    LEVEL_CHANNELS.map((ch) => {
      const i = h('input', { type: 'checkbox', 'data-testid': `level-ch-${ch}`, checked: s.channels.includes(ch), onchange: () => {
        s.channels = i.checked ? [...new Set([...s.channels, ch])] : s.channels.filter((c) => c !== ch);
        if (!i.checked && s.offsets[ch]) { delete s.offsets[ch]; opts.apply(); }
        opts.save(); render();
      } });
      return h('label', { class: 'check-inline' }, i, h('span', {}, opts.label(ch)));
    }));
  const current = () => {
    const rows = LEVEL_CHANNELS.filter((ch) => s.channels.includes(ch)).map((ch) => h('div', { class: 'row level-row' },
      h('span', { class: 'lbl' }, opts.label(ch)),
      h('span', { class: `badge ${s.offsets[ch] ? 'warn' : 'ok'}`, 'data-testid': `level-offset-${ch}` }, s.offsets[ch] ? `sænkes ${fmt(s.offsets[ch])}` : 'uændret')));
    return h('div', {}, rows);
  };

  const measure = async () => {
    const devs = await listAudioDevices().catch(() => []);
    const ids = Object.fromEntries(s.channels.map((ch) => [ch, channelEndpoint(ch, devs)]).filter(([, id]) => id));
    if (Object.keys(ids).length < 2) { toast('Fandt ikke GoXLR’ens udgange for de valgte kanaler', 'info'); return; }
    s.measuring = true;
    await opts.apply();
    const meter = createLevelMeter();
    const bars = Object.fromEntries(Object.keys(ids).map((ch) => [ch, h('div', { class: 'level-fill' })]));
    const vals = Object.fromEntries(Object.keys(ids).map((ch) => [ch, h('span', { class: 'hint' }, '–')]));
    const progress = h('div', { class: 'hint', 'data-testid': 'level-progress' });
    body.replaceChildren(
      h('div', { class: 'hint' }, 'Spil det, du plejer at have kørende samtidig – fx spillet og musikken. Udligningen er slået fra, mens der måles.'),
      ...Object.keys(ids).map((ch) => h('div', { class: 'row level-row' }, h('span', { class: 'lbl' }, opts.label(ch)), h('div', { class: 'level-bar' }, bars[ch]), vals[ch])),
      progress,
      h('div', { class: 'row' }, h('button', { class: 'btn sm', 'data-testid': 'level-cancel', onclick: () => { stop(); s.measuring = false; opts.apply(); render(); } }, 'Afbryd')));
    ctx.levelMeasuring = true;
    const t0 = performance.now();
    let last = t0;
    running = { timer: setInterval(() => {
      const now = performance.now();
      const dt = (now - last) / 1000;
      last = now;
      for (const [ch, id] of Object.entries(ids)) {
        const p = ctx.levels?.[id] || 0;
        meter.add(ch, p, dt);
        bars[ch].style.width = `${Math.max(0, Math.min(100, (20 * Math.log10(p || 1e-6) + 60) / 60 * 100))}%`;
        const r = meter.result()[ch];
        vals[ch].textContent = r ? `${fmt(r.db)} · ${Math.round(r.secs)} s` : 'stille';
      }
      const left = Math.max(0, Math.ceil(MEASURE_SECONDS - (now - t0) / 1000));
      progress.textContent = `Måler… ${left} s tilbage`;
      if (left <= 0) finish(meter.result());
    }, 100) };
  };
  const finish = async (measured) => {
    stop();
    s.measuring = false;
    const { offsets, measuredChannels } = levelCuts(measured, s.channels);
    if (measuredChannels.length < 2) {
      toast('Der skal spille noget på mindst to af kanalerne i mindst 5 sekunder', 'info');
      await opts.apply();
      render();
      return;
    }
    // Channels that were measured get their new cut; the others keep theirs.
    for (const ch of measuredChannels) { if (offsets[ch]) s.offsets[ch] = offsets[ch]; else delete s.offsets[ch]; }
    s.enabled = true;
    s.measured = { at: Date.now(), levels: measured };
    opts.save();
    await opts.apply();
    const what = Object.entries(offsets).map(([ch, v]) => `${opts.label(ch)} ${fmt(v)}`).join(', ');
    toast(what ? `Udlignet: ${what}` : 'Kanalerne er allerede lige høje', 'info');
    render();
  };

  const render = () => {
    body.replaceChildren(
      enabledBox(),
      channelBoxes(),
      current(),
      h('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn sm primary', 'data-testid': 'level-measure', onclick: measure }, `Mål og udlign (${MEASURE_SECONDS} s)`),
        Object.keys(s.offsets).length ? h('button', { class: 'btn sm', 'data-testid': 'level-reset', onclick: () => { s.offsets = {}; opts.save(); opts.apply(); render(); } }, 'Nulstil') : null),
      opts.eqOff() ? h('div', { class: 'hint warn-text' }, 'EQ’en er slået fra – udligningen virker kun, når EQ’en er til.') : '',
      h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Kun de højeste sænkes – intet hæves. Det sker i EQ-motoren på GoXLR’ens udgange, så dine faders betyder det samme som før, bare fra et lige udgangspunkt.'));
  };
  render();
  return h('div', { class: 'card' }, h('h2', {}, 'Lige lydniveau'), body);
}
