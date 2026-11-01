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
  } else if (task.action === 'uninstall') {
    demoEngine.kind = 'none'; demoEngine.uses_our_config = false; demoEngine.installed = new Set(); log.push('EQ-motoren er fjernet');
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

export async function apoListConfigs() {
  if (!isNative()) return [];
  return invoke('apo_list_configs');
}

export async function setHotkeys(bindings) {
  if (!isNative()) return bindings.map((b) => ({ id: b.id, ok: true, error: null }));
  return invoke('set_hotkeys', { bindings });
}

const DEMO_APPS = [
  { pid: 101, exe: 'Spotify.exe', path: 'C:\\Spotify\\Spotify.exe', output: 'out-goxlr-music', input: null },
  { pid: 102, exe: 'Discord.exe', path: 'C:\\Discord\\Discord.exe', output: 'out-goxlr-chat', input: 'in-goxlr-chat' },
  { pid: 103, exe: 'chrome.exe', path: 'C:\\Chrome\\chrome.exe', output: 'out-goxlr-old', input: null },
  { pid: 104, exe: 'cod.exe', path: 'C:\\Games\\cod.exe', output: 'out-goxlr-system', input: 'in-goxlr-chat' },
];
export async function appSessions() {
  if (isNative()) return invoke('app_sessions');
  return structuredClone(DEMO_APPS);
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

const demoDaemon = { started_by_us: false, foreign: ['C:\\Program Files\\GoXLR Utility\\goxlr-daemon.exe'] };
export async function daemonInfo() {
  if (isNative()) return invoke('daemon_info');
  return { bundled: true, version: '1.2.4', started_by_us: demoDaemon.started_by_us, process_running: true, foreign: [...demoDaemon.foreign], last_error: null };
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

export async function setTrayStatus(muted, tooltip) {
  if (isNative()) return invoke('set_tray_status', { muted, tooltip }).catch(() => {});
}

export async function appInfo() {
  if (isNative()) return invoke('app_info');
  return { version: '0.5.2', installed: false, browser: true };
}

// The newest release (GitHub's API shape). The app reads latest.json from the release – no hourly
// limit – and falls back to GitHub's API itself; the browser demo asks the API directly.
const RELEASES_API = 'https://api.github.com/repos/MRDonnii/goxlr-studio/releases/latest';
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
