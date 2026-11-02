import { GoXLRConnection } from './api.js';
import { h, Binder, toast, icon, ICONS, logActivity, confirmDialog, infoDialog } from './ui.js';
import { mixerView, routingView, devicesView } from './views-mixer.js';
import { micView } from './views-mic.js';
import { outputEqView, loadOutputEqState } from './views-outeq.js';
import { effectsView, scenesView, lightingView, profilesView, settingsView, applyScene, snapshotProfiles } from './views-misc.js';
import { storeGet, storeSet, isNative, setOutputEqEngine, setHotkeys, setTray, showOsd, setApi, apiPublish, setTrayStatus, appInfo, installUpdate, latestRelease, updateResult, takeLaunchAction, driverInfo, startDaemon, engineStatus, engineInfo, engineTask, listAudioDevices, openUrl, audioLevels } from './native.js';
import { diagView } from './views-diag.js';
import { soundcheckView } from './views-soundcheck.js';
import { deckView } from './views-deck.js';
import { pedalsView } from './views-pedals.js';
import { loadPedals, startPedals, keyPedal, savePedals } from './pedals.js';
import { soundsView } from './views-sounds.js';
import { migrateView } from './views-migrate.js';
import { startDiscordSync } from './discord.js';
import { applyStartLevels } from './startlevels.js';
import { playbackOffset } from './eqchain.js';
import { dbToMeter, notesFor, markdownBlocks, channelEndpoint, enginePayload, resolveDevice, deviceName, compareVersions, pickUpdateAsset, takeoverMessage, updateOutcome, micIsMuted, mutedSpeechThreshold } from './extras.js';
import { hotkeysView, accelFromEvent, prettyAccel } from './views-hotkeys.js';
import { appsView, startAppRules } from './views-apps.js';
import { startDeviceTriggers } from './devicetriggers.js';
import { startMqtt } from './mqtt.js';
import { startHearing } from './hearing.js';
import { obsFollowProfile } from './obs.js';
import { setLanguage, resolveLanguage, t, language } from './i18n.js';
import { applyTheme, watchTheme } from './theme.js';
import { startMediaWatch } from './media.js';
import { startSchedule } from './schedule.js';
import { startMicLimiter } from './miclimiter.js';
import { runAction, actionCatalog, applyEqPreset, toggleEq, eqPresetNames, releaseAction, pttMuteState } from './actions.js';
import { BUILTIN_PRESETS } from './eq.js';
import { engineConfig, usesChannelEq, hasProfileSets } from './channeleq.js';
import { levelOffsets } from './levelmatch.js';

const PAGES = [
  { id: 'mixer', title: 'Mixer', icon: 'mixer', view: mixerView },
  { id: 'mic', title: 'Mikrofon', icon: 'mic', view: micView },
  { id: 'outeq', title: 'Afspilnings-EQ', icon: 'eq', view: outputEqView },
  { id: 'routing', title: 'Routing', icon: 'routing', view: routingView },
  { id: 'devices', title: 'Lydenheder', icon: 'routing', view: devicesView },
  { id: 'apps', title: 'Lyd pr. app', icon: 'apps', view: appsView },
  { id: 'effects', title: 'Effekter', icon: 'fx', view: effectsView, hidden: (m) => m?.hardware?.device_type === 'Mini' },
  { id: 'scenes', title: 'Scener', icon: 'scenes', view: scenesView },
  { id: 'sounds', title: 'Lydbank', icon: 'sound', view: soundsView },
  { id: 'lighting', title: 'Lys', icon: 'light', view: lightingView },
  { id: 'profiles', title: 'Profiler', icon: 'profile', view: profilesView },
  { id: 'hotkeys', title: 'Genveje', icon: 'key', view: hotkeysView },
  { id: 'deck', title: 'Stream Deck', icon: 'deck', view: deckView },
  { id: 'pedals', title: 'Fodpedal', icon: 'pedal', view: pedalsView },
  { id: 'migrate', title: 'Overflytning', icon: 'move', view: migrateView },
  { id: 'soundcheck', title: 'Lydtjek', icon: 'check', view: soundcheckView },
  { id: 'diag', title: 'Diagnose', icon: 'diag', view: diagView },
  { id: 'settings', title: 'Indstillinger', icon: 'settings', view: settingsView },
];

class Ducker {
  constructor(conn) {
    this.conn = conn;
    // chat: duck while the friends talk (the GoXLR's Chat output), not only while you talk.
    this.settings = { enabled: false, targets: ['Music', 'Game'], amount: 50, threshold: -35, hold: 900, chat: { enabled: false, threshold: -45 } };
    this.active = false;
    this.base = null;
    this.lastVoice = 0;
  }
  async load() {
    const saved = await storeGet('ducking', {});
    Object.assign(this.settings, saved, { chat: { ...this.settings.chat, ...(saved?.chat || {}) } });
  }
  get on() { return this.settings.enabled || !!this.settings.chat?.enabled; }
  save() {
    storeSet('ducking', this.settings);
    if (!this.on && this.active) this.release();
  }
  /** db = your mic (dB), chatDb = the Chat output's peak (dB) – either can start the ducking. */
  tick(db, chatDb = null) {
    const s = this.settings;
    const m = this.conn.mixer;
    if (!this.on || !m) return false;
    const now = performance.now();
    const voice = (s.enabled && db != null && db > s.threshold) || (s.chat?.enabled && chatDb != null && chatDb > s.chat.threshold);
    if (voice) {
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
  prefs: { pinnedDevices: [], autostart: false, closeToTray: true, osd: true, autoStartDaemon: true, autoUpdate: true, fixStaleApps: false },
  scenes: [],
  hotkeys: [],
  hotkeyStatus: {},
  appRules: [],
  appTriggers: [],
  deviceTriggers: [],
  updateState: {},
  apiError: null,
  capturingHotkey: false,
  outputEq: null,
  onMicLevel: null,
  navigate: (id) => navigate(id),
  savePrefs: () => storeSet('prefs', ctx.prefs),
  renderBanners: () => renderBanners(),
  saveScenes: () => { storeSet('scenes', ctx.scenes); syncTray(); renderTopActions(); },
  saveHotkeys: () => { storeSet('hotkeys', ctx.hotkeys); return registerHotkeys(); },
  saveAppRules: () => storeSet('app-rules', ctx.appRules),
  saveAppTriggers: () => storeSet('app-triggers', ctx.appTriggers),
  notify: (text, kind = 'info') => {
    toast(text, 'info');
    if (ctx.prefs.osd !== false) showOsd(t(text), kind);
  },
  // Sprog / language: switches at once (the page is drawn again in the new language).
  setLanguage: (pref) => {
    ctx.prefs.lang = pref;
    ctx.savePrefs();
    setLanguage(resolveLanguage(pref));
    trayKey = '';
    trayStatusKey = '';
    navKey = '';
    topKey = '';
    syncTray();
    syncTrayStatus();
    buildNav();
    renderTopActions();
    renderBanners();
    navigate(current);
  },
  checkUpdate: (manual) => checkUpdate(manual),
  installUpdate: () => doInstallUpdate(),
  applyApi: () => applyApi(),
  onApoChanged: (takenOver) => { ctx.prefs.apoExpected = takenOver; ctx.savePrefs(); ctx.apoLost = false; renderBanners(); },
  pauseHotkeys: () => setHotkeys([]).catch(() => {}),
  resumeHotkeys: () => registerHotkeys(),
  registerHotkeys: () => registerHotkeys(),
  savePedals: () => savePedals(ctx),
  runAction: (id, source) => Promise.resolve(runAction(ctx, id, source)).catch((e) => toast(String(e))),
  onStateChanged: (kind) => {
    syncTray();
    syncTrayStatus();
    publishApi();
    renderTopActions();
    if (kind === 'eq' && current === 'outeq') mount();
  },
  applyOutputEq: () => applyOutputEq(),
  playbackEq: () => playbackEq(),
};

// The EQ target is stored by id and name, so it survives GoXLR driver updates that change ids.
async function applyOutputEq() {
  const st = ctx.outputEq;
  let target = st.target;
  // EQ pr. kanal needs the GoXLR's Windows outputs (found by name, so driver updates don't matter).
  const devs = target || usesChannelEq(st) || Object.keys(levelOffsets(st)).length ? await listAudioDevices().catch(() => []) : [];
  if (target) {
    const r = resolveDevice(devs, target, st.target_name, 'render');
    if (r && r !== target) { st.target = target = r; storeSet('output-eq', st); }
    if (r && !st.target_name) { st.target_name = deviceName(devs, r); storeSet('output-eq', st); }
  }
  return setOutputEqEngine(engineConfig(st, { devices: devs, profile: conn.mixer?.profile_name || null, target }));
}

// What the engine plays: the active slot with Loudness/Crossfeed and the preamp offset from the
// clip guard (eqchain.js). The EQ page's Lyttetest plays the same.
function playbackEq(target = null) {
  const st = ctx.outputEq;
  return enginePayload(st.slots[st.active], st.extras, target, playbackOffset(st));
}

// ---------- updates ----------
async function checkUpdate(manual = false) {
  const u = ctx.updateState;
  try {
    const info = await appInfo();
    u.current = info.version;
    u.installed = info.installed;
    const rel = await latestRelease();
    const asset = pickUpdateAsset(rel, info.installed);
    Object.assign(u, { latest: rel.tag_name, notes: rel.body || '', url: rel.html_url, asset, error: null, checkedAt: Date.now() });
    u.available = compareVersions(rel.tag_name, info.version) > 0 && !!asset;
    if (manual) toast(u.available ? `Version ${rel.tag_name} er klar` : 'Du har den nyeste version', 'info');
    if (u.available && isNative() && ctx.prefs.autoUpdate !== false && document.hidden) doInstallUpdate(true);
  } catch (e) {
    u.error = String(e.message || e);
    u.checkedAt = Date.now();
    if (manual) toast(`Opdatering: ${u.error}`);
  }
  ctx.onUpdateState?.();
  renderBanners();
}

// `background`: started by the automatic update while the app is in the tray.
async function doInstallUpdate(background = false) {
  const u = ctx.updateState;
  if (!u.asset) return;
  if (!isNative()) { window.open(u.url, '_blank'); return; }
  u.installing = true;
  renderBanners();
  logActivity(`Opdatering til ${u.latest} startet (${background ? 'automatisk' : 'manuelt'})`);
  toast(`Henter ${u.latest}… GoXLR Studio lukker, installerer og starter igen af sig selv`, 'info');
  try { await installUpdate(u.asset.url, u.asset.sha256, u.latest, background); } catch (e) { u.installing = false; toast(`Opdatering fejlede: ${e}`); renderBanners(); }
}

// "Du er muted!": while the mic is muted, listen to the GoXLR's meter; speech for about a second
// shows a notice over the game (at most every 20 s). Nothing is polled while the mic is open.
function startMutedReminder() {
  let talk = 0;
  let last = 0;
  setInterval(async () => {
    const m = conn.mixer;
    if (ctx.prefs.mutedReminder === false || conn.mode !== 'live' || !m || ctx.lockMuted || !micIsMuted(m)) { talk = 0; return; }
    const db = await conn.micLevel().catch(() => null);
    talk = Number.isFinite(db) && db > mutedSpeechThreshold(m) ? talk + 1 : Math.max(0, talk - 1);
    if (talk >= 3 && Date.now() - last > 20000) {
      last = Date.now(); talk = 0;
      ctx.notify('Du er muted – mikrofonen er slået fra', 'mute');
    }
  }, 300);
}

// Win+L: mute the mic (to everything) while the pc is locked, and open it again on unlock – only
// if GoXLR Studio muted it. With Discord "stum og døv", Discord follows.
function onSessionLock(locked) {
  const m = conn.mixer;
  if (ctx.prefs.lockMute === false || !m) return;
  if (locked && m.cough_button?.state === 'Unmuted') {
    ctx.lockMuted = true;
    conn.command('SetCoughMuteState', 'MutedToAll');
    logActivity('Pc’en blev låst – mikrofonen er muted');
  } else if (!locked && ctx.lockMuted) {
    ctx.lockMuted = false;
    conn.command('SetCoughMuteState', 'Unmuted');
    logActivity('Pc’en blev låst op – mikrofonen er åben igen');
  }
}

// TC-Helicon's driver makes the GoXLR a sound card and carries the engine's USB talk; GoXLR Studio
// may not install it, so say so – with TC-Helicon's download – when it is missing.
async function checkDriver() {
  const d = await driverInfo().catch(() => null);
  ctx.driverMissing = d && !d.installed ? d : null;
  renderBanners();
}

// GoXLR Studio was started by a Stream Deck button: run that action once the GoXLR is there
// (most actions need it), or after 15 s anyway.
async function runLaunchAction() {
  const id = await takeLaunchAction().catch(() => null);
  if (!id) return;
  const start = Date.now();
  while (conn.mode !== 'live' && Date.now() - start < 15000) await new Promise((r) => setTimeout(r, 300));
  runDeckAction(id, 'Stream Deck (start)');
}

function runDeckAction(id, source) {
  // "Test linket" on the Stream Deck page: the link went through Windows and reached the app.
  if (id === 'deck-test') { toast('Linket virker: Windows sendte det til GoXLR Studio ✓', 'info'); return; }
  logActivity(`${source}: ${id}`);
  ctx.runAction(id, source);
}

// After an update: say whether it worked (the helper writes the outcome before it starts the app).
async function reportUpdateResult() {
  const r = await updateResult().catch(() => null);
  const u = ctx.updateState;
  u.log = r?.log || [];
  const info = await appInfo().catch(() => null);
  const out = info && updateOutcome(r?.result, info.version);
  if (!out) return;
  logActivity(out.text);
  if (out.ok) toast(out.text, 'info');
  else { u.failed = out.text; renderBanners(); }
  ctx.onUpdateState?.();
}

// ---------- "Hvad er nyt" ----------
// Once after an update (not after the first install): the release notes for the version you got.
async function showWhatsNew(force = false) {
  const info = await appInfo().catch(() => null);
  if (!info) return;
  const seen = ctx.prefs.lastSeenVersion;
  if (!force) {
    if (seen === info.version) return;
    ctx.prefs.lastSeenVersion = info.version;
    ctx.savePrefs();
    if (!seen) return;
  }
  const rel = await latestRelease().catch(() => null);
  if (!rel || compareVersions(rel.tag_name, info.version) !== 0 || !rel.body) {
    if (force) toast('Kunne ikke hente udgivelsesnoterne');
    return;
  }
  const blocks = markdownBlocks(notesFor(rel.body, language())).filter((b, i) => !(i === 0 && b.kind === 'h'));
  const inline = (parts) => parts.map((x) => (x.bold ? h('strong', {}, x.text) : x.text));
  const nodes = [];
  let list = null;
  for (const b of blocks) {
    if (b.kind === 'li') { if (!list) { list = h('ul'); nodes.push(list); } list.append(h('li', {}, inline(b.parts))); continue; }
    list = null;
    nodes.push(b.kind === 'hr' ? h('hr') : b.kind === 'h' ? h('h4', {}, inline(b.parts)) : h('p', {}, inline(b.parts)));
  }
  infoDialog(`Hvad er nyt i GoXLR Studio ${info.version}`, nodes, { testid: 'whats-new' });
}
ctx.showWhatsNew = (force) => showWhatsNew(force);

// ---------- local API ----------
async function applyApi() {
  const cfg = ctx.prefs.api;
  if (!cfg) return;
  try { await setApi(cfg); ctx.apiError = null; } catch (e) { ctx.apiError = String(e); toast(`API: ${e}`); }
  publishApi(true);
}

let apiStateKey = '';
let apiActionsKey = '';
async function publishApi(force = false) {
  if (!isNative() || !ctx.prefs.api?.enabled) return;
  const m = conn.mixer;
  const eq = ctx.outputEq?.slots[ctx.outputEq.active];
  const state = {
    connected: conn.mode === 'live',
    profile: m?.profile_name || null,
    profiles: m ? conn.status.files?.profiles || [] : [],
    mic_profile: m?.mic_profile_name || null,
    mic_muted: m ? m.cough_button.state !== 'Unmuted' : null,
    volumes: m?.levels.volumes || {},
    eq: { enabled: !!eq?.enabled, preset: ctx.outputEq?.presetName || null, presets: ctx.outputEq ? eqPresetNames(ctx) : [] },
    scenes: ctx.scenes.map((x) => ({ id: x.id, name: x.name })),
  };
  const key = JSON.stringify(state);
  if (!force && key === apiStateKey) return;
  apiStateKey = key;
  const shape = JSON.stringify([state.profiles, state.eq.presets, state.scenes]);
  let actions;
  if (force || shape !== apiActionsKey) {
    apiActionsKey = shape;
    actions = (await actionCatalog(ctx)).flatMap((g) => g.items.map((i) => ({ id: i.id, label: i.label, group: g.title })));
  }
  apiPublish(state, actions);
}

// ---------- banners (engine lost, GoXLR engine missing, update ready) ----------
function renderBanners() {
  const el = document.getElementById('banners');
  if (!el) return;
  const items = [];
  if (isNative() && conn.mode === 'demo') {
    items.push(h('div', { class: 'banner warn' }, 'GoXLR-motoren kører ikke, eller mixeren er ikke tilsluttet – du ser demo-data.',
      h('button', { class: 'btn sm primary', onclick: () => startDaemon().then((t) => toast(t, 'info')).catch((e) => toast(String(e))) }, 'Start GoXLR-motoren')));
  }
  if (ctx.soundRescue) {
    const r = ctx.soundRescue;
    const close = () => { ctx.soundRescue = null; renderBanners(); };
    items.push(h('div', { class: 'banner warn', 'data-testid': 'banner-restore-sound' },
      'Gendan lyd: EQ’en er slået fra, så lyden går lige igennem. Er lyden tilbage og normal?',
      h('button', { class: 'btn sm primary', onclick: close }, 'Ja, behold EQ fra'),
      r.wasOn ? h('button', { class: 'btn sm', onclick: () => { ctx.runAction('eq-toggle', 'Gendan lyd'); close(); } }, 'Slå EQ til igen') : null,
      h('button', { class: 'btn sm', 'data-testid': 'restore-sound-remove', onclick: async () => {
        if (!(await confirmDialog('Lyden er stadig væk eller forkert, selv med EQ’en slået fra? Så fjern EQ-motoren fra alle udgange – Windows-lyden bliver, som den var før. Du kan installere den igen på Afspilnings-EQ-siden.', { ok: 'Fjern EQ-motoren', danger: true }))) return;
        try {
          const res = await engineTask({ action: 'uninstall' });
          toast(res.ok ? 'EQ-motoren er fjernet – Windows-lyden er som før' : `Kunne ikke fjerne EQ-motoren: ${res.error}`, res.ok ? 'info' : undefined);
          if (res.ok) close();
        } catch (e) { toast(String(e.message || e)); }
      } }, 'Lyden er stadig væk – fjern EQ-motoren')));
  }
  if (ctx.driverMissing) {
    const d = ctx.driverMissing;
    items.push(h('div', { class: 'banner warn', 'data-testid': 'banner-driver-missing' },
      'TC-Helicons GoXLR-driver er ikke installeret. Den gør GoXLR’en til et lydkort i Windows, og uden den kan GoXLR Studio ikke tale med GoXLR’en. Driveren er gratis, men den må kun hentes hos TC-Helicon:',
      h('button', { class: 'btn sm primary', onclick: () => openUrl(d.download_mini) }, 'Hent til GoXLR Mini'),
      h('button', { class: 'btn sm', onclick: () => openUrl(d.download_full) }, 'Hent til GoXLR'),
      h('button', { class: 'btn sm', onclick: () => checkDriver().then(() => toast(ctx.driverMissing ? 'Driveren mangler stadig' : 'Driveren er fundet – start GoXLR-motoren', ctx.driverMissing ? undefined : 'info')) }, 'Tjek igen')));
  }
  if (ctx.adminTask) {
    items.push(h('div', { class: 'banner admin', 'data-testid': 'banner-admin-task' },
      h('strong', {}, 'Kører med administrator-adgang: '), ctx.adminTask.text));
  }
  if (ctx.eqTargetNotice && ctx.outputEq?.target) {
    const name = ctx.outputEq.target_name || 'én udgang';
    const decide = (all) => {
      if (all) { ctx.outputEq.target = null; ctx.outputEq.target_name = null; storeSet('output-eq', ctx.outputEq); applyOutputEq().catch(() => {}); }
      ctx.prefs.eqTargetConfirmed = true; ctx.savePrefs(); ctx.eqTargetNotice = false; renderBanners();
      if (current === 'outeq') mount();
      toast(all ? 'EQ’en gælder nu alle markerede udgange' : `EQ’en gælder fortsat kun ${name}`, 'info');
    };
    items.push(h('div', { class: 'banner warn', 'data-testid': 'banner-eq-target' },
      `EQ’en gælder kun ${name} – en indstilling fra en tidligere version. Lyd på andre udgange (fx Music fra Spotify) får ingen EQ.`,
      h('button', { class: 'btn sm primary', 'data-testid': 'banner-eq-target-all', onclick: () => decide(true) }, 'Gælder alle markerede udgange'),
      h('button', { class: 'btn sm', 'data-testid': 'banner-eq-target-keep', onclick: () => decide(false) }, `Behold kun ${name}`)));
  }
  const rep = ctx.engineRepair;
  if (rep?.needed) {
    items.push(h('div', { class: 'banner warn', 'data-testid': 'banner-engine-repair' },
      `EQ-motoren er ikke registreret korrekt i Windows, så EQ’en høres ikke: ${rep.problems.join('; ')}.`,
      h('button', { class: 'btn sm primary', 'data-testid': 'engine-repair', disabled: rep.running, onclick: () => repairEngine(true) }, rep.running ? 'Reparerer…' : 'Reparér nu'),
      h('button', { class: 'btn sm', onclick: () => navigate('outeq') }, 'Gå til EQ-motor')));
  }
  if (ctx.apoLost) {
    items.push(h('div', { class: 'banner warn' }, 'EQ-motoren læser ikke længere GoXLR Studios EQ (fx efter en geninstallation af Equalizer APO).',
      h('button', { class: 'btn sm primary', onclick: () => navigate('outeq') }, 'Gå til EQ-motor'),
      h('button', { class: 'btn sm', onclick: () => ctx.onApoChanged(false) }, 'Ignorér')));
  }
  const u = ctx.updateState;
  if (u.failed) {
    items.push(h('div', { class: 'banner warn', 'data-testid': 'banner-update-failed' }, u.failed,
      u.available ? h('button', { class: 'btn sm primary', disabled: u.installing, onclick: () => doInstallUpdate() }, 'Prøv igen') : null,
      h('button', { class: 'btn sm', onclick: () => openUrl('https://github.com/MRDonnii/goxlr-studio/releases/latest') }, 'Hent installeren på GitHub'),
      h('button', { class: 'btn sm', onclick: () => { u.failed = null; renderBanners(); } }, 'Luk')));
  } else if (u.available) {
    items.push(h('div', { class: 'banner', 'data-testid': 'banner-update' }, `GoXLR Studio ${u.latest} er klar.`,
      h('button', { class: 'btn sm primary', disabled: u.installing, onclick: () => doInstallUpdate() }, u.installing ? 'Installerer…' : 'Installér og genstart'),
      h('a', { href: u.url, target: '_blank', rel: 'noopener' }, 'Hvad er nyt?')));
  }
  el.replaceChildren(...items);
}

// Something else (an Equalizer APO reinstall, a restored backup…) can point the engine away from our config.
async function apoWatchdog() {
  if (!isNative()) return;
  const st = await engineStatus().catch(() => null);
  if (st?.apo_installed) {
    if (st.taken_over && !ctx.prefs.apoExpected) { ctx.prefs.apoExpected = true; ctx.savePrefs(); }
    const lost = !st.taken_over && !!ctx.prefs.apoExpected;
    if (lost && !ctx.apoLost) ctx.notify('Afspilnings-EQ er slået fra', 'mute');
    if (lost !== !!ctx.apoLost) { ctx.apoLost = lost; renderBanners(); }
  }
}

// Fejl 1: an engine installed by an older version (or unregistered by Equalizer APO's uninstaller)
// is installed but cannot be created by Windows. Checked at startup without admin; repaired once
// automatically per app version (it needs admin), otherwise from the banner.
async function checkEngineRegistration() {
  if (!isNative()) return;
  const info = await engineInfo().catch(() => null);
  if (!info || info.kind !== 'builtin') { ctx.engineRepair = null; renderBanners(); return; }
  const problems = (info.registration?.problems || []).map((p) => p.text);
  const outdated = (info.schema || 0) < (info.schema_required || 0);
  ctx.engineRepair = { needed: problems.length > 0, outdated, problems, running: false };
  renderBanners();
  const version = (await appInfo().catch(() => ({}))).version || '?';
  if ((problems.length || outdated) && ctx.prefs.engineRepairTried !== version) {
    ctx.prefs.engineRepairTried = version; ctx.savePrefs();
    repairEngine(false);
  }
}

async function repairEngine(manual) {
  const rep = ctx.engineRepair || (ctx.engineRepair = { problems: [] });
  if (rep.running) return;
  rep.running = true; renderBanners();
  toast('EQ-motoren repareres og testes – Windows beder om administrator-adgang, og lyden afbrydes et øjeblik', 'info');
  try {
    const r = await engineTask({ action: 'test' });
    if (!r.ok) throw new Error(r.error || 'Ukendt fejl');
    const fixed = (r.log || []).find((l) => l.startsWith('Rettet:'));
    const failed = (r.tests || []).filter((t) => !t.ok && !t.error);
    if (r.tests?.length) storeSet('engine-test', { at: Date.now(), tests: r.tests }).catch(() => {});
    toast(failed.length ? (r.log || []).slice(-1)[0] : `${fixed ? 'EQ-motoren er repareret' : 'EQ-motoren er i orden'}${r.tests?.length ? ` og kører på ${r.tests.filter((t) => t.ok).length} udgange` : ''}`, failed.length ? undefined : 'info');
  } catch (e) {
    if (manual) toast(`Reparation af EQ-motoren: ${e.message || e}`);
  }
  rep.running = false;
  await checkEngineRegistration();
  if (current === 'outeq') mount();
}
ctx.repairEngine = (manual = true) => repairEngine(manual);

// The built-in GoXLR engine is started by the app at launch; restart it if it stops while we run.
let daemonRetry = 0;
function daemonWatchdog() {
  if (!isNative() || ctx.prefs.autoStartDaemon === false || conn.mode !== 'demo') { daemonRetry = 0; return; }
  if (daemonRetry++ < 3) startDaemon().catch(() => {});
}

// ---------- per-profile EQ + tray status ----------
let lastProfile;
function followProfile() {
  const m = conn.mixer;
  if (!m) return;
  if (m.profile_name === lastProfile) return;
  const first = lastProfile === undefined;
  lastProfile = m.profile_name;
  // EQ pr. kanal: a profile can have its own set of channel EQs.
  if (hasProfileSets(ctx.outputEq)) applyOutputEq().catch(() => {});
  // Mindre fejl 5: this ran on the first status after every app start and replaced the preset the
  // user had chosen with the profile's linked one. At start, only follow the profile if it changed
  // while the app was closed.
  if (first && (!ctx.outputEq?.presetProfile || ctx.outputEq.presetProfile === m.profile_name)) return;
  if (!first) obsFollowProfile(ctx, m.profile_name);
  const link = ctx.outputEq?.profileLinks?.[m.profile_name];
  if (link && link !== ctx.outputEq.presetName && (ctx.outputEq.presets[link] || BUILTIN_PRESETS[link])) {
    applyEqPreset(ctx, link, first ? `GoXLR-profilen er "${m.profile_name}" – den skiftede, mens appen var lukket ("EQ følger GoXLR-profil")` : `GoXLR-profilen skiftede til "${m.profile_name}" ("EQ følger GoXLR-profil")`);
    toast(`EQ: ${link} – fordi GoXLR-profilen er "${m.profile_name}" (EQ følger GoXLR-profil)`, 'info');
  }
}

let trayStatusKey = '';
let trayMicLevel = null;
let trayMeterAt = 0;
function syncTrayStatus() {
  const m = conn.mixer;
  const muted = !!m && m.cough_button.state !== 'Unmuted';
  const eq = ctx.outputEq?.slots[ctx.outputEq.active];
  const tip = ['GoXLR Studio', m?.profile_name, eq ? (eq.enabled ? `EQ: ${ctx.outputEq.presetName || 'tilpasset'}` : 'EQ fra') : null, muted ? 'Mikrofon muted' : null].filter(Boolean).join(' · ');
  // Niveaumåler i bakken: the mic level in 8 steps (only sent when the step changes).
  const level = ctx.prefs.trayMeter && !muted && trayMicLevel != null ? Math.round(dbToMeter(trayMicLevel) * 8) / 8 : null;
  const key = `${muted}|${tip}|${level}`;
  if (key === trayStatusKey) return;
  trayStatusKey = key;
  setTrayStatus(muted, t(tip), level);
}

// ---------- hotkeys ----------
async function registerHotkeys() {
  const active = ctx.hotkeys.filter((b) => b.accel && b.action).map(({ id, accel }) => ({ id, accel }));
  // Fodpedal: pedals that type a key are hotkeys too (pressed and released, see keyPedal).
  for (const p of ctx.pedals || []) if (p.input?.kind === 'key' && p.input.accel && !active.some((b) => b.accel === p.input.accel)) active.push({ id: `pedal:${p.id}`, accel: p.input.accel });
  const res = await setHotkeys(active).catch((e) => active.map((b) => ({ id: b.id, ok: false, error: String(e) })));
  ctx.hotkeyStatus = Object.fromEntries(res.map((r) => [r.id, r]));
  const failed = res.filter((r) => !r.ok);
  if (failed.length && !ctx.capturingHotkey) {
    const names = failed.map((r) => prettyAccel(ctx.hotkeys.find((b) => b.id === r.id)?.accel || ctx.pedals?.find((p) => `pedal:${p.id}` === r.id)?.input?.accel)).join(', ');
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
// The menu texts (Danish here, translated with t() – the Rust side has the same Danish defaults).
const TRAY_LABELS = { show: 'Åbn GoXLR Studio', profiles: 'GoXLR-profil', eq: 'EQ-preset', eq_toggle: 'EQ aktiv', scenes: 'Scener', mute: 'Mute / unmute mikrofon', restore: 'Gendan lyd (slå EQ fra)', quit: 'Afslut' };
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
    labels: Object.fromEntries(Object.entries(TRAY_LABELS).map(([k, v]) => [k, t(v)])),
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
  ctx.onLevels = null;
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
    const sel = h('select', { class: 'quick', title: 'Afspilnings-EQ preset', onchange: () => applyEqPreset(ctx, sel.value, 'topbjælken') },
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
// Start levels: set once per device each time GoXLR Studio starts, a moment after the engine has
// reported the device (so the profile it loads at start does not overwrite them).
const startLevelsDone = new Set();
function maybeStartLevels() {
  const m = conn.mixer;
  if (!m || !(conn.mode === 'live' || !isNative())) return;
  const key = conn.serial || m.hardware?.serial_number || 'device';
  if (startLevelsDone.has(key)) return;
  startLevelsDone.add(key);
  if (ctx.prefs.startLevels?.enabled) setTimeout(() => applyStartLevels(ctx), 1500);
  // Push-to-talk: the mic is closed until the key is held – also right after a start.
  if (ctx.hotkeys.some((b) => b.action === 'hold:ptt' && b.accel)) setTimeout(() => conn.command('SetCoughMuteState', pttMuteState(ctx)), 1600);
}

conn.addEventListener('change', () => {
  maybeStartLevels();
  updateChrome();
  syncTray();
  syncTrayStatus();
  followProfile();
  publishApi();
  if (conn.mode !== lastMode) renderBanners();
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
// The GoXLR's Chat output (where Discord plays), looked up every 10 s.
let chatEp = { id: null, at: 0 };
async function chatEndpointId() {
  if (Date.now() - chatEp.at > 10000) {
    const devs = await listAudioDevices().catch(() => []);
    chatEp = { id: channelEndpoint('Chat', devs), at: Date.now() };
  }
  return chatEp.id;
}

async function meterLoop() {
  let db = null;
  if (conn.mode === 'live') db = await conn.micLevel().catch(() => null);
  else if (conn.mode === 'demo') {
    demoPhase += 1;
    const talking = Math.sin(demoPhase / 23) > 0.2;
    db = talking ? -22 - Math.random() * 12 : -62 - Math.random() * 6;
  }
  ctx.onMicLevel?.(db);
  if (ctx.prefs.trayMeter && performance.now() - trayMeterAt > 200) { trayMeterAt = performance.now(); trayMicLevel = db; syncTrayStatus(); }
  // Windows' peak meters: for the VU meters, chat-ducking and høreværn.
  const wantLevels = ctx.onLevels || ctx.ducker.settings.chat?.enabled || ctx.wantLevels || ctx.levelMeasuring;
  const levels = wantLevels ? await audioLevels().catch(() => null) : null;
  ctx.levels = levels;
  if (ctx.onLevels) ctx.onLevels(levels);
  const chatId = ctx.ducker.settings.chat?.enabled ? await chatEndpointId() : null;
  const chatPeak = chatId && levels ? levels[chatId] : null;
  if (ctx.ducker.tick(db, chatPeak > 0 ? 20 * Math.log10(chatPeak) : null)) ctx.binder.run();
  setTimeout(meterLoop, conn.mode === 'live' ? 70 : 90);
}

// ---------- command palette ----------
async function paletteActions() {
  const acts = visiblePages().map((p) => ({ label: `Gå til ${p.title}`, run: () => navigate(p.id) }));
  for (const g of await actionCatalog(ctx)) {
    for (const i of g.items) {
      const k = hotkeyFor(i.id);
      acts.push({ label: `${g.title}: ${i.label}`, key: k ? prettyAccel(k) : null, run: () => ctx.runAction(i.id, 'kommandolinjen (Ctrl+K)') });
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

// External links open in the default browser, not inside the app window.
document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="https://"]');
  if (!a || !isNative()) return;
  e.preventDefault();
  openUrl(a.href).catch((err) => toast(String(err)));
});

document.addEventListener('keydown', (e) => {
  if (ctx.capturingHotkey) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  // In the Windows app the OS delivers the global shortcuts; in a browser tab they only work while focused.
  if (isNative() || document.querySelector('.palette')) return;
  if (e.target.matches?.('input, select, textarea') && !e.ctrlKey && !e.altKey) return;
  const accel = accelFromEvent(e);
  const b = accel && ctx.hotkeys.find((x) => x.accel === accel && x.action);
  if (b) { e.preventDefault(); ctx.runAction(b.action, `genvej ${prettyAccel(b.accel)}`); }
});

// Mindre fejl 9: every elevated task is visible in the app while it runs, with what it changes.
window.addEventListener('admin-task', (ev) => {
  const d = ev.detail || {};
  if (d.phase === 'start') { ctx.adminTask = { action: d.action, text: d.text }; logActivity(`Administrator-opgave "${d.action}" startet: ${d.text}`); }
  else {
    ctx.adminTask = null;
    logActivity(`Administrator-opgave "${d.action}" ${d.ok ? 'færdig' : `fejlede${d.error ? `: ${d.error}` : ''}`}`);
  }
  renderBanners();
});

async function registerNativeHooks() {
  if (!isNative()) return;
  const { listen } = window.__TAURI__.event;
  await listen('hotkey', (ev) => {
    if (keyPedal(ctx, ev.payload, true)) return;
    const b = ctx.hotkeys.find((x) => x.id === ev.payload);
    if (b?.action) ctx.runAction(b.action, `genvej ${prettyAccel(b.accel)}`);
  });
  await listen('hotkey-release', (ev) => {
    if (keyPedal(ctx, ev.payload, false)) return;
    const b = ctx.hotkeys.find((x) => x.id === ev.payload);
    if (b?.action?.startsWith('hold:')) releaseAction(ctx, b.action);
  });
  // GoXLR Studio switched off an installed GoXLR Utility and started its own engine.
  await listen('engine-takeover', (ev) => {
    const t = ev.payload || {};
    if (t.stopped?.length || t.old_engine_removed || t.autostart_remaining?.length) {
      const m = takeoverMessage(t);
      toast(m.text, m.ok ? 'info' : undefined);
    }
  });
  await listen('engine-takeover-failed', (ev) => toast(`Kunne ikke starte den indbyggede GoXLR-motor: ${ev.payload}`));
  // The GoXLR engine runs inside the app; it stops by itself only on errors (or if TC-Helicon's
  // own app takes the GoXLR). The watchdog starts it again.
  await listen('engine-stopped', (ev) => { if (ev.payload) toast(`GoXLR-motoren stoppede: ${ev.payload}`); });
  // Tray ids are action ids: profile:…, eq-preset:…, eq-toggle, scene:…, mute-mic.
  await listen('tray-action', (ev) => { if (typeof ev.payload === 'string') ctx.runAction(ev.payload, 'bakke-menuen'); });
  await listen('api-action', (ev) => { if (typeof ev.payload === 'string') ctx.runAction(ev.payload, 'lokalt API'); });
  // A Stream Deck button (goxlr-studio://action/… or --action …) while GoXLR Studio runs.
  await listen('session-lock', (ev) => onSessionLock(!!ev.payload));
  await listen('deck-action', (ev) => { if (typeof ev.payload === 'string') runDeckAction(ev.payload, 'Stream Deck'); });
}

async function boot() {
  const [prefs, scenes, outputEq, hotkeys, appRules, appTriggers, deviceTriggers] = await Promise.all([
    storeGet('prefs', {}), storeGet('scenes', []), loadOutputEqState(), storeGet('hotkeys', null), storeGet('app-rules', []), storeGet('app-triggers', []), storeGet('device-triggers', []), ctx.ducker.load()]);
  ctx.appTriggers = appTriggers;
  ctx.deviceTriggers = deviceTriggers || [];
  Object.assign(ctx.prefs, prefs);
  setLanguage(resolveLanguage(ctx.prefs.lang));
  applyTheme(ctx.prefs);
  watchTheme(ctx);
  ctx.scenes = scenes;
  ctx.outputEq = outputEq;
  // Fejl 2: versions before 0.4.2 kept a single "EQ gælder for" output silently – ask once.
  ctx.eqTargetNotice = !!(outputEq.target && !ctx.prefs.eqTargetConfirmed);
  ctx.appRules = appRules;
  ctx.hotkeys = hotkeys || defaultHotkeys(scenes);
  if (!hotkeys) storeSet('hotkeys', ctx.hotkeys);
  await loadPedals(ctx);
  buildNav();
  await registerNativeHooks();
  startPedals(ctx);
  registerHotkeys();
  syncTray();
  startAppRules(ctx);
  startDeviceTriggers(ctx);
  startMqtt(ctx);
  startHearing(ctx);
  startMediaWatch(ctx);
  startSchedule(ctx);
  startMicLimiter(ctx);
  // Profilhistorik: a version of each changed profile every 5 minutes.
  setTimeout(() => snapshotProfiles(ctx), 20000);
  setInterval(() => snapshotProfiles(ctx), 5 * 60 * 1000);
  startDiscordSync(ctx);
  ctx.applyOutputEq().catch(() => {});
  if (ctx.prefs.api?.enabled) applyApi();
  renderBanners();
  // Background chores: APO watchdog, daemon autostart, update check.
  setInterval(apoWatchdog, 20000);
  setTimeout(apoWatchdog, 4000);
  setTimeout(checkEngineRegistration, 3000);
  setInterval(daemonWatchdog, 15000);
  setTimeout(() => reportUpdateResult(), 2000);
  setTimeout(() => showWhatsNew(), 4000);
  setTimeout(() => checkDriver(), 2500);
  startMutedReminder();
  runLaunchAction();
  setTimeout(() => checkUpdate(), 15000);
  setInterval(() => checkUpdate(), 6 * 3600 * 1000);
  current = localStorage.getItem('studio.page') || 'mixer';
  navigate(current);
  conn.start();
  meterLoop();
}

boot();
