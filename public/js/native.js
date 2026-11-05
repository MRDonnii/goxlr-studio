import { updateHttpText } from './extras.js';

const tauri = () => window.__TAURI__;
export const isNative = () => !!tauri();

async function invoke(cmd, args) {
  return tauri().core.invoke(cmd, args);
}

export async function storeGet(key, fallback) {
  try {
    if (isNative()) {
      const v = await invoke('store_get', { key });
      return v ?? fallback;
    }
    if (key === 'output-eq') {
      const r = await fetch('/studio/output-eq');
      if (r.ok) { const v = await r.json(); if (v) return v; }
    }
    const raw = localStorage.getItem(`studio.${key}`);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export async function storeSet(key, value) {
  if (isNative()) return invoke('store_set', { key, value });
  localStorage.setItem(`studio.${key}`, JSON.stringify(value));
  if (key === 'output-eq') {
    fetch('/studio/output-eq', { method: 'PUT', body: JSON.stringify(value) }).catch(() => {});
  }
}

const DEMO_DEVICES = [
  { id: 'out-goxlr-system', name: 'System (TC-Helicon GoXLR)', flow: 'render', default: true, default_comm: false },
  { id: 'out-goxlr-game', name: 'Game (TC-Helicon GoXLR)', flow: 'render', default: false, default_comm: false },
  { id: 'out-goxlr-chat', name: 'Chat (TC-Helicon GoXLR)', flow: 'render', default: false, default_comm: true },
  { id: 'out-goxlr-music', name: 'Music (TC-Helicon GoXLR)', flow: 'render', default: false, default_comm: false },
  { id: 'out-speakers', name: 'Højttalere (Realtek USB Audio)', flow: 'render', default: false, default_comm: false },
  { id: 'out-monitor', name: 'LG UltraGear (NVIDIA High Definition Audio)', flow: 'render', default: false, default_comm: false },
  { id: 'in-goxlr-chat', name: 'Chat Mic (TC-Helicon GoXLR)', flow: 'capture', default: true, default_comm: true },
  { id: 'in-goxlr-broadcast', name: 'Broadcast Stream Mix (TC-Helicon GoXLR)', flow: 'capture', default: false, default_comm: false },
  { id: 'in-webcam', name: 'Mikrofon (Logitech BRIO)', flow: 'capture', default: false, default_comm: false },
];
let demoDevices = structuredClone(DEMO_DEVICES);
// Browser demo: a USB headset (?usbheadset), and window.studioDemo.plug()/unplug() to test the
// device automatik.
const DEMO_HEADSET = { id: 'out-usb-arctis', name: 'Arctis 7 Game (SteelSeries Arctis 7)', flow: 'render', default: false, default_comm: false };
if (typeof window !== 'undefined' && !isNative()) {
  if (new URLSearchParams(location.search).has('usbheadset')) demoDevices.push({ ...DEMO_HEADSET });
  window.studioDemo = {
    plug: () => { if (!demoDevices.some((d) => d.id === DEMO_HEADSET.id)) demoDevices.push({ ...DEMO_HEADSET }); },
    unplug: () => { demoDevices = demoDevices.filter((d) => d.id !== DEMO_HEADSET.id); },
  };
}

export async function listAudioDevices() {
  if (isNative()) return invoke('audio_devices');
  return structuredClone(demoDevices);
}

// role: 'all' sets both console/multimedia and communications defaults.
export async function setDefaultDevice(id, role = 'all') {
  if (isNative()) return invoke('set_default_device', { id, role });
  const dev = demoDevices.find((d) => d.id === id);
  for (const d of demoDevices) {
    if (d.flow !== dev.flow) continue;
    if (role !== 'comm') d.default = d.id === id;
    if (role !== 'console') d.default_comm = d.id === id;
  }
}

export async function setOutputEqEngine(eq) {
  if (isNative()) return invoke('output_eq_apply', { eq });
  return null;
}

// Browser demo of the EQ engine: starts as a separately installed Equalizer APO.
const brokenDemo = typeof location !== 'undefined' && /[?&]brokenengine\b/.test(location.search);
const demoEngine = brokenDemo
  ? { kind: 'builtin', mode: 'sfx-efx', uses_our_config: true, unregistered: true, installed: new Set(['out-goxlr-system', 'out-goxlr-game', 'out-goxlr-chat', 'out-goxlr-music']) }
  : { kind: 'external', mode: 'lfx-gfx', uses_our_config: false, installed: new Set(['out-goxlr-system', 'out-goxlr-game', 'out-goxlr-chat', 'out-goxlr-music']) };
demoEngine.mics = new Set();
// Demo ?oldvoice: Ren mikrofon from 0.13 (before Stemmeisolering) is installed.
let demoOldVoice = typeof location !== 'undefined' && /[?&]oldvoice\b/.test(location.search);
if (demoOldVoice) demoEngine.mics = new Set(['in-goxlr-chat']);
// Demo ?discordbypass: Discord gets Chat Mic around the cleaner (the engine is only registered for
// normal recordings, as before 0.14.2, and OBS records too).
const demoBypass = typeof location !== 'undefined' && /[?&]discordbypass\b/.test(location.search);
if (demoBypass) demoEngine.mics = new Set(['in-goxlr-chat']);
let demoVoicePrograms = !demoOldVoice && !demoBypass;
const demoMicTests = (ids) => ids.map((id) => ({
  guid: id, name: demoDevices.find((x) => x.id === id)?.name || id, mode: 'sfx-mfx', pre_mix: true, post_mix: false, capture: true, ok: true, error: null,
  streams: { default: true, communications: demoVoicePrograms, raw: true, all_modes: true, errors: [] },
}));
const demoStreamLine = (t) => `${t.streams.communications ? '✓' : '✗'} ${t.name}: almindelig optagelse renses · Discord/stemmeprogrammer ${t.streams.communications ? 'renses' : 'renses IKKE'} · rå optagelse renses`;

export async function engineInfo() {
  if (isNative()) return invoke('engine_info');
  return {
    kind: demoEngine.kind,
    bundled: true,
    version: '1.4.2',
    install_path: demoEngine.kind === 'none' ? null : demoEngine.kind === 'builtin' ? 'C:\\Program Files\\GoXLR Studio Engine' : 'C:\\Program Files\\EqualizerAPO',
    config_path: null,
    uses_our_config: demoEngine.uses_our_config,
    external_config: demoEngine.kind === 'external' ? 'C:\\Program Files\\EqualizerAPO\\config' : null,
    devices: demoDevices.filter((d) => d.flow === 'render').map((d) => {
      const installed = demoEngine.kind !== 'none' && demoEngine.installed.has(d.id);
      return { id: d.id, guid: d.id, name: d.name, installed, mode: installed ? demoEngine.mode : null };
    }),
    registration: demoEngine.kind === 'builtin' && demoEngine.unregistered
      ? { ok: false, problems: [{ code: 'missing-clsid-pre-mix', text: 'Motorens pre-mix-del er ikke registreret i Windows' }, { code: 'protected-audiodg', text: 'DisableProtectedAudioDG er ikke sat til 1' }] }
      : { ok: true, problems: [] },
    schema: demoEngine.unregistered ? 0 : 2,
    schema_required: 2,
    denoise_bundled: true,
    denoise_installed: demoEngine.kind === 'builtin',
    dynamics_bundled: true,
    dynamics_installed: demoEngine.kind === 'builtin',
    voice_bundled: true,
    voice_installed: demoEngine.kind === 'builtin',
    voice_outdated: demoEngine.kind === 'builtin' && demoEngine.mics.size > 0 && demoOldVoice,
    mics: demoDevices.filter((d) => d.flow === 'capture').map((d) => {
      const installed = demoEngine.kind === 'builtin' && demoEngine.mics.has(d.id);
      return { id: d.id, guid: d.id, name: d.name, installed, mode: installed ? 'sfx-mfx' : null, voice_programs: installed ? demoVoicePrograms : null };
    }),
  };
}

// task: {action: 'install'|'set-devices', devices: [ids]} | {action: 'uninstall'|'use-external'|'restore-external'}
// Browser demo of the engine test: like on some PCs, LFX/GFX does not load, so the test moves the
// outputs to SFX/EFX by itself.
function demoTest(log, autoAdjust = true) {
  const label = { 'sfx-efx': 'SFX/EFX', 'sfx-mfx': 'SFX/MFX', 'lfx-gfx': 'LFX/GFX' };
  log.push('Tester at EQ-motoren bliver indlæst på udgangene…');
  const ids = [...demoEngine.installed];
  if (demoEngine.mode === 'lfx-gfx' && autoAdjust) {
    for (const id of ids) log.push(`${demoDevices.find((x) => x.id === id)?.name || id}: prøver en anden måde (SFX/EFX)`);
    demoEngine.mode = 'sfx-efx';
  }
  const ok = demoEngine.mode !== 'lfx-gfx';
  const target = (() => { try { return JSON.parse(localStorage.getItem('studio.output-eq') || '{}').target || null; } catch { return null; } })();
  const covers = (id) => !target || target === id;
  const tests = ids.map((id) => ({ guid: id, name: demoDevices.find((x) => x.id === id)?.name || id, mode: demoEngine.mode, pre_mix: ok, post_mix: ok, ok, error: null, covered: covers(id), peak: id === 'out-goxlr-music' ? 0.398 : 0 }));
  for (const t of tests) log.push(t.ok ? `✓ ${t.name}: EQ-motoren kører (${label[t.mode]})` : `✗ ${t.name}: ikke indlæst`);
  // Demo: Spotify plays on Music.
  const music = demoDevices.find((x) => x.id === 'out-goxlr-music')?.name || 'Music';
  const only = tests.filter((t) => t.covered).map((t) => t.name).join(', ') || 'ingen udgange';
  demoSound = [covers('out-goxlr-music') ? `✓ Der spiller lyd på ${music}, og EQ'en gælder der.` : `⚠ Der spiller lyd på ${music}, men EQ'en gælder kun ${only}.`];
  log.push(...demoSound);
  return tests;
}
let demoSound = [];

// What each elevated task changes – shown in the app while it runs (mindre fejl 9: with UAC set
// to approve silently there was no sign that the audio service was restarted).
export const ADMIN_TASKS = {
  install: 'Installerer EQ-motoren: kopierer motorfiler til C:\\Program Files\\GoXLR Studio Engine, registrerer den i Windows, sætter den på de valgte udgange (FxProperties i registreringsdatabasen) og genstarter Windows’ lydtjeneste. En separat Equalizer APO tages backup af og afinstalleres.',
  'set-devices': 'Ændrer hvilke udgange EQ-motoren sidder på (FxProperties i registreringsdatabasen) og genstarter Windows’ lydtjeneste.',
  test: 'Tjekker og retter EQ-motorens registrering i Windows, genstarter Windows’ lydtjeneste og åbner hver udgang et øjeblik for at teste motoren.',
  uninstall: 'Fjerner EQ-motoren fra alle udgange, afregistrerer den og sletter motorfilerne. Windows’ lydtjeneste genstartes.',
  'use-external': 'Peger Equalizer APO’s config-mappe (ConfigPath) på GoXLR Studios EQ og genstarter Windows’ lydtjeneste.',
  'restore-external': 'Giver Equalizer APO sin egen config-mappe tilbage og genstarter Windows’ lydtjeneste.',
  'set-mics': 'Sætter EQ-motoren på mikrofonen (Ren mikrofon: FxProperties i registreringsdatabasen), genstarter Windows’ lydtjeneste og tester at den bliver indlæst.',
  'disable-autostart': 'Slår GoXLR-softwares autostart fra: deaktiverer planlagte opgaver (schtasks /DISABLE) og flytter genveje fra Startup-mappen til backup-mappen. Intet slettes.',
};
function adminEvent(phase, task, extra = {}) {
  try { window.dispatchEvent(new CustomEvent('admin-task', { detail: { phase, action: task.action, text: ADMIN_TASKS[task.action] || task.action, ...extra } })); } catch { /* no window */ }
}

export async function engineTask(task) {
  adminEvent('start', task);
  try {
    const r = await engineTaskRaw(task);
    adminEvent('end', task, { ok: !!r?.ok });
    return r;
  } catch (e) {
    adminEvent('end', task, { ok: false, error: String(e?.message || e) });
    throw e;
  }
}

async function engineTaskRaw(task) {
  if (isNative()) return invoke('engine_task', { task });
  await new Promise((r) => setTimeout(r, 600));
  const log = [];
  let tests = [];
  if (task.action === 'install') {
    if (demoEngine.kind === 'external') log.push('Equalizer APO’s config (inkl. Peace-presets) gemt', 'Den separate Equalizer APO er afinstalleret');
    demoEngine.kind = 'builtin'; demoEngine.uses_our_config = true; demoEngine.installed = new Set(task.devices); demoEngine.mode = 'lfx-gfx';
    log.push('Motorfiler lagt i C:\\Program Files\\GoXLR Studio Engine', ...task.devices.map((d) => `EQ-motor sat på: ${demoDevices.find((x) => x.id === d)?.name || d} (lfx-gfx)`));
    tests = demoTest(log);
  } else if (task.action === 'set-devices') {
    demoEngine.installed = new Set(task.devices);
    if (task.mode) demoEngine.mode = task.mode;
    tests = demoTest(log, !task.mode);
  } else if (task.action === 'set-mics') {
    if (demoEngine.kind !== 'builtin') return { ok: false, error: 'GoXLR Studios EQ-motor er ikke installeret', log, reboot: false, tests: [], sound: [] };
    demoEngine.mics = new Set(task.devices);
    if (demoOldVoice && task.devices.length) { demoOldVoice = false; log.push('goxlr_studio_voice.dll opdateret'); }
    for (const d of task.devices) log.push(`EQ-motor sat på mikrofonen: ${demoDevices.find((x) => x.id === d)?.name || d} (sfx-mfx)`);
    if (task.devices.length && !demoVoicePrograms) { demoVoicePrograms = true; log.push(`${demoDevices.find((x) => x.id === task.devices[0])?.name}: renser nu også lyden til Discord og andre stemmeprogrammer`); }
    tests = demoMicTests(task.devices);
    for (const t of tests) log.push(`✓ ${t.name}: Ren mikrofon kører (SFX/MFX)`, demoStreamLine(t));
  } else if (task.action === 'disable-autostart') {
    for (const a of demoAutostarts) {
      if ((a.kind === 'task' && task.tasks?.includes(a.id)) || (a.kind === 'link' && task.links?.includes(a.id))) {
        a.enabled = a.kind === 'task' ? false : a.enabled;
        if (a.kind === 'link') a.moved = true;
        log.push(a.kind === 'task' ? `Planlagt opgave slået fra: ${a.id}` : `Genvej flyttet fra Startup til backup: ${a.name}`);
      }
    }
    demoAutostarts = demoAutostarts.filter((a) => !a.moved);
  } else if (task.action === 'test') {
    if (demoEngine.unregistered) {
      log.push('Rettet: Motorens pre-mix-del er ikke registreret i Windows; DisableProtectedAudioDG er ikke sat til 1 – motoren er registreret i Windows igen');
      demoEngine.unregistered = false;
    }
    tests = demoTest(log);
    if (demoEngine.kind === 'builtin' && demoEngine.mics.size) {
      const mt = demoMicTests([...demoEngine.mics]);
      for (const t of mt) log.push(`✓ ${t.name}: Ren mikrofon kører (SFX/MFX)`, demoStreamLine(t));
      tests = [...tests, ...mt];
    }
  } else if (task.action === 'uninstall') {
    demoEngine.kind = 'none'; demoEngine.uses_our_config = false; demoEngine.installed = new Set(); demoEngine.mics = new Set(); log.push('EQ-motoren er fjernet');
  } else if (task.action === 'use-external') { demoEngine.uses_our_config = true; log.push('Equalizer APO læser nu GoXLR Studios EQ'); }
  else if (task.action === 'restore-external') { demoEngine.uses_our_config = false; log.push('Equalizer APO bruger igen sin egen config-mappe'); }
  return { ok: true, error: null, log, reboot: tests.some((t) => !t.ok && !t.error), tests, sound: tests.length ? demoSound : [] };
}

export async function engineStatus() {
  if (isNative()) return invoke('output_eq_status');
  const info = await engineInfo();
  const on = info.devices.some((d) => d.installed);
  return {
    kind: info.kind, bundled: true, engine_version: info.version,
    available: true, apo_installed: info.kind !== 'none', taken_over: info.uses_our_config,
    running: info.kind !== 'none' && info.uses_our_config && on,
    reason: 'Browser-demo – i Windows-appen styrer dette den rigtige lydmotor.',
    devices: info.devices.map((d) => ({ id: d.id, name: d.name, apo: d.installed })),
  };
}

export async function apoTakeover(enable) {
  if (!isNative()) { await engineTask({ action: enable ? 'use-external' : 'restore-external' }); return; }
  const task = { action: enable ? 'use-external' : 'restore-external' };
  adminEvent('start', task);
  try { const r = await invoke('apo_takeover', { enable }); adminEvent('end', task, { ok: true }); return r; } catch (e) { adminEvent('end', task, { ok: false }); throw e; }
}

export async function apoReadConfig() {
  if (!isNative()) throw new Error('Kun i Windows-appen');
  return invoke('apo_read_config');
}

// Eget FIR-filter (fir.rs): the WAV goes into the engine's folder. The browser demo only reads its header.
export async function firSave(name, data) {
  if (isNative()) return invoke('fir_save', { name, data });
  const b = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const dv = new DataView(b.buffer);
  if (b.length < 44 || String.fromCharCode(...b.slice(0, 4)) !== 'RIFF') throw new Error('Filen er ikke en WAV-fil');
  const stem = name.replace(/\.wav$/i, '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'filter';
  const ch = dv.getUint16(22, true), rate = dv.getUint32(24, true), align = dv.getUint16(32, true);
  return { file: `fir-${stem}.wav`, rate, channels: ch, frames: Math.floor((b.length - 44) / Math.max(1, align)) };
}

export async function apoListConfigs() {
  if (!isNative()) return [];
  return invoke('apo_list_configs');
}

// Medieknapper (media.rs). The browser demo has a pretend player.
const demoMedia = { available: true, playing: true, title: 'Demo-sang', artist: 'Demo-kunstner', app: 'Spotify', n: 1 };
export async function mediaNow() { if (isNative()) return invoke('media_now'); return { ...demoMedia }; }
export async function mediaControl(cmd) {
  if (isNative()) return invoke('media_control', { cmd });
  if (cmd === 'play-pause') demoMedia.playing = !demoMedia.playing;
  if (cmd === 'next' || cmd === 'previous') { demoMedia.n += cmd === 'next' ? 1 : -1; demoMedia.title = `Demo-sang ${demoMedia.n}`; demoMedia.playing = true; }
  if (cmd === 'stop') demoMedia.playing = false;
  return null;
}

// Fodpedal: MIDI inputs (midi.rs). The browser demo has one pretend pedal (window.studioDemo.midi).
export async function midiStart() { if (isNative()) return invoke('midi_start'); return null; }
export async function midiPorts() { if (isNative()) return invoke('midi_ports'); return ['Demo MIDI-pedal']; }

export async function setHotkeys(bindings) {
  if (!isNative()) return bindings.map((b) => ({ id: b.id, ok: true, error: null }));
  return invoke('set_hotkeys', { bindings });
}

const DEMO_APPS = [
  { pid: 101, exe: 'Spotify.exe', path: 'C:\\Spotify\\Spotify.exe', output: 'out-goxlr-music', input: null, volume: 0.8, muted: false },
  { pid: 102, exe: 'Discord.exe', path: 'C:\\Discord\\Discord.exe', output: 'out-goxlr-chat', input: 'in-goxlr-chat', volume: 1, muted: false },
  { pid: 103, exe: 'chrome.exe', path: 'C:\\Chrome\\chrome.exe', output: 'out-goxlr-old', input: null, volume: 0.6, muted: false },
  { pid: 104, exe: 'cod.exe', path: 'C:\\Games\\cod.exe', output: 'out-goxlr-system', input: 'in-goxlr-chat', volume: 1, muted: false },
];
export async function appSessions() {
  if (isNative()) return invoke('app_sessions');
  return structuredClone(DEMO_APPS);
}

/** An app's own volume (0–1) and/or mute, like Windows' volume mixer. */
export async function setAppVolume(pid, volume = null, mute = null) {
  if (isNative()) return invoke('app_volume', { pid, volume, mute });
  const a = DEMO_APPS.find((x) => x.pid === pid);
  if (a) { if (volume != null) a.volume = volume; if (mute != null) a.muted = mute; }
  return 1;
}

export async function setAppDevice(pid, flow, id) {
  if (isNative()) return invoke('set_app_device', { pid, flow, id });
  const a = DEMO_APPS.find((x) => x.pid === pid);
  if (a) a[flow === 'capture' ? 'input' : 'output'] = id;
}

export async function setTray(model) {
  if (isNative()) return invoke('set_tray', { model }).catch(() => {});
}

export async function showOsd(text, kind = 'info') {
  if (isNative()) return invoke('show_osd', { text, kind }).catch(() => {});
}

export async function startDaemon() {
  if (!isNative()) throw new Error('Kun i Windows-appen');
  return invoke('start_daemon');
}

// Browser demo: ?engineerror shows the engine that did not start after an update.
const demoEngineError = typeof location !== 'undefined' && new URLSearchParams(location.search).has('engineerror');
const demoDaemon = { started_by_us: false, foreign: ['C:\\Program Files\\GoXLR Utility\\goxlr-daemon.exe'] };
export async function daemonInfo() {
  if (isNative()) return invoke('daemon_info');
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('otherinstance')) {
    return { bundled: true, version: '1.2.4', started_by_us: false, process_running: true, foreign: [], last_error: 'En anden GoXLR-motor svarer allerede', attempts: [],
      own_pid: 100, port_pid: 200, port_process: 'goxlr-studio.exe', others: [{ pid: 200, path: null, same_user: null, elevated: null, session: 1 }] };
  }
  if (demoEngineError) {
    const e = 'En anden GoXLR-motor svarer allerede – typisk den gamle GoXLR Studio, der stadig er ved at lukke efter en opdatering, eller GoXLR Utility';
    const now = Date.now();
    return { bundled: true, version: '1.2.4', started_by_us: false, process_running: false, foreign: [], last_error: e, log_path: null,
      attempts: [{ at: now - 70000, ok: false, text: e }, { at: now - 68000, ok: false, text: 'Prøver igen om 2 s' }, { at: now - 60000, ok: false, text: e }] };
  }
  return { bundled: true, version: '1.2.4', started_by_us: demoDaemon.started_by_us, process_running: true, foreign: [...demoDaemon.foreign], last_error: null, attempts: [] };
}

// The end of the GoXLR engine's own log (goxlr-daemon.log): { path, lines }.
export async function engineLog(lines = 200) {
  if (isNative()) return invoke('engine_log', { lines });
  const t = '10:00:00';
  return { path: 'C:\\Users\\<bruger>\\AppData\\Roaming\\GoXLR-on-Linux\\GoXLR-Utility\\data\\logs\\goxlr-daemon.log',
    lines: demoEngineError ? [`${t} [INFO] Starting GoXLR Daemon v1.2.4 (inside GoXLR Studio)`, `${t} [INFO] Performing Platform Preflight...`,
      `${t} [ERROR] GoXLR engine stopped: The GoXLR Daemon is already running.`]
      : [`${t} [INFO] Starting GoXLR Daemon v1.2.4 (inside GoXLR Studio)`, `${t} [INFO] Performing Platform Preflight...`, `${t} [INFO] Bound IPC Socket @ "@goxlr.socket"`, `${t} [INFO] Started GoXLR configuration interface at http://localhost:14564/`] };
}

// "Start med Windows" as Windows sees it: { registered, points_here, quoted, approved, enabled, started_minimized }.
export async function autostartStatus() {
  if (isNative()) return invoke('autostart_status');
  return { registered: false, enabled: false, approved: true, started_minimized: false };
}

export async function setAutostart(enabled) {
  if (isNative()) return invoke('set_autostart', { enabled });
  throw new Error('Kun i Windows-appen');
}

// Another GoXLR Studio (administrator / another account) holding the engine: stop it, start ours.
export async function stopOtherInstances() {
  if (isNative()) return invoke('stop_other_instances');
  throw new Error('Kun i Windows-appen');
}

export async function restartEngine() {
  if (isNative()) return invoke('restart_engine');
  throw new Error('Kun i Windows-appen');
}

// What settings.json says for a GoXLR: { found, profile, mic_profile, profile_files }.
export async function engineSettingsCheck(serial) {
  if (isNative()) return invoke('engine_settings_check', { serial });
  return { found: false };
}

export async function openEngineLogDir() {
  if (isNative()) return invoke('open_engine_log_dir');
  throw new Error('Kun i Windows-appen');
}

// GoXLR software that starts with Windows (scheduled tasks, Startup shortcuts) – mindre fejl 3.
let demoAutostarts = [
  { kind: 'task', name: 'GoXLR Utility Startup (Single Instance)', id: '\\GoXLR Utility Startup (Single Instance)', target: 'C:\\Program Files\\GoXLR Utility\\goxlr-launcher.exe', enabled: true, owner: 'utility' },
  { kind: 'link', name: 'GoXLR Control Panel Autostart', id: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\GoXLR Control Panel Autostart.lnk', target: 'C:\\Program Files\\TC-HELICON\\GoXLR_Audio_Driver\\W10_x64\\GoXLRControlPanel.exe', enabled: true, owner: 'driver' },
];
export async function migrateAutostarts() {
  if (isNative()) return invoke('migrate_autostarts');
  return structuredClone(demoAutostarts);
}

// Switch from an installed GoXLR Utility to GoXLR Studio's own engine.
export async function daemonTakeover() {
  if (isNative()) return invoke('daemon_takeover');
  const stopped = demoDaemon.foreign.splice(0);
  demoDaemon.started_by_us = true;
  return { stopped, autostart_disabled: stopped.length ? 'backup\\autostart-slået-fra\\GoXLR Utility.lnk' : null, old_engine_removed: false, started: 'GoXLR-motoren er startet', restored_utility: false, autostart_remaining: demoAutostarts.filter((a) => a.enabled) };
}

// ---------- moving over from the old programs ----------
const DEMO_AHK = [
  '; Eksempel på et gammelt AutoHotkey-script',
  'F13::Run, "C:\\Program Files\\GoXLR Utility\\goxlr-client-quiet.exe" profiles device load Headset, , Hide',
  'F14::Run, "C:\\Program Files\\GoXLR Utility\\goxlr-client-quiet.exe" profiles device load Speakers, , Hide',
  '^PgUp::Run, "C:\\Program Files\\GoXLR Utility\\goxlr-client-quiet.exe" profiles device load Headset, , Hide',
  '^PgDn::Run, "C:\\Program Files\\GoXLR Utility\\goxlr-client-quiet.exe" profiles device load Speakers, , Hide',
].join('\r\n');

export async function migrateScan() {
  if (isNative()) return invoke('migrate_scan');
  return {
    ahk: [{ path: 'C:\\Users\\demo\\Documents\\GoXLR.ahk', text: DEMO_AHK, autostart: true, startup_entry: 'C:\\Users\\demo\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\GoXLR.lnk' }],
    ahk_running: true,
    // As on the user's pc: TC-Helicon's mic profiles lie in "MicProfiles" (no space).
    tc_helicon: { installed: false, dir: 'C:\\Users\\demo\\Documents\\GoXLR', profiles: ['Headset', 'Speakers'], mic_profiles: ['Røde'],
      profile_files: ['C:\\Users\\demo\\Documents\\GoXLR\\Profiles\\Headset.goxlr', 'C:\\Users\\demo\\Documents\\GoXLR\\Profiles\\Speakers.goxlr'],
      mic_profile_files: ['C:\\Users\\demo\\Documents\\GoXLR\\MicProfiles\\Røde.goxlrMicProfile'] },
    apo: { config_dir: demoEngine.kind === 'external' ? 'C:\\Program Files\\EqualizerAPO\\config' : null, peace_installed: demoEngine.kind === 'external', peace_txt: null, preset_files: 12 },
    backup_root: 'C:\\Users\\demo\\AppData\\Roaming\\GoXLR Studio\\backup',
  };
}

export async function migrateBackup(stamp, goxlrDirs, studioJson) {
  if (isNative()) return invoke('migrate_backup', { stamp, goxlrDirs, studioJson });
  return { path: `C:\\Users\\demo\\AppData\\Roaming\\GoXLR Studio\\backup\\${stamp}`, files: 42, bytes: 1234567 };
}

// Spiltilstand. Demo: window.studioDemo.game('game.exe') starts a pretend full-screen game, .game(null) ends it.
const demoGame = { notification: 5, fullscreen: false, exe: 'goxlr-studio.exe', system_muted: false };
if (typeof window !== 'undefined' && window.studioDemo) {
  window.studioDemo.game = (exe) => Object.assign(demoGame, exe ? { notification: 3, fullscreen: true, exe } : { notification: 5, fullscreen: false, exe: 'goxlr-studio.exe' });
}
export async function gameState() { if (isNative()) return invoke('game_state'); return { ...demoGame }; }
export async function gameMuteSystemSounds(mute) {
  if (isNative()) return invoke('game_mute_system_sounds', { mute });
  demoGame.system_muted = mute;
  return 1;
}

// Lydklip (clips.rs). The demo pretends to keep sound.
let demoClips = { running: false, device: '', seconds: 30, rate: 48000, buffered: 0, error: null, at: 0 };
export async function clipsStart(device, seconds) {
  if (isNative()) return invoke('clips_start', { device, seconds });
  demoClips = { ...demoClips, running: true, device, seconds, at: Date.now() };
}
export async function clipsStop() { if (isNative()) return invoke('clips_stop'); demoClips.running = false; }
export async function clipsStatus() {
  if (isNative()) return invoke('clips_status');
  return { ...demoClips, buffered: demoClips.running ? Math.min(demoClips.seconds, (Date.now() - demoClips.at) / 1000) : 0 };
}
export async function clipsSave(seconds) {
  if (isNative()) return invoke('clips_save', { seconds });
  if (!demoClips.running) throw new Error('Lydklip er ikke slået til');
  return `C:\\Users\\demo\\Music\\GoXLR Studio\\Klip ${new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.')}.wav`;
}
export async function clipsOpenDir() { if (isNative()) return invoke('clips_open_dir'); }

// Stemmeisolering in the demo: running when chosen (unless the old plugin is installed).
function demoVoiceIsolate() {
  try { return JSON.parse(localStorage.getItem('studio.prefs') || '{}').voiceClean?.noise === 'isolate' ? (demoOldVoice ? null : 'running') : null; } catch { return null; }
}

// Ren mikrofon's check (lib.rs voice_check): who records from which mic + the engine's mic part.
// Demo ?discordwebcam: Discord records from the webcam's mic instead of Chat Mic.
export async function voiceCheck() {
  if (isNative()) return invoke('voice_check');
  const webcam = typeof location !== 'undefined' && /[?&]discordwebcam\b/.test(location.search);
  const on = [...demoEngine.mics];
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem('studio.prefs') || '{}'); } catch { /* demo */ }
  const vc = prefs.voiceClean || {};
  return {
    recordings: [{ device: webcam ? 'in-webcam' : 'in-goxlr-chat', pid: 4242, exe: 'Discord.exe', active: true },
      ...(demoBypass ? [{ device: 'in-goxlr-chat', pid: 5150, exe: 'obs64.exe', active: true }] : [])],
    config: { devices: vc.enabled ? on : [], plugin: !!vc.enabled && on.length > 0, isolate: !!vc.enabled && vc.noise === 'isolate' && !demoOldVoice },
    error: null,
  };
}

// Ren mikrofon's echo reference (voiceref.rs). The demo pretends the plugin runs while it is on.
let demoVoice = { enabled: false, sources: [] };
export async function voiceConfigure(config) {
  if (isNative()) return invoke('voice_configure', { config });
  demoVoice = config;
}
// The browser demo of "Test din mikrofon": typing is removed, the voice comes through.
let demoVoicePhase = null;
export function setDemoVoicePhase(phase) { demoVoicePhase = phase; }
export async function voiceStatus() {
  if (isNative()) return invoke('voice_status');
  if (!demoVoice.enabled) return { enabled: false, connected: false, plugin: false, echo: false, noise: false, reference: false, bypassed: false, erle_db: null, delay_ms: null, playing: false, sources: [], error: null };
  const t = Date.now() / 1000;
  return {
    enabled: true, connected: demoEngine.mics.size > 0, plugin: demoEngine.mics.size > 0, echo: demoVoice.sources.length > 0, noise: true, reference: demoVoice.sources.length > 0, bypassed: false, isolate: demoVoiceIsolate(),
    erle_db: 24 + 4 * Math.sin(t / 3), delay_ms: 38, playing: demoVoice.sources.length > 0,
    in_db: (demoVoicePhase === 'speech' ? -24 : -31) + 3 * Math.sin(t),
    out_db: (demoVoicePhase === 'speech' ? -25 : demoVoicePhase === 'typing' ? -78 : -57) + 3 * Math.sin(t),
    instances: demoOldVoice ? null : demoBypass && !demoVoicePrograms ? 1 : demoBypass ? 2 : 1,
    sources: demoVoice.sources.map((s) => ({ device: s.device, ok: true, rate: 48000, playing: s.gain > 0, error: null })), error: null,
  };
}

/** An output's format ({ rate, bits } or null). The demo's Chat output runs 48 kHz. */
export async function deviceFormat(id) {
  if (isNative()) return invoke('device_format', { id });
  return { rate: 48000, bits: 24 };
}

// Streonor / MiraBox StreamDock plugin (streamdock.rs). The demo pretends the app is installed.
let demoStreamdock = { plugins_dir: 'C:\\Users\\demo\\AppData\\Roaming\\HotSpot\\StreamDock\\plugins', installed: null, bundled: '0.9.1.0' };
export async function streamdockInfo() { if (isNative()) return invoke('streamdock_info'); return { ...demoStreamdock }; }
export async function streamdockInstall() {
  if (isNative()) return invoke('streamdock_install');
  demoStreamdock.installed = demoStreamdock.bundled;
  return `${demoStreamdock.plugins_dir}\\com.goxlrstudio.sdPlugin`;
}

const demoB64 = (t) => btoa(t);
export async function moveCollect(dirs) {
  if (isNative()) return invoke('move_collect', { dirs });
  return { files: [['profiles', 'Headset.goxlr'], ['profiles', 'Speakers.goxlr'], ['mic-profiles', 'Standard.goxlrMicProfile'], ['sounds', 'Applaus.mp3']]
    .map(([kind, name]) => ({ kind, name, data: demoB64(`demo ${name}`) })), skipped: [] };
}
export async function moveRestore(files, dirs, stamp) {
  if (isNative()) return invoke('move_restore', { files, dirs, stamp });
  return { written: files.length, same: 0, skipped: [], backup: null };
}

export async function migrateCopyProfiles(files, dest) {
  if (isNative()) return invoke('migrate_copy_profiles', { files, dest });
  return files.length;
}

export async function migrateDisableStartup(entry) {
  if (isNative()) return invoke('migrate_disable_startup', { entry });
  return 'backup\\autostart-slået-fra';
}

export async function migrateStopAhk() {
  if (isNative()) return invoke('migrate_stop_ahk');
}

const demoApps = [
  { key: 'demo-utility', name: 'GoXLR Utility', publisher: 'GoXLR on Linux', version: '1.2.4', category: 'replace', note: 'GoXLR Studio har sin egen GoXLR-motor. Dine profiler bliver liggende.' },
  { key: 'demo-apo', name: 'Equalizer APO', publisher: 'Jonas Thedering', version: '1.4.2', category: 'engine', note: 'Erstattes af GoXLR Studios indbyggede EQ-motor (under Afspilnings-EQ).' },
  { key: 'demo-peace', name: 'Peace Equalizer, interface Equalizer APO', publisher: 'P.E. Verbeek', version: '1.6', category: 'replace', note: 'GoXLR Studio har EQ, presets og genveje. Importér presets først.' },
  { key: 'demo-ahk', name: 'AutoHotkey', publisher: 'AutoHotkey Foundation', version: '1.1.37', category: 'check', note: 'Genvejene er flyttet til GoXLR Studio. Afinstallér kun, hvis du ikke bruger andre AutoHotkey-scripts.' },
  { key: 'demo-driver', name: 'TC-Helicon GoXLR Driver', publisher: 'TC-Helicon', version: '5.57', category: 'keep', note: 'Driveren får GoXLR’en til at virke som lydkort i Windows. Den skal blive.' },
];
export async function installedApps() {
  if (isNative()) return invoke('installed_apps');
  return demoApps.filter((a) => a.category !== 'engine' || demoEngine.kind === 'external');
}

export async function runUninstaller(key) {
  if (isNative()) return invoke('run_uninstaller', { key });
  const i = demoApps.findIndex((a) => a.key === key);
  const [a] = demoApps.splice(i, 1);
  return a.name;
}

export async function openPath(path) {
  if (isNative()) return invoke('open_path', { path });
}

export async function setApi(config) {
  if (!isNative()) return null;
  return invoke('set_api', { config });
}

export async function apiPublish(status, actions) {
  if (isNative()) return invoke('api_publish', { status, actions: actions ?? null }).catch(() => {});
}

export async function setTrayStatus(muted, tooltip, level = null) {
  if (isNative()) return invoke('set_tray_status', { muted, tooltip, level }).catch(() => {});
}

export async function appInfo() {
  if (isNative()) return invoke('app_info');
  return { version: '0.5.5', installed: false, browser: true };
}

// The newest release (GitHub's API shape). The app reads latest.json from the release – no hourly
// limit – and falls back to GitHub's API itself; the browser demo asks the API directly.
const RELEASES_API = 'https://api.github.com/repos/MRDonnii/goxlr-studio/releases/latest';
/** Does this build only install updates from a correctly signed release (update.rs)? */
export async function updateSigned() { return isNative() ? invoke('update_signed') : false; }

export async function latestRelease() {
  if (isNative()) return invoke('update_check');
  const r = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error(updateHttpText(r.status, Number(r.headers.get('x-ratelimit-reset')) || null, Date.now()));
  return r.json();
}

// `background`: the app is in the tray – install silently and start it in the tray again.
export async function installUpdate(url, sha256, version, background = false) {
  if (!isNative()) throw new Error('Kun i Windows-appen');
  return invoke('install_update', { url, sha256, version, background });
}

// The action GoXLR Studio was started with (a Stream Deck link or --action), once.
export async function takeLaunchAction() {
  if (isNative()) return invoke('take_launch_action');
  return new URLSearchParams(location.search).get('action');
}

// ---------- Lydbank (sound files in %APPDATA%\GoXLR Studio\sounds) ----------
const demoSounds = new Map(); // browser demo: file -> base64
export async function soundsList() {
  if (isNative()) return invoke('sounds_list');
  return [...demoSounds.keys()].sort().map((file) => ({ file, name: file.replace(/\.[^.]+$/, ''), size: demoSounds.get(file).length }));
}
export async function soundsSave(name, data) {
  if (isNative()) return invoke('sounds_save', { name, data });
  let file = name.split(/[\\/]/).pop();
  for (let n = 2; demoSounds.has(file); n++) file = name.replace(/(\.[^.]+)$/, ` (${n})$1`);
  demoSounds.set(file, data);
  return file;
}
export async function soundsRead(file) {
  if (isNative()) return invoke('sounds_read', { file });
  if (!demoSounds.has(file)) throw new Error('Lyden findes ikke længere');
  return demoSounds.get(file);
}
export async function soundsDelete(file) {
  if (isNative()) return invoke('sounds_delete', { file });
  demoSounds.delete(file);
}
export async function soundsRename(file, name) {
  if (isNative()) return invoke('sounds_rename', { file, name });
  const ext = file.match(/\.[^.]+$/)?.[0] || '';
  const target = `${name.trim()}${ext}`;
  if (target !== file && demoSounds.has(target)) throw new Error('Der findes allerede en lyd med det navn');
  demoSounds.set(target, demoSounds.get(file)); if (target !== file) demoSounds.delete(file);
  return target;
}
export async function soundsOpenDir() {
  if (isNative()) return invoke('sounds_open_dir');
}

// TC-Helicon's GoXLR driver: { installed, api, download_mini, download_full } (only read, never changed).
export async function driverInfo() {
  if (isNative()) return invoke('driver_info');
  const missing = new URLSearchParams(location.search).has('nodriver');
  return { installed: !missing, api: missing ? null : 'C:\\Program Files\\TC-HELICON\\GoXLR_Audio_Driver\\W10_x64\\goxlr_audioapi_x64.dll',
    download_mini: 'https://www.tchelicon.com/en/products/0803-AAB', download_full: 'https://www.tchelicon.com/en/products/0803-AAA' };
}

// { exe, link_registered, link_here, link_command } – for the Stream Deck page.
export async function deckInfo() {
  if (isNative()) return invoke('deck_info');
  const exe = 'C:\\Users\\dig\\AppData\\Local\\GoXLR Studio\\goxlr-studio.exe';
  return { exe, link_registered: true, link_here: true, link_command: `"${exe}" "%1"`, demo: true };
}

export async function updateLog() {
  if (isNative()) return invoke('update_log');
  return [];
}

// { result: { from, to, code, installed, at } | null, log: [lines of update.log] }
export async function updateResult() {
  if (isNative()) return invoke('update_result');
  return { result: null, log: [] };
}

export async function openUrl(url) {
  if (isNative()) return invoke('open_url', { url });
  window.open(url, '_blank', 'noopener');
}

export async function sendKeys(accel) {
  if (isNative()) return invoke('send_keys', { accel });
}

export async function discordRunning() {
  if (isNative()) return invoke('discord_running');
  return true;
}

// OBS (obs.rs). The demo pretends OBS runs with four scenes.
let demoObsScene = 'Gaming';
export async function obsRequest(config, requestType, data = {}) {
  if (isNative()) return invoke('obs_request', { config, requestType, data });
  if (requestType === 'GetSceneList') return { currentProgramSceneName: demoObsScene, scenes: ['BRB', 'Just Chatting', 'Gaming', 'Starter snart'].map((sceneName) => ({ sceneName })) };
  if (requestType === 'SetCurrentProgramScene') { demoObsScene = data.sceneName; return null; }
  throw new Error(`OBS: ${requestType} findes ikke i demoen`);
}

// Profilhistorik (history.rs). The demo keeps two versions of each profile in memory.
const demoHistory = new Map();
export async function historySnapshot(profiles, mics) {
  if (isNative()) return invoke('history_snapshot', { profiles: profiles || '', mics: mics || '' });
  return 0;
}
export async function historyList(kind, name) {
  if (isNative()) return invoke('history_list', { kind, name });
  const k = `${kind}:${name}`;
  if (!demoHistory.has(k)) demoHistory.set(k, [{ file: '20261101-214500.goxlr', at: '2026-11-01 21:45:00', size: 18234 }, { file: '20261031-190210.goxlr', at: '2026-10-31 19:02:10', size: 18190 }]);
  return demoHistory.get(k);
}
export async function historyRestore(kind, name, version, folder) {
  if (isNative()) return invoke('history_restore', { kind, name, version, folder });
  return null;
}

// Lydtjek (soundcheck.rs). The browser demo has Windows' default ducking (−80 %), the GoXLR's
// System output at 63 % and Chat Mic at 70 %.
const demoSoundcheck = { ducking: null, backup: false, levels: { 'out-goxlr-system': 0.63, 'in-goxlr-chat': 0.7 }, muted: {} };
export async function soundcheckReport() {
  if (isNative()) return invoke('soundcheck_report');
  const fmt = { rate: 48000, bits: 24, channels: 2, float: false };
  return {
    ducking: demoSoundcheck.ducking,
    ducking_backup: demoSoundcheck.backup,
    endpoints: demoDevices.map((d) => ({ ...d, volume: demoSoundcheck.levels[d.id] ?? 1, muted: !!demoSoundcheck.muted[d.id], format: d.flow === 'render' ? fmt : { ...fmt, channels: 1 } })),
  };
}
export async function soundcheckSetDucking(value) {
  if (isNative()) return invoke('soundcheck_set_ducking', { value });
  demoSoundcheck.backup = true;
  demoSoundcheck.ducking = value;
  return null;
}
export async function soundcheckRestoreDucking() {
  if (isNative()) return invoke('soundcheck_restore_ducking');
  demoSoundcheck.ducking = null;
  return null;
}
export async function soundcheckSetEndpoint(id, volume = null, mute = null) {
  if (isNative()) return invoke('soundcheck_set_endpoint', { id, volume, mute });
  if (volume != null) demoSoundcheck.levels[id] = volume;
  if (mute != null) demoSoundcheck.muted[id] = mute;
  return null;
}

// Home Assistant via MQTT (mqtt.rs). The browser demo pretends to be connected and keeps what
// would have been sent in window.studioDemo.mqtt (and .mqttCommand() acts as Home Assistant).
const demoMqtt = { status: { enabled: false, connected: false, broker: '', error: null }, sent: [] };
const demoMqttEvent = (detail) => window.dispatchEvent(new CustomEvent('studio-mqtt', { detail }));
if (typeof window !== 'undefined' && !isNative()) {
  window.studioDemo = { ...(window.studioDemo || {}), mqtt: demoMqtt, mqttCommand: (topic, payload) => demoMqttEvent({ type: 'command', topic, payload }) };
}

export async function mqttStart(config) {
  if (isNative()) return invoke('mqtt_start', { config });
  demoMqtt.status = { enabled: true, connected: true, broker: `${config.host.replace(/^mqtt:\/\//, '')}${/:\d+$/.test(config.host) ? '' : ':1883'}`, error: null };
  demoMqtt.sent = [];
  setTimeout(() => demoMqttEvent({ type: 'connected' }), 300);
  return null;
}

export async function mqttStop() {
  if (isNative()) return invoke('mqtt_stop');
  demoMqtt.status = { ...demoMqtt.status, enabled: false, connected: false, error: null };
  return null;
}

export async function mqttPublish(messages) {
  if (isNative()) return invoke('mqtt_publish', { messages });
  demoMqtt.sent.push(...messages);
  return messages.length;
}

export async function mqttStatus() {
  if (isNative()) return invoke('mqtt_status');
  return { ...demoMqtt.status };
}

/** connected(): (re)connected – announce everything; command({topic, payload}); status(s). */
export async function onMqttEvents({ connected, command, status }) {
  if (isNative()) {
    const { listen } = window.__TAURI__.event;
    await listen('mqtt-connected', () => connected());
    await listen('mqtt-command', (ev) => command(ev.payload));
    await listen('mqtt-status', (ev) => status(ev.payload));
    return;
  }
  window.addEventListener('studio-mqtt', (e) => {
    if (e.detail.type === 'connected') { status({ ...demoMqtt.status }); connected(); }
    if (e.detail.type === 'command') command({ topic: e.detail.topic, payload: e.detail.payload });
  });
}

// Live spectrum of an output (null = Windows' default output) for the EQ graph – spectrum.rs.
// The browser demo plays "music" on the Music output.
export async function spectrumRead(device) {
  if (isNative()) return invoke('spectrum_read', { device: device || null });
  const { demoSpectrum, SPECTRUM_BANDS, SPECTRUM_FLOOR } = await import('./spectrum.js');
  // The same outputs that move on the demo's VU meters (audioLevels below), the quieter ones lower.
  const offset = { 'out-goxlr-music': 0, 'out-goxlr-game': -4, 'out-goxlr-system': -9, 'out-goxlr-chat': -13 }[device || 'out-goxlr-music'];
  const playing = offset !== undefined;
  const t = performance.now() / 1000 + (offset || 0);
  return { device: device || '', rate: 48000, playing, error: null, bands: playing ? demoSpectrum(t).map((v) => v + offset) : new Array(SPECTRUM_BANDS).fill(SPECTRUM_FLOOR) };
}

// Peak level (0–1) per audio endpoint, for the VU meters.
export async function audioLevels() {
  if (isNative()) return invoke('audio_levels');
  const t = performance.now() / 1000;
  const wave = (base, speed) => Math.max(0, base * (0.75 + 0.25 * Math.sin(t * speed)) * (0.85 + Math.random() * 0.3));
  return { 'out-goxlr-music': wave(0.5, 2.1), 'out-goxlr-system': wave(0.2, 3.3), 'out-goxlr-chat': wave(0.12, 4.7), 'out-goxlr-game': wave(0.3, 1.7) };
}
