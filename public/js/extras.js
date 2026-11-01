// Pure helpers (no DOM) shared by the views and covered by tests/extras.test.mjs.

// ---------- devices ----------
// Windows gives GoXLR endpoints new ids after a driver update; fall back to the device name.
export function resolveDevice(devs, id, name, flow) {
  if (id == null) return null;
  const pool = devs.filter((d) => !flow || d.flow === flow);
  if (pool.some((d) => d.id === id)) return id;
  if (name) {
    const hit = pool.find((d) => d.name === name) || pool.find((d) => d.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.id;
  }
  return undefined; // gone
}

export const deviceName = (devs, id) => devs.find((d) => d.id === id)?.name || null;

// ---------- crossfeed / loudness ----------
// Headphone crossfeed as Equalizer APO commands: a low-passed, slightly delayed copy of each
// channel is mixed into the other one, like hearing speakers in a room.
export function crossfeedLines({ level = -8, cutoff = 700, delay = 0.3 } = {}) {
  const g = Math.pow(10, level / 20);
  const comp = -20 * Math.log10(1 + g);
  return [
    'Channel: all',
    'Copy: XL=L XR=R',
    'Channel: XL XR',
    `Filter: ON LP Fc ${Math.round(cutoff)} Hz`,
    `Delay: ${delay.toFixed(2)} ms`,
    'Channel: all',
    `Copy: L=L+${g.toFixed(4)}*XR R=R+${g.toFixed(4)}*XL`,
    `Preamp: ${comp.toFixed(1)} dB`,
  ];
}

// Gentle bass/treble lift for listening at low volume (amount 0–10 dB).
export function loudnessBands(amount) {
  if (!amount) return [];
  return [
    { enabled: true, type: 'LSC', freq: 100, gain: amount, q: 0.7 },
    { enabled: true, type: 'HSC', freq: 10000, gain: amount / 2, q: 0.7 },
  ];
}

// The payload sent to the Rust engine: the active slot plus crossfeed/loudness.
export function enginePayload(eq, extras = {}, target = null) {
  const loud = extras.loudness?.enabled ? loudnessBands(extras.loudness.amount) : [];
  const preamp = eq.preamp - (loud.length ? extras.loudness.amount : 0);
  return {
    ...eq,
    preamp,
    bands: [...eq.bands, ...loud],
    extra: extras.crossfeed?.enabled ? crossfeedLines(extras.crossfeed) : [],
    target,
  };
}

// ---------- presets ----------
const bandKey = (b) => [b.enabled !== false, b.type, +b.freq, +(b.gain || 0), +b.q].join('|');
// True when the active slot no longer matches the preset it was loaded from.
export function presetModified(eq, preset) {
  if (!preset) return false;
  if (Math.abs((eq.preamp || 0) - (preset.preamp || 0)) > 0.01) return true;
  const a = eq.bands.map(bandKey);
  const b = (preset.bands || []).map(bandKey);
  return a.length !== b.length || a.some((k, i) => k !== b[i]);
}

// ---------- AutoEQ ----------
export const AUTOEQ_RAW = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results';

// INDEX.md lines look like: - [Name](./source/type/Name%20Encoded) by source on rig
export function parseAutoEqIndex(md) {
  const out = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^- \[(.+?)\]\(\.\/(.+?)\)(?: by (.+))?$/);
    if (m) out.push({ name: m[1], path: m[2], source: (m[3] || '').trim() });
  }
  return out;
}

export function autoEqUrl(entry) {
  const folder = entry.path.split('/').pop();
  return `${AUTOEQ_RAW}/${entry.path}/${folder}%20ParametricEQ.txt`;
}

export function searchAutoEq(index, query, limit = 30) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return index.filter((e) => terms.every((t) => e.name.toLowerCase().includes(t))).slice(0, limit);
}

// ---------- updates ----------
export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

// Picks the asset matching how the app is installed: NSIS setup or portable exe.
export function pickUpdateAsset(release, installed) {
  const assets = release?.assets || [];
  const a = installed
    ? assets.find((x) => /-setup\.exe$/i.test(x.name))
    : assets.find((x) => /portable.*\.exe$/i.test(x.name));
  return a ? { url: a.browser_download_url, sha256: a.digest || null, name: a.name, size: a.size } : null;
}

// ---------- app triggers ----------
// Given the exes running before and now, returns the actions to run.
export function triggerActions(triggers, before, now) {
  const has = (set, exe) => [...set].some((x) => x.toLowerCase() === exe.toLowerCase());
  const out = [];
  for (const t of triggers) {
    if (!t.exe) continue;
    const was = has(before, t.exe), is = has(now, t.exe);
    if (!was && is && t.onStart) out.push(t.onStart);
    if (was && !is && t.onExit) out.push(t.onExit);
  }
  return out;
}

// ---------- AutoHotkey import ----------
const AHK_KEYS = {
  pgup: 'PageUp', pgdn: 'PageDown', ins: 'Insert', insert: 'Insert', del: 'Delete', delete: 'Delete', esc: 'Escape', escape: 'Escape',
  enter: 'Enter', space: 'Space', tab: 'Tab', home: 'Home', end: 'End', up: 'Up', down: 'Down', left: 'Left', right: 'Right',
  backspace: 'Backspace', bs: 'Backspace', pause: 'Pause', printscreen: 'PrintScreen', scrolllock: 'ScrollLock',
  media_play_pause: 'MediaPlayPause', media_next: 'MediaTrackNext', media_prev: 'MediaTrackPrevious', media_stop: 'MediaStop',
  volume_up: 'AudioVolumeUp', volume_down: 'AudioVolumeDown', volume_mute: 'AudioVolumeMute',
};
const AHK_CHANNELS = { mic: 'Mic', 'line-in': 'LineIn', console: 'Console', system: 'System', game: 'Game', chat: 'Chat', sample: 'Sample', music: 'Music', headphones: 'Headphones', 'mic-monitor': 'MicMonitor', 'line-out': 'LineOut' };
const AHK_MUTE = { unmuted: 'Unmuted', 'muted-to-x': 'MutedToX', 'muted-to-all': 'MutedToAll' };

// "^!PgUp" → "Ctrl+Alt+PageUp"; null for combos GoXLR Studio can't register (a & b, mouse buttons…).
export function ahkHotkeyToAccel(hk) {
  if (hk.includes(' & ') || /up$/i.test(hk.split(' ').pop()) && / up$/i.test(hk)) return null;
  const m = hk.trim().match(/^([~*$<>^!+#]*)(.+)$/);
  if (!m) return null;
  const mods = [];
  if (m[1].includes('^')) mods.push('Ctrl');
  if (m[1].includes('!')) mods.push('Alt');
  if (m[1].includes('+')) mods.push('Shift');
  if (m[1].includes('#')) mods.push('Super');
  const raw = m[2].trim();
  const low = raw.toLowerCase();
  let key;
  if (/^f([1-9]|1\d|2[0-4])$/.test(low)) key = raw.toUpperCase();
  else if (/^[a-z]$/.test(low)) key = low.toUpperCase();
  else if (/^[0-9]$/.test(low)) key = low;
  else if (/^numpad[0-9]$/.test(low)) key = `Numpad${low.slice(6)}`;
  else if (AHK_KEYS[low]) key = AHK_KEYS[low];
  else return null;
  return [...mods, key].join('+');
}

// AHK v1 `Run, target, workdir, options`: the command ends at the first comma outside quotes.
function cutAtComma(s) {
  let q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === ',') return s.slice(0, i);
  }
  return s;
}

function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Translates one goxlr-client argument list into a GoXLR Studio action id.
export function goxlrClientAction(args) {
  const a = args.map((x) => x.toLowerCase());
  const at = (i) => args[i];
  if (a[0] === 'profiles' && a[2] === 'load' && at(3)) {
    if (a[1] === 'device') return `profile:${at(3)}`;
    if (a[1] === 'microphone') return `micprofile:${at(3)}`;
  }
  if (a[0] === 'volume' && AHK_CHANNELS[a[1]] && /^\d+$/.test(a[2] || '')) return `vol-set:${AHK_CHANNELS[a[1]]}|${Math.min(100, Number(a[2]))}`;
  if (a[0] === 'cough-button' && a[1] === 'mute-state' && AHK_MUTE[a[2]]) return `cough:${AHK_MUTE[a[2]]}`;
  return null;
}

// Finds hotkeys in an AutoHotkey (v1 or v2) script that call goxlr-client and maps them to actions.
export function parseAhk(text) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.replace(/(^|\s);.*$/, '').trim();
    if (!line) continue;
    const hk = line.match(/^([^\s:"'(]+?)::(.*)$/);
    if (hk && !/^:/.test(line)) {
      cur = { hotkey: hk[1], body: [] };
      blocks.push(cur);
      const rest = hk[2].trim();
      if (rest && rest !== '{') { cur.body.push(rest); if (!rest.endsWith('{')) cur = null; }
      continue;
    }
    if (!cur) continue;
    if (/^return\b/i.test(line) || line === '}') { cur = null; continue; }
    cur.body.push(line);
  }
  const bindings = [];
  const unknown = [];
  for (const b of blocks) {
    const calls = [];
    for (const l of b.body) {
      const m = l.match(/goxlr-client(?:-quiet)?(?:\.exe)?["']?\s+(.*)$/i);
      if (!m) continue;
      const args = splitArgs(cutAtComma(m[1])).map((t) => t.replace(/^["'(]+|["')\],]+$/g, '')).filter(Boolean);
      calls.push(goxlrClientAction(args) || `?${m[1].trim()}`);
    }
    if (!calls.length) continue;
    const accel = ahkHotkeyToAccel(b.hotkey);
    const known = calls.filter((c) => !c.startsWith('?'));
    const profiles = [...new Set(known.filter((c) => c.startsWith('profile:')).map((c) => c.slice(8)))];
    let action = null;
    if (profiles.length === 2) action = `profile-toggle:${profiles[0]}|${profiles[1]}`;
    else if (known.length) action = known[0];
    if (accel && action) bindings.push({ hotkey: b.hotkey, accel, action, extra: known.length > 1 && profiles.length !== 2 ? known.slice(1) : [] });
    else unknown.push({ hotkey: b.hotkey, reason: !accel ? 'Tasten kan ikke bruges som global genvej' : 'Kommandoen kendes ikke', text: b.body.join(' / ') });
  }
  return { bindings, unknown };
}

// ---------- fader LEDs ----------
// Same rule as the GoXLR hardware / GoXLR Utility UI: 15 LEDs; those at or below the fader position
// show the bottom colour (colour_two), those above the top colour (colour_one). Gradient styles
// blend bottom→top below the fader and leave the LEDs above it dark.
export const FADER_LEDS = 15;
const hexRgb = (hex) => { const n = parseInt(String(hex).slice(0, 6), 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const rgbHex = (c) => c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();

export function faderLeds(style, top, bottom, value) {
  const lit = Math.ceil((FADER_LEDS / 255) * value + 0.25);
  const t = hexRgb(top), b = hexRgb(bottom);
  return Array.from({ length: FADER_LEDS }, (_, i) => {
    if (style === 'Gradient' || style === 'GradientMeter') {
      if (i >= lit) return null;
      const k = i / FADER_LEDS;
      return rgbHex(b.map((v, j) => v + (t[j] - v) * k));
    }
    return i >= lit ? rgbHex(t) : rgbHex(b);
  });
}

// ---------- Discord mute sync ----------
const mutedFor = (state, fn) => state === 'MutedToAll' || (state === 'MutedToX' && (fn === 'All' || fn === 'ToVoiceChat'));

// Is the mic muted towards voice chat on the GoXLR (cough button and/or the Mic fader's mute)?
export function micMutedForChat(mixer, opts = {}) {
  if (!mixer) return false;
  const cough = opts.cough !== false && mutedFor(mixer.cough_button?.state, mixer.cough_button?.mute_type);
  const fader = opts.fader !== false && Object.values(mixer.fader_status || {}).some((f) => f.channel === 'Mic' && mutedFor(f.mute_state, f.mute_type));
  return cough || fader;
}
