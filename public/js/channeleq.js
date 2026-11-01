// EQ pr. kanal: each GoXLR channel (Game, Music, Chat, System) can have its own EQ preset. Apps
// are already routed to channels (Lyd pr. app), so Spotify on Music gets the music EQ and the game
// on Game gets the footsteps EQ by itself. A GoXLR profile can have its own set ("Headset" vs
// "Speakers"); channels without a preset get the main EQ (the editor's A/B slot).
// The engine writes one Equalizer APO "Device:" section per channel (apo.rs).
import { enginePayload, channelEndpoint } from './extras.js';
import { clipGuard, playbackOffset } from './eqchain.js';
import { BUILTIN_PRESETS } from './eq.js';

export const EQ_CHANNELS = ['Game', 'Music', 'Chat', 'System'];
/** "Ingen EQ" on a channel: the channel is left out of the main EQ and gets nothing. */
export const FLAT = '__flat';
export const ALL_PROFILES = '*';

const FLAT_EQ = { enabled: true, preamp: 0, bands: [] };

/** The preset for a channel under a profile: the profile's own choice, else "Alle profiler", else null (= main EQ). */
export function channelPresetFor(state, channel, profile) {
  const sets = state?.channelEq || {};
  return (profile && sets[profile]?.[channel]) || sets[ALL_PROFILES]?.[channel] || null;
}

export function presetEq(state, name, builtins = BUILTIN_PRESETS) {
  if (name === FLAT) return FLAT_EQ;
  return state?.presets?.[name] || builtins[name] || null;
}

/** True when any profile has its own set (then a profile change must rewrite the engine config). */
export const hasProfileSets = (state) => Object.entries(state?.channelEq || {}).some(([k, v]) => k !== ALL_PROFILES && v && Object.values(v).some(Boolean));

/** Which channel EQs apply now: [{ channel, name, id, eq }] – only channels whose Windows output exists. */
export function activeChannels(state, devices, profile, builtins = BUILTIN_PRESETS) {
  const out = [];
  for (const channel of EQ_CHANNELS) {
    const name = channelPresetFor(state, channel, profile);
    if (!name) continue;
    const eq = presetEq(state, name, builtins);
    const id = eq && channelEndpoint(channel, devices || []);
    if (id) out.push({ channel, name, id, eq });
  }
  return out;
}

const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

/** The whole payload for the engine: the main EQ, plus one section per channel with its own preset.
 *  With channel EQs, the main EQ lists its outputs explicitly (`devices`) so the channel outputs are
 *  left out of it. "EQ fra" turns everything off. */
export function engineConfig(state, { devices = [], profile = null, target = state?.target || null, builtins = BUILTIN_PRESETS } = {}) {
  const main = enginePayload(state.slots[state.active], state.extras, target, playbackOffset(state));
  if (!main.enabled) return main;
  const chans = activeChannels(state, devices, profile, builtins);
  if (!chans.length) return main;
  const taken = (id) => chans.some((c) => sameId(c.id, id));
  const pool = target ? [target] : devices.filter((d) => d.flow === 'render').map((d) => d.id);
  return {
    ...main,
    devices: pool.filter((id) => !taken(id)),
    channels: chans.map((c) => {
      // "Ingen EQ" is really nothing: no Loudness/Crossfeed either.
      const extras = c.name === FLAT ? {} : state.extras;
      const eq = { ...c.eq, enabled: true };
      const guard = state.clipGuard !== false ? clipGuard(eq, extras) : 0;
      return { ...enginePayload(eq, extras, c.id, guard), channel: c.channel, name: c.name };
    }),
  };
}

/** True when any channel has a preset under any profile. */
export const usesChannelEq = (state) => Object.values(state?.channelEq || {}).some((v) => v && Object.values(v).some(Boolean));
