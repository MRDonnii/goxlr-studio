// EQ pr. kanal: each GoXLR channel (Game, Music, Chat, System) can have its own EQ preset. Apps
// are already routed to channels (Lyd pr. app), so Spotify on Music gets the music EQ and the game
// on Game gets the footsteps EQ by itself. A GoXLR profile can have its own set ("Headset" vs
// "Speakers"); channels without a preset get the main EQ (the editor's A/B slot).
// The engine writes one Equalizer APO "Device:" section per channel (apo.rs).
import { enginePayload, channelEndpoint } from './extras.js';
import { clipGuard, playbackOffset } from './eqchain.js';
import { BUILTIN_PRESETS } from './eq.js';
import { levelOffsets } from './levelmatch.js';

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
  // Lige lydniveau: a channel that is lowered needs its own section, even without its own preset.
  const levels = levelOffsets(state);
  const pool = target ? [target] : devices.filter((d) => d.flow === 'render').map((d) => d.id);
  for (const channel of EQ_CHANNELS) {
    if (!levels[channel] || chans.some((c) => c.channel === channel)) continue;
    const id = channelEndpoint(channel, devices);
    if (id) chans.push({ channel, name: null, id, eq: null, main: pool.some((x) => sameId(x, id)) });
  }
  if (!chans.length) return main;
  const taken = (id) => chans.some((c) => sameId(c.id, id));
  return {
    ...main,
    devices: pool.filter((id) => !taken(id)),
    channels: chans.map((c) => {
      const level = levels[c.channel] || 0;
      // Only lowered: the main EQ where it applied, otherwise nothing but the cut.
      if (!c.eq) {
        const eq = c.main ? state.slots[state.active] : FLAT_EQ;
        const extras = c.main ? state.extras : {};
        return { ...enginePayload({ ...eq, enabled: true }, extras, c.id, (c.main ? playbackOffset(state) : 0) + level), channel: c.channel, name: null, level };
      }
      // "Ingen EQ" is really nothing: no Loudness/Crossfeed either.
      const extras = c.name === FLAT ? {} : state.extras;
      const eq = { ...c.eq, enabled: true };
      const guard = state.clipGuard !== false ? clipGuard(eq, extras) : 0;
      return { ...enginePayload(eq, extras, c.id, guard + level), channel: c.channel, name: c.name, level };
    }),
  };
}

/** True when any channel has a preset under any profile. */
export const usesChannelEq = (state) => Object.values(state?.channelEq || {}).some((v) => v && Object.values(v).some(Boolean));

// ---------- EQ pr. app ----------
// Windows' EQ engine works per output, not per app – but each GoXLR channel is its own output. So
// "Call of Duty gets the footsteps EQ, Spotify the music EQ" = each app on its own channel, with
// that channel's EQ. Apps with the same preset share a channel; four channels = four EQs at once.
const MUSIC_APPS = /spotify|tidal|deezer|itunes|applemusic|musicbee|foobar|aimp|winamp|amazon ?music|youtube ?music|qobuz|plex|musicassistant|music assistant/i;
const CHAT_APPS = /discord|teams|zoom|skype|slack|mumble|teamspeak|ts3client|whatsapp|signal|telegram/i;

/** The channel an app would naturally use: music players → Music, voice chat → Chat, else Game. */
export const preferredChannel = (exe) => (MUSIC_APPS.test(exe) ? 'Music' : CHAT_APPS.test(exe) ? 'Chat' : 'Game');

/** Which channel each preset gets. Apps keep the channel they already use when it is free – except
 *  System, which is Windows' default output where every other sound plays too; then the natural
 *  one; then any free one (System last). `channelOf(exe)` = the channel the app plays on now (or null),
 *  `available` = channels whose Windows output exists. More presets than channels → `full`. */
export function planAppEq(appEq, { channelOf = () => null, available = EQ_CHANNELS } = {}) {
  const groups = [];
  for (const r of appEq || []) {
    if (!r?.exe || !r.preset) continue;
    let g = groups.find((x) => x.preset === r.preset);
    if (!g) groups.push((g = { preset: r.preset, apps: [] }));
    g.apps.push(r.exe);
  }
  const taken = new Map();
  const channelFor = new Map();
  const take = (g, ch) => { taken.set(ch, g.preset); channelFor.set(g.preset, ch); };
  for (const g of groups) {
    for (const exe of g.apps) {
      const ch = channelOf(exe);
      if (ch && ch !== 'System' && available.includes(ch) && !taken.has(ch) && !channelFor.has(g.preset)) take(g, ch);
    }
  }
  for (const g of groups) {
    if (channelFor.has(g.preset)) continue;
    const pref = preferredChannel(g.apps[0]);
    const ch = [pref, ...EQ_CHANNELS.filter((c) => c !== pref)].find((c) => available.includes(c) && !taken.has(c));
    if (ch) take(g, ch);
  }
  return {
    assignments: (appEq || []).filter((r) => r?.exe && r.preset).map((r) => ({ exe: r.exe, preset: r.preset, channel: channelFor.get(r.preset) || null })),
    sets: Object.fromEntries(taken),
    full: groups.filter((g) => !channelFor.has(g.preset)).map((g) => g.preset),
  };
}
