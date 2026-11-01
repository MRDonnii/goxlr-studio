import { GoXLRConnection } from './api.js';
import { h, Binder, toast, icon, ICONS } from './ui.js';
import { mixerView, routingView, devicesView } from './views-mixer.js';
import { micView } from './views-mic.js';
import { outputEqView, loadOutputEqState } from './views-outeq.js';
import { effectsView, scenesView, lightingView, profilesView, settingsView, applyScene } from './views-misc.js';
import { storeGet, storeSet, isNative, listAudioDevices, setDefaultDevice, setOutputEqEngine } from './native.js';
import { shortName } from './views-mixer.js';

const PAGES = [
  { id: 'mixer', title: 'Mixer', icon: 'mixer', view: mixerView },
  { id: 'mic', title: 'Mikrofon', icon: 'mic', view: micView },
  { id: 'outeq', title: 'Afspilnings-EQ', icon: 'eq', view: outputEqView },
  { id: 'routing', title: 'Routing', icon: 'routing', view: routingView },
  { id: 'devices', title: 'Lydenheder', icon: 'routing', view: devicesView },
  { id: 'effects', title: 'Effekter', icon: 'fx', view: effectsView },
  { id: 'scenes', title: 'Scener', icon: 'scenes', view: scenesView },
  { id: 'lighting', title: 'Lys', icon: 'light', view: lightingView },
  { id: 'profiles', title: 'Profiler', icon: 'profile', view: profilesView },
  { id: 'settings', title: 'Indstillinger', icon: 'settings', view: settingsView },
];

class Ducker {
  constructor(conn) {
    this.conn = conn;
    this.settings = { enabled: false, targets: ['Music', 'Game'], amount: 50, threshold: -35, hold: 900 };
    this.active = false;
    this.base = null;
    this.lastVoice = 0;
  }
  async load() { Object.assign(this.settings, await storeGet('ducking', {})); }
  save() {
    storeSet('ducking', this.settings);
    if (!this.settings.enabled && this.active) this.release();
  }
  tick(db) {
    const s = this.settings;
    const m = this.conn.mixer;
    if (!s.enabled || db == null || !m) return false;
    const now = performance.now();
    if (db > s.threshold) {
      this.lastVoice = now;
      if (!this.active) {
        this.active = true;
        this.base = Object.fromEntries(s.targets.map((c) => [c, m.levels.volumes[c]]));
        for (const [c, v] of Object.entries(this.base)) this.conn.command('SetVolume', c, Math.round(v * (1 - s.amount / 100)));
        return true;
      }
    } else if (this.active && now - this.lastVoice > s.hold) {
      this.release();
      return true;
    }
    return false;
  }
  release() {
    if (this.base) for (const [c, v] of Object.entries(this.base)) this.conn.command('SetVolume', c, v);
    this.active = false;
    this.base = null;
  }
}

const conn = new GoXLRConnection();
const ctx = {
  conn,
  binder: new Binder(),
  cleanup: [],
  ducker: new Ducker(conn),
  prefs: { pinnedDevices: [], autostart: false, closeToTray: true },
  scenes: [],
  outputEq: null,
  onMicLevel: null,
  navigate: (id) => navigate(id),
  savePrefs: () => storeSet('prefs', ctx.prefs),
  saveScenes: () => storeSet('scenes', ctx.scenes),
  applyOutputEq: () => setOutputEqEngine({ ...ctx.outputEq.slots[ctx.outputEq.active], target: ctx.outputEq.target }).catch(() => {}),
};

let current = null;

function buildNav() {
  const nav = document.getElementById('nav');
  nav.replaceChildren(...PAGES.map((p) => h('button', { 'data-id': p.id, onclick: () => navigate(p.id) }, icon(ICONS[p.icon]), p.title)));
}

function navigate(id) {
  const page = PAGES.find((p) => p.id === id) || PAGES[0];
  current = page.id;
  localStorage.setItem('studio.page', current);
  for (const b of document.querySelectorAll('#nav button')) b.classList.toggle('active', b.dataset.id === current);
  document.getElementById('title').textContent = page.title;
  mount();
}

function mount() {
  ctx.cleanup.splice(0).forEach((fn) => fn());
  ctx.binder = new Binder();
  ctx.onMicLevel = null;
  ctx.refreshDevices = null;
  const view = document.getElementById('view');
  if (!conn.mixer) {
    view.replaceChildren(h('div', { class: 'card' }, conn.mode === 'connecting' ? 'Forbinder til GoXLR…' : 'Ingen GoXLR fundet. Tjek at GoXLR Utility kører og at mixeren er tilsluttet.'));
    return;
  }
  const page = PAGES.find((p) => p.id === current);
  view.replaceChildren(page.view(ctx));
  renderTopActions();
}

function renderTopActions() {
  const top = document.getElementById('top-actions');
  const sceneBtns = ctx.scenes.slice(0, 4).map((s) => h('button', { class: 'btn sm', style: { borderColor: s.color }, onclick: () => applyScene(ctx, s) }, s.name));
  top.replaceChildren(...sceneBtns,
    h('button', { class: 'btn sm', title: 'Kommandoer (Ctrl+K)', onclick: openPalette }, icon(ICONS.search), ' Ctrl+K'));
  top.querySelector('svg')?.setAttribute('style', 'width:14px;height:14px;vertical-align:-2px');
}

function updateChrome() {
  const el = document.getElementById('conn');
  el.className = `conn ${conn.mode}`;
  el.querySelector('.label').textContent = conn.mode === 'live' ? 'Forbundet' : conn.mode === 'demo' ? 'Demo-tilstand' : 'Forbinder…';
  const m = conn.mixer;
  document.getElementById('device').textContent = m ? `${m.hardware.device_type === 'Mini' ? 'GoXLR Mini' : 'GoXLR'} · ${m.profile_name}` : '';
}

let lastSerial = null;
let lastMode = null;
conn.addEventListener('change', () => {
  updateChrome();
  if (conn.serial !== lastSerial || conn.mode !== lastMode) {
    lastSerial = conn.serial;
    lastMode = conn.mode;
    mount();
    return;
  }
  ctx.binder.run();
});
conn.addEventListener('error', (e) => toast(e.detail));

// ---------- mic meter + ducking ----------
let demoPhase = 0;
async function meterLoop() {
  let db = null;
  if (conn.mode === 'live') db = await conn.micLevel().catch(() => null);
  else if (conn.mode === 'demo') {
    demoPhase += 1;
    const talking = Math.sin(demoPhase / 23) > 0.2;
    db = talking ? -22 - Math.random() * 12 : -62 - Math.random() * 6;
  }
  ctx.onMicLevel?.(db);
  if (ctx.ducker.tick(db)) ctx.binder.run();
  setTimeout(meterLoop, conn.mode === 'live' ? 70 : 90);
}

// ---------- command palette ----------
function paletteActions() {
  const acts = PAGES.map((p) => ({ label: `Gå til ${p.title}`, run: () => navigate(p.id) }));
  ctx.scenes.forEach((s) => acts.push({ label: `Scene: ${s.name}`, run: () => applyScene(ctx, s) }));
  const m = conn.mixer;
  if (m) {
    for (const f of ['A', 'B', 'C', 'D']) {
      const fs = m.fader_status[f];
      acts.push({ label: `${fs.mute_state === 'Unmuted' ? 'Mute' : 'Unmute'} fader ${f} (${fs.scribble?.bottom_text || fs.channel})`, run: () => conn.command('SetFaderMuteState', f, fs.mute_state === 'Unmuted' ? 'MutedToX' : 'Unmuted') });
    }
    acts.push({ label: m.cough_button.state === 'Unmuted' ? 'Mute mikrofon' : 'Unmute mikrofon', run: () => conn.command('SetCoughMuteState', m.cough_button.state === 'Unmuted' ? 'MutedToX' : 'Unmuted') });
    if (m.effects) acts.push({ label: m.effects.is_enabled ? 'Slå effekter fra' : 'Slå effekter til', run: () => conn.command('SetFXEnabled', !m.effects.is_enabled) });
    (conn.status.files?.profiles || []).forEach((p) => acts.push({ label: `Indlæs profil: ${p}`, run: () => conn.command('LoadProfile', p, true) }));
  }
  if (ctx.outputEq) {
    acts.push({ label: 'Afspilnings-EQ til/fra', run: () => { const e = ctx.outputEq.slots[ctx.outputEq.active]; e.enabled = !e.enabled; storeSet('output-eq', ctx.outputEq); ctx.applyOutputEq(); if (current === 'outeq') mount(); } });
    Object.keys(ctx.outputEq.presets).forEach((n) => acts.push({ label: `EQ-preset: ${n}`, run: () => {
      ctx.outputEq.slots[ctx.outputEq.active] = structuredClone(ctx.outputEq.presets[n]);
      ctx.outputEq.presetName = n; storeSet('output-eq', ctx.outputEq); ctx.applyOutputEq(); if (current === 'outeq') mount();
    } }));
  }
  acts.push({ label: `Auto-ducking ${ctx.ducker.settings.enabled ? 'fra' : 'til'}`, run: () => { ctx.ducker.settings.enabled = !ctx.ducker.settings.enabled; ctx.ducker.save(); ctx.binder.run(); } });
  return acts;
}

async function openPalette() {
  if (document.querySelector('.palette')) return;
  const acts = paletteActions();
  const devs = await listAudioDevices().catch(() => []);
  devs.forEach((d) => acts.push({ label: `${d.flow === 'render' ? 'Udgang' : 'Mikrofon'}: ${shortName(d.name)}`, run: () => setDefaultDevice(d.id, 'all').then(() => ctx.refreshDevices?.()) }));
  const input = h('input', { type: 'text', placeholder: 'Skriv en kommando…' });
  const list = h('div', { class: 'palette-list' });
  let sel = 0;
  let filtered = acts;
  const close = () => wrap.remove();
  const render = () => {
    const q = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    filtered = acts.filter((a) => q.every((t) => a.label.toLowerCase().includes(t)));
    sel = Math.min(sel, Math.max(filtered.length - 1, 0));
    list.replaceChildren(...filtered.slice(0, 50).map((a, i) => h('div', { class: `palette-item ${i === sel ? 'sel' : ''}`, onclick: () => { close(); a.run(); } }, a.label)));
    list.children[sel]?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { sel = 0; render(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, filtered.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter') { const a = filtered[sel]; close(); a?.run(); }
    else if (e.key === 'Escape') close();
  });
  const wrap = h('div', { class: 'palette', onclick: (e) => { if (e.target === wrap) close(); } }, h('div', { class: 'palette-box' }, input, list));
  document.body.append(wrap);
  render();
  input.focus();
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (e.ctrlKey && e.altKey && /^[1-9]$/.test(e.key) && !isNative()) {
    const s = ctx.scenes[Number(e.key) - 1];
    if (s && conn.mixer) { e.preventDefault(); applyScene(ctx, s); }
  }
});

async function registerNativeHooks() {
  if (!isNative()) return;
  const { listen } = window.__TAURI__.event;
  await listen('scene-hotkey', (ev) => {
    const s = ctx.scenes[ev.payload];
    if (s && conn.mixer) applyScene(ctx, s);
  });
  await listen('tray-action', (ev) => {
    const m = conn.mixer;
    if (!m) return;
    if (ev.payload === 'mute-mic') conn.command('SetCoughMuteState', m.cough_button.state === 'Unmuted' ? 'MutedToX' : 'Unmuted');
    if (ev.payload?.startsWith?.('scene:')) {
      const s = ctx.scenes.find((x) => x.id === ev.payload.slice(6));
      if (s) applyScene(ctx, s);
    }
  });
  const syncScenes = () => window.__TAURI__.core.invoke('set_scenes', { scenes: ctx.scenes.map((s) => ({ id: s.id, name: s.name })) }).catch(() => {});
  const orig = ctx.saveScenes;
  ctx.saveScenes = () => { orig(); syncScenes(); renderTopActions(); };
  syncScenes();
}

async function boot() {
  buildNav();
  const [prefs, scenes, outputEq] = await Promise.all([storeGet('prefs', {}), storeGet('scenes', []), loadOutputEqState(), ctx.ducker.load()]);
  Object.assign(ctx.prefs, prefs);
  ctx.scenes = scenes;
  ctx.outputEq = outputEq;
  if (!isNative()) { const orig = ctx.saveScenes; ctx.saveScenes = () => { orig(); renderTopActions(); }; }
  await registerNativeHooks();
  ctx.applyOutputEq();
  current = localStorage.getItem('studio.page') || 'mixer';
  navigate(current);
  conn.start();
  meterLoop();
}

boot();
