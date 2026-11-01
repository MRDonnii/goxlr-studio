// Home Assistant via MQTT: keeps the connection (src-tauri/src/mqtt.rs), announces the entities
// (mqttmodel.js), sends the state when it changes and carries out what Home Assistant asks for.
import { h, toast, logActivity } from './ui.js';
import { mqttStart, mqttStop, mqttPublish, onMqttEvents, appInfo } from './native.js';
import { discoveryConfigs, stateMessages, parseCommand, diffMessages, newNodeId, baseTopic } from './mqttmodel.js';
import { micIsMuted } from './extras.js';
import { pttMuteState, toggleEq } from './actions.js';
import { BUILTIN_PRESETS } from './eq.js';

let status = { enabled: false, connected: false, broker: '', error: null };
let sentDiscovery = {};
let sentState = {};
let version = '';
let busy = false;

export function mqttSettings(ctx) {
  const m = (ctx.prefs.mqtt ??= {});
  if (!m.node) { m.node = newNodeId(); ctx.savePrefs?.(); }
  return m;
}

// The choices Home Assistant gets: GoXLR profiles, all EQ presets (yours and the built-in), scenes.
function lists(ctx) {
  const mine = Object.keys(ctx.outputEq?.presets || {});
  return {
    profiles: ctx.conn.status?.files?.profiles || [],
    presets: [...mine, ...Object.keys(BUILTIN_PRESETS).filter((n) => !mine.includes(n))],
    scenes: ctx.scenes || [],
  };
}

function snapshot(ctx, presets) {
  const mixer = ctx.conn.mixer;
  const eq = ctx.outputEq?.slots?.[ctx.outputEq.active];
  return {
    connected: !!mixer,
    micMuted: micIsMuted(mixer),
    profile: mixer?.profile_name || null,
    volumes: mixer?.levels?.volumes || {},
    eqOn: !!eq?.enabled,
    eqPreset: ctx.outputEq?.presetName || null,
    presets,
  };
}

// Sends what changed since last time (twice a second while connected).
async function sync(ctx) {
  if (!status.connected || busy) return;
  busy = true;
  try {
    const m = mqttSettings(ctx);
    const l = lists(ctx);
    const model = ctx.conn.mixer?.hardware?.device_type === 'Mini' ? 'GoXLR Mini' : 'GoXLR';
    const configs = {};
    for (const [topic, c] of discoveryConfigs({ node: m.node, version, model, profiles: l.profiles, presets: l.presets, scenes: l.scenes.map((s) => s.name) })) configs[topic] = JSON.stringify(c);
    const disc = diffMessages(sentDiscovery, configs, { removeMissing: true });
    const states = stateMessages(m.node, snapshot(ctx, l.presets));
    const st = diffMessages(sentState, states);
    if (disc.length || st.length) {
      await mqttPublish([...disc, ...st]);
      for (const x of disc) { if (x.payload === '') delete sentDiscovery[x.topic]; else sentDiscovery[x.topic] = x.payload; }
      Object.assign(sentState, states);
    }
  } catch { /* not connected right now */ }
  busy = false;
}

async function onCommand(ctx, { topic, payload }) {
  const m = mqttSettings(ctx);
  const c = parseCommand(topic, payload, m.node, lists(ctx));
  if (!c) return;
  // Home Assistant restarted: announce everything again.
  if (c.kind === 'republish') { sentDiscovery = {}; sentState = {}; return; }
  const mixer = ctx.conn.mixer;
  switch (c.kind) {
    case 'mic_mute':
      if (!mixer) return;
      logActivity(`Home Assistant: mikrofon ${c.on ? 'muted' : 'åben'}`);
      if (c.on) {
        if (!micIsMuted(mixer)) ctx.conn.command('SetCoughMuteState', pttMuteState(ctx));
      } else {
        // Open means open: the cough button and a muted mic fader.
        if (mixer.cough_button?.state !== 'Unmuted') ctx.conn.command('SetCoughMuteState', 'Unmuted');
        for (const [f, s] of Object.entries(mixer.fader_status || {})) if (s.channel === 'Mic' && s.mute_state && s.mute_state !== 'Unmuted') ctx.conn.command('SetFaderMuteState', f, 'Unmuted');
      }
      return;
    case 'eq': {
      const eq = ctx.outputEq.slots[ctx.outputEq.active];
      if (!!eq.enabled !== c.on) { logActivity(`Home Assistant: EQ ${c.on ? 'til' : 'fra'}`); toggleEq(ctx); }
      return;
    }
    case 'volume':
      if (mixer) { logActivity(`Home Assistant: ${c.channel} ${Math.round(c.value / 2.55)} %`); ctx.conn.command('SetVolume', c.channel, c.value); }
      return;
    case 'action':
      logActivity(`Home Assistant: ${c.label}`);
      ctx.runAction(c.id, 'Home Assistant');
      return;
    default:
  }
}

/** Connects with the settings (or disconnects when it is switched off). */
export async function applyMqtt(ctx) {
  const m = mqttSettings(ctx);
  sentDiscovery = {};
  sentState = {};
  if (!m.enabled || !m.host?.trim()) {
    await mqttStop().catch(() => {});
    status = { ...status, enabled: false, connected: false, error: null };
    ctx.onMqttStatus?.(status);
    return;
  }
  status = { enabled: true, connected: false, broker: m.host.trim(), error: null };
  ctx.onMqttStatus?.(status);
  try {
    await mqttStart({ host: m.host.trim(), port: 1883, user: m.user || '', password: m.password || '', base: baseTopic(m.node), client_id: `goxlr-studio-${m.node}` });
  } catch (e) {
    status = { ...status, error: String(e.message || e) };
    ctx.onMqttStatus?.(status);
  }
}

/** Removes GoXLR Studio's entities from Home Assistant (empty retained discovery messages). */
export async function removeFromHomeAssistant(ctx) {
  if (!status.connected) throw new Error('Ikke forbundet til MQTT-brokeren');
  const m = mqttSettings(ctx);
  const all = discoveryConfigs({ node: m.node, profiles: ['x'], presets: ['x'], scenes: ['x'] });
  await mqttPublish([...all.keys()].map((topic) => ({ topic, payload: '', retain: true })));
  m.enabled = false;
  ctx.savePrefs?.();
  await applyMqtt(ctx);
}

export async function startMqtt(ctx) {
  version = (await appInfo().catch(() => null))?.version || '';
  await onMqttEvents({
    connected: () => { sentDiscovery = {}; sentState = {}; sync(ctx); },
    command: (c) => { onCommand(ctx, c).catch(() => {}); },
    status: (s) => { status = { ...status, ...s }; ctx.onMqttStatus?.(status); },
  }).catch(() => {});
  setInterval(() => sync(ctx), 500);
  if (ctx.prefs.mqtt?.enabled) applyMqtt(ctx);
}

export const mqttStatusNow = () => status;

// ---- Indstillinger → Home Assistant ----
export function mqttCard(ctx) {
  const m = mqttSettings(ctx);
  const field = (key, label, attrs = {}) => {
    const input = h('input', { type: 'text', value: m[key] || '', 'data-testid': `mqtt-${key}`, ...attrs, onchange: () => { m[key] = input.value.trim(); ctx.savePrefs?.(); } });
    return h('div', { class: 'row' }, h('label', {}, label), input);
  };
  const state = h('div', { class: 'hint mqtt-state', 'data-testid': 'mqtt-state' });
  const enabled = h('input', { type: 'checkbox', checked: !!m.enabled, 'data-testid': 'mqtt-enabled', onchange: () => { m.enabled = enabled.checked; ctx.savePrefs?.(); applyMqtt(ctx); } });
  const render = (s) => {
    enabled.checked = !!m.enabled;
    state.className = `hint mqtt-state ${s.connected ? 'ok' : s.error ? 'bad' : ''}`;
    state.textContent = !s.enabled ? 'Slået fra.'
      : s.connected ? `✓ Forbundet til ${s.broker}. GoXLR Studio står i Home Assistant under Indstillinger → Enheder og tjenester → MQTT.`
        : s.error ? `✗ ${s.error}` : `Forbinder til ${s.broker || m.host}…`;
  };
  ctx.onMqttStatus = render;
  render(status);
  return h('div', { class: 'card' }, h('h2', {}, 'Home Assistant (MQTT)'),
    h('div', { class: 'row' }, h('label', {}, 'Forbind til Home Assistant'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, enabled, h('span'))),
    field('host', 'MQTT-broker', { placeholder: 'fx homeassistant.local eller 192.168.1.10' }),
    field('user', 'Brugernavn', { autocomplete: 'off' }),
    field('password', 'Adgangskode', { type: 'password', autocomplete: 'new-password' }),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } },
      h('button', { class: 'btn sm primary', 'data-testid': 'mqtt-connect', onclick: () => { m.enabled = true; enabled.checked = true; ctx.savePrefs?.(); applyMqtt(ctx); } }, 'Gem og forbind'),
      h('button', { class: 'btn sm', 'data-testid': 'mqtt-remove', title: 'Fjerner enheden og dens entiteter fra Home Assistant og slår forbindelsen fra', onclick: () => removeFromHomeAssistant(ctx).then(() => toast('GoXLR Studio er fjernet fra Home Assistant', 'info')).catch((e) => toast(String(e.message || e))) }, 'Fjern fra Home Assistant')),
    state,
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Kræver Mosquitto-tilføjelsen og MQTT-integrationen i Home Assistant. Log ind med en Home Assistant-bruger. Du får mikrofon-mute, "Mikrofon åben" (fx til en ON AIR-lampe), GoXLR-profil, EQ-preset, EQ til/fra, scene og lydstyrker.'));
}
