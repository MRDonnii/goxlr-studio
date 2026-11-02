// Lydklip: "save the last 30 seconds" – like a replay buffer, for sound. While switched on, the
// last N seconds of the stream mix (GoXLR's "Broadcast Stream Mix": you, the game, the chat …)
// are kept in memory only; "Gem klip" (button, hotkey, Stream Deck, pedal) writes them to a WAV in
// Music\GoXLR Studio. Off until switched on.
import { h, toast } from './ui.js';
import { listAudioDevices, clipsStart, clipsStop, clipsStatus, clipsSave, clipsOpenDir, isNative } from './native.js';
import { shortName } from './views-mixer.js';

export function clipSettings(ctx) {
  const c = (ctx.prefs.clips ??= {});
  c.enabled ??= false;
  c.device ??= ''; // '' = the GoXLR's stream mix, found by name
  c.seconds ??= 30;
  return c;
}

/** The device to record: the chosen one, else the GoXLR's Broadcast Stream Mix, else the default mic. */
export function pickClipDevice(devs, chosen) {
  if (chosen && devs.some((d) => d.id === chosen)) return chosen;
  return devs.find((d) => d.flow === 'capture' && /broadcast stream mix/i.test(d.name))?.id || '';
}

export async function applyClips(ctx) {
  const c = clipSettings(ctx);
  if (!c.enabled) { await clipsStop().catch(() => {}); return; }
  const devs = await listAudioDevices().catch(() => []);
  await clipsStart(pickClipDevice(devs, c.device), c.seconds).catch((e) => toast(`Lydklip: ${e}`));
}

export async function saveClip(ctx) {
  const c = clipSettings(ctx);
  if (!c.enabled) { ctx.notify?.('Lydklip er slået fra (Lydbank-siden)', 'info'); return; }
  try {
    const path = await clipsSave(c.seconds);
    ctx.notify?.(`Klip gemt: ${path.split(/[\\/]/).pop()}`, 'ok');
  } catch (e) { ctx.notify?.(`Lydklip: ${e.message || e}`, 'mute'); }
}

export function startClips(ctx) {
  if (clipSettings(ctx).enabled) setTimeout(() => applyClips(ctx), 4000);
}

export function clipsCard(ctx) {
  const c = clipSettings(ctx);
  const state = h('div', { class: 'hint', 'data-testid': 'clips-state' });
  const sel = h('select', { 'data-testid': 'clips-device', onchange: () => { c.device = sel.value; ctx.savePrefs?.(); applyClips(ctx); } });
  const secs = h('select', { 'data-testid': 'clips-seconds', onchange: () => { c.seconds = Number(secs.value); ctx.savePrefs?.(); applyClips(ctx); } },
    [15, 30, 60, 120].map((s) => h('option', { value: s, selected: c.seconds === s }, `${s} sekunder`)));
  const sw = h('input', { type: 'checkbox', 'data-testid': 'clips-on', checked: c.enabled, onchange: () => { c.enabled = sw.checked; ctx.savePrefs?.(); applyClips(ctx).then(tick); } });
  listAudioDevices().then((devs) => {
    sel.replaceChildren(
      h('option', { value: '' }, 'Automatisk: GoXLR’ens stream-mix'),
      h('optgroup', { label: 'Optage-enheder' }, devs.filter((d) => d.flow === 'capture').map((d) => h('option', { value: d.id, selected: c.device === d.id }, shortName(d.name)))),
      h('optgroup', { label: 'Udgange (det, Windows spiller)' }, devs.filter((d) => d.flow === 'render').map((d) => h('option', { value: d.id, selected: c.device === d.id }, shortName(d.name)))));
  }).catch(() => {});
  const tick = async () => {
    if (!document.body.contains(state)) return;
    const s = await clipsStatus().catch(() => null);
    state.textContent = !c.enabled ? 'Slået fra – intet optages.' : s?.error ? `Fejl: ${s.error}` : s?.running ? `Klar: ${Math.floor(s.buffered)} af ${s.seconds} sekunder i hukommelsen` : 'Starter…';
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 300);
  return h('div', { class: 'card', 'data-testid': 'clips-card' }, h('h2', {}, 'Lydklip'),
    h('div', { class: 'row' }, h('label', {}, 'Hold de sidste sekunder klar'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, sw, h('span'))),
    h('div', { class: 'row' }, h('label', {}, 'Optag fra'), sel),
    h('div', { class: 'row' }, h('label', {}, 'Længde'), secs),
    h('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap' } },
      h('button', { class: 'btn sm primary', 'data-testid': 'clips-save', onclick: () => saveClip(ctx) }, 'Gem klip nu'),
      isNative() ? h('button', { class: 'btn sm', onclick: () => clipsOpenDir().catch((e) => toast(String(e))) }, 'Åbn mappen') : null),
    state,
    h('div', { class: 'hint' }, 'Sagde nogen noget sjovt? Tryk "Gem klip" – også fra en genvej, Stream Deck eller fodpedal – så gemmes de sidste sekunder som en WAV-fil i Musik\\GoXLR Studio. Lyden ligger kun i hukommelsen, indtil du gemmer.'));
}
