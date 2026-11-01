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
const demoEngine = { kind: 'external', mode: 'lfx-gfx', uses_our_config: false, installed: new Set(['out-goxlr-system', 'out-goxlr-game', 'out-goxlr-chat', 'out-goxlr-music']) };

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
  };
}

// task: {action: 'install'|'set-devices', devices: [ids]} | {action: 'uninstall'|'use-external'|'restore-external'}
export async function engineTask(task) {
  if (isNative()) return invoke('engine_task', { task });
  await new Promise((r) => setTimeout(r, 600));
  const log = [];
  if (task.action === 'install') {
    if (demoEngine.kind === 'external') log.push('Equalizer APO’s config (inkl. Peace-presets) gemt', 'Den separate Equalizer APO er afinstalleret');
    demoEngine.kind = 'builtin'; demoEngine.uses_our_config = true; demoEngine.installed = new Set(task.devices);
    log.push('Motorfiler lagt i C:\\Program Files\\GoXLR Studio Engine', ...task.devices.map((d) => `EQ-motor sat på: ${demoDevices.find((x) => x.id === d)?.name || d}`), 'Windows-lydtjenesten er genstartet');
  } else if (task.action === 'set-devices') {
    demoEngine.installed = new Set(task.devices);
    if (task.mode) demoEngine.mode = task.mode;
    log.push(task.mode ? `EQ-motoren sat på igen (${task.mode})` : 'Udgange opdateret', 'Windows-lydtjenesten er genstartet');
  } else if (task.action === 'uninstall') {
    demoEngine.kind = 'none'; demoEngine.uses_our_config = false; demoEngine.installed = new Set(); log.push('EQ-motoren er fjernet');
  } else if (task.action === 'use-external') { demoEngine.uses_our_config = true; log.push('Equalizer APO læser nu GoXLR Studios EQ'); }
  else if (task.action === 'restore-external') { demoEngine.uses_our_config = false; log.push('Equalizer APO bruger igen sin egen config-mappe'); }
  return { ok: true, error: null, log, reboot: false };
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
  return invoke('apo_takeover', { enable });
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

export async function daemonInfo() {
  if (isNative()) return invoke('daemon_info');
  return { bundled: true, version: '1.2.4', started_by_us: false, process_running: true };
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
    tc_helicon: { installed: false, dir: null, profiles: [], mic_profiles: [] },
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
  return { version: '0.3.2', installed: false, browser: true };
}

export async function installUpdate(url, sha256) {
  if (!isNative()) throw new Error('Kun i Windows-appen');
  return invoke('install_update', { url, sha256 });
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

// Peak level (0–1) per audio endpoint, for the VU meters.
export async function audioLevels() {
  if (isNative()) return invoke('audio_levels');
  const t = performance.now() / 1000;
  const wave = (base, speed) => Math.max(0, base * (0.75 + 0.25 * Math.sin(t * speed)) * (0.85 + Math.random() * 0.3));
  return { 'out-goxlr-music': wave(0.5, 2.1), 'out-goxlr-system': wave(0.2, 3.3), 'out-goxlr-chat': wave(0.12, 4.7), 'out-goxlr-game': wave(0.3, 1.7) };
}
