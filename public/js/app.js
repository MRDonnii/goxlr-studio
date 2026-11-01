import { GoXLRConnection } from './api.js';
import { h, Binder, toast, icon, ICONS } from './ui.js';
import { mixerView, routingView, devicesView } from './views-mixer.js';
import { micView } from './views-mic.js';
import { outputEqView, loadOutputEqState } from './views-outeq.js';
import { effectsView, scenesView, lightingView, profilesView, settingsView, applyScene } from './views-misc.js';
import { storeGet, storeSet, isNative, setOutputEqEngine, setHotkeys, setTray } from './native.js';
import { hotkeysView, accelFromEvent, prettyAccel } from './views-hotkeys.js';
import { appsView, startAppRules } from './views-apps.js';
import { runAction, actionCatalog, applyEqPreset, toggleEq, eqPresetNames } from './actions.js';
import { BUILTIN_PRESETS } from './eq.js';

const PAGES = [
  { id: 'mixer', title: 'Mixer', icon: 'mixer', view: mixerView },
  { id: 'mic', title: 'Mikrofon', icon: 'mic', view: micView },
  { id: 'outeq', title: 'Afspilnings-EQ', icon: 'eq', view: outputEqView },
  { id: 'routing', title: 'Routing', icon: 'routing', view: routingView },
  { id: 'devices', title: 'Lydenheder', icon: 'routing', view: devicesView },
  { id: 'apps', title: 'Lyd pr. app', icon: 'apps', view: appsView },
  { id: 'effects', title: 'Effekter', icon: 'fx', view: effectsView, hidden: (m) => m?.hardware?.device_type === 'Mini' },
  { id: 'scenes', title: 'Scener', icon: 'scenes', view: scenesView },
  { id: 'lighting', title: 'Lys', icon: 'light', view: lightingView },
  { id: 'profiles', title: 'Profiler', icon: 'profile', view: profilesView },
  { id: 'hotkeys', title: 'Genveje', icon: 'key', view: hotkeysView },
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
  hotkeys: [],
  hotkeyStatus: {},
  appRules: [],
  capturingHotkey: false,
  outputEq: null,
  onMicLevel: null,
  navigate: (id) => navigate(id),
  savePrefs: () => storeSet('prefs', ctx.prefs),
  saveScenes: () => { storeSet('scenes', ctx.scenes); syncTray(); renderTopActions(); },
  saveHotkeys: () => { storeSet('hotkeys', ctx.hotkeys); return registerHotkeys(); },
  saveAppRules: () => storeSet('app-rules', ctx.appRules),
  pauseHotkeys: () => setHotkeys([]).catch(() => {}),
  resumeHotkeys: () => registerHotkeys(),
  runAction: (id) => Promise.resolve(runAction(ctx, id)).catch((e) => toast(String(e))),
  onStateChanged: (kind) => {
    syncTray();
    renderTopActions();
    if (kind === 'eq' && current === 'outeq') mount();
  },
  applyOutputEq: () => setOutputEqEngine({ ...ctx.outputEq.slots[ctx.outputEq.active], target: ctx.outputEq.target }).catch(() => {}),
};

// ---------- hotkeys ----------
async function registerHotkeys() {
  const active = ctx.hotkeys.filter((b) => b.accel && b.action).map(({ id, accel }) => ({ id, accel }));
  const res = await setHotkeys(active).catch((e) => active.map((b) => ({ id: b.id, ok: false, error: String(e) })));
  ctx.hotkeyStatus = Object.fromEntries(res.map((r) => [r.id, r]));
  const failed = res.filter((r) => !r.ok);
  if (failed.length && !ctx.capturingHotkey) {
    const names = failed.map((r) => prettyAccel(ctx.hotkeys.find((b) => b.id === r.id)?.accel)).join(', ');
    toast(`Kunne ikke registrere: ${names} (bruges af et andet program?)`);
  }
  return ctx.hotkeyStatus;
}

function defaultHotkeys(scenes) {
  // Same keys the app used before bindings became configurable.
  return [
    { id: crypto.randomUUID(), accel: 'Ctrl+Alt+M', action: 'mute-mic' },
    ...scenes.slice(0, 9).map((s, i) => ({ id: crypto.randomUUID(), accel: `Ctrl+Alt+${i + 1}`, action: `scene:${s.id}` })),
  ];
}

function hotkeyFor(action) {
  return ctx.hotkeys.find((b) => b.action === action && b.accel)?.accel || null;
}
ctx.hotkeyFor = hotkeyFor;

// ---------- tray ----------
let trayKey = '';
function syncTray() {
  const m = conn.mixer;
  const eq = ctx.outputEq?.slots[ctx.outputEq.active];
  const model = {
    scenes: ctx.scenes.map((s) => ({ id: s.id, name: s.name })),
    profiles: m ? conn.status.files?.profiles || [] : [],
    active_profile: m?.profile_name || null,
    eq_presets: ctx.outputEq ? eqPresetNames(ctx) : [],
    active_eq: ctx.outputEq?.presetName || null,
    eq_enabled: !!eq?.enabled,
  };
  const key = JSON.stringify(model);
  if (key === trayKey) return;
  trayKey = key;
  setTray(model);
}

let current = null;

const visiblePages = () => PAGES.filter((p) => !p.hidden?.(conn.mixer));

let navKey = '';
function buildNav() {
  const pages = visiblePages();
  const key = pages.map((p) => p.id).join();
  if (key === navKey) return;
  navKey = key;
  const nav = document.getElementById('nav');
  nav.replaceChildren(...pages.map((p) => h('button', { 'data-id': p.id, class: p.id === current ? 'active' : '', onclick: () => navigate(p.id) }, icon(ICONS[p.icon]), p.title)));
}

function navigate(id) {
  const page = visiblePages().find((p) => p.id === id) || PAGES[0];
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
  buildNav();
  if (current && !visiblePages().some((p) => p.id === current)) { navigate('mixer'); return; }
  if (!conn.mixer) {
    view.replaceChildren(h('div', { class: 'card' }, conn.mode === 'connecting' ? 'Forbinder til GoXLR…' : 'Ingen GoXLR fundet. Tjek at GoXLR Utility kører og at mixeren er tilsluttet.'));
    return;
  }
  const page = PAGES.find((p) => p.id === current);
  view.replaceChildren(page.view(ctx));
  renderTopActions();
}

// Quick switches in the top bar: GoXLR profile, EQ preset and scenes – always one click away.
function renderTopActions() {
  const top = document.getElementById('top-actions');
  const m = conn.mixer;
  const parts = [];
  const profiles = m ? conn.status.files?.profiles || [] : [];
  if (profiles.length) {
    const tip = (p) => { const k = hotkeyFor(`profile:${p}`); return k ? `${p} (${prettyAccel(k)})` : p; };
    parts.push(profiles.length <= 4
      ? h('div', { class: 'seg quick', title: 'GoXLR-profil' }, profiles.map((p) => h('button', { class: p === m.profile_name ? 'on' : '', title: tip(p), onclick: () => ctx.runAction(`profile:${p}`) }, p)))
      : h('select', { class: 'quick', title: 'GoXLR-profil', onchange: (e) => ctx.runAction(`profile:${e.target.value}`) },
        profiles.map((p) => h('option', { value: p, selected: p === m.profile_name }, p))));
  }
  if (ctx.outputEq) {
    const eq = ctx.outputEq.slots[ctx.outputEq.active];
    const mine = Object.keys(ctx.outputEq.presets);
    const builtin = Object.keys(BUILTIN_PRESETS).filter((n) => !mine.includes(n));
    const active = ctx.outputEq.presetName;
    const opt = (n) => h('option', { value: n, selected: n === active }, n);
    const sel = h('select', { class: 'quick', title: 'Afspilnings-EQ preset', onchange: () => applyEqPreset(ctx, sel.value) },
      !active || ![...mine, ...builtin].includes(active) ? h('option', { value: '', selected: true, disabled: true }, 'Tilpasset EQ') : null,
      mine.length ? h('optgroup', { label: 'Mine' }, mine.map(opt)) : null,
      h('optgroup', { label: 'Indbyggede' }, builtin.map(opt)));
    parts.push(h('div', { class: 'quick-eq' },
      h('button', { class: `btn sm eq-pill ${eq.enabled ? 'on' : ''}`, title: 'EQ til/fra', onclick: () => toggleEq(ctx) }, icon(ICONS.eq), eq.enabled ? 'EQ' : 'EQ fra'),
      sel));
  }
  parts.push(...ctx.scenes.slice(0, 3).map((s) => h('button', { class: 'btn sm', style: { borderColor: s.color }, onclick: () => applyScene(ctx, s) }, s.name)));
  parts.push(h('button', { class: 'btn sm', title: 'Kommandoer (Ctrl+K)', onclick: openPalette }, icon(ICONS.search), ' Ctrl+K'));
  top.replaceChildren(...parts);
  for (const svg of top.querySelectorAll('svg')) svg.setAttribute('style', 'width:14px;height:14px;vertical-align:-2px');
}

let topKey = '';
function topActionsKey() {
  const m = conn.mixer;
  return JSON.stringify([m?.profile_name, conn.status?.files?.profiles]);
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
  syncTray();
  const k = topActionsKey();
  if (k !== topKey) { topKey = k; renderTopActions(); }
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
async function paletteActions() {
  const acts = visiblePages().map((p) => ({ label: `Gå til ${p.title}`, run: () => navigate(p.id) }));
  for (const g of await actionCatalog(ctx)) {
    for (const i of g.items) {
      const k = hotkeyFor(i.id);
      acts.push({ label: `${g.title}: ${i.label}`, key: k ? prettyAccel(k) : null, run: () => ctx.runAction(i.id) });
    }
  }
  return acts;
}

async function openPalette() {
  if (document.querySelector('.palette')) return;
  const acts = await paletteActions();
  const input = h('input', { type: 'text', placeholder: 'Skriv en kommando…' });
  const list = h('div', { class: 'palette-list' });
  let sel = 0;
  let filtered = acts;
  const close = () => wrap.remove();
  const render = () => {
    const q = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    filtered = acts.filter((a) => q.every((t) => a.label.toLowerCase().includes(t)));
    sel = Math.min(sel, Math.max(filtered.length - 1, 0));
    list.replaceChildren(...filtered.slice(0, 50).map((a, i) => h('div', { class: `palette-item ${i === sel ? 'sel' : ''}`, onclick: () => { close(); a.run(); } }, h('span', {}, a.label), a.key ? h('span', { class: 'kbd' }, a.key) : null)));
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
  if (ctx.capturingHotkey) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  // In the Windows app the OS delivers the global shortcuts; in a browser tab they only work while focused.
  if (isNative() || document.querySelector('.palette')) return;
  if (e.target.matches?.('input, select, textarea') && !e.ctrlKey && !e.altKey) return;
  const accel = accelFromEvent(e);
  const b = accel && ctx.hotkeys.find((x) => x.accel === accel && x.action);
  if (b) { e.preventDefault(); ctx.runAction(b.action); }
});

async function registerNativeHooks() {
  if (!isNative()) return;
  const { listen } = window.__TAURI__.event;
  await listen('hotkey', (ev) => {
    const b = ctx.hotkeys.find((x) => x.id === ev.payload);
    if (b?.action) ctx.runAction(b.action);
  });
  // Tray ids are action ids: profile:…, eq-preset:…, eq-toggle, scene:…, mute-mic.
  await listen('tray-action', (ev) => { if (typeof ev.payload === 'string') ctx.runAction(ev.payload); });
}

async function boot() {
  const [prefs, scenes, outputEq, hotkeys, appRules] = await Promise.all([
    storeGet('prefs', {}), storeGet('scenes', []), loadOutputEqState(), storeGet('hotkeys', null), storeGet('app-rules', []), ctx.ducker.load()]);
  Object.assign(ctx.prefs, prefs);
  ctx.scenes = scenes;
  ctx.outputEq = outputEq;
  ctx.appRules = appRules;
  ctx.hotkeys = hotkeys || defaultHotkeys(scenes);
  if (!hotkeys) storeSet('hotkeys', ctx.hotkeys);
  buildNav();
  await registerNativeHooks();
  registerHotkeys();
  syncTray();
  startAppRules(ctx);
  ctx.applyOutputEq();
  current = localStorage.getItem('studio.page') || 'mixer';
  navigate(current);
  conn.start();
  meterLoop();
}

boot();
