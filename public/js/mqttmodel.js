// Home Assistant via MQTT – the pure parts: which entities GoXLR Studio announces (MQTT discovery),
// their state messages and what a message from Home Assistant asks for. Tested in
// tests/mqtt.test.mjs; the connection itself is mqtt.js + src-tauri/src/mqtt.rs.

export const DISCOVERY_PREFIX = 'homeassistant';

// GoXLR channel → name in Home Assistant.
export const VOLUME_CHANNELS = { Headphones: 'Hovedtelefoner', Music: 'Musik', Game: 'Spil', Chat: 'Chat', System: 'System', LineOut: 'Line out' };

export const slug = (s) => String(s).toLowerCase().replace(/ø/g, 'o').replace(/æ/g, 'ae').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** This installation's id in Home Assistant, made once and kept in the settings. */
export const newNodeId = () => `goxlr_${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;

export const baseTopic = (node) => `goxlr-studio/${node}`;

const pct = (v) => Math.round((Math.max(0, Math.min(255, Number(v) || 0)) / 255) * 100);

/** Discovery messages: Map of config topic → config object. Selects without options are left out
 *  (Home Assistant refuses them), e.g. profiles before the GoXLR is connected. */
export function discoveryConfigs({ node, version = '', model = 'GoXLR', profiles = [], presets = [], scenes = [], channels = Object.keys(VOLUME_CHANNELS) }) {
  const base = baseTopic(node);
  const device = { identifiers: [node], name: 'GoXLR Studio', manufacturer: 'GoXLR Studio', model, sw_version: version };
  const out = new Map();
  const add = (component, object, name, extra) => {
    out.set(`${DISCOVERY_PREFIX}/${component}/${node}/${object}/config`, {
      name, unique_id: `${node}_${object}`, availability_topic: `${base}/status`, device, ...extra,
    });
  };
  const st = (o) => `${base}/${o}/state`;
  const cmd = (o) => `${base}/${o}/set`;
  add('switch', 'mic_mute', 'Mikrofon mute', { icon: 'mdi:microphone-off', state_topic: st('mic_mute'), command_topic: cmd('mic_mute') });
  // For an "ON AIR" lamp: on while the mic is open.
  add('binary_sensor', 'mic_live', 'Mikrofon åben', { icon: 'mdi:microphone', state_topic: st('mic_live') });
  add('binary_sensor', 'connected', 'GoXLR forbundet', { device_class: 'connectivity', entity_category: 'diagnostic', state_topic: st('connected') });
  if (profiles.length) add('select', 'profile', 'GoXLR-profil', { icon: 'mdi:account-music', options: profiles, state_topic: st('profile'), command_topic: cmd('profile') });
  if (presets.length) add('select', 'eq_preset', 'EQ-preset', { icon: 'mdi:equalizer', options: presets, state_topic: st('eq_preset'), command_topic: cmd('eq_preset') });
  add('switch', 'eq', 'EQ', { icon: 'mdi:tune-vertical', state_topic: st('eq'), command_topic: cmd('eq') });
  // A scene has no lasting state: Home Assistant keeps the last choice itself.
  if (scenes.length) add('select', 'scene', 'Scene', { icon: 'mdi:palette', options: scenes, command_topic: cmd('scene'), optimistic: true });
  // 0.9.0: ChatMix, the mic limiter, game mode and audio clips.
  add('number', 'chatmix', 'ChatMix (spil ↔ chat)', { icon: 'mdi:headset', min: -100, max: 100, step: 5, mode: 'slider', state_topic: st('chatmix'), command_topic: cmd('chatmix') });
  add('switch', 'mic_limiter', 'Mikrofon-limiter', { icon: 'mdi:shield-check', state_topic: st('mic_limiter'), command_topic: cmd('mic_limiter') });
  add('binary_sensor', 'game_active', 'Spiltilstand aktiv', { icon: 'mdi:controller', state_topic: st('game_active') });
  add('button', 'clip_save', 'Gem lydklip', { icon: 'mdi:content-save', command_topic: cmd('clip_save') });
  for (const ch of channels) {
    if (!VOLUME_CHANNELS[ch]) continue;
    const o = `vol_${slug(ch)}`;
    add('number', o, `Lydstyrke ${VOLUME_CHANNELS[ch]}`, { icon: 'mdi:volume-high', min: 0, max: 100, step: 1, mode: 'slider', unit_of_measurement: '%', state_topic: st(o), command_topic: cmd(o) });
  }
  return out;
}

/** State messages (topic → payload). s = { connected, micMuted, profile, volumes (0–255), eqOn,
 *  eqPreset, presets }. A preset that isn't in the list (a changed one) is not sent. */
export function stateMessages(node, s) {
  const base = baseTopic(node);
  const out = { [`${base}/connected/state`]: s.connected ? 'ON' : 'OFF', [`${base}/eq/state`]: s.eqOn ? 'ON' : 'OFF' };
  out[`${base}/mic_limiter/state`] = s.limiter ? 'ON' : 'OFF';
  out[`${base}/game_active/state`] = s.gameActive ? 'ON' : 'OFF';
  out[`${base}/chatmix/state`] = String(Math.round(Number(s.chatMix) || 0));
  if (s.eqPreset && (!s.presets || s.presets.includes(s.eqPreset))) out[`${base}/eq_preset/state`] = s.eqPreset;
  if (s.connected) {
    out[`${base}/mic_mute/state`] = s.micMuted ? 'ON' : 'OFF';
    out[`${base}/mic_live/state`] = s.micMuted ? 'OFF' : 'ON';
    if (s.profile) out[`${base}/profile/state`] = s.profile;
    for (const [ch, v] of Object.entries(s.volumes || {})) if (VOLUME_CHANNELS[ch]) out[`${base}/vol_${slug(ch)}/state`] = String(pct(v));
  }
  return out;
}

/** What a message from Home Assistant asks for; null when it isn't for us or isn't valid. */
export function parseCommand(topic, payload, node, { profiles = [], presets = [], scenes = [] } = {}) {
  const p = String(payload ?? '').trim();
  if (topic === `${DISCOVERY_PREFIX}/status`) return p === 'online' ? { kind: 'republish' } : null;
  const base = baseTopic(node);
  if (!topic.startsWith(`${base}/`) || !topic.endsWith('/set')) return null;
  const object = topic.slice(base.length + 1, -'/set'.length);
  const onOff = (kind) => (p === 'ON' || p === 'OFF' ? { kind, on: p === 'ON' } : null);
  switch (object) {
    case 'mic_mute': return onOff('mic_mute');
    case 'eq': return onOff('eq');
    case 'mic_limiter': return p === 'ON' || p === 'OFF' ? { kind: 'action', id: `mic-limiter:${p === 'ON' ? 'on' : 'off'}`, label: `mikrofon-limiter ${p === 'ON' ? 'til' : 'fra'}` } : null;
    case 'clip_save': return { kind: 'action', id: 'clip-save', label: 'gem lydklip' };
    case 'chatmix': {
      const v = Number(p);
      return p !== '' && Number.isFinite(v) ? { kind: 'chatmix', value: Math.max(-100, Math.min(100, Math.round(v))) } : null;
    }
    case 'profile': return profiles.includes(p) ? { kind: 'action', id: `profile:${p}`, label: `profil "${p}"` } : null;
    case 'eq_preset': return presets.includes(p) ? { kind: 'action', id: `eq-preset:${p}`, label: `EQ-preset "${p}"` } : null;
    case 'scene': {
      const s = scenes.find((x) => x.name === p);
      return s ? { kind: 'action', id: `scene:${s.id}`, label: `scene "${p}"` } : null;
    }
    default: {
      const m = object.match(/^vol_([a-z0-9_]+)$/);
      const ch = m && Object.keys(VOLUME_CHANNELS).find((c) => slug(c) === m[1]);
      const v = Number(p);
      if (!ch || p === '' || !Number.isFinite(v)) return null;
      return { kind: 'volume', channel: ch, value: Math.round((Math.max(0, Math.min(100, v)) / 100) * 255) };
    }
  }
}

/** Only what changed since last time; removed discovery topics get an empty message (removes the entity). */
export function diffMessages(prev, next, { removeMissing = false } = {}) {
  const out = [];
  for (const [topic, payload] of Object.entries(next)) if (prev[topic] !== payload) out.push({ topic, payload, retain: true });
  if (removeMissing) for (const topic of Object.keys(prev)) if (!(topic in next) && prev[topic] !== '') out.push({ topic, payload: '', retain: true });
  return out;
}
