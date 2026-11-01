import { h, toggle, toast, debounce } from './ui.js';
import { EqGraph, BAND_COLORS } from './eqgraph.js';
import { BUILTIN_PRESETS, FILTER_TYPES, newBand, defaultOutputEq, totalResponse, bandResponse, suggestedPreamp, parseApoConfig, toApoConfig, coefficients, formatFreq } from './eq.js';
import { storeGet, storeSet, setOutputEqEngine, engineStatus, listAudioDevices, apoTakeover, apoReadConfig, apoListConfigs, apoOpenConfigurator, isNative } from './native.js';
import { shortName } from './views-mixer.js';
import { applyEqPreset, toggleEq } from './actions.js';

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

function presetBar(ctx) {
  const state = ctx.outputEq;
  const eq = state.slots[state.active];
  const mine = Object.keys(state.presets);
  const key = (n) => ctx.hotkeyFor?.(`eq-preset:${n}`);
  const chip = (n, builtin) => h('button', {
    class: `chip ${state.presetName === n ? 'on' : ''} ${builtin ? 'ghost' : ''}`,
    title: key(n) ? `Genvej: ${key(n)}` : (builtin ? 'Indbygget preset' : 'Klik for at bruge'),
    onclick: () => applyEqPreset(ctx, n),
  }, n);
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
    setOutputEqEngine({ ...eq(), target: state.target }).then(() => refreshEngine()).catch((e) => toast(`Lydmotor: ${e}`));
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
    h('div', { class: 'row' }, presetSel,
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

  const engineBadge = h('span', { class: 'badge' });
  const engineText = h('div', { class: 'hint' });
  const apoLine = h('div', { class: 'apo-devices' });
  const configBtn = h('button', { class: 'btn sm', onclick: () => apoOpenConfigurator().then(() => toast('Configurator åbnes – vælg enheder og genstart bagefter', 'info')).catch((e) => toast(String(e))) }, 'Åbn APO Configurator');
  const takeoverBtn = h('button', { class: 'btn sm primary' });
  const importApoBtn = h('button', { class: 'btn sm', onclick: async () => {
    try {
      const text = await apoReadConfig();
      const parsed = parseApoConfig(text);
      if (!parsed.bands.length) { toast('Fandt ingen filtre i din APO-opsætning.'); return; }
      state.presets['Min APO-opsætning'] = parsed;
      loadEq(parsed, 'Min APO-opsætning');
      ctx.onStateChanged?.('eq');
      toast(`Importeret ${parsed.bands.length} filtre fra Equalizer APO`, 'info');
    } catch (e) { toast(String(e)); }
  } }, 'Importér min nuværende APO');
  let engine = null;
  takeoverBtn.addEventListener('click', async () => {
    const enable = !engine?.taken_over;
    if (enable && !confirm('GoXLR Studio overtager Equalizer APO. Din nuværende config.txt gemmes som backup og kan gendannes her. Windows beder om administrator-tilladelse én gang. Fortsæt?')) return;
    try { await apoTakeover(enable); apply(); toast(enable ? 'GoXLR Studio styrer nu EQ’en' : 'Din gamle APO-opsætning er gendannet', 'info'); } catch (e) { toast(String(e)); }
    refreshEngine();
  });
  const targetSel = h('select', { onchange: () => { state.target = targetSel.value || null; persist(); apply(); } });
  const refreshEngine = async () => {
    engine = await engineStatus().catch((e) => ({ available: false, reason: String(e) }));
    engineBadge.textContent = engine.running ? 'Aktiv' : engine.available ? 'Klar' : 'Ikke aktiv';
    engineBadge.className = `badge ${engine.running ? 'ok' : engine.available ? '' : 'warn'}`;
    engineText.textContent = engine.reason || (engine.running ? 'EQ’en kører i Windows’ lydmotor – ændringer høres med det samme.' : '');
    takeoverBtn.textContent = engine.taken_over ? 'Gendan gammel APO-opsætning' : 'Overtag APO';
    takeoverBtn.className = `btn sm ${engine.taken_over ? '' : 'primary'}`;
    takeoverBtn.style.display = engine.apo_installed ? '' : 'none';
    importApoBtn.style.display = engine.apo_installed ? '' : 'none';
    configBtn.style.display = isNative() && engine.apo_installed ? '' : 'none';
    renderApo();
  };
  // Equalizer APO only processes devices it was installed on (chosen in its Configurator).
  const renderApo = () => {
    const devices = engine?.devices || [];
    if (!devices.length) { apoLine.replaceChildren(); return; }
    const pill = (d) => h('span', { class: `badge ${d.apo ? 'ok' : 'warn'}`, title: d.name }, `${d.apo ? '✓' : '✕'} ${shortName(d.name)}`);
    if (state.target) {
      const d = devices.find((x) => x.id === state.target);
      apoLine.replaceChildren(
        d ? pill(d) : h('span', { class: 'badge warn' }, 'Udgangen findes ikke'),
        h('span', { class: 'hint' }, d?.apo ? ' APO er installeret på denne udgang.' : ' APO er ikke installeret på denne udgang – EQ’en høres ikke. Tilføj den i Configurator.'));
    } else {
      apoLine.replaceChildren(h('div', { class: 'hint' }, 'APO på udgange:'), h('div', { class: 'fx-toggle' }, devices.map(pill)));
    }
  };
  listAudioDevices().then((devs) => {
    targetSel.replaceChildren(h('option', { value: '' }, 'Alle udgange'), ...devs.filter((d) => d.flow === 'render').map((d) => h('option', { value: d.id }, shortName(d.name))));
    targetSel.value = state.target || '';
  }).catch(() => {});
  refreshEngine();
  const engineCard = h('div', { class: 'card' }, h('h2', {}, 'Lydmotor', engineBadge),
    h('div', { class: 'row' }, h('label', {}, 'EQ på udgang'), targetSel),
    apoLine,
    isNative() ? h('div', { class: 'row', style: { flexWrap: 'wrap' } }, takeoverBtn, importApoBtn, configBtn) : null,
    engineText);

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
    presetBar(ctx),
    h('div', { class: 'card' }, h('h2', {}, 'Parametrisk EQ – afspilning'), toolbar,
      h('div', { class: 'eq-wrap', style: { marginTop: '12px' } }, canvas),
      h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Træk punkter · scroll = Q · dobbeltklik = nyt bånd · Alt+træk = kun frekvens · Del = slet · B = bypass · Ctrl+Z/Y = fortryd/gentag'),
      h('table', { class: 'band-table' }, h('thead', {}, h('tr', {}, h('th'), h('th', {}, 'Til'), h('th', {}, 'Type'), h('th', {}, 'Frekvens'), h('th', {}, 'Gain'), h('th', {}, 'Q'), h('th'))), bandsBody)),
    h('div', { class: 'grid cols-3' }, presetsCard, engineCard, previewCard));
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
