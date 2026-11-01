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

export async function engineStatus() {
  if (isNative()) return invoke('output_eq_status');
  return { available: false, reason: 'Browser-tilstand – lydmotoren findes kun i Windows-appen.' };
}

export async function apoTakeover(enable) {
  if (!isNative()) throw new Error('Kun i Windows-appen');
  return invoke('apo_takeover', { enable });
}

export async function apoReadConfig() {
  if (!isNative()) throw new Error('Kun i Windows-appen');
  return invoke('apo_read_config');
}

export async function apoOpenConfigurator() {
  return invoke('apo_open_configurator');
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
