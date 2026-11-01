import { toast } from './ui.js';
import { storeSet, listAudioDevices, setDefaultDevice } from './native.js';
import { applyScene } from './views-misc.js';
import { BUILTIN_PRESETS } from './eq.js';
import { CHANNEL_LABEL, shortName } from './views-mixer.js';

export function eqPresetNames(ctx) {
  return Object.keys(ctx.outputEq?.presets || {});
}

export function applyEqPreset(ctx, name) {
  const src = ctx.outputEq.presets[name] || BUILTIN_PRESETS[name];
  if (!src) { toast(`EQ-preset "${name}" findes ikke`); return; }
  const copy = structuredClone(src);
  copy.bands = (copy.bands || []).map((b) => ({ enabled: true, ...b, id: crypto.randomUUID() }));
  ctx.outputEq.slots[ctx.outputEq.active] = { enabled: true, preamp: 0, ...copy };
  ctx.outputEq.presetName = name;
  storeSet('output-eq', ctx.outputEq);
  ctx.applyOutputEq();
  ctx.onStateChanged?.('eq');
  toast(`EQ: ${name}`, 'info');
}

export function toggleEq(ctx) {
  const e = ctx.outputEq.slots[ctx.outputEq.active];
  e.enabled = !e.enabled;
  storeSet('output-eq', ctx.outputEq);
  ctx.applyOutputEq();
  ctx.onStateChanged?.('eq');
  toast(`EQ ${e.enabled ? 'til' : 'fra'}`, 'info');
}

function loadProfile(ctx, name) {
  ctx.conn.command('LoadProfile', name, true);
  toast(`Profil: ${name}`, 'info');
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
  toast(`Udgang: ${shortName(next.name)}`, 'info');
}

function nudgeVolume(ctx, ch, delta) {
  const m = ctx.conn.mixer;
  if (!m) return;
  ctx.conn.command('SetVolume', ch, Math.min(255, Math.max(0, m.levels.volumes[ch] + delta)));
}

export async function runAction(ctx, id) {
  const [kind, ...rest] = id.split(':');
  const arg = rest.join(':');
  const m = ctx.conn.mixer;
  switch (kind) {
    case 'profile': return loadProfile(ctx, arg);
    case 'profile-toggle': {
      const [a, b] = arg.split('|');
      return loadProfile(ctx, m?.profile_name === a ? b : a);
    }
    case 'micprofile': ctx.conn.command('LoadMicProfile', arg, true); return toast(`Mikrofonprofil: ${arg}`, 'info');
    case 'scene': { const s = ctx.scenes.find((x) => x.id === arg); if (s) return applyScene(ctx, s); return; }
    case 'mute-mic': if (m) ctx.conn.command('SetCoughMuteState', m.cough_button.state === 'Unmuted' ? 'MutedToX' : 'Unmuted'); return;
    case 'mute-fader': if (m) ctx.conn.command('SetFaderMuteState', arg, m.fader_status[arg].mute_state === 'Unmuted' ? 'MutedToX' : 'Unmuted'); return;
    case 'eq-toggle': return toggleEq(ctx);
    case 'eq-preset': return applyEqPreset(ctx, arg);
    case 'eq-next': {
      const names = eqPresetNames(ctx);
      if (!names.length) return;
      const i = names.indexOf(ctx.outputEq.presetName);
      return applyEqPreset(ctx, names[(i + 1) % names.length]);
    }
    case 'output': await setDefaultDevice(arg, 'all'); ctx.refreshDevices?.(); return;
    case 'input': await setDefaultDevice(arg, 'all'); ctx.refreshDevices?.(); return;
    case 'output-next': return cycleOutput(ctx);
    case 'vol-up': return nudgeVolume(ctx, arg, 13);
    case 'vol-down': return nudgeVolume(ctx, arg, -13);
    case 'fx-toggle': if (m?.effects) ctx.conn.command('SetFXEnabled', !m.effects.is_enabled); return;
    case 'ducking-toggle': ctx.ducker.settings.enabled = !ctx.ducker.settings.enabled; ctx.ducker.save(); return toast(`Auto-ducking ${ctx.ducker.settings.enabled ? 'til' : 'fra'}`, 'info');
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
    ...eqPresetNames(ctx).map((p) => ({ id: `eq-preset:${p}`, label: `EQ-preset "${p}"` })),
  ]);
  g('Scener', ctx.scenes.map((s) => ({ id: `scene:${s.id}`, label: `Scene "${s.name}"` })));
  g('Mute', [
    { id: 'mute-mic', label: 'Mute/unmute mikrofon (cough)' },
    ...['A', 'B', 'C', 'D'].map((f) => ({ id: `mute-fader:${f}`, label: `Mute fader ${f}${m ? ` (${m.fader_status[f].scribble?.bottom_text || CHANNEL_LABEL[m.fader_status[f].channel]})` : ''}` })),
  ]);
  const devs = await listAudioDevices().catch(() => []);
  g('Windows-lyd', [
    { id: 'output-next', label: 'Næste udgang (fastgjorte)' },
    ...devs.filter((d) => d.flow === 'render').map((d) => ({ id: `output:${d.id}`, label: `Udgang → ${shortName(d.name)}` })),
    ...devs.filter((d) => d.flow === 'capture').map((d) => ({ id: `input:${d.id}`, label: `Mikrofon → ${shortName(d.name)}` })),
  ]);
  g('Volumen', ['Headphones', 'Music', 'Game', 'Chat', 'System', 'LineOut'].flatMap((c) => [
    { id: `vol-up:${c}`, label: `${CHANNEL_LABEL[c]} op` },
    { id: `vol-down:${c}`, label: `${CHANNEL_LABEL[c]} ned` },
  ]));
  g('Andet', [
    m?.effects ? { id: 'fx-toggle', label: 'Effekter til/fra' } : null,
    { id: 'ducking-toggle', label: 'Auto-ducking til/fra' },
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
