// Your own EQ presets: rename, copy and delete – and every place that names a preset follows along
// (the preset in use, GoXLR profile links, EQ pr. kanal, EQ pr. app, and actions "eq-preset:<navn>"
// in genveje, fodpedaler, enhedsautomatik, tidsstyring and spiltilstand). Pure, so it can be tested.

export const presetAction = (name) => `eq-preset:${name}`;

/** A free name for a copy: "Navn (2)", "Navn (3)" … */
export function copyName(presets, name) {
  const base = String(name).replace(/ \(\d+\)$/, '');
  for (let i = 2; ; i++) {
    const n = `${base} (${i})`;
    if (!(n in presets)) return n;
  }
}

/** Why a new name cannot be used, or null. `from` is the preset being renamed (a case change is fine). */
export function nameProblem(presets, name, from = null) {
  const n = String(name ?? '').trim();
  if (!n) return 'Navnet må ikke være tomt';
  if (n.length > 60) return 'Navnet er for langt (højst 60 tegn)';
  if (/[|]/.test(n)) return 'Navnet må ikke indeholde |';
  const clash = Object.keys(presets).find((k) => k.toLowerCase() === n.toLowerCase());
  if (clash && clash !== from) return `Der findes allerede et preset, der hedder "${clash}"`;
  return null;
}

/** Replaces every string value equal to `from` with `to` anywhere in `value` (arrays and objects). Returns the count. */
export function replaceStrings(value, from, to) {
  let n = 0;
  const walk = (v) => {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (v[i] === from) { v[i] = to; n++; } else if (v[i] && typeof v[i] === 'object') walk(v[i]);
      }
    } else if (v && typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (v[k] === from) { v[k] = to; n++; } else if (v[k] && typeof v[k] === 'object') walk(v[k]);
      }
    }
  };
  walk(value);
  return n;
}

/** Counts string values equal to `s` anywhere in `value`. */
export function countStrings(value, s) {
  let n = 0;
  const walk = (v) => {
    if (v === s) n++;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return n;
}

/** Where the EQ state names `name` (for the delete question). */
export function presetUses(eq, name, others = {}) {
  const uses = [];
  if (eq.presetName === name) uses.push('i brug nu');
  const links = Object.entries(eq.profileLinks || {}).filter(([, v]) => v === name).map(([p]) => p);
  if (links.length) uses.push(`GoXLR-profil ${links.join(', ')}`);
  const chans = [];
  for (const [prof, set] of Object.entries(eq.channelEq || {})) for (const [ch, v] of Object.entries(set || {})) if (v === name) chans.push(prof === '*' ? ch : `${ch} (${prof})`);
  if (chans.length) uses.push(`EQ pr. kanal: ${chans.join(', ')}`);
  const apps = (eq.appEq || []).filter((r) => r?.preset === name).map((r) => r.exe).filter(Boolean);
  if (apps.length) uses.push(`EQ pr. app: ${apps.join(', ')}`);
  const actions = countStrings(others, presetAction(name));
  if (actions) uses.push(actions === 1 ? '1 genvej/handling' : `${actions} genveje/handlinger`);
  return uses;
}

/**
 * Renames a preset in the EQ state and in `others` (an object of lists holding action ids, e.g.
 * { hotkeys, pedals, deviceTriggers, prefs }). Returns { ok, error, moved } – moved = references updated.
 */
export function renamePreset(eq, from, to, others = {}) {
  to = String(to ?? '').trim();
  if (!(from in (eq.presets || {}))) return { ok: false, error: `Fandt ikke "${from}"` };
  if (to === from) return { ok: true, moved: 0 };
  const problem = nameProblem(eq.presets, to, from);
  if (problem) return { ok: false, error: problem };
  // Keep the order of the list (the chips and the tray show them in this order).
  eq.presets = Object.fromEntries(Object.entries(eq.presets).map(([k, v]) => [k === from ? to : k, v]));
  let moved = 0;
  if (eq.presetName === from) { eq.presetName = to; moved++; }
  for (const p of Object.keys(eq.profileLinks || {})) if (eq.profileLinks[p] === from) { eq.profileLinks[p] = to; moved++; }
  for (const set of Object.values(eq.channelEq || {})) for (const ch of Object.keys(set || {})) if (set[ch] === from) { set[ch] = to; moved++; }
  for (const r of eq.appEq || []) if (r?.preset === from) { r.preset = to; moved++; }
  moved += replaceStrings(others, presetAction(from), presetAction(to));
  return { ok: true, moved };
}

/** Copies a preset under a free name ("Navn (2)"). Returns the new name. */
export function duplicatePreset(eq, name, source) {
  const src = source ?? eq.presets?.[name];
  if (!src) return null;
  const n = copyName(eq.presets, name);
  eq.presets[n] = structuredClone(src);
  return n;
}

/**
 * Deletes presets. Links to them (GoXLR profiles, EQ pr. kanal, EQ pr. app) are removed so nothing
 * points at a preset that is gone; actions in genveje etc. are left for the user to change.
 * Returns the names deleted.
 */
export function deletePresets(eq, names) {
  const gone = new Set(names.filter((n) => n in (eq.presets || {})));
  for (const n of gone) delete eq.presets[n];
  if (gone.has(eq.presetName)) eq.presetName = null;
  for (const p of Object.keys(eq.profileLinks || {})) if (gone.has(eq.profileLinks[p])) delete eq.profileLinks[p];
  for (const [prof, set] of Object.entries(eq.channelEq || {})) {
    for (const ch of Object.keys(set || {})) if (gone.has(set[ch])) delete set[ch];
    if (set && !Object.keys(set).length) delete eq.channelEq[prof];
  }
  if (Array.isArray(eq.appEq)) eq.appEq = eq.appEq.filter((r) => !gone.has(r?.preset));
  return [...gone];
}

/** Text files as Notepad reads them: UTF-16/UTF-8 with a BOM, UTF-8, otherwise ANSI (Windows-1252, as Peace writes). */
export function decodeText(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b.length >= 4 && b.length % 2 === 0 && b[0] !== 0 && [...b.subarray(0, 128)].every((x, i) => i % 2 === 0 || x === 0)) return new TextDecoder('utf-16le').decode(b);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { return new TextDecoder('windows-1252').decode(b); }
}
