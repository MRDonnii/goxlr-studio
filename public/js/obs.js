// OBS: switch OBS scenes from GoXLR Studio (actions "obs-scene:<name>", for hotkeys, Stream Deck,
// automation, Home Assistant) and let the OBS scene follow the GoXLR profile. Talks to OBS's
// built-in WebSocket server through obs.rs. "Stream-sikker musik" is GoXLR routing: the Music
// channel out of the stream mix, so the stream doesn't get music it may not use.
import { h, toast, logActivity } from './ui.js';
import { obsRequest } from './native.js';

export const obsSettings = (ctx) => (ctx.prefs.obs ??= { host: '127.0.0.1', port: 4455, password: '', scenes: [], follow: {} });
const config = (o) => ({ host: o.host || '127.0.0.1', port: Number(o.port) || 4455, password: o.password || '' });

export async function obsScene(ctx, name, source = 'handling') {
  const o = obsSettings(ctx);
  await obsRequest(config(o), 'SetCurrentProgramScene', { sceneName: name });
  logActivity(`OBS: scene "${name}" (${source})`);
}

/** Music out of (or back into) the stream mix – the GoXLR's routing Music → Broadcast Mix. */
export function streamSafeMusic(ctx, on = null) {
  const m = ctx.conn.mixer;
  if (!m) return null;
  const inStream = m.router?.Music?.BroadcastMix !== false;
  const safe = on == null ? inStream : on;
  ctx.conn.command('SetRouter', 'Music', 'BroadcastMix', !safe);
  return safe;
}

/** The OBS scene follows the GoXLR profile (called when the profile changes). */
export function obsFollowProfile(ctx, profile) {
  const o = obsSettings(ctx);
  const scene = o.follow?.[profile];
  if (!scene) return;
  obsScene(ctx, scene, `GoXLR-profilen "${profile}"`).catch((e) => toast(String(e.message || e)));
}

export function obsCard(ctx) {
  const o = obsSettings(ctx);
  const save = () => ctx.savePrefs();
  const field = (key, label, attrs = {}) => {
    const input = h('input', { type: 'text', value: o[key] ?? '', 'data-testid': `obs-${key}`, ...attrs, onchange: () => { o[key] = key === 'port' ? Number(input.value) || 4455 : input.value.trim(); save(); } });
    return h('div', { class: 'row' }, h('label', {}, label), input);
  };
  const state = h('div', { class: 'hint', 'data-testid': 'obs-state' });
  const follow = h('div', { class: 'list' });
  const renderFollow = () => {
    const profiles = ctx.conn.status?.files?.profiles || [];
    follow.replaceChildren(...(o.scenes?.length ? profiles.map((p) => {
      const sel = h('select', { onchange: () => { if (sel.value) o.follow[p] = sel.value; else delete o.follow[p]; save(); } },
        h('option', { value: '' }, '— uændret —'), o.scenes.map((s) => h('option', { value: s, selected: o.follow?.[p] === s }, s)));
      return h('div', { class: 'row' }, h('label', {}, p), sel);
    }) : [h('div', { class: 'hint' }, 'Tryk "Forbind og hent scener" for at vælge OBS-scener til dine GoXLR-profiler.')]));
  };
  const test = async () => {
    state.textContent = 'Forbinder …';
    try {
      const r = await obsRequest(config(o), 'GetSceneList', {});
      o.scenes = (r?.scenes || []).map((s) => s.sceneName).filter(Boolean).reverse();
      o.follow ??= {};
      save();
      state.textContent = `✓ Forbundet – ${o.scenes.length} scener${r?.currentProgramSceneName ? `, nu: ${r.currentProgramSceneName}` : ''}. Scenerne kan nu lægges på genveje og Stream Deck.`;
      renderFollow();
    } catch (e) { state.textContent = `✗ ${e.message || e}`; }
  };
  renderFollow();
  return h('div', { class: 'card' }, h('h2', {}, 'OBS'),
    field('host', 'Adresse', { placeholder: '127.0.0.1' }),
    field('port', 'Port', { placeholder: '4455' }),
    field('password', 'Adgangskode', { type: 'password', autocomplete: 'new-password' }),
    h('div', { class: 'row' }, h('button', { class: 'btn sm primary', 'data-testid': 'obs-connect', onclick: test }, 'Forbind og hent scener')),
    state,
    h('div', { class: 'hint', style: { margin: '10px 0 4px' } }, 'OBS-scene følger GoXLR-profil:'),
    follow,
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Slå WebSocket-serveren til i OBS (Værktøjer → WebSocket Server Settings) og kopiér adgangskoden derfra. "Stream-sikker musik" (handling) tager Music-kanalen ud af stream-mixet, så streamen ikke får musik, du ikke må bruge.'));
}
