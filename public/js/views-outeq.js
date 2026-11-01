import { h, toggle, toast, debounce } from './ui.js';
import { EqGraph, BAND_COLORS } from './eqgraph.js';
import { BUILTIN_PRESETS, FILTER_TYPES, newBand, defaultOutputEq, totalResponse, bandResponse, suggestedPreamp, parseApoConfig, toApoConfig, coefficients, formatFreq } from './eq.js';
import { storeGet, storeSet, listAudioDevices, apoReadConfig, apoListConfigs, engineInfo, engineTask, isNative } from './native.js';
import { shortName } from './views-mixer.js';
import { applyEqPreset, toggleEq } from './actions.js';
import { presetModified, parseAutoEqIndex, searchAutoEq, autoEqUrl } from './extras.js';

// Reads every Peace/APO preset file and stores the non-empty ones as presets. Returns the imported names.
export async function importPeacePresets(ctx) {
  const files = await apoListConfigs();
  const names = [];
  for (const f of files) {
    const parsed = parseApoConfig(f.text);
    if (!parsed.bands.length) continue;
    let name = f.name.split(/[\\/]/).pop().replace(/ ParametricEQ$/i, '');
    if (/^peace$/i.test(name)) name = 'Peace (nuværende)';
    if (names.includes(name)) name = f.name;
    ctx.outputEq.presets[name] = parsed;
    names.push(name);
  }
  if (names.length) await storeSet('output-eq', ctx.outputEq);
  return { names, total: files.length };
}

const ENGINE_MODES = ['lfx-gfx', 'sfx-efx', 'sfx-mfx'];
const ENGINE_MODE_LABEL = { 'lfx-gfx': 'LFX/GFX – standard', 'sfx-efx': 'SFX/EFX', 'sfx-mfx': 'SFX/MFX' };

// "EQ follows profile": pick a preset per GoXLR profile; applied whenever the profile changes.
function profileLinksCard(ctx) {
  const state = ctx.outputEq;
  state.profileLinks ??= {};
  const profiles = ctx.conn.status?.files?.profiles || [];
  const names = [...Object.keys(state.presets), ...Object.keys(BUILTIN_PRESETS).filter((n) => !(n in state.presets))];
  const rows = profiles.map((p) => {
    const sel = h('select', { onchange: () => {
      if (sel.value) state.profileLinks[p] = sel.value; else delete state.profileLinks[p];
      storeSet('output-eq', state);
      if (sel.value && ctx.conn.mixer?.profile_name === p && state.presetName !== sel.value) applyEqPreset(ctx, sel.value);
    } },
      h('option', { value: '' }, '— uændret —'),
      names.map((n) => h('option', { value: n, selected: state.profileLinks[p] === n }, n)));
    return h('div', { class: 'row' }, h('label', {}, p, ctx.conn.mixer?.profile_name === p ? h('span', { class: 'badge ok', style: { marginLeft: '6px' } }, 'aktiv') : null), sel);
  });
  return h('div', { class: 'card' }, h('h2', {}, 'EQ følger GoXLR-profil'),
    rows.length ? rows : h('div', { class: 'hint' }, 'Ingen GoXLR-profiler fundet.'),
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Når profilen skifter – fra appen, en genvej, G HUB eller GoXLR Utility – skifter EQ’en med. Fx Headset → dit hovedtelefon-preset, Speakers → dit højttaler-preset.'));
}

// Crossfeed and loudness are layered on top of whichever preset is active.
function extrasCard(ctx, apply) {
  const state = ctx.outputEq;
  state.extras ??= {};
  const x = state.extras;
  x.crossfeed ??= { enabled: false, level: -8, cutoff: 700, delay: 0.3 };
  x.loudness ??= { enabled: false, amount: 4 };
  const save = () => { storeSet('output-eq', state); apply(); };
  const sw = (obj) => { const i = h('input', { type: 'checkbox', checked: obj.enabled, onchange: () => { obj.enabled = i.checked; save(); } }); return h('label', { class: 'switch' }, i, h('span')); };
  const range = (obj, key, min, max, step, fmt) => {
    const val = h('span', { class: 'val' }, fmt(obj[key]));
    const r = h('input', { type: 'range', min, max, step, value: obj[key] });
    const fill = () => r.style.setProperty('--p', `${((obj[key] - min) / (max - min)) * 100}%`);
    r.addEventListener('input', () => { obj[key] = Number(r.value); val.textContent = fmt(obj[key]); fill(); });
    r.addEventListener('change', save);
    fill();
    return [r, val];
  };
  return h('div', { class: 'card' }, h('h2', {}, 'Lytte-forbedringer'),
    h('div', { class: 'row' }, h('label', {}, 'Crossfeed'), h('div', { class: 'spacer' }), sw(x.crossfeed)),
    h('div', { class: 'row' }, h('label', {}, 'Styrke'), ...range(x.crossfeed, 'level', -15, -3, 0.5, (v) => `${v} dB`)),
    h('div', { class: 'row' }, h('label', {}, 'Afskæring'), ...range(x.crossfeed, 'cutoff', 300, 1500, 50, (v) => `${v} Hz`)),
    h('div', { class: 'hint' }, 'Til hovedtelefoner: lidt af venstre kanal blandes ind i højre (og omvendt) som når man hører højttalere – mindre "lyd inde i hovedet".'),
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('label', {}, 'Loudness'), h('div', { class: 'spacer' }), sw(x.loudness)),
    h('div', { class: 'row' }, h('label', {}, 'Løft'), ...range(x.loudness, 'amount', 1, 10, 0.5, (v) => `${v} dB`)),
    h('div', { class: 'hint' }, 'Løfter bas og diskant til lav lydstyrke. Preamp sænkes automatisk tilsvarende, så intet klipper. Begge dele virker oven på alle presets.'));
}

// Search the AutoEQ project's measured corrections and import one as a preset.
let autoEqIndex = null;
function autoEqCard(ctx) {
  const input = h('input', { type: 'text', placeholder: 'Model, fx HD 650 eller Arctis', style: { flex: 1 } });
  const results = h('div', { class: 'list autoeq-results' });
  const status = h('div', { class: 'hint' }, 'Måleresultater fra AutoEQ-projektet (github.com/jaakkopasanen/AutoEq) for over 5000 hovedtelefoner.');
  const loadIndex = async () => {
    if (autoEqIndex) return autoEqIndex;
    try { const c = JSON.parse(localStorage.getItem('studio.autoeq-index') || 'null'); if (c && Date.now() - c.at < 7 * 864e5) return (autoEqIndex = c.list); } catch { /* ignore */ }
    status.textContent = 'Henter AutoEQ-oversigten…';
    const r = await fetch('https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/INDEX.md');
    if (!r.ok) throw new Error(`AutoEQ svarede ${r.status}`);
    autoEqIndex = parseAutoEqIndex(await r.text());
    try { localStorage.setItem('studio.autoeq-index', JSON.stringify({ at: Date.now(), list: autoEqIndex })); } catch { /* quota */ }
    status.textContent = `${autoEqIndex.length} profiler.`;
    return autoEqIndex;
  };
  const pick = async (e) => {
    try {
      const r = await fetch(autoEqUrl(e));
      if (!r.ok) throw new Error(`AutoEQ svarede ${r.status}`);
      const parsed = parseApoConfig(await r.text());
      if (!parsed.bands.length) throw new Error('Filen indeholdt ingen filtre');
      const name = `AutoEQ: ${e.name}`;
      ctx.outputEq.presets[name] = parsed;
      await storeSet('output-eq', ctx.outputEq);
      applyEqPreset(ctx, name);
    } catch (err) { toast(String(err.message || err)); }
  };
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { results.replaceChildren(); return; }
    try {
      const hits = searchAutoEq(await loadIndex(), q, 25);
      results.replaceChildren(...hits.map((e) => h('div', { class: 'item' }, h('div', {}, e.name, h('div', { class: 'hint' }, e.source)), h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: () => pick(e) }, 'Brug'))));
      if (!hits.length) results.append(h('div', { class: 'hint' }, 'Ingen match.'));
    } catch (err) { status.textContent = `Kunne ikke hente AutoEQ: ${err.message || err}`; }
  }, 250);
  input.addEventListener('input', search);
  return h('div', { class: 'card' }, h('h2', {}, 'AutoEQ – find dine hovedtelefoner'),
    h('div', { class: 'row' }, input), results, status);
}

function presetBar(ctx) {
  const state = ctx.outputEq;
  const eq = state.slots[state.active];
  const mine = Object.keys(state.presets);
  const key = (n) => ctx.hotkeyFor?.(`eq-preset:${n}`);
  const modified = state.presetName && presetModified(eq, state.presets[state.presetName] || BUILTIN_PRESETS[state.presetName]);
  const chip = (n, builtin) => h('button', {
    class: `chip ${state.presetName === n ? 'on' : ''} ${builtin ? 'ghost' : ''}`,
    title: state.presetName === n && modified ? 'Ændret siden det blev indlæst – klik for at nulstille' : key(n) ? `Genvej: ${key(n)}` : (builtin ? 'Indbygget preset' : 'Klik for at bruge'),
    onclick: () => applyEqPreset(ctx, n),
  }, n, state.presetName === n && modified ? h('span', { class: 'chip-mod' }, ' ●') : null);
  const importBtn = h('button', { class: 'btn sm', onclick: async () => {
    if (!isNative()) { toast('Peace-presets kan kun importeres i Windows-appen.'); return; }
    importBtn.disabled = true;
    importBtn.textContent = 'Importerer…';
    try {
      const { names, total } = await importPeacePresets(ctx);
      toast(names.length ? `Importeret ${names.length} Peace-presets` : `Fandt ingen presets med filtre (${total} filer gennemset)`, names.length ? 'info' : 'error');
      ctx.onStateChanged?.('eq');
    } catch (e) { toast(String(e)); importBtn.disabled = false; importBtn.textContent = 'Importér alle Peace-presets'; }
  } }, 'Importér alle Peace-presets');
  return h('div', { class: 'card preset-bar' },
    h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } },
      h('button', { class: `chip power ${eq.enabled ? 'on' : ''}`, title: 'EQ til/fra (B)', onclick: () => toggleEq(ctx) }, eq.enabled ? '● EQ til' : '○ EQ fra'),
      h('span', { class: 'chip-sep' }),
      mine.map((n) => chip(n)),
      mine.length ? h('span', { class: 'chip-sep' }) : null,
      Object.keys(BUILTIN_PRESETS).filter((n) => !mine.includes(n)).map((n) => chip(n, true)),
      h('div', { class: 'spacer' }),
      importBtn),
    !mine.length ? h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Hent dine Peace-presets ind med ét klik – derefter skifter du med chipsene her, fra bakke-ikonet, toppen af vinduet eller en genvej.') : null);
}


export async function loadOutputEqState() {
  const st = await storeGet('output-eq', null);
  if (st && st.slots) return st;
  return { active: 'A', slots: { A: defaultOutputEq(), B: defaultOutputEq() }, presets: {}, target: null, presetName: null };
}

export function outputEqView(ctx) {
  const state = ctx.outputEq;
  const eq = () => state.slots[state.active];
  let history = [JSON.stringify(eq())];
  let future = [];
  let selected = 0;

  const persist = debounce(() => storeSet('output-eq', state), 400);
  const apply = debounce(() => {
    ctx.applyOutputEq().catch((e) => toast(`EQ-motor: ${e}`));
    preview.update();
  }, 60);
  const changed = (record = true) => {
    if (record) {
      const snap = JSON.stringify(eq());
      if (snap !== history[history.length - 1]) { history.push(snap); if (history.length > 200) history.shift(); future = []; }
    }
    persist();
    apply();
    redraw();
  };
  const restore = (snap) => { state.slots[state.active] = JSON.parse(snap); selected = Math.min(selected, eq().bands.length - 1); changed(false); renderBands(); };
  const undo = () => { if (history.length > 1) { future.push(history.pop()); restore(history[history.length - 1]); } };
  const redo = () => { if (future.length) { const s = future.pop(); history.push(s); restore(s); } };

  const bar = presetBar(ctx);
  const canvas = h('canvas', { class: 'eq-canvas', style: { height: '360px' } });
  const graph = new EqGraph(canvas, {
    minDb: -18, maxDb: 18,
    getPoints: () => eq().bands.map((b, i) => ({
      freq: b.freq, gain: FILTER_TYPES[b.type].gain ? b.gain : 0, q: b.q, enabled: b.enabled && eq().enabled,
      color: BAND_COLORS[i % BAND_COLORS.length], label: String(i + 1), fixedGain: !FILTER_TYPES[b.type].gain,
    })),
    curve: (freqs) => (eq().enabled ? totalResponse(eq(), freqs) : freqs.map(() => 0)),
    bandCurve: (i, freqs) => (eq().bands[i] ? bandResponse(eq().bands[i], freqs) : null),
    onSelect: (i) => { selected = i; renderBands(); },
    onDrag: (i, { freq, gain }, e) => {
      const b = eq().bands[i];
      b.freq = Math.round(Math.min(Math.max(freq, 20), 20000) * 10) / 10;
      if (FILTER_TYPES[b.type].gain && !e.altKey) b.gain = Math.round(gain * 10) / 10;
      changed(false); renderBands();
    },
    onDragEnd: () => changed(true),
    onQ: (i, q) => { eq().bands[i].q = Math.round(q * 1000) / 1000; changed(); renderBands(); },
    onAdd: (freq, gain) => {
      const b = newBand(Math.round(freq), 'PK');
      b.gain = gain;
      eq().bands.push(b);
      selected = eq().bands.length - 1;
      graph.selected = selected;
      changed(); renderBands();
    },
  });
  const redraw = () => { graph.selected = selected; graph.draw(); syncTop(); };

  const bandsBody = h('tbody');
  const renderBands = () => {
    bandsBody.replaceChildren(...eq().bands.map((b, i) => {
      const num = (key, min, max, step, disabled) => {
        const inp = h('input', { type: 'number', min, max, step, value: b[key], disabled });
        inp.addEventListener('change', () => { b[key] = Math.min(Math.max(Number(inp.value), min), max); changed(); });
        inp.addEventListener('focus', () => { selected = i; redraw(); });
        return inp;
      };
      const type = h('select', { onchange: () => { b.type = type.value; changed(); renderBands(); } },
        Object.entries(FILTER_TYPES).map(([k, v]) => h('option', { value: k, selected: k === b.type }, v.label)));
      const en = h('input', { type: 'checkbox', checked: b.enabled, onchange: () => { b.enabled = en.checked; changed(); } });
      return h('tr', { class: i === selected ? 'sel' : '', onclick: () => { if (selected !== i) { selected = i; redraw(); bandsBody.querySelectorAll('tr').forEach((tr, k) => tr.classList.toggle('sel', k === i)); } } },
        h('td', {}, h('span', { class: 'band-dot', style: { background: BAND_COLORS[i % BAND_COLORS.length] } })),
        h('td', {}, h('label', { class: 'switch' }, en, h('span'))),
        h('td', {}, type),
        h('td', {}, num('freq', 20, 20000, 1), ' Hz'),
        h('td', {}, num('gain', -24, 24, 0.1, !FILTER_TYPES[b.type].gain), ' dB'),
        h('td', {}, num('q', 0.1, 20, 0.01)),
        h('td', {}, h('button', { class: 'btn sm', title: 'Slet bånd', onclick: (e) => { e.stopPropagation(); eq().bands.splice(i, 1); selected = Math.max(0, Math.min(selected, eq().bands.length - 1)); changed(); renderBands(); } }, '✕')));
    }));
  };

  const preampIn = h('input', { type: 'number', min: -30, max: 12, step: 0.1 });
  preampIn.addEventListener('change', () => { eq().preamp = Number(preampIn.value); changed(); });
  const clipWarn = h('span', { class: 'badge warn' }, 'Kan klippe');
  const abSeg = h('div', { class: 'seg' });
  const abBtns = ['A', 'B'].map((k) => {
    const b = h('button', { onclick: () => { state.active = k; history = [JSON.stringify(eq())]; future = []; selected = 0; persist(); apply(); renderBands(); redraw(); } }, k);
    abSeg.append(b);
    return [k, b];
  });
  const bypass = h('input', { type: 'checkbox', onchange: () => { eq().enabled = bypass.checked; changed(); ctx.onStateChanged?.('eq-local'); } });
  const syncTop = () => {
    if (document.activeElement !== preampIn) preampIn.value = eq().preamp;
    const peak = Math.max(...totalResponse(eq(), graph.freqs));
    clipWarn.style.display = eq().enabled && peak > 0.05 ? '' : 'none';
    clipWarn.textContent = `Kan klippe (+${peak.toFixed(1)} dB)`;
    bypass.checked = eq().enabled;
    // Keep the "modified" dot on the active preset chip in sync while editing.
    const active = bar.querySelector('.chip.on:not(.power)');
    if (active) {
      const mod = presetModified(eq(), state.presets[state.presetName] || BUILTIN_PRESETS[state.presetName]);
      const dot = active.querySelector('.chip-mod');
      if (mod && !dot) active.append(h('span', { class: 'chip-mod' }, ' ●'));
      if (!mod && dot) dot.remove();
    }
    for (const [k, b] of abBtns) b.classList.toggle('on', k === state.active);
  };

  const toolbar = h('div', { class: 'row', style: { flexWrap: 'wrap' } },
    h('label', { class: 'switch', title: 'EQ til/fra (bypass)' }, bypass, h('span')),
    h('span', {}, 'EQ aktiv'),
    h('span', { class: 'lbl', style: { minWidth: 0, marginLeft: '12px' } }, 'Preamp'), preampIn, h('span', {}, 'dB'),
    h('button', { class: 'btn sm', onclick: () => { eq().preamp = suggestedPreamp(eq()); changed(); } }, 'Auto'),
    clipWarn,
    h('div', { class: 'spacer' }),
    h('span', { class: 'lbl', style: { minWidth: 0 } }, 'Sammenlign'), abSeg,
    h('button', { class: 'btn sm', onclick: () => { state.slots[state.active === 'A' ? 'B' : 'A'] = structuredClone(eq()); persist(); toast(`Kopieret til ${state.active === 'A' ? 'B' : 'A'}`, 'info'); } }, 'Kopiér til den anden'),
    h('button', { class: 'btn sm', title: 'Fortryd (Ctrl+Z)', onclick: undo }, '↶'),
    h('button', { class: 'btn sm', title: 'Gentag (Ctrl+Y)', onclick: redo }, '↷'),
    h('button', { class: 'btn sm primary', onclick: () => { const b = newBand(1000); eq().bands.push(b); selected = eq().bands.length - 1; changed(); renderBands(); } }, '+ Bånd'),
  );

  const presetSel = h('select');
  const renderPresets = () => {
    presetSel.replaceChildren(
      h('optgroup', { label: 'Mine' }, Object.keys(state.presets).map((n) => h('option', { value: `u:${n}` }, n))),
      h('optgroup', { label: 'Indbyggede' }, Object.keys(BUILTIN_PRESETS).map((n) => h('option', { value: `b:${n}` }, n))));
    if (state.presetName && state.presets[state.presetName]) presetSel.value = `u:${state.presetName}`;
  };
  const loadEq = (src, name) => {
    const copy = structuredClone(src);
    copy.bands = copy.bands.map((b) => ({ ...newBand(b.freq, b.type), ...b, id: crypto.randomUUID() }));
    state.slots[state.active] = { enabled: true, preamp: 0, ...copy };
    state.presetName = name;
    selected = 0;
    changed(); renderBands();
    ctx.onStateChanged?.('eq-local');
  };
  const fileIn = h('input', { type: 'file', accept: '.txt,.cfg,text/plain', style: { display: 'none' } });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    const parsed = parseApoConfig(await f.text());
    if (!parsed.bands.length) { toast('Fandt ingen filtre i filen.'); return; }
    const name = f.name.replace(/\.(txt|cfg)$/i, '').replace(/ ParametricEQ$/i, '');
    state.presets[name] = parsed;
    loadEq(parsed, name);
    ctx.onStateChanged?.('eq');
    toast(`Importeret "${name}" – ${parsed.bands.length} filtre`, 'info');
    fileIn.value = '';
  });
  const presetsCard = h('div', { class: 'card' }, h('h2', {}, 'Presets'),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, presetSel,
      h('button', { class: 'btn sm', onclick: () => { const [k, ...r] = presetSel.value.split(':'); const n = r.join(':'); loadEq(k === 'u' ? state.presets[n] : BUILTIN_PRESETS[n], k === 'u' ? n : null); } }, 'Indlæs'),
      h('button', { class: 'btn sm', onclick: () => {
        const n = prompt('Navn på preset', state.presetName || '');
        if (!n) return;
        state.presets[n] = structuredClone(eq()); state.presetName = n; persist(); toast(`Gemt "${n}"`, 'info'); ctx.onStateChanged?.('eq');
      } }, 'Gem som…'),
      h('button', { class: 'btn sm', onclick: () => {
        const [k, ...r] = presetSel.value.split(':'); const n = r.join(':');
        if (k !== 'u' || !confirm(`Slet "${n}"?`)) return;
        delete state.presets[n]; if (state.presetName === n) state.presetName = null; persist(); ctx.onStateChanged?.('eq');
      } }, 'Slet')),
    h('div', { class: 'row' },
      h('button', { class: 'btn sm', onclick: () => fileIn.click() }, 'Importér APO / AutoEQ…'),
      h('button', { class: 'btn sm', onclick: async () => {
        const txt = prompt('Indsæt Equalizer APO-konfiguration (Preamp/Filter-linjer):');
        if (!txt) return;
        const parsed = parseApoConfig(txt);
        if (!parsed.bands.length) { toast('Fandt ingen filtre.'); return; }
        loadEq(parsed, null);
      } }, 'Indsæt tekst'),
      h('button', { class: 'btn sm', onclick: () => {
        const blob = new Blob([toApoConfig(eq())], { type: 'text/plain' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `${state.presetName || 'GoXLR Studio'} ParametricEQ.txt` });
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, 'Eksportér (APO-format)'),
      fileIn),
    h('div', { class: 'hint' }, 'Dine gamle Equalizer APO-filer og AutoEQ-profiler til hovedtelefoner (ParametricEQ.txt) kan importeres direkte.'));
  renderPresets();

  // ---- EQ engine: GoXLR Studio's built-in engine, or a separately installed Equalizer APO ----
  const engineBadge = h('span', { class: 'badge' });
  const engineText = h('div', { class: 'hint' });
  const engineLog = h('div', { class: 'engine-log' });
  const devList = h('div', { class: 'engine-devices' });
  const engineActions = h('div', { class: 'row', style: { flexWrap: 'wrap', marginTop: '10px' } });
  const targetHint = h('div', { class: 'hint' });
  const importApoBtn = h('button', { class: 'btn sm', onclick: async () => {
    try {
      const text = await apoReadConfig();
      const parsed = parseApoConfig(text);
      if (!parsed.bands.length) { toast('Fandt ingen filtre i din Peace/APO-opsætning.'); return; }
      state.presets['Min Peace-opsætning'] = parsed;
      loadEq(parsed, 'Min Peace-opsætning');
      ctx.onStateChanged?.('eq');
      toast(`Importeret ${parsed.bands.length} filtre fra din Peace/APO-opsætning`, 'info');
    } catch (e) { toast(String(e)); }
  } }, 'Importér nuværende Peace-opsætning');
  const targetSel = h('select', { onchange: () => { state.target = targetSel.value || null; state.target_name = targetSel.selectedOptions[0]?.dataset.name || null; persist(); apply(); renderTarget(); } });
  let info = { kind: 'none', devices: [] };
  let chosen = null;
  const isGoXLR = (n) => /goxlr|tc-helicon/i.test(n);
  const installedIds = () => info.devices.filter((d) => d.installed).map((d) => d.id);
  const selectionChanged = () => { const inst = new Set(installedIds()); return chosen.size !== inst.size || [...chosen].some((id) => !inst.has(id)); };
  const run = async (task, busy) => {
    engineActions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    engineText.textContent = busy;
    try {
      const r = await engineTask(task);
      engineLog.replaceChildren(...(r.log || []).map((l) => h('div', {}, '• ', l)));
      if (!r.ok) throw new Error(r.error || 'Ukendt fejl');
      ctx.onApoChanged?.(task.action !== 'uninstall' && task.action !== 'restore-external');
      apply();
      toast(r.reboot ? 'Færdig – genstart pc’en, så alle programmer bruger EQ’en' : 'Færdig', 'info');
    } catch (e) { toast(String(e.message || e)); }
    refreshEngine();
  };
  const needDevices = (fn) => () => (chosen.size ? fn() : toast('Markér mindst én udgang'));
  const replaceExternal = async () => {
    if (!confirm('GoXLR Studio erstatter Equalizer APO med sin indbyggede EQ-motor:\n\n1. Dine Peace/APO-presets importeres og gemmes.\n2. Equalizer APO afinstalleres (Peace virker derefter ikke længere og kan fjernes).\n3. GoXLR Studios motor sættes på de markerede udgange.\n\nWindows beder om administrator-adgang én gang, og lyden afbrydes et øjeblik. Fortsæt?')) return;
    try { const { names } = await importPeacePresets(ctx); if (names.length) toast(`Importeret ${names.length} Peace-presets`, 'info'); } catch { /* no presets */ }
    await run({ action: 'install', devices: [...chosen] }, 'Erstatter Equalizer APO med den indbyggede motor…');
  };
  const btn = (text, cls, fn) => h('button', { class: `btn sm ${cls}`, onclick: fn }, text);
  const renderActions = () => {
    const list = [];
    if (info.kind === 'none') {
      list.push(info.bundled
        ? btn('Installér EQ-motor', 'primary', needDevices(() => run({ action: 'install', devices: [...chosen] }, 'Installerer EQ-motoren…')))
        : h('span', { class: 'hint' }, 'Denne version indeholder ikke EQ-motoren.'));
    }
    if (info.kind === 'external') {
      if (info.bundled) list.push(btn('Erstat med indbygget motor', 'primary', needDevices(replaceExternal)));
      if (!info.uses_our_config) list.push(btn('Brug den eksisterende motor', '', () => run({ action: 'use-external' }, 'Kobler Equalizer APO til GoXLR Studio…')));
    }
    if (info.kind === 'builtin') {
      if (!info.uses_our_config) list.push(btn('Reparér', 'primary', needDevices(() => run({ action: 'install', devices: [...chosen] }, 'Reparerer EQ-motoren…'))));
      else if (selectionChanged()) list.push(btn('Gem udgange', 'primary', () => run({ action: 'set-devices', devices: [...chosen] }, 'Opdaterer udgange…')));
      // Equalizer APO's "troubleshooting options": some drivers only play through the engine when
      // it is hooked in another way. Cycle through the three ways.
      if (installedIds().length && !selectionChanged()) {
        list.push(btn('Hører du ikke EQ’en? Prøv en anden måde', '', () => {
          const cur = info.devices.find((d) => d.installed)?.mode || 'lfx-gfx';
          const next = ENGINE_MODES[(ENGINE_MODES.indexOf(cur) + 1) % ENGINE_MODES.length];
          if (!confirm(`Sæt EQ-motoren på de markerede udgange på en anden måde (${ENGINE_MODE_LABEL[next]})?\n\nLyden afbrydes et øjeblik. Virker det heller ikke, så prøv igen – der er tre måder – og genstart pc’en til sidst.`)) return;
          run({ action: 'set-devices', devices: [...chosen], mode: next }, 'Skifter måde…');
        }));
      }
      list.push(btn('Fjern EQ-motor', '', () => { if (confirm('Fjern GoXLR Studios EQ-motor fra alle udgange?')) run({ action: 'uninstall' }, 'Fjerner EQ-motoren…'); }));
    }
    if (info.external_config) list.push(importApoBtn);
    engineActions.replaceChildren(...list);
  };
  const renderDevices = () => {
    devList.replaceChildren(...info.devices.map((d) => {
      const cb = h('input', { type: 'checkbox', checked: chosen.has(d.id), onchange: () => { if (cb.checked) chosen.add(d.id); else chosen.delete(d.id); renderActions(); } });
      return h('label', { class: 'engine-dev', title: d.mode ? `${d.name} – ${ENGINE_MODE_LABEL[d.mode] || d.mode}` : d.name }, cb, h('span', {}, shortName(d.name)), d.installed ? h('span', { class: 'badge ok' }, 'aktiv') : null);
    }));
    if (!info.devices.length) devList.append(h('div', { class: 'hint' }, 'Fandt ingen udgange.'));
  };
  const renderTarget = () => {
    const d = info.devices.find((x) => x.id === state.target);
    targetHint.textContent = state.target && d && !d.installed ? 'EQ-motoren kører ikke på denne udgang endnu – markér den ovenfor.' : '';
  };
  const refreshEngine = async () => {
    info = await engineInfo().catch((e) => ({ kind: 'none', bundled: false, devices: [], error: String(e) }));
    const inst = installedIds();
    if (!chosen) chosen = new Set(inst.length ? inst : info.devices.filter((d) => isGoXLR(d.name)).map((d) => d.id));
    const running = info.kind !== 'none' && info.uses_our_config && inst.length > 0;
    engineBadge.textContent = running ? 'Aktiv' : info.kind === 'none' ? 'Ikke installeret' : 'Ikke aktiv';
    engineBadge.className = `badge ${running ? 'ok' : 'warn'}`;
    const kind = {
      builtin: `GoXLR Studios indbyggede EQ-motor${info.version ? ` (Equalizer APO ${info.version})` : ''}.`,
      external: 'Equalizer APO er installeret som et separat program.',
      none: 'EQ-motoren er ikke installeret endnu.',
    }[info.kind] || '';
    engineText.textContent = `${kind} ${running ? 'EQ’en virker på de markerede udgange, og ændringer høres med det samme.' : ''}${info.error ? ` (${info.error})` : ''}`;
    renderDevices(); renderActions(); renderTarget();
  };
  listAudioDevices().then((devs) => {
    targetSel.replaceChildren(h('option', { value: '' }, 'Alle markerede udgange'), ...devs.filter((d) => d.flow === 'render').map((d) => h('option', { value: d.id, 'data-name': d.name }, shortName(d.name))));
    targetSel.value = state.target || '';
  }).catch(() => {});
  refreshEngine();
  const engineCard = h('div', { class: 'card' }, h('h2', {}, 'EQ-motor', engineBadge),
    engineText,
    h('div', { class: 'hint', style: { margin: '10px 0 4px' } }, 'Udgange med EQ-motor:'), devList,
    engineActions, engineLog,
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('label', {}, 'EQ gælder for'), targetSel), targetHint);

  const preview = makePreview(eq);
  const previewCard = h('div', { class: 'card' }, h('h2', {}, 'Lyttetest'),
    h('div', { class: 'hint' }, 'Afspil lyd gennem EQ’en her i appen og skift mellem med/uden for at høre forskellen.'),
    preview.controls);

  const onKey = (e) => {
    if (!document.body.contains(canvas)) { document.removeEventListener('keydown', onKey); return; }
    if (e.target.matches('input, select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && eq().bands[selected]) { eq().bands.splice(selected, 1); selected = Math.max(0, selected - 1); changed(); renderBands(); }
    else if (e.key.toLowerCase() === 'b' && !e.ctrlKey && !e.altKey) { toggleEq(ctx); }
  };
  document.addEventListener('keydown', onKey);
  ctx.cleanup.push(() => { graph.destroy(); preview.stop(); document.removeEventListener('keydown', onKey); });

  renderBands();
  setTimeout(redraw);
  apply();

  return h('div', { class: 'grid' },
    bar,
    h('div', { class: 'card' }, h('h2', {}, 'Parametrisk EQ – afspilning'), toolbar,
      h('div', { class: 'eq-wrap', style: { marginTop: '12px' } }, canvas),
      h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Træk punkter · scroll = Q · dobbeltklik = nyt bånd · Alt+træk = kun frekvens · Del = slet · B = bypass · Ctrl+Z/Y = fortryd/gentag'),
      h('table', { class: 'band-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Til'), h('th', {}, 'Type'), h('th', {}, 'Frekvens'), h('th', {}, 'Gain'), h('th', {}, 'Q'), h('th'))), bandsBody)),
    h('div', { class: 'grid cols-3' }, presetsCard, engineCard, previewCard),
    h('div', { class: 'grid cols-3' }, profileLinksCard(ctx), extrasCard(ctx, apply), autoEqCard(ctx)));
}

function makePreview(getEq) {
  let ac = null, src = null, chainIn = null, out = null, bypassed = false, kind = null, buffer = null;
  const status = h('span', { class: 'hint' });
  const playNoise = h('button', { class: 'btn sm', onclick: () => start('noise') }, 'Pink noise');
  const fileIn = h('input', { type: 'file', accept: 'audio/*', style: { display: 'none' } });
  const playFile = h('button', { class: 'btn sm', onclick: () => fileIn.click() }, 'Afspil musikfil…');
  const ab = h('button', { class: 'btn sm', onclick: () => { bypassed = !bypassed; rebuild(); } }, 'Med EQ');
  const stopBtn = h('button', { class: 'btn sm', onclick: () => stop() }, 'Stop');
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    ensure();
    try { buffer = await ac.decodeAudioData(await f.arrayBuffer()); start('file', f.name); } catch { toast('Kunne ikke læse lydfilen.'); }
    fileIn.value = '';
  });

  function ensure() {
    if (!ac) { ac = new AudioContext(); out = ac.createGain(); out.gain.value = 0.5; out.connect(ac.destination); }
  }
  function pinkNoise() {
    const len = ac.sampleRate * 4;
    const buf = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.08;
        b6 = w * 0.115926;
      }
    }
    return buf;
  }
  function start(k, name) {
    ensure();
    stopSource();
    kind = k;
    src = ac.createBufferSource();
    src.buffer = k === 'noise' ? pinkNoise() : buffer;
    src.loop = true;
    src.start();
    status.textContent = k === 'noise' ? 'Spiller pink noise' : `Spiller ${name || 'fil'}`;
    rebuild();
  }
  function rebuild() {
    if (!src) { ab.textContent = bypassed ? 'Uden EQ' : 'Med EQ'; return; }
    src.disconnect();
    chainIn?.forEach((n) => n.disconnect());
    chainIn = [];
    const eq = getEq();
    let node = src;
    if (!bypassed && eq.enabled) {
      const pre = ac.createGain();
      pre.gain.value = Math.pow(10, eq.preamp / 20);
      node.connect(pre); node = pre; chainIn.push(pre);
      for (const b of eq.bands) {
        if (!b.enabled) continue;
        const c = coefficients(b, ac.sampleRate);
        const f = ac.createIIRFilter([c.b0, c.b1, c.b2], [1, c.a1, c.a2]);
        node.connect(f); node = f; chainIn.push(f);
      }
    }
    node.connect(out);
    ab.textContent = bypassed ? 'Uden EQ' : 'Med EQ';
    ab.classList.toggle('on', !bypassed);
  }
  function stopSource() { try { src?.stop(); } catch { /* already stopped */ } src?.disconnect(); src = null; }
  function stop() { stopSource(); status.textContent = ''; kind = null; }
  return {
    controls: h('div', {}, h('div', { class: 'row', style: { flexWrap: 'wrap' } }, playNoise, playFile, ab, stopBtn, fileIn), h('div', { class: 'row' }, status)),
    update: () => { if (src) rebuild(); },
    stop: () => { stop(); ac?.close(); ac = null; },
    get playing() { return !!kind; },
  };
}

export { formatFreq };
