import { h, toggle, toast, debounce, confirmDialog, promptDialog } from './ui.js';
import { EqGraph, BAND_COLORS } from './eqgraph.js';
import { BUILTIN_PRESETS, PRESET_INFO, SOUND_FIXES, fixMove, FILTER_TYPES, SLOPES, EAR_LABEL, usesEars, onEar, expandBands, SLIDER_SETS, graphicGain, resampleGraphic, graphicActive, graphicOnSet, parseApoConfigReport, ignoredText, newBand, defaultOutputEq, totalResponse, bandResponse, toApoConfig, coefficients, formatFreq } from './eq.js';
import { chainResponse, chainLoudness, safePreamp, floorBase, balancedPreamp, headroomInfo, bandWarnings, abMatch, abText, playbackOffset, blindVerdict, slotsEqual, loudnessDb, CHAIN_FREQS } from './eqchain.js';
import { storeGet, storeSet, listAudioDevices, apoReadConfig, apoListConfigs, engineInfo, engineTask, isNative, spectrumRead, audioLevels } from './native.js';
import { t, language } from './i18n.js';
import { SPECTRUM_BANDS, SPECTRUM_FLOOR, SPECTRUM_FREQS, smoothSpectrum, pickSpectrumDevice, bandsFromBins } from './spectrum.js';
import { shortName, CHANNEL_LABEL } from './views-mixer.js';
import { EQ_CHANNELS, FLAT, ALL_PROFILES, channelPresetFor, presetEq, activeChannels } from './channeleq.js';
import { channelEndpoint } from './extras.js';
import { applyEqPreset, toggleEq } from './actions.js';
import { presetModified, parseAutoEqIndex, searchAutoEq, autoEqUrl, exportPresets, importPresets } from './extras.js';

// An imported EQ counts when it has parametric bands or a GraphicEQ curve (Peace's sliders).
const hasFilters = (eq) => !!(eq?.bands?.length || eq?.graphic?.length);

/** A warning toast when an import left lines out (Delay, Copy, Convolution …), so nothing disappears silently. */
export function warnIgnored(what, ignored) {
  if (!ignored?.length) return;
  const list = ignoredText(ignored);
  toast(ignored.length === 1 ? `${what}: 1 linje blev ikke importeret – ${list}` : `${what}: ${ignored.length} linjer blev ikke importeret – ${list}`, 'warn');
}

// Reads every Peace/APO preset file and stores the non-empty ones as presets. Returns the imported names.
export async function importPeacePresets(ctx) {
  const files = await apoListConfigs();
  const names = [];
  const skipped = [];
  for (const f of files) {
    const { eq: parsed, ignored } = parseApoConfigReport(f.text);
    if (!hasFilters(parsed)) continue;
    skipped.push(...ignored.map((x) => ({ ...x, line: `${f.name}: ${x.line}` })));
    let name = f.name.split(/[\\/]/).pop().replace(/ ParametricEQ$/i, '');
    if (/^peace$/i.test(name)) name = 'Peace (nuværende)';
    if (names.includes(name)) name = f.name;
    ctx.outputEq.presets[name] = parsed;
    names.push(name);
  }
  if (names.length) await storeSet('output-eq', ctx.outputEq);
  warnIgnored('Peace-presets', skipped);
  return { names, total: files.length, ignored: skipped };
}

const ENGINE_MODES = ['lfx-gfx', 'sfx-efx', 'sfx-mfx'];
const ENGINE_MODE_LABEL = { 'lfx-gfx': 'LFX/GFX', 'sfx-efx': 'SFX/EFX', 'sfx-mfx': 'SFX/MFX' };

// Summary of the last engine test (see engine.rs Task::Test): which outputs the engine loads on.
export function engineTestSummary(tests = [], sound = []) {
  const tested = tests.filter((t) => !t.error);
  const ok = tested.filter((t) => t.ok);
  if (!tested.length) return null;
  if (ok.length !== tested.length) {
    const bad = tested.filter((t) => !t.ok).map((t) => shortName(t.name)).join(', ');
    return { ok: false, kind: 'not-loaded', text: `EQ-motoren blev ikke indlæst på: ${bad}. Genstart pc’en og tryk "Test EQ-motoren".` };
  }
  // Fejl 2: loaded is not enough – the EQ must apply where the sound plays.
  const warn = sound.find((l) => l.startsWith('⚠'));
  if (warn) return { ok: false, kind: 'coverage', text: warn.replace(/^⚠\s*/, '') };
  return { ok: true, kind: 'ok', text: `EQ-motoren er testet og kører på ${ok.length === 1 ? 'udgangen' : `alle ${ok.length} udgange`}.` };
}

// Does the EQ (state.target = one output, or null = all marked outputs) apply to this output?
const appliesTo = (state, id) => !state.target || String(state.target).toLowerCase() === String(id).toLowerCase();

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
      if (sel.value && ctx.conn.mixer?.profile_name === p && state.presetName !== sel.value) applyEqPreset(ctx, sel.value, `knyttet til GoXLR-profilen "${p}"`);
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
  x.channels ??= { mono: false, balance: 0 };
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
    h('div', { class: 'hint' }, 'Løfter bas og diskant til lav lydstyrke. Preamp sænkes automatisk tilsvarende, så intet klipper. Begge dele virker oven på alle presets.'),
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('label', {}, 'Mono'), h('div', { class: 'spacer' }),
      (() => { const i = h('input', { type: 'checkbox', 'data-testid': 'eq-mono', checked: !!x.channels.mono, onchange: () => { x.channels.mono = i.checked; save(); } }); return h('label', { class: 'switch' }, i, h('span')); })()),
    h('div', { class: 'row' }, h('label', {}, 'Balance'), ...range(x.channels, 'balance', -10, 10, 0.5, (v) => (v === 0 ? 'Midt' : `${v > 0 ? 'H' : 'V'} ${String(Math.abs(v)).replace('.', ',')} dB`))),
    h('div', { class: 'hint' }, 'Mono: begge ører får det samme – fx med én øresnegl eller nedsat hørelse på det ene øre. Balance: H 3 dB = venstre side 3 dB lavere, så lyden flytter mod højre.'));
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
      const { eq: parsed, ignored } = parseApoConfigReport(await r.text());
      if (!hasFilters(parsed)) throw new Error('Filen indeholdt ingen filtre');
      warnIgnored('AutoEQ', ignored);
      const name = `AutoEQ: ${e.name}`;
      ctx.outputEq.presets[name] = parsed;
      await storeSet('output-eq', ctx.outputEq);
      applyEqPreset(ctx, name, 'AutoEQ');
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
    onclick: () => applyEqPreset(ctx, n, 'preset-knap på EQ-siden'),
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
    PRESET_INFO[state.presetName] && !state.presets[state.presetName] ? h('div', { class: 'hint preset-info', 'data-testid': 'preset-info', style: { marginTop: '8px' } }, `${state.presetName}: ${PRESET_INFO[state.presetName]}`) : null,
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
  // Fortryd/gentag per slot, kept across restarts (this PC only).
  const UNDO_KEY = 'studio.eq-undo';
  const loadUndo = () => {
    const cur = JSON.stringify(eq());
    try {
      const u = JSON.parse(localStorage.getItem(UNDO_KEY) || '{}')[state.active];
      if (u?.history?.length) {
        if (u.history[u.history.length - 1] === cur) return [u.history, u.future || []];
        return [[...u.history.slice(-49), cur], []];
      }
    } catch { /* no storage */ }
    return [[cur], []];
  };
  const saveUndo = () => {
    try {
      const all = JSON.parse(localStorage.getItem(UNDO_KEY) || '{}');
      all[state.active] = { history: history.slice(-50), future: future.slice(-50) };
      localStorage.setItem(UNDO_KEY, JSON.stringify(all));
    } catch { /* full or blocked */ }
  };
  let [history, future] = loadUndo();
  let selected = 0;

  const persist = debounce(() => storeSet('output-eq', state), 400);
  const apply = debounce(() => {
    ctx.applyOutputEq().catch((e) => toast(`EQ-motor: ${e}`));
    preview.update();
  }, 60);
  // Balance (standard til): every boost lowers the floor (preamp) as much, so a boost becomes a
  // balanced change instead of just more level. `base` is your own floor on top of that; it is
  // taken from the preamp whenever an EQ is loaded, restored or the preamp is set by hand.
  const balanceOn = () => state.balance !== false;
  let base = floorBase(eq());
  const rebase = () => { base = floorBase(eq()); };
  const changed = (record = true) => {
    if (balanceOn()) eq().preamp = balancedPreamp(eq(), base);
    if (record) {
      const snap = JSON.stringify(eq());
      if (snap !== history[history.length - 1]) { history.push(snap); if (history.length > 200) history.shift(); future = []; saveUndo(); }
    }
    persist();
    apply();
    redraw();
  };
  const restore = (snap) => { state.slots[state.active] = JSON.parse(snap); selected = Math.min(selected, eq().bands.length - 1); rebase(); changed(false); renderBands(); };
  const undo = () => { if (history.length > 1) { future.push(history.pop()); restore(history[history.length - 1]); saveUndo(); } };
  const redo = () => { if (future.length) { const s = future.pop(); history.push(s); restore(s); saveUndo(); } };

  const bar = presetBar(ctx);
  const fmt1 = (v) => String(Math.round(Math.abs(v) * 10) / 10).replace('.', ',');
  const chainLegend = h('div', { class: 'hint chain-legend' }, h('span', { class: 'chain-dash' }), 'Stiplet: det der faktisk spilles – med Loudness, Crossfeed, klip-beskyttelse og udligning af A/B.');
  // Venstre/højre øre: when a band is for one ear only, the graph shows a curve per ear.
  const earLegend = h('div', { class: 'hint chain-legend', 'data-testid': 'ear-legend' }, h('span', { class: 'ear-swatch left' }), h('span', {}, 'Venstre øre'), h('span', { class: 'ear-swatch right' }), h('span', {}, 'Højre øre'));
  const canvas = h('canvas', { class: 'eq-canvas', style: { height: '360px' } });
  const graph = new EqGraph(canvas, {
    minDb: -18, maxDb: 18,
    getPoints: () => eq().bands.map((b, i) => ({
      freq: b.freq, gain: FILTER_TYPES[b.type].gain ? b.gain : 0, q: b.q, enabled: b.enabled && eq().enabled,
      color: BAND_COLORS[i % BAND_COLORS.length], label: `${i + 1}${b.channel === 'L' ? (language() === 'en' ? 'L' : 'V') : b.channel === 'R' ? (language() === 'en' ? 'R' : 'H') : ''}`, fixedGain: !FILTER_TYPES[b.type].gain,
    })),
    curve: (freqs) => (eq().enabled ? totalResponse(eq(), freqs, 'L') : freqs.map(() => 0)),
    curveR: (freqs) => (eq().enabled && usesEars(eq()) ? totalResponse(eq(), freqs, 'R') : null),
    // What is really played (Loudness, Crossfeed, klip-beskyttelse) – only when it differs.
    chainCurve: (freqs) => (chainDiffers() ? chainResponse(eq(), state.extras, freqs, offsetDb()) : null),
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
        inp.addEventListener('change', () => { b[key] = Math.min(Math.max(Number(inp.value), min), max); changed(); warn(); });
        inp.addEventListener('focus', () => { selected = i; redraw(); });
        return inp;
      };
      const type = h('select', { onchange: () => { b.type = type.value; changed(); renderBands(); } },
        Object.entries(FILTER_TYPES).map(([k, v]) => h('option', { value: k, selected: k === b.type }, v.label)));
      const en = h('input', { type: 'checkbox', checked: b.enabled, onchange: () => { b.enabled = en.checked; changed(); warn(); } });
      // Big boosts and very narrow boosts get a ⚠ with the reason (Tillæg 2).
      const warnIcon = h('span', { class: 'band-warn', 'data-testid': 'band-warn' }, '⚠');
      const warn = () => { const w = bandWarnings(b); warnIcon.style.display = w.length ? '' : 'none'; warnIcon.title = w.join('\n'); };
      warn();
      return h('tr', { class: i === selected ? 'sel' : '', onclick: () => { if (selected !== i) { selected = i; redraw(); bandsBody.querySelectorAll('tr').forEach((tr, k) => tr.classList.toggle('sel', k === i)); } } },
        h('td', {}, h('span', { class: 'band-dot', style: { background: BAND_COLORS[i % BAND_COLORS.length] } })),
        h('td', {}, h('label', { class: 'switch' }, en, h('span'))),
        h('td', {}, type),
        h('td', {}, h('select', { class: 'ear-sel', 'data-testid': 'band-ear', title: 'Hvilket øre båndet gælder for', onchange: (e) => { if (e.target.value === 'all') delete b.channel; else b.channel = e.target.value; changed(); renderBands(); } },
          Object.entries(EAR_LABEL).map(([k, v]) => h('option', { value: k, selected: (b.channel || 'all') === k }, v)))),
        h('td', {}, num('freq', 20, 20000, 1), ' Hz'),
        h('td', {}, num('gain', -24, 24, 0.1, !FILTER_TYPES[b.type].gain), ' dB'),
        h('td', {}, num('q', 0.1, 30, 0.01, b.slope > 12), FILTER_TYPES[b.type].slope
          ? h('select', { class: 'slope-sel', title: 'Hældning (dB pr. oktav)', 'data-testid': 'band-slope', onchange: (e) => { b.slope = Number(e.target.value); if (b.slope <= 12) delete b.slope; changed(); renderBands(); } },
            SLOPES.map((sl) => h('option', { value: sl, selected: (b.slope || 12) === sl }, `${sl} dB/okt`)))
          : null, warnIcon),
        h('td', {}, h('button', { class: 'btn sm', title: 'Slet bånd', onclick: (e) => { e.stopPropagation(); eq().bands.splice(i, 1); selected = Math.max(0, Math.min(selected, eq().bands.length - 1)); changed(); renderBands(); } }, '✕')));
    }));
    renderSliders();
  };
  let renderSliders = () => {};

  const preampIn = h('input', { type: 'number', min: -30, max: 12, step: 0.1 });
  preampIn.addEventListener('change', () => { eq().preamp = Number(preampIn.value); rebase(); changed(); preampIn.value = eq().preamp; });
  // Headroom of the whole chain (EQ + Loudness + Crossfeed); "Klip-beskyttelse" lowers the preamp
  // in the engine when the chain would go above 0 dB, without changing the preset.
  const headBadge = h('span', { class: 'badge', 'data-testid': 'eq-headroom' });
  const guardOn = () => state.clipGuard !== false;
  // Klip-beskyttelse + the A/B loudness match, as the engine adds them (eqchain.js playbackOffset).
  const offsetDb = () => playbackOffset(state);
  const chainDiffers = () => eq().enabled && (!!state.extras?.loudness?.enabled || !!state.extras?.crossfeed?.enabled || offsetDb() !== 0);
  const guardBox = h('input', { type: 'checkbox', 'data-testid': 'eq-clip-guard', onchange: () => { state.clipGuard = guardBox.checked; persist(); apply(); redraw(); } });
  const selectSlot = (k) => { state.active = k; [history, future] = loadUndo(); selected = 0; rebase(); persist(); apply(); renderBands(); redraw(); };
  const balanceBox = h('input', { type: 'checkbox', 'data-testid': 'eq-balance', onchange: () => {
    state.balance = balanceBox.checked; rebase(); changed();
    toast(balanceBox.checked ? 'Balance til: løfter du et bånd, sænkes hele gulvet lige så meget' : 'Balance fra: preamp styrer du selv', 'info');
  } });
  const abSeg = h('div', { class: 'seg', 'data-testid': 'eq-ab' });
  const abBtns = ['A', 'B'].map((k) => {
    const b = h('button', { onclick: () => selectSlot(k) }, k);
    abSeg.append(b);
    return [k, b];
  });
  // Tillæg 2: A/B at the same loudness – the louder one sounds "better" without being better.
  const matchBox = h('input', { type: 'checkbox', 'data-testid': 'eq-ab-match', onchange: () => { state.abMatch = matchBox.checked; persist(); apply(); redraw(); } });
  const abInfo = h('span', { class: 'ab-info', 'data-testid': 'eq-ab-info' });
  const other = () => (state.active === 'A' ? 'B' : 'A');
  const setOther = (eqNew, msg) => { state.slots[other()] = eqNew; persist(); apply(); redraw(); toast(msg, 'info'); };
  const bypass = h('input', { type: 'checkbox', onchange: () => { eq().enabled = bypass.checked; changed(); ctx.onStateChanged?.('eq-local'); } });
  let syncPre = () => {};
  const syncTop = () => {
    if (document.activeElement !== preampIn) preampIn.value = eq().preamp;
    syncPre();
    const head = headroomInfo(eq(), state.extras, guardOn());
    headBadge.textContent = head.text;
    headBadge.className = `badge ${head.kind === 'ok' ? 'ok' : head.kind === 'clip' ? 'warn' : head.kind === 'guard' ? 'info' : ''}`;
    headBadge.title = head.kind === 'guard'
      ? `EQ’en ville gå ${fmt1(head.peak)} dB over 0 dB og klippe. Motoren sænker derfor lyden ${fmt1(-head.guard)} dB – dit preset er uændret. Tryk "Auto" for at sætte preamp selv.`
      : head.kind === 'clip' ? 'Lyden kan forvrænge (klippe) ved høj lydstyrke. Tryk "Auto", eller slå klip-beskyttelse til.'
        : head.kind === 'ok' ? 'Afstanden fra EQ’ens højeste punkt (inkl. Loudness og Crossfeed) til 0 dB. Over 0 dB kan lyden klippe.' : '';
    guardBox.checked = guardOn();
    chainLegend.style.display = chainDiffers() ? '' : 'none';
    earLegend.style.display = usesEars(eq()) ? '' : 'none';
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
    const m = abMatch(state);
    abInfo.textContent = abText(m, state.abMatch !== false);
    abInfo.className = `ab-info ${Math.abs(m.diff) >= 0.1 && state.abMatch !== false && !m.unmatched ? 'ok' : Math.abs(m.diff) >= 0.1 ? 'warn' : ''}`;
    matchBox.checked = state.abMatch !== false;
    balanceBox.checked = balanceOn();
  };

  const toolbar = h('div', { class: 'row', style: { flexWrap: 'wrap' } },
    h('label', { class: 'switch', title: 'EQ til/fra (bypass)' }, bypass, h('span')),
    h('span', {}, 'EQ aktiv'),
    h('span', { class: 'lbl', style: { minWidth: 0, marginLeft: '12px' } }, 'Preamp'), preampIn, h('span', {}, 'dB'),
    h('button', { class: 'btn sm', 'data-testid': 'eq-auto-preamp', title: 'Sæt preamp, så det højeste punkt af hele kæden (inkl. Loudness og Crossfeed) lige rammer 0 dB', onclick: () => { eq().preamp = safePreamp(eq(), state.extras); rebase(); changed(); } }, 'Auto'),
    headBadge,
    h('label', { class: 'check-inline', title: 'Hæv aldrig uden at sænke gulvet: løfter du et bånd, sænkes preamp – hele resten af lyden – lige så meget, så du får balance i stedet for bare mere lyd. Tager du løftet ned igen, kommer gulvet op igen. Du kan selv sænke preamp yderligere, men ikke hæve den over balancen.' }, balanceBox, h('span', {}, 'Balance')),
    h('label', { class: 'check-inline', title: 'Sænker automatisk preamp, så EQ’en – også med Loudness og Crossfeed – aldrig klipper. Dit preset ændres ikke.' }, guardBox, h('span', {}, 'Klip-beskyttelse')),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm', title: 'Fortryd (Ctrl+Z)', onclick: undo }, '↶'),
    h('button', { class: 'btn sm', title: 'Gentag (Ctrl+Y)', onclick: redo }, '↷'),
    h('button', { class: 'btn sm primary', onclick: () => { const b = newBand(1000); eq().bands.push(b); selected = eq().bands.length - 1; changed(); renderBands(); } }, '+ Bånd'),
  );
  const abRow = h('div', { class: 'row ab-row', style: { flexWrap: 'wrap' } },
    h('span', { class: 'lbl', style: { minWidth: 0 } }, 'Sammenlign'), abSeg,
    h('button', { class: 'btn sm', onclick: () => setOther(structuredClone(eq()), `Kopieret til ${other()}`) }, 'Kopiér til den anden'),
    h('button', { class: 'btn sm', 'data-testid': 'eq-ab-flat', title: 'Sammenlign med og uden EQ: den anden bliver flad (ingen filtre)', onclick: () => setOther({ enabled: true, preamp: 0, bands: [] }, `${other()} er nu flad – uden EQ`) }, 'Gør den anden flad'),
    h('label', { class: 'check-inline', title: 'Den højeste af A og B sænkes, så de spiller lige højt (målt som LUFS). Ellers lyder den højeste næsten altid bedst – uden at være det.' }, matchBox, h('span', {}, 'Udlign lydstyrke')),
    abInfo,
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn sm', 'data-testid': 'eq-blind-start', title: 'Hør A og B som X og Y uden at vide hvilken er hvilken – 5 runder', onclick: () => startBlind() }, 'Blindtest'));

  // ---- Live-spektrum (Tillæg 2): what plays right now, behind the curve ----
  const specCanvas = h('canvas', { class: 'eq-spectrum' });
  const prefs = ctx.prefs;
  const specToggle = h('input', { type: 'checkbox', 'data-testid': 'eq-spectrum-on', checked: prefs.eqSpectrum !== false, onchange: () => {
    prefs.eqSpectrum = specToggle.checked; ctx.savePrefs?.();
    specSel.disabled = !specToggle.checked;
    if (!specToggle.checked) { specLevels = null; graph.drawSpectrum(specCanvas, null); specStatus.textContent = ''; }
  } });
  const specSel = h('select', { 'data-testid': 'eq-spectrum-device', disabled: prefs.eqSpectrum === false, onchange: () => { prefs.eqSpectrumDevice = specSel.value; ctx.savePrefs?.(); specAuto = null; specLevels = null; } },
    h('option', { value: 'auto' }, 'Automatisk – det der spiller'), h('option', { value: '' }, 'Windows’ standardudgang'));
  const specStatus = h('span', { class: 'spectrum-status', 'data-testid': 'eq-spectrum-status' });
  let renderDevs = [];
  listAudioDevices().then((devs) => {
    const goxlr = (d) => (/goxlr|tc-helicon/i.test(d.name) ? 0 : 1);
    renderDevs = devs.filter((d) => d.flow === 'render').sort((a, b) => goxlr(a) - goxlr(b));
    specSel.append(...renderDevs.map((d) => h('option', { value: d.id }, shortName(d.name))));
    renderChannels();
    specSel.value = prefs.eqSpectrumDevice ?? 'auto';
    if (!specSel.value && prefs.eqSpectrumDevice) specSel.value = 'auto';
  }).catch(() => {});
  let specLevels = null, specAt = 0, specAuto = null, levelsAt = 0, specBusy = false;
  const specTick = async () => {
    if (specBusy || !specToggle.checked || document.hidden || blind || !document.body.contains(canvas)) return;
    specBusy = true;
    try {
      const now = performance.now();
      let bands = null, label;
      if (preview.playing) {
        bands = preview.spectrum();
        label = 'Lyttetest';
        specStatus.textContent = 'Viser lyttetesten – med EQ';
      } else {
        let dev = specSel.value;
        if (dev === 'auto') {
          if (now - levelsAt > 1000) { levelsAt = now; specAuto = pickSpectrumDevice(await audioLevels().catch(() => null), renderDevs.map((d) => d.id), specAuto); }
          dev = specAuto;
        }
        const r = await spectrumRead(dev || null);
        label = dev ? shortName(renderDevs.find((d) => d.id === dev)?.name || dev) : 'Standardudgangen';
        bands = r?.bands?.length === SPECTRUM_BANDS ? r.bands : null;
        specStatus.textContent = r?.error ? `Kan ikke lytte på ${label}: ${r.error}` : r?.playing ? `Lytter på ${label}` : `${label}: intet spiller lige nu`;
      }
      specLevels = smoothSpectrum(specLevels, bands || new Array(SPECTRUM_BANDS).fill(SPECTRUM_FLOOR), now - specAt);
      specAt = now;
      graph.drawSpectrum(specCanvas, { freqs: SPECTRUM_FREQS, db: specLevels, label: t(label) });
    } catch { /* next tick */ } finally { specBusy = false; }
  };
  const specTimer = setInterval(specTick, 50);
  const spectrumRow = h('div', { class: 'row spectrum-row' },
    h('label', { class: 'check-inline', title: 'Viser det, der spiller lige nu, bag EQ-kurven – så du kan se, hvor musikken eller spillet har sin energi.' }, specToggle, h('span', {}, 'Live-spektrum')),
    specSel, specStatus);

  // ---- Three ways to edit: Tabel, Sliders (like Peace) and Grafisk kurve ----
  const fmtHz = (f) => (f >= 1000 ? `${String(Math.round(f / 100) / 10).replace('.', ',')}k` : String(Math.round(f * 10) / 10).replace('.', ','));
  const fmtGain = (g) => `${g > 0 ? '+' : ''}${String(Math.round(g * 10) / 10).replace('.', ',')}`;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // Preamp as a slider column, as in Peace (shared by the two slider views; the toolbar has it too).
  const preRange = h('input', { type: 'range', min: -30, max: 12, step: 0.1, 'aria-label': 'Preamp', 'data-testid': 'slider-preamp' });
  const preNum = h('input', { type: 'number', min: -30, max: 12, step: 0.1, class: 'col-num', 'data-testid': 'slider-preamp-value' });
  const setPre = (v, record) => {
    eq().preamp = Math.round(clamp(v, -30, 12) * 10) / 10; rebase(); changed(record);
    // Balance may have held the floor down – show what it really is.
    preNum.value = eq().preamp; if (record) preRange.value = eq().preamp;
  };
  preRange.addEventListener('input', () => { preNum.value = preRange.value; setPre(Number(preRange.value), false); });
  preRange.addEventListener('change', () => setPre(Number(preRange.value), true));
  preRange.addEventListener('dblclick', () => setPre(0, true));
  preNum.addEventListener('change', () => setPre(Number(preNum.value), true));
  syncPre = () => {
    if (document.activeElement !== preNum) preNum.value = eq().preamp;
    if (document.activeElement !== preRange) preRange.value = eq().preamp;
  };
  const preCol = h('div', { class: 'slider-col peace-col pre-col' }, h('span', { class: 'col-head' }, 'Preamp'), preNum, preRange, h('span', { class: 'slider-hz' }, 'dB'));

  // Sliders like Peace: one column per band with on/off, gain (slider and value), frequency, Q,
  // filter type and ear. These are the same bands as in Tabel.
  const peaceBox = h('div', { class: 'slider-eq', 'data-testid': 'peace-eq' });
  const PEACE_BW = { 10: 1, 15: 2 / 3, 31: 1 / 3 }; // octaves between the bands
  const peaceQ = (n) => Math.round((Math.sqrt(2 ** n) / (2 ** n - 1)) * 1000) / 1000;
  const makePeace = async (n) => {
    const count = eq().bands.length;
    if (count && !(await confirmDialog(`Erstat dine ${count} bånd med ${n} flade Peace-bånd (Q ${String(peaceQ(PEACE_BW[n])).replace('.', ',')})? Ctrl+Z fortryder.`, { ok: 'Erstat' }))) return;
    eq().bands = SLIDER_SETS[n].map((f) => ({ ...newBand(f, 'PK'), q: peaceQ(PEACE_BW[n]) }));
    selected = 0; changed(); renderBands();
  };
  const renderPeace = () => {
    peaceBox.replaceChildren(...eq().bands.map((b, i) => {
      const has = FILTER_TYPES[b.type].gain;
      const pick = () => { if (selected !== i) { selected = i; redraw(); peaceBox.querySelectorAll('.peace-col').forEach((c, k) => c.classList.toggle('sel', k === i)); } };
      const num = (key, min, max, step, disabled, testid) => {
        const inp = h('input', { type: 'number', min, max, step, value: b[key], disabled, class: 'col-num', 'data-testid': testid });
        inp.addEventListener('focus', pick);
        inp.addEventListener('change', () => { b[key] = clamp(Number(inp.value), min, max); changed(); renderBands(); });
        return inp;
      };
      const gainNum = num('gain', -24, 24, 0.1, !has, 'peace-gain-value');
      const range = h('input', { type: 'range', min: -15, max: 15, step: 0.1, value: has ? b.gain : 0, disabled: !has, 'aria-label': `${fmtHz(b.freq)} Hz`, 'data-testid': 'peace-gain' });
      range.addEventListener('pointerdown', pick);
      range.addEventListener('input', () => { b.gain = Number(range.value); gainNum.value = b.gain; changed(false); });
      range.addEventListener('change', () => { changed(true); renderBands(); });
      range.addEventListener('dblclick', () => { b.gain = 0; changed(); renderBands(); });
      const on = h('input', { type: 'checkbox', checked: b.enabled, title: 'Til/fra', onchange: () => { b.enabled = on.checked; changed(); renderBands(); } });
      const type = h('select', { class: 'col-sel', 'data-testid': 'peace-type', onchange: () => { b.type = type.value; changed(); renderBands(); } },
        Object.entries(FILTER_TYPES).map(([k, v]) => h('option', { value: k, selected: k === b.type }, v.label)));
      const ear = h('select', { class: 'col-sel', title: 'Hvilket øre båndet gælder for', onchange: () => { if (ear.value === 'all') delete b.channel; else b.channel = ear.value; changed(); renderBands(); } },
        Object.entries(EAR_LABEL).map(([k, v]) => h('option', { value: k, selected: (b.channel || 'all') === k }, v)));
      const slope = FILTER_TYPES[b.type].slope
        ? h('select', { class: 'col-sel', title: 'Hældning (dB pr. oktav)', onchange: (e) => { b.slope = Number(e.target.value); if (b.slope <= 12) delete b.slope; changed(); renderBands(); } },
          SLOPES.map((sl) => h('option', { value: sl, selected: (b.slope || 12) === sl }, `${sl} dB/okt`)))
        : null;
      return h('div', { class: `slider-col peace-col ${i === selected ? 'sel' : ''}`, onclick: pick },
        h('span', { class: 'col-head' }, h('span', { class: 'band-dot', style: { background: BAND_COLORS[i % BAND_COLORS.length] } }), String(i + 1), on),
        gainNum, range,
        h('label', { class: 'col-lbl' }, 'Hz'), num('freq', 20, 20000, 1, false, 'peace-freq'),
        h('label', { class: 'col-lbl' }, 'Q'), num('q', 0.1, 30, 0.01, b.slope > 12, 'peace-q'), slope,
        type, ear,
        h('button', { class: 'btn sm', title: 'Slet bånd', onclick: (e) => { e.stopPropagation(); eq().bands.splice(i, 1); selected = Math.max(0, Math.min(selected, eq().bands.length - 1)); changed(); renderBands(); } }, '✕'));
    }));
    if (!eq().bands.length) peaceBox.append(h('div', { class: 'hint' }, 'Ingen bånd endnu – lav 10, 15 eller 31 Peace-bånd ovenfor, eller tryk "+ Bånd".'));
    if (graphicActive(eq())) peaceBox.append(h('div', { class: 'hint peace-note' }, 'Der er også en grafisk kurve i dette preset (fx fra AutoEQ) – den lægges oven i båndene. Se "Grafisk kurve".'));
  };

  // Grafisk kurve: Equalizer APO's GraphicEQ – the curve goes exactly through the sliders (straight
  // lines between them on a log axis) and is added to the bands. An imported curve (e.g. 127 points
  // from AutoEQ) is shown on the sliders and turned into slider points when you move one.
  const sliderBox = h('div', { class: 'slider-eq', 'data-testid': 'slider-eq' });
  const sliderHint = h('div', { class: 'hint', 'data-testid': 'slider-hint' });
  const countSel = h('select', { 'data-testid': 'slider-count', onchange: () => { prefs.eqSliders = Number(countSel.value); ctx.savePrefs?.(); renderSliders(); } },
    [10, 15, 31].map((n) => h('option', { value: n }, `${n} bånd`)));
  const renderGraphic = () => {
    const set = SLIDER_SETS[prefs.eqSliders] || SLIDER_SETS[10];
    countSel.value = String(set.length);
    const pts = eq().graphic || [];
    const onSet = graphicOnSet(pts, set);
    sliderHint.textContent = pts.length && !onSet
      ? `Kurven har ${pts.length} punkter (fx fra AutoEQ eller Peace). Sliderne viser den på ${set.length} bånd – flytter du en, bliver kurven til ${set.length} slider-punkter.`
      : eq().bands.some((b) => b.enabled) ? 'Kurven lægges oven i de parametriske bånd. Grafen viser det hele.' : '';
    sliderBox.replaceChildren(...set.map((f, i) => {
      const cur = () => (eq().graphic || []);
      const write = (v, record) => {
        const g = graphicOnSet(cur(), set) ? cur().map((p) => [...p]) : resampleGraphic(cur(), set);
        g[i][1] = Math.round(clamp(v, -24, 24) * 10) / 10;
        eq().graphic = g;
        changed(record);
      };
      const val = h('input', { type: 'number', min: -24, max: 24, step: 0.1, value: Math.round(graphicGain(pts, f) * 10) / 10, class: 'col-num', 'data-testid': `slider-value-${i}` });
      const inp = h('input', { type: 'range', min: -15, max: 15, step: 0.5, value: graphicGain(pts, f), 'aria-label': `${fmtHz(f)} Hz`, 'data-testid': `slider-${i}` });
      inp.addEventListener('input', () => { val.value = inp.value; write(Number(inp.value), false); });
      inp.addEventListener('change', () => { write(Number(inp.value), true); renderSliders(); });
      inp.addEventListener('dblclick', () => { write(0, true); renderSliders(); });
      val.addEventListener('change', () => { write(Number(val.value), true); renderSliders(); });
      return h('div', { class: 'slider-col' }, val, inp, h('span', { class: 'slider-hz' }, fmtHz(f)));
    }));
  };

  const viewBtns = {};
  const view = () => (['bands', 'sliders', 'graphic'].includes(prefs.eqView) ? prefs.eqView : 'bands');
  renderSliders = () => { if (view() === 'sliders') renderPeace(); else if (view() === 'graphic') renderGraphic(); };
  const peaceTools = h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('label', {}, 'Lav Peace-bånd'),
    ...[10, 15, 31].map((n) => h('button', { class: 'btn sm', 'data-testid': `peace-make-${n}`, onclick: () => makePeace(n) }, `${n} bånd`)),
    h('span', { class: 'hint' }, 'Dobbeltklik på en slider = 0 dB'));
  const graphicTools = h('div', {},
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('label', {}, 'Antal'), countSel,
      h('button', { class: 'btn sm', 'data-testid': 'slider-reset', onclick: () => { delete eq().graphic; changed(); renderSliders(); } }, 'Nulstil kurven'),
      h('span', { class: 'hint' }, 'Dobbeltklik = 0 dB')),
    sliderHint);
  const sliderArea = h('div', { class: 'slider-area' }, preCol, peaceBox, sliderBox);
  const setView = (v) => {
    prefs.eqView = v; ctx.savePrefs?.();
    for (const [k, b] of Object.entries(viewBtns)) b.classList.toggle('on', k === v);
    bandsTable.style.display = v === 'bands' ? '' : 'none';
    sliderArea.style.display = v === 'bands' ? 'none' : '';
    peaceTools.style.display = v === 'sliders' ? '' : 'none';
    peaceBox.style.display = v === 'sliders' ? '' : 'none';
    graphicTools.style.display = v === 'graphic' ? '' : 'none';
    sliderBox.style.display = v === 'graphic' ? '' : 'none';
    syncPre();
    renderSliders();
  };
  viewBtns.bands = h('button', { class: 'btn sm', 'data-testid': 'eq-view-bands', onclick: () => setView('bands') }, 'Tabel');
  viewBtns.sliders = h('button', { class: 'btn sm', 'data-testid': 'eq-view-sliders', title: 'Hvert bånd som en slider med gain, frekvens, Q og filtertype – som i Peace', onclick: () => setView('sliders') }, 'Sliders (som Peace)');
  viewBtns.graphic = h('button', { class: 'btn sm', 'data-testid': 'eq-view-graphic', title: 'En præcis kurve gennem faste bånd (GraphicEQ) – fx fra AutoEQ', onclick: () => setView('graphic') }, 'Grafisk kurve');
  const bandsTable = h('table', { class: 'band-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Til'), h('th', {}, 'Type'), h('th', {}, 'Øre'), h('th', {}, 'Frekvens'), h('th', {}, 'Gain'), h('th', {}, 'Q'), h('th'))), bandsBody);

  const editorBody = h('div', {},
    h('div', { class: 'eq-wrap live', style: { marginTop: '12px' } }, specCanvas, canvas),
    spectrumRow,
    h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Træk punkter · scroll = Q · dobbeltklik = nyt bånd · Alt+træk = kun frekvens · Del = slet · B = bypass · Ctrl+Z/Y = fortryd/gentag'),
    chainLegend, earLegend,
    h('div', { class: 'row eq-view', style: { margin: '10px 0 4px' } }, viewBtns.bands, viewBtns.sliders, viewBtns.graphic),
    peaceTools, graphicTools, bandsTable, sliderArea);
  setView(view());

  // Blind test: X and Y are A and B in random order each round, the curve is hidden, and both
  // play at the same loudness. After 5 rounds: which one you chose.
  let blind = null;
  const blindBox = h('div', { class: 'blind-panel', 'data-testid': 'eq-blind', style: { display: 'none' } });
  const shuffle = () => (Math.random() < 0.5 ? { X: 'A', Y: 'B' } : { X: 'B', Y: 'A' });
  const startBlind = (prev) => {
    if (slotsEqual(state.slots.A, state.slots.B)) { toast('A og B er ens – lav først en forskel (fx et andet preset i B)'); return; }
    if (!state.slots.A.enabled || !state.slots.B.enabled) { toast('Slå EQ til i både A og B – ellers kan de ikke spille lige højt'); return; }
    blind = { round: 1, rounds: 5, map: shuffle(), picks: [], on: 'X', prevMatch: prev ? prev.prevMatch : state.abMatch, prevActive: prev ? prev.prevActive : state.active };
    state.abMatch = true;
    blindListen('X');
  };
  const blindListen = (side) => { blind.on = side; selectSlot(blind.map[side]); renderBlind(); };
  const blindPick = (side) => {
    blind.picks.push(blind.map[side]);
    if (blind.round >= blind.rounds) { blind.done = true; renderBlind(); return; }
    blind.round++;
    blind.map = shuffle();
    blindListen('X');
  };
  const endBlind = (use) => {
    if (!blind) return;
    state.abMatch = blind.prevMatch;
    const slot = use || blind.prevActive;
    blind = null;
    selectSlot(slot);
    renderBlind();
  };
  const renderBlind = () => {
    const on = !!blind;
    for (const el of [toolbar, abRow, editorBody, bar]) el.style.display = on ? 'none' : '';
    blindBox.style.display = on ? '' : 'none';
    if (!on) return;
    if (blind.done) {
      const v = blindVerdict(blind.picks);
      blindBox.replaceChildren(
        h('h3', {}, 'Blindtest – resultat'),
        h('div', { class: 'blind-result', 'data-testid': 'eq-blind-result' }, v.text),
        h('div', { class: 'row', style: { flexWrap: 'wrap' } },
          v.winner ? h('button', { class: 'btn sm primary', 'data-testid': 'eq-blind-use', onclick: () => endBlind(v.winner) }, `Brug ${v.winner}`) : null,
          h('button', { class: 'btn sm', onclick: () => { const prev = blind; blind = null; startBlind(prev); } }, 'Tag testen igen'),
          h('button', { class: 'btn sm', onclick: () => endBlind(null) }, 'Luk')));
      return;
    }
    const side = (k) => h('button', { class: blind.on === k ? 'on' : '', 'data-testid': `eq-blind-${k}`, onclick: () => blindListen(k) }, k);
    blindBox.replaceChildren(
      h('h3', {}, `Blindtest · runde ${blind.round} af ${blind.rounds}`),
      h('div', { class: 'hint' }, 'Lyt til X og Y – skift så tit du vil. De spiller lige højt, og kurven er skjult. Hvilken lyder bedst?'),
      h('div', { class: 'row', style: { flexWrap: 'wrap' } },
        h('div', { class: 'seg blind-seg' }, side('X'), side('Y')),
        h('button', { class: 'btn sm primary', 'data-testid': 'eq-blind-pick-X', onclick: () => blindPick('X') }, 'X er bedst'),
        h('button', { class: 'btn sm primary', 'data-testid': 'eq-blind-pick-Y', onclick: () => blindPick('Y') }, 'Y er bedst'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: () => endBlind(null) }, 'Afbryd')));
  };

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
    rebase(); changed(); renderBands();
    ctx.onStateChanged?.('eq-local');
  };
  const fileIn = h('input', { type: 'file', accept: '.txt,.cfg,.json,text/plain,application/json', style: { display: 'none' }, 'data-testid': 'preset-file' });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    if (!f) return;
    const text = await f.text();
    // A GoXLR Studio preset file (all presets) – added next to yours, nothing is overwritten.
    if (/^\s*\{/.test(text)) {
      try {
        const r = importPresets(state.presets, text);
        state.presets = r.presets;
        persist(); renderPresets(); ctx.onStateChanged?.('eq');
        toast(`Importeret ${r.added.length} preset${r.added.length === 1 ? '' : 's'}: ${r.added.join(', ')}`, 'info');
      } catch (e) { toast(String(e.message || e)); }
      fileIn.value = '';
      return;
    }
    const { eq: parsed, ignored } = parseApoConfigReport(text);
    if (!hasFilters(parsed)) { toast('Fandt ingen filtre i filen.'); warnIgnored(f.name, ignored); return; }
    warnIgnored(f.name, ignored);
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
      h('button', { class: 'btn sm', 'data-testid': 'preset-save-as', onclick: async () => {
        const n = await promptDialog('Navn på preset', state.presetName || '', { ok: 'Gem' });
        if (!n) return;
        state.presets[n] = structuredClone(eq()); state.presetName = n; persist(); apply(); renderChannels(); toast(`Gemt "${n}"`, 'info'); ctx.onStateChanged?.('eq');
      } }, 'Gem som…'),
      h('button', { class: 'btn sm', 'data-testid': 'preset-delete', onclick: async () => {
        const [k, ...r] = presetSel.value.split(':'); const n = r.join(':');
        if (k !== 'u' || !(await confirmDialog(`Slet "${n}"?`, { ok: 'Slet', danger: true }))) return;
        delete state.presets[n]; if (state.presetName === n) state.presetName = null; persist(); apply(); renderChannels(); ctx.onStateChanged?.('eq');
      } }, 'Slet')),
    h('div', { class: 'row wrap' },
      h('button', { class: 'btn sm', 'data-testid': 'preset-import-file', onclick: () => fileIn.click() }, 'Importér (APO, AutoEQ, presetfil)…'),
      h('button', { class: 'btn sm', onclick: async () => {
        const txt = await promptDialog('Indsæt Equalizer APO-konfiguration (Preamp/Filter-linjer):', '', { ok: 'Indsæt', input: { multiline: true, placeholder: 'Preamp: -6 dB\nFilter 1: ON PK Fc 100 Hz Gain 3 dB Q 1.41' } });
        if (!txt) return;
        const { eq: parsed, ignored } = parseApoConfigReport(txt);
        warnIgnored('Indsat tekst', ignored);
        if (!hasFilters(parsed)) { toast('Fandt ingen filtre.'); return; }
        loadEq(parsed, null);
      } }, 'Indsæt tekst'),
      h('button', { class: 'btn sm', 'data-testid': 'preset-export-all', title: 'Alle dine presets i én fil – til backup eller til en ven. Importeres med "Importér".', onclick: () => {
        if (!Object.keys(state.presets).length) { toast('Du har ingen egne presets endnu'); return; }
        const blob = new Blob([exportPresets(state.presets, ctx.updateState?.current || '')], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: 'GoXLR Studio EQ-presets.json' });
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, 'Eksportér alle presets'),
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
  const targetWarn = h('div', { class: 'target-warn', 'data-testid': 'eq-target-warning' });
  const soundBox = h('div', { class: 'sound-notes', 'data-testid': 'engine-sound-notes' });
  const renderSound = (notes = []) => soundBox.replaceChildren(...notes.map((l) => h('div', { class: l.startsWith('⚠') ? 'bad' : l.startsWith('✓') ? 'ok' : '' }, l)));
  const importApoBtn = h('button', { class: 'btn sm', onclick: async () => {
    try {
      const text = await apoReadConfig();
      const { eq: parsed, ignored } = parseApoConfigReport(text);
      warnIgnored('Peace/APO-opsætningen', ignored);
      if (!hasFilters(parsed)) { toast('Fandt ingen filtre i din Peace/APO-opsætning.'); return; }
      state.presets['Min Peace-opsætning'] = parsed;
      loadEq(parsed, 'Min Peace-opsætning');
      ctx.onStateChanged?.('eq');
      toast(`Importeret ${parsed.bands.length} filtre fra din Peace/APO-opsætning`, 'info');
    } catch (e) { toast(String(e)); }
  } }, 'Importér nuværende Peace-opsætning');
  const setTarget = (id, name) => {
    state.target = id || null; state.target_name = id ? name || null : null;
    // A choice made here is the user's own (fejl 2: older versions kept one silently).
    ctx.prefs.eqTargetConfirmed = true; ctx.savePrefs?.(); ctx.eqTargetNotice = false; ctx.renderBanners?.();
    persist(); apply(); renderTarget(); renderDevices();
  };
  const targetSel = h('select', { 'data-testid': 'eq-target', onchange: () => setTarget(targetSel.value, targetSel.selectedOptions[0]?.dataset.name) });
  let info = { kind: 'none', devices: [] };
  let renderChannels = () => {};
  // EQ pr. kanal: which outputs have their own channel EQ right now (for the badges and the warning).
  const channelOf = (id) => activeChannels(state, renderDevs, ctx.conn.mixer?.profile_name).find((c) => c.id.toLowerCase() === String(id).toLowerCase());
  let chosen = null;
  let lastTest = null; // { at, tests } from the last engine task
  storeGet('engine-test', null).then((t) => { lastTest = t; renderSound(t?.sound); if (info.devices.length) { renderDevices(); refreshText(); } }).catch(() => {});
  const testOf = (d) => lastTest?.tests?.find((t) => d.guid && t.guid.toLowerCase() === d.guid.toLowerCase());
  const isGoXLR = (n) => /goxlr|tc-helicon/i.test(n);
  const installedIds = () => info.devices.filter((d) => d.installed).map((d) => d.id);
  const selectionChanged = () => { const inst = new Set(installedIds()); return chosen.size !== inst.size || [...chosen].some((id) => !inst.has(id)); };
  const run = async (task, busy) => {
    engineActions.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    engineText.textContent = busy;
    const requested = task.devices ? [...task.devices] : null;
    try {
      const r = await engineTask(task);
      // The sound check is shown highlighted below the log (soundBox), not twice.
      engineLog.replaceChildren(...(r.log || []).filter((l) => !(r.sound || []).includes(l)).map((l) => h('div', { class: /^✓/.test(l) ? 'ok' : /^✗/.test(l) ? 'bad' : '' }, /^[✓✗–]/.test(l) ? '' : '• ', l)));
      if (!r.ok) throw new Error(r.error || 'Ukendt fejl');
      if (r.tests?.length || task.action === 'uninstall') {
        lastTest = { at: Date.now(), tests: r.tests || [], sound: r.sound || [] };
        storeSet('engine-test', lastTest).catch(() => {});
      }
      renderSound(r.sound);
      ctx.onApoChanged?.(task.action !== 'uninstall' && task.action !== 'restore-external');
      apply();
      const sum = engineTestSummary(r.tests, r.sound);
      toast(sum ? sum.text : r.reboot ? 'Færdig – genstart pc’en, så alle programmer bruger EQ’en' : 'Færdig', sum && !sum.ok ? undefined : 'info');
    } catch (e) { toast(String(e.message || e)); }
    // Mindre fejl 2: the ticks show what really has the engine afterwards, and outputs that were
    // ticked but did not get it are named.
    chosen = null;
    await refreshEngine();
    const now = new Set(installedIds());
    const dropped = (requested || []).filter((id) => !now.has(id)).map((id) => shortName(info.devices.find((d) => d.id === id)?.name || id));
    if (dropped.length) engineLog.append(h('div', { class: 'bad', 'data-testid': 'engine-dropped' }, `✗ ${dropped.join(', ')} fik ikke EQ-motoren – afkrydsningen viser nu, hvilke udgange der faktisk har den.`));
  };
  const needDevices = (fn) => () => (chosen.size ? fn() : toast('Markér mindst én udgang'));
  const replaceExternal = async () => {
    if (!(await confirmDialog('GoXLR Studio erstatter Equalizer APO med sin indbyggede EQ-motor:\n\n1. Dine Peace/APO-presets importeres og gemmes.\n2. Equalizer APO afinstalleres (Peace virker derefter ikke længere og kan fjernes).\n3. GoXLR Studios motor sættes på de markerede udgange.\n\nWindows beder om administrator-adgang én gang, og lyden afbrydes et øjeblik. Fortsæt?', { ok: 'Erstat' }))) return;
    try { const { names } = await importPeacePresets(ctx); if (names.length) toast(`Importeret ${names.length} Peace-presets`, 'info'); } catch { /* no presets */ }
    await run({ action: 'install', devices: [...chosen] }, 'Erstatter Equalizer APO med den indbyggede motor…');
  };
  const btn = (text, cls, fn, testid) => h('button', { class: `btn sm ${cls}`, onclick: fn, 'data-testid': testid || `engine-${text.toLowerCase().replace(/[^a-zæøå0-9]+/g, '-').replace(/^-|-$/g, '')}` }, text);
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
      // Fejl 1: installed, but Windows cannot create the engine (registration missing).
      if (info.registration && !info.registration.ok) list.push(btn('Reparér EQ-motoren', 'primary', () => run({ action: 'test' }, 'Reparerer og tester EQ-motoren – lyden afbrydes et øjeblik…'), 'engine-repair'));
      if (!info.uses_our_config) list.push(btn('Reparér', 'primary', needDevices(() => run({ action: 'install', devices: [...chosen] }, 'Reparerer EQ-motoren…'))));
      else if (selectionChanged()) list.push(btn('Gem udgange', 'primary', () => run({ action: 'set-devices', devices: [...chosen] }, 'Opdaterer udgange…')));
      // The test checks that Windows' audio engine really loads the engine on each output, and
      // finds the way of hooking in that works (Equalizer APO's Device Selector does the same).
      if (installedIds().length && !selectionChanged()) {
        list.push(btn('Test EQ-motoren', lastTest?.tests?.some((t) => !t.ok && !t.error) ? 'primary' : '', () => run({ action: 'test' }, 'Tester EQ-motoren på udgangene – lyden afbrydes et øjeblik…')));
        // Manual fallback (Equalizer APO's "troubleshooting options"): cycle through the three ways.
        list.push(btn('Prøv en anden måde', '', async () => {
          const cur = info.devices.find((d) => d.installed)?.mode || 'lfx-gfx';
          const next = ENGINE_MODES[(ENGINE_MODES.indexOf(cur) + 1) % ENGINE_MODES.length];
          if (!(await confirmDialog(`Sæt EQ-motoren på de markerede udgange på en anden måde (${ENGINE_MODE_LABEL[next]})?\n\nNormalt finder "Test EQ-motoren" selv den måde der virker. Lyden afbrydes et øjeblik.`, { ok: 'Skift måde' }))) return;
          run({ action: 'set-devices', devices: [...chosen], mode: next }, 'Skifter måde…');
        }));
      }
      list.push(btn('Gendan lyd', '', () => ctx.runAction('restore-sound', 'EQ-siden'), 'engine-restore-sound'));
      list.push(btn('Fjern EQ-motor', '', async () => { if (await confirmDialog('Fjern GoXLR Studios EQ-motor fra alle udgange?', { ok: 'Fjern', danger: true })) run({ action: 'uninstall' }, 'Fjerner EQ-motoren…'); }));
    }
    if (info.external_config) list.push(importApoBtn);
    engineActions.replaceChildren(...list);
  };
  const renderDevices = () => {
    devList.replaceChildren(...info.devices.map((d) => {
      const cb = h('input', { type: 'checkbox', checked: chosen.has(d.id), onchange: () => { if (cb.checked) chosen.add(d.id); else chosen.delete(d.id); renderActions(); } });
      const t = d.installed ? testOf(d) : null;
      const status = !d.installed ? null : t && !t.error ? (t.ok ? 'kører' : 'ikke indlæst') : 'aktiv';
      const chan = channelOf(d.id);
      const applies = chan || appliesTo(state, d.id);
      const badge = status && h('span', { class: `badge ${status === 'ikke indlæst' || !applies ? 'warn' : 'ok'}`, 'data-testid': 'engine-device-status' },
        chan ? `${status} · kanal-EQ: ${chan.name === FLAT ? 'ingen' : chan.name}` : `${status} · EQ ${applies ? 'gælder her' : 'gælder ikke her'}`);
      return h('label', { class: 'engine-dev', title: d.mode ? `${d.name} – ${ENGINE_MODE_LABEL[d.mode] || d.mode}` : d.name }, cb, h('span', {}, shortName(d.name)), badge);
    }));
    if (!info.devices.length) devList.append(h('div', { class: 'hint' }, 'Fandt ingen udgange.'));
  };
  const renderTarget = () => {
    const d = info.devices.find((x) => appliesTo(state, x.id) && state.target);
    targetHint.textContent = state.target && d && !d.installed ? 'EQ-motoren kører ikke på denne udgang endnu – markér den ovenfor.' : '';
    // Fejl 2: the engine sits on several outputs, but the EQ applies to one of them only.
    const others = info.devices.filter((x) => x.installed && !appliesTo(state, x.id) && !channelOf(x.id)).map((x) => shortName(x.name));
    targetWarn.replaceChildren(...(state.target && others.length ? [
      h('span', {}, `⚠ EQ’en gælder kun ${shortName(state.target_name || d?.name || 'én udgang')} – lyd på ${others.join(', ')} får ingen EQ.`),
      h('button', { class: 'btn sm primary', 'data-testid': 'eq-target-all', onclick: () => { targetSel.value = ''; setTarget(null); toast('EQ’en gælder nu alle markerede udgange', 'info'); } }, 'Gælder alle markerede udgange'),
    ] : []));
  };
  const refreshEngine = async () => {
    info = await engineInfo().catch((e) => ({ kind: 'none', bundled: false, devices: [], error: String(e) }));
    const inst = installedIds();
    // Default: the GoXLR outputs you listen to (Chat, Game, Music, System) – not Sample.
    if (!chosen) chosen = new Set(inst.length ? inst : info.devices.filter((d) => isGoXLR(d.name) && !/sample/i.test(d.name)).map((d) => d.id));
    const running = info.kind !== 'none' && info.uses_our_config && inst.length > 0;
    engineBadge.textContent = running ? 'Aktiv' : info.kind === 'none' ? 'Ikke installeret' : 'Ikke aktiv';
    engineBadge.className = `badge ${running ? 'ok' : 'warn'}`;
    refreshText();
    renderDevices(); renderActions(); renderTarget(); renderChannels();
  };
  function refreshText() {
    const running = info.kind !== 'none' && info.uses_our_config && installedIds().length > 0;
    const kind = {
      builtin: `GoXLR Studios indbyggede EQ-motor${info.version ? ` (Equalizer APO ${info.version})` : ''}.`,
      external: 'Equalizer APO er installeret som et separat program.',
      none: 'EQ-motoren er ikke installeret endnu.',
    }[info.kind] || '';
    const unregistered = info.kind === 'builtin' && info.registration && !info.registration.ok;
    const sum = running && info.kind === 'builtin' ? engineTestSummary(lastTest?.tests, lastTest?.sound) : null;
    const state = unregistered
      ? `Motoren er installeret, men ikke registreret korrekt i Windows, så EQ’en høres ikke: ${info.registration.problems.map((x) => x.text).join('; ')}. Tryk "Reparér EQ-motoren".`
      : !running ? '' : sum ? sum.text : 'Tryk "Test EQ-motoren" for at tjekke at den kører på udgangene.';
    engineText.textContent = `${kind} ${state}${info.error ? ` (${info.error})` : ''}`;
    if (unregistered) { engineBadge.textContent = 'Skal repareres'; engineBadge.className = 'badge warn'; }
    else if (sum && !sum.ok) { engineBadge.textContent = sum.kind === 'coverage' ? 'Rammer ikke lyden' : 'Ikke indlæst'; engineBadge.className = 'badge warn'; }
  }
  listAudioDevices().then((devs) => {
    targetSel.replaceChildren(h('option', { value: '' }, 'Alle markerede udgange'), ...devs.filter((d) => d.flow === 'render').map((d) => h('option', { value: d.id, 'data-name': d.name }, shortName(d.name))));
    targetSel.value = state.target || '';
  }).catch(() => {});
  refreshEngine();
  const engineCard = h('div', { class: 'card' }, h('h2', {}, 'EQ-motor', engineBadge),
    engineText,
    h('div', { class: 'hint', style: { margin: '10px 0 4px' } }, 'Udgange med EQ-motor:'), devList,
    engineActions, engineLog,
    soundBox,
    h('div', { class: 'row', style: { marginTop: '12px' } }, h('label', {}, 'EQ gælder for'), targetSel), targetWarn, targetHint);

  // ---- EQ pr. kanal: its own preset on Game, Music, Chat and System, optionally per GoXLR profile ----
  const chanRows = h('div', { class: 'list', 'data-testid': 'channel-eq-rows' });
  let chanProfile = ALL_PROFILES;
  const chanProfileSel = h('select', { 'data-testid': 'channel-eq-profile', onchange: () => { chanProfile = chanProfileSel.value; renderChannels(); } });
  const setChannel = (ch, value) => {
    state.channelEq ??= {};
    const set = (state.channelEq[chanProfile] ??= {});
    if (value) set[ch] = value; else delete set[ch];
    if (!Object.keys(set).length) delete state.channelEq[chanProfile];
    persist(); apply(); renderChannels(); renderDevices(); renderTarget();
  };
  renderChannels = () => {
    const profiles = ctx.conn.status?.files?.profiles || [];
    const current = ctx.conn.mixer?.profile_name;
    chanProfileSel.replaceChildren(h('option', { value: ALL_PROFILES }, 'Alle profiler'),
      ...profiles.map((p) => h('option', { value: p }, p === current ? `${p} (aktiv)` : p)));
    if (chanProfile !== ALL_PROFILES && !profiles.includes(chanProfile)) chanProfile = ALL_PROFILES;
    chanProfileSel.value = chanProfile;
    const mine = Object.keys(state.presets);
    const builtin = Object.keys(BUILTIN_PRESETS).filter((n) => !(n in state.presets));
    const installed = new Set(info.devices.filter((d) => d.installed).map((d) => d.id.toLowerCase()));
    chanRows.replaceChildren(...EQ_CHANNELS.map((ch) => {
      const own = state.channelEq?.[chanProfile]?.[ch] || '';
      const inherited = chanProfile === ALL_PROFILES ? null : channelPresetFor(state, ch, null);
      const fallback = chanProfile === ALL_PROFILES ? 'Hoved-EQ’en' : `Som "Alle profiler" (${inherited === FLAT ? 'ingen EQ' : inherited || 'hoved-EQ’en'})`;
      const known = !own || own === FLAT || presetEq(state, own);
      const sel = h('select', { 'data-testid': `channel-eq-${ch}`, onchange: () => setChannel(ch, sel.value) },
        h('option', { value: '' }, fallback),
        h('option', { value: FLAT }, 'Ingen EQ'),
        known ? null : h('option', { value: own }, `${own} (findes ikke – bruger hoved-EQ’en)`),
        mine.length ? h('optgroup', { label: 'Mine' }, mine.map((n) => h('option', { value: n }, n))) : null,
        h('optgroup', { label: 'Indbyggede' }, builtin.map((n) => h('option', { value: n }, n))));
      sel.value = own;
      // Does the EQ engine sit on this channel's Windows output?
      const id = channelEndpoint(ch, renderDevs);
      const effective = channelPresetFor(state, ch, chanProfile === ALL_PROFILES ? null : chanProfile);
      let note = null;
      if (!id) note = h('span', { class: 'badge', 'data-testid': 'channel-eq-state' }, 'ikke i Windows');
      else if (effective && info.kind !== 'none' && !installed.has(id.toLowerCase())) {
        note = h('span', { class: 'row', style: { gap: '6px' } },
          h('span', { class: 'badge warn', 'data-testid': 'channel-eq-state' }, 'EQ-motoren mangler her'),
          info.kind === 'builtin' && info.uses_our_config
            ? h('button', { class: 'btn sm primary', 'data-testid': `channel-eq-install-${ch}`, onclick: () => run({ action: 'set-devices', devices: [...new Set([...installedIds(), id])] }, `Sætter EQ-motoren på ${CHANNEL_LABEL[ch] || ch} – lyden afbrydes et øjeblik…`) }, 'Sæt motoren på')
            : null);
      }
      return h('div', { class: 'row' }, h('label', {}, CHANNEL_LABEL[ch] || ch), sel, note);
    }));
  };
  const channelCard = h('div', { class: 'card', 'data-testid': 'channel-eq' }, h('h2', {}, 'EQ pr. kanal'),
    h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'Giv hver GoXLR-kanal sit eget preset. Apps følger deres kanal (Lyd pr. app), så fx Spotify på Musik får musik-EQ og spillet på Spil får fodtrins-EQ. Kanaler uden valg får hoved-EQ’en ovenfor.'),
    h('div', { class: 'row' }, h('label', {}, 'Indstil for'), chanProfileSel),
    chanRows,
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Vælg en GoXLR-profil for at give den sit eget sæt, fx Headset og Speakers. Presets laver og retter du i editoren ovenfor (Gem som…). "EQ fra" slår også kanal-EQ’en fra. Kanalerne går også til stream-mixet, så seerne hører den samme EQ.'));
  renderChannels();

  // "Uden EQ" in the Lyttetest plays at the EQ's loudness when "Udlign lydstyrke" is on.
  const bypassGainDb = () => (state.abMatch !== false && eq().enabled ? Math.min(0, Math.round(chainLoudness(eq(), state.extras, offsetDb()) * 10) / 10) : 0);
  // "Det lyder forkert?": one click per problem, on top of the EQ you have (Ctrl+Z undoes it).
  const fixCard = h('div', { class: 'card' }, h('h2', {}, 'Lyder det forkert?'),
    h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'Vælg det, du hører. EQ’en justeres et lille skridt – tryk igen for mere, eller Ctrl+Z for at fortryde.'),
    h('div', { class: 'fix-grid', 'data-testid': 'sound-fixes' }, SOUND_FIXES.map((f) => h('button', { class: 'btn sm', title: f.why, 'data-testid': `fix-${f.id}`, onclick: () => {
      state.slots[state.active] = fixMove(eq(), f.move);
      if (!eq().enabled) eq().enabled = true;
      changed(); renderBands();
      toast(`${f.label}: ${f.why}`, 'info');
    } }, f.label))));

  const preview = makePreview(() => (ctx.playbackEq ? ctx.playbackEq() : eq()), bypassGainDb);
  const previewCard = h('div', { class: 'card' }, h('h2', {}, 'Lyttetest'),
    h('div', { class: 'hint' }, 'Afspil lyd gennem EQ’en her i appen og skift mellem med/uden for at høre forskellen.'),
    preview.controls);

  const onKey = (e) => {
    if (!document.body.contains(canvas)) { document.removeEventListener('keydown', onKey); return; }
    if (e.target.matches('input, select, textarea') || blind) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && eq().bands[selected]) { eq().bands.splice(selected, 1); selected = Math.max(0, selected - 1); changed(); renderBands(); }
    else if (e.key.toLowerCase() === 'b' && !e.ctrlKey && !e.altKey) { toggleEq(ctx); }
  };
  document.addEventListener('keydown', onKey);
  ctx.cleanup.push(() => { clearInterval(specTimer); endBlind(null); graph.destroy(); preview.stop(); document.removeEventListener('keydown', onKey); });

  renderBands();
  setTimeout(redraw);
  apply();

  return h('div', { class: 'grid' },
    bar,
    h('div', { class: 'card' }, h('h2', {}, 'Parametrisk EQ – afspilning'), toolbar, abRow, blindBox, editorBody),
    h('div', { class: 'grid cols-3' }, presetsCard, engineCard, h('div', { class: 'grid' }, fixCard, previewCard)),
    h('div', { class: 'grid cols-3' }, channelCard, profileLinksCard(ctx), extrasCard(ctx, () => { apply(); redraw(); })),
    h('div', { class: 'grid cols-3' }, autoEqCard(ctx)));
}

// The Lyttetest's GraphicEQ: an 8192-tap linear-phase FIR from the curve (Hann-windowed), cached.
let impulseCache = { key: '', buf: null };
function graphicImpulse(ac, points) {
  const key = `${ac.sampleRate}|${JSON.stringify(points)}`;
  if (impulseCache.key === key) return impulseCache.buf;
  const N = 8192, half = N / 2, fs = ac.sampleRate;
  const mag = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) mag[k] = Math.pow(10, graphicGain(points, Math.max(k * fs / N, 1)) / 20);
  const cos = new Float64Array(N);
  for (let m = 0; m < N; m++) cos[m] = Math.cos((2 * Math.PI * m) / N);
  const buf = ac.createBuffer(1, N, fs);
  const h = buf.getChannelData(0);
  for (let n = 0; n < N; n++) {
    const t = n - half;
    let sum = mag[0] + mag[half] * (t % 2 ? -1 : 1);
    for (let k = 1; k < half; k++) sum += 2 * mag[k] * cos[(((k * t) % N) + N) % N];
    h[n] = (sum / N) * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1)));
  }
  impulseCache = { key, buf };
  return buf;
}

function makePreview(getEq, bypassGainDb = () => 0) {
  let ac = null, src = null, chainIn = null, out = null, bypassed = false, kind = null, buffer = null, analyser = null;
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
    if (!ac) {
      ac = new AudioContext(); out = ac.createGain(); out.gain.value = 0.5; out.connect(ac.destination);
      // For the live spectrum on the graph while the Lyttetest plays (after the EQ, before the volume).
      analyser = ac.createAnalyser(); analyser.fftSize = 8192; analyser.smoothingTimeConstant = 0;
    }
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
    const label = (g) => (bypassed ? (g ? `Uden EQ (udlignet −${String(Math.abs(g)).replace('.', ',')} dB)` : 'Uden EQ') : 'Med EQ');
    if (!src) { ab.textContent = label(0); return; }
    src.disconnect();
    chainIn?.forEach((n) => n.disconnect());
    chainIn = [];
    const eq = getEq();
    let node = src;
    if (!bypassed && eq.enabled) {
      const pre = ac.createGain();
      pre.gain.value = Math.pow(10, eq.preamp / 20);
      node.connect(pre); node = pre; chainIn.push(pre);
      const chain = (from, bands) => {
        let n = from;
        for (const b of expandBands(bands)) {
          if (!b.enabled) continue;
          const c = coefficients(b, ac.sampleRate);
          const f = ac.createIIRFilter([c.b0, c.b1, c.b2], [1, c.a1, c.a2]);
          n.connect(f); n = f; chainIn.push(f);
        }
        return n;
      };
      // GraphicEQ (sliders): a linear-phase FIR that follows the curve, like the engine's filter.
      if (graphicActive(eq)) {
        const conv = ac.createConvolver();
        conv.normalize = false;
        conv.buffer = graphicImpulse(ac, eq.graphic);
        node.connect(conv); node = conv; chainIn.push(conv);
      }
      node = chain(node, eq.bands.filter((b) => onEar(b, 'all') && b.channel !== 'L' && b.channel !== 'R'));
      // Venstre/højre øre: split, filter each side, merge.
      if (usesEars(eq)) {
        const split = ac.createChannelSplitter(2), merge = ac.createChannelMerger(2);
        node.connect(split); chainIn.push(split, merge);
        ['L', 'R'].forEach((ear, i) => {
          const g = ac.createGain(); split.connect(g, i); chainIn.push(g);
          chain(g, eq.bands.filter((b) => b.channel === ear)).connect(merge, 0, i);
        });
        node = merge;
      }
    }
    // Without EQ at the EQ's loudness, so the louder one doesn't win by being louder.
    const g = bypassed ? bypassGainDb() : 0;
    if (g < 0) {
      const match = ac.createGain();
      match.gain.value = Math.pow(10, g / 20);
      node.connect(match); node = match; chainIn.push(match);
    }
    node.connect(out);
    node.connect(analyser);
    ab.textContent = label(g);
    ab.classList.toggle('on', !bypassed);
  }
  function stopSource() { try { src?.stop(); } catch { /* already stopped */ } src?.disconnect(); src = null; }
  function stop() { stopSource(); status.textContent = ''; kind = null; }
  return {
    controls: h('div', {}, h('div', { class: 'row', style: { flexWrap: 'wrap' } }, playNoise, playFile, ab, stopBtn, fileIn), h('div', { class: 'row' }, status)),
    update: () => { if (src) rebuild(); },
    stop: () => { stop(); ac?.close(); ac = null; analyser = null; },
    get playing() { return !!kind; },
    spectrum: () => {
      if (!analyser) return null;
      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      return bandsFromBins(bins, ac.sampleRate, analyser.fftSize);
    },
  };
}

export { formatFreq };
