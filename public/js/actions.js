import { toast, logActivity } from './ui.js';

// Toast in the app, plus the on-screen display when the app is in the background.
const notify = (ctx, text, kind = 'info') => (ctx.notify ? ctx.notify(text, kind) : toast(text, 'info'));
import { storeSet, listAudioDevices, setDefaultDevice } from './native.js';
import { applyScene } from './views-misc.js';
import { BUILTIN_PRESETS } from './eq.js';
import { CHANNEL_LABEL, shortName } from './views-mixer.js';

// The user's own presets; the built-in ones until the user has any (e.g. before importing Peace).
export function eqPresetNames(ctx) {
  const mine = Object.keys(ctx.outputEq?.presets || {});
  return mine.length ? mine : Object.keys(BUILTIN_PRESETS);
}

// `reason` says what switched the preset; it is logged (Diagnose → Seneste hændelser) so a switch
// the user did not choose can be traced (mindre fejl 5).
export function applyEqPreset(ctx, name, reason = 'valgt i appen') {
  const src = ctx.outputEq.presets[name] || BUILTIN_PRESETS[name];
  if (!src) { toast(`EQ-preset "${name}" findes ikke`); return; }
  const before = ctx.outputEq.presetName || 'Tilpasset';
  if (before !== name) logActivity(`EQ-preset: ${before} → ${name} (årsag: ${reason})`);
  ctx.outputEq.presetProfile = ctx.conn?.mixer?.profile_name || ctx.outputEq.presetProfile || null;
  const copy = structuredClone(src);
  copy.bands = (copy.bands || []).map((b) => ({ enabled: true, ...b, id: crypto.randomUUID() }));
  ctx.outputEq.slots[ctx.outputEq.active] = { enabled: true, preamp: 0, ...copy };
  ctx.outputEq.presetName = name;
  storeSet('output-eq', ctx.outputEq);
  ctx.applyOutputEq();
  ctx.onStateChanged?.('eq');
  notify(ctx, `EQ: ${name}`);
}

export function toggleEq(ctx) {
  const e = ctx.outputEq.slots[ctx.outputEq.active];
  e.enabled = !e.enabled;
  storeSet('output-eq', ctx.outputEq);
  ctx.applyOutputEq();
  ctx.onStateChanged?.('eq');
  notify(ctx, `EQ ${e.enabled ? 'til' : 'fra'}`, e.enabled ? 'ok' : 'mute');
}

function loadProfile(ctx, name) {
  ctx.conn.command('LoadProfile', name, true);
  notify(ctx, `Profil: ${name}`);
}

async function cycleOutput(ctx) {
  const devs = (await listAudioDevices()).filter((d) => d.flow === 'render');
  const pins = ctx.prefs.pinnedDevices;
  const list = devs.filter((d) => pins.includes(d.id));
  const ring = list.length > 1 ? list : devs;
  if (!ring.length) return;
  const i = ring.findIndex((d) => d.default);
  const next = ring[(i + 1) % ring.length];
  await setDefaultDevice(next.id, 'all');
  ctx.refreshDevices?.();
  notify(ctx, `Udgang: ${shortName(next.name)}`);
}

function nudgeVolume(ctx, ch, delta) {
  const m = ctx.conn.mixer;
  if (!m) return;
  ctx.conn.command('SetVolume', ch, Math.min(255, Math.max(0, m.levels.volumes[ch] + delta)));
}

export async function runAction(ctx, id, source = 'handling') {
  const [kind, ...rest] = id.split(':');
  const arg = rest.join(':');
  const m = ctx.conn.mixer;
  switch (kind) {
    case 'profile': return loadProfile(ctx, arg);
    case 'profile-toggle': {
      const [a, b] = arg.split('|');
      return loadProfile(ctx, m?.profile_name === a ? b : a);
    }
    case 'micprofile': ctx.conn.command('LoadMicProfile', arg, true); return notify(ctx, `Mikrofonprofil: ${arg}`);
    case 'scene': { const s = ctx.scenes.find((x) => x.id === arg); if (s) return applyScene(ctx, s); return; }
    case 'mute-mic': {
      if (!m) return;
      const mute = m.cough_button.state === 'Unmuted';
      ctx.conn.command('SetCoughMuteState', mute ? 'MutedToX' : 'Unmuted');
      return notify(ctx, mute ? 'Mikrofon muted' : 'Mikrofon tændt', mute ? 'mute' : 'ok');
    }
    case 'mute-fader': {
      if (!m) return;
      const mute = m.fader_status[arg].mute_state === 'Unmuted';
      ctx.conn.command('SetFaderMuteState', arg, mute ? 'MutedToX' : 'Unmuted');
      return notify(ctx, `${m.fader_status[arg].scribble?.bottom_text || CHANNEL_LABEL[m.fader_status[arg].channel] || `Fader ${arg}`} ${mute ? 'muted' : 'tændt'}`, mute ? 'mute' : 'ok');
    }
    case 'discord-toggle': return ctx.discordToggle?.();
    case 'eq-toggle': return toggleEq(ctx);
    case 'crossfeed-toggle':
    case 'loudness-toggle': {
      const k = kind === 'crossfeed-toggle' ? 'crossfeed' : 'loudness';
      const x = (ctx.outputEq.extras ??= {});
      x[k] = { ...(k === 'crossfeed' ? { level: -8, cutoff: 700, delay: 0.3 } : { amount: 4 }), ...x[k], enabled: !x[k]?.enabled };
      storeSet('output-eq', ctx.outputEq);
      ctx.applyOutputEq();
      ctx.onStateChanged?.('eq');
      return notify(ctx, `${k === 'crossfeed' ? 'Crossfeed' : 'Loudness'} ${x[k].enabled ? 'til' : 'fra'}`, x[k].enabled ? 'ok' : 'mute');
    }
    case 'eq-preset': return applyEqPreset(ctx, arg, source);
    case 'eq-next': {
      const names = eqPresetNames(ctx);
      if (!names.length) return;
      const i = names.indexOf(ctx.outputEq.presetName);
      return applyEqPreset(ctx, names[(i + 1) % names.length], `${source} (næste preset)`);
    }
    case 'output': await setDefaultDevice(arg, 'all'); ctx.refreshDevices?.(); return;
    case 'input': await setDefaultDevice(arg, 'all'); ctx.refreshDevices?.(); return;
    case 'output-next': return cycleOutput(ctx);
    case 'vol-set': {
      const [ch, pct] = arg.split('|');
      if (m) ctx.conn.command('SetVolume', ch, Math.round(Math.min(100, Math.max(0, Number(pct))) * 2.55));
      return notify(ctx, `${CHANNEL_LABEL[ch] || ch}: ${pct} %`);
    }
    case 'cough': if (m) ctx.conn.command('SetCoughMuteState', arg); return notify(ctx, arg === 'Unmuted' ? 'Mikrofon tændt' : 'Mikrofon muted', arg === 'Unmuted' ? 'ok' : 'mute');
    case 'vol-up': return nudgeVolume(ctx, arg, 13);
    case 'vol-down': return nudgeVolume(ctx, arg, -13);
    case 'fx-toggle': if (m?.effects) { ctx.conn.command('SetFXEnabled', !m.effects.is_enabled); notify(ctx, `Effekter ${m.effects.is_enabled ? 'fra' : 'til'}`); } return;
    case 'ducking-toggle': ctx.ducker.settings.enabled = !ctx.ducker.settings.enabled; ctx.ducker.save(); return notify(ctx, `Auto-ducking ${ctx.ducker.settings.enabled ? 'til' : 'fra'}`);
    case 'show': return window.__TAURI__?.core.invoke('plugin:window|show', { label: 'main' }).catch(() => {});
    default: return undefined;
  }
}

// Grouped list of everything that can be bound to a key or used from the palette.
export async function actionCatalog(ctx) {
  const m = ctx.conn.mixer;
  const groups = [];
  const profiles = ctx.conn.status?.files?.profiles || [];
  const micProfiles = ctx.conn.status?.files?.mic_profiles || [];
  const g = (title, items) => items.length && groups.push({ title, items });
  g('GoXLR-profil', [
    ...profiles.map((p) => ({ id: `profile:${p}`, label: `Indlæs profil "${p}"` })),
    ...profiles.flatMap((a, i) => profiles.slice(i + 1).map((b) => ({ id: `profile-toggle:${a}|${b}`, label: `Skift mellem "${a}" ↔ "${b}"` }))),
  ]);
  g('Mikrofonprofil', micProfiles.map((p) => ({ id: `micprofile:${p}`, label: `Indlæs mikrofonprofil "${p}"` })));
  g('Afspilnings-EQ', [
    { id: 'eq-toggle', label: 'EQ til/fra' },
    { id: 'eq-next', label: 'Næste EQ-preset' },
    { id: 'crossfeed-toggle', label: 'Crossfeed til/fra' },
    { id: 'loudness-toggle', label: 'Loudness til/fra' },
    ...eqPresetNames(ctx).map((p) => ({ id: `eq-preset:${p}`, label: `EQ-preset "${p}"` })),
  ]);
  g('Scener', ctx.scenes.map((s) => ({ id: `scene:${s.id}`, label: `Scene "${s.name}"` })));
  g('Mute', [
    { id: 'mute-mic', label: 'Mute/unmute mikrofon (cough)' },
    { id: 'cough:MutedToX', label: 'Mute mikrofon' },
    { id: 'cough:Unmuted', label: 'Unmute mikrofon' },
    ...['A', 'B', 'C', 'D'].map((f) => ({ id: `mute-fader:${f}`, label: `Mute fader ${f}${m ? ` (${m.fader_status[f].scribble?.bottom_text || CHANNEL_LABEL[m.fader_status[f].channel]})` : ''}` })),
  ]);
  const devs = await listAudioDevices().catch(() => []);
  g('Windows-lyd', [
    { id: 'output-next', label: 'Næste udgang (fastgjorte)' },
    ...devs.filter((d) => d.flow === 'render').map((d) => ({ id: `output:${d.id}`, label: `Udgang → ${shortName(d.name)}` })),
    ...devs.filter((d) => d.flow === 'capture').map((d) => ({ id: `input:${d.id}`, label: `Mikrofon → ${shortName(d.name)}` })),
  ]);
  g('Volumen', ['Headphones', 'Music', 'Game', 'Chat', 'System', 'LineOut'].flatMap((c) => [
    ...[0, 25, 50, 75, 100].map((p) => ({ id: `vol-set:${c}|${p}`, label: `${CHANNEL_LABEL[c]} ${p} %` })),
    { id: `vol-up:${c}`, label: `${CHANNEL_LABEL[c]} op` },
    { id: `vol-down:${c}`, label: `${CHANNEL_LABEL[c]} ned` },
  ]));
  g('Andet', [
    m?.effects ? { id: 'fx-toggle', label: 'Effekter til/fra' } : null,
    { id: 'ducking-toggle', label: 'Auto-ducking til/fra' },
    { id: 'discord-toggle', label: 'Skift Discord-mute (uden at røre GoXLR’en)' },
  ].filter(Boolean));
  return groups;
}

export async function describeAction(ctx, id) {
  for (const grp of await actionCatalog(ctx)) {
    const hit = grp.items.find((i) => i.id === id);
    if (hit) return hit.label;
  }
  return id;
}

// Readable name for any action id, also ones the catalog doesn't list (e.g. imported from AutoHotkey).
export function actionLabel(ctx, id) {
  const [kind, ...rest] = id.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'profile': return `Indlæs profil "${arg}"`;
    case 'profile-toggle': { const [a, b] = arg.split('|'); return `Skift mellem "${a}" ↔ "${b}"`; }
    case 'micprofile': return `Indlæs mikrofonprofil "${arg}"`;
    case 'vol-set': { const [c, p] = arg.split('|'); return `${CHANNEL_LABEL[c] || c} ${p} %`; }
    case 'vol-up': return `${CHANNEL_LABEL[arg] || arg} op`;
    case 'vol-down': return `${CHANNEL_LABEL[arg] || arg} ned`;
    case 'cough': return arg === 'Unmuted' ? 'Unmute mikrofon' : 'Mute mikrofon';
    case 'mute-mic': return 'Mute/unmute mikrofon';
    case 'mute-fader': return `Mute fader ${arg}`;
    case 'scene': return `Scene "${ctx.scenes.find((s) => s.id === arg)?.name || 'slettet'}"`;
    case 'eq-preset': return `EQ-preset "${arg}"`;
    case 'eq-toggle': return 'EQ til/fra';
    case 'eq-next': return 'Næste EQ-preset';
    case 'crossfeed-toggle': return 'Crossfeed til/fra';
    case 'loudness-toggle': return 'Loudness til/fra';
    case 'output-next': return 'Næste udgang';
    case 'fx-toggle': return 'Effekter til/fra';
    case 'ducking-toggle': return 'Auto-ducking til/fra';
    case 'discord-toggle': return 'Skift Discord-mute';
    default: return id;
  }
}
