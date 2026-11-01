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
