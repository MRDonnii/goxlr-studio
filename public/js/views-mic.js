import { h, slider, segmented, selectBox, toggle, throttle, promptDialog, confirmDialog, toast, logActivity } from './ui.js';
import { MIC_MODELS, USB_ONLY, micSettings, micPresetCommands, describeMic } from './micpresets.js';
import { GATE_TIMES, RATIOS, ATTACKS, RELEASES, enumIndex } from './micenums.js';
import { EQ_BANDS, MINI_EQ_BANDS } from './demo.js';
import { EqGraph, BAND_COLORS } from './eqgraph.js';
import { coefficients, magnitudeDb, formatFreq } from './eq.js';

const FULL_RANGES = [[30, 300], [30, 300], [30, 300], [30, 300], [300, 2000], [300, 2000], [300, 2000], [2000, 18000], [2000, 18000], [2000, 18000]];
const MINI_RANGES = [[30, 90], [100, 300], [310, 800], [800, 2500], [2600, 5000], [5100, 18000]];
// The hardware doesn't expose Q; this approximates the GoXLR's fixed band width for the drawing.
const HW_Q = 1.3;

const ms = (s) => s.replace(/^(Gate|Comp)/, '').replace('ms', ' ms');
const ratio = (s) => s.replace('Ratio', '').replace('_', ',') + ' : 1';

// The engine reports and expects these as positions in the list (see micenums.js).
function enumSlider(binder, { label, list, get, set, fmt }) {
  return slider(binder, {
    label, min: 0, max: list.length - 1,
    get: () => enumIndex(list, get()),
    set: (i) => set(i),
    fmt: (i) => fmt(list[i]),
  });
}

const fmtHz = (f) => (f >= 1000 ? `${f / 1000}k` : `${f}`).replace('.', ',');

// "Din mikrofon": EQ, type, gate, compressor and de-esser from the mic's frequency response.
function micPresetCard(ctx) {
  const { conn } = ctx;
  const p = ctx.prefs;
  const isMini = () => conn.mixer?.hardware?.device_type === 'Mini';
  const parts = { eq: true, type: true, gate: true, comp: true, deess: true, gain: false };
  const byName = (a, b) => a.name.localeCompare(b.name, 'da');
  const sel = h('select', { 'data-testid': 'mic-model', onchange: () => render() },
    h('option', { value: '' }, 'Vælg din mikrofon …'),
    h('optgroup', { label: 'Dynamiske' }, MIC_MODELS.filter((m) => m.type === 'dynamic' && m.brand).sort(byName).map((m) => h('option', { value: m.id }, m.name))),
    h('optgroup', { label: 'Kondensator (+48V)' }, MIC_MODELS.filter((m) => m.type === 'condenser' && m.brand).sort(byName).map((m) => h('option', { value: m.id }, m.name))),
    h('optgroup', { label: 'Andre' }, MIC_MODELS.filter((m) => !m.brand).map((m) => h('option', { value: m.id }, m.name))));
  sel.value = MIC_MODELS.some((m) => m.id === p.micModel) ? p.micModel : '';
  const body = h('div', { class: 'mic-preset' });
  const model = () => MIC_MODELS.find((m) => m.id === sel.value);
  const check = (key, text) => {
    const cb = h('input', { type: 'checkbox', checked: parts[key], onchange: () => { parts[key] = cb.checked; } });
    return h('label', { class: 'engine-dev', 'data-testid': `mic-part-${key}` }, cb, h('span', {}, text));
  };
  const apply = async () => {
    const m = model();
    if (!m || !conn.mixer) return;
    const cmds = micPresetCommands(m, isMini(), parts);
    const what = [parts.eq && 'EQ', parts.type && 'mikrofontype', parts.gain && 'gain', parts.gate && 'noise gate', parts.comp && 'kompressor', parts.deess && 'de-esser'].filter(Boolean);
    if (!what.length) { toast('Vælg mindst én ting, der skal indstilles'); return; }
    if (!(await confirmDialog(`Indstil ${what.join(', ')} til ${m.name}?\n\nDet overskriver de nuværende indstillinger i mikrofonprofilen "${conn.mixer.mic_profile_name}". Gem den bagefter (eller som en ny profil), så det huskes.`, { ok: 'Indstil' }))) return;
    for (const c of cmds) await conn.command(...c);
    p.micModel = m.id; ctx.savePrefs();
    logActivity(`Mikrofon indstillet til ${m.name} (${what.join(', ')})`);
    toast(`Indstillet til ${m.name}. Lyt efter, og justér – gem så mikrofonprofilen.`, 'info');
  };
  const saveAs = async () => {
    const m = model();
    const n = await promptDialog('Navn på ny mikrofonprofil', m ? m.name.replace(/[^\p{L}\p{N} ._-]/gu, '') : '');
    if (n) conn.command('SaveMicProfileAs', n);
  };
  const render = () => {
    const m = model();
    if (!m) {
      body.replaceChildren(h('div', { class: 'hint' }, `Vælg din mikrofon blandt ${MIC_MODELS.length - 2} modeller. GoXLR Studio foreslår så EQ, noise gate, kompressor og de-esser ud fra mikrofonens frekvenskurve. Står din ikke på listen, så vælg "Anden dynamisk" eller "Anden kondensator" nederst. ${USB_ONLY.length > 1 ? `${USB_ONLY.slice(0, -1).join(', ')} og ${USB_ONLY.at(-1)}` : USB_ONLY[0] || ''} er kun USB og kan ikke sluttes til GoXLR’en.`));
      return;
    }
    const s = micSettings(m, isMini());
    body.replaceChildren(
      h('div', {}, describeMic(m)),
      h('div', { class: 'hint', 'data-testid': 'mic-preset-eq' }, `EQ (${isMini() ? 'GoXLR Mini' : 'GoXLR'}): ${s.eq.map((b) => `${fmtHz(b.freq)} ${b.gain > 0 ? '+' : ''}${b.gain}`).join(' · ')} dB`),
      h('div', { class: 'mic-preset-parts' },
        check('eq', 'EQ'),
        check('type', s.type === 'Condenser' ? (m.type === 'dynamic' ? 'Type: kondensator (+48V til forforstærkeren)' : 'Type: kondensator (tænder +48V)') : 'Type: dynamisk (+48V fra)'),
        check('gate', `Noise gate (${s.gate.threshold} dB)`),
        check('comp', `Kompressor (${s.comp.threshold} dB, 3,2:1)`),
        check('deess', `De-esser ${s.deess} %`),
        check('gain', `Gain ${s.gain} dB (kun et forslag)`)),
      h('div', { class: 'row', style: { flexWrap: 'wrap' } },
        h('button', { class: 'btn sm primary', 'data-testid': 'mic-preset-apply', disabled: !conn.mixer, onclick: apply }, 'Indstil til min mikrofon'),
        h('button', { class: 'btn sm', onclick: saveAs }, 'Gem som mikrofonprofil …'),
        m.source ? h('a', { href: m.source, target: '_blank', rel: 'noopener' }, 'Frekvenskurve') : null),
      h('div', { class: 'hint' }, 'Et udgangspunkt ud fra producentens frekvenskurve: EQ = en klar talestemme minus mikrofonens egen klang. Rum, stemme og afstand er forskellige, så lyt og finjustér. Gain står fra, fordi den afhænger af, hvor tæt og hvor højt du taler.'));
  };
  render();
  return h('div', { class: 'card' }, h('h2', {}, 'Din mikrofon'), h('div', { class: 'row', style: { flexWrap: 'wrap' } }, sel), body);
}

export function micView(ctx) {
  const { conn, binder } = ctx;
  const m = () => conn.mixer;
  const mic = () => m().mic_status;
  const isMini = () => m().hardware.device_type === 'Mini';

  const eqCard = h('div', { class: 'card' });
  const canvas = h('canvas', { class: 'eq-canvas' });
  const table = h('table', { class: 'band-table' });
  let graph = null;
  let bandsKey = '';
  let overlay = null;

  const bands = () => (isMini() ? MINI_EQ_BANDS : EQ_BANDS);
  const ranges = () => (isMini() ? MINI_RANGES : FULL_RANGES);
  const eqData = () => (isMini() ? mic().equaliser_mini : mic().equaliser);
  const setGain = (b, v) => conn.command(isMini() ? 'SetEqMiniGain' : 'SetEqGain', b, v);
  const setFreq = (b, v) => conn.command(isMini() ? 'SetEqMiniFreq' : 'SetEqFreq', b, v);

  const points = () => {
    const d = overlay || eqData();
    return bands().map((b, i) => ({ freq: d.frequency[b], gain: d.gain[b], q: HW_Q, color: BAND_COLORS[i % BAND_COLORS.length], label: String(i + 1) }));
  };
  const bandC = (pt) => coefficients({ type: 'PK', freq: pt.freq, gain: pt.gain, q: HW_Q });

  const sendGain = throttle((b, v) => setGain(b, v), 60);
  const sendFreq = throttle((b, v) => setFreq(b, v), 60);

  const build = () => {
    graph?.destroy();
    graph = new EqGraph(canvas, {
      minDb: -12, maxDb: 12,
      getPoints: points,
      curve: (freqs) => {
        const cs = points().map(bandC);
        return freqs.map((f) => cs.reduce((s, c) => s + magnitudeDb(c, f), 0));
      },
      bandCurve: (i, freqs) => { const c = bandC(points()[i]); return freqs.map((f) => magnitudeDb(c, f)); },
      onDrag: (i, { freq, gain }) => {
        const b = bands()[i];
        const [lo, hi] = ranges()[i];
        if (!overlay) overlay = structuredClone(eqData());
        const f = Math.round(Math.min(Math.max(freq, lo), hi) * 10) / 10;
        const g = Math.round(Math.min(Math.max(gain, -9), 9));
        if (overlay.frequency[b] !== f) { overlay.frequency[b] = f; sendFreq(b, f); }
        if (overlay.gain[b] !== g) { overlay.gain[b] = g; sendGain(b, g); }
        renderTable();
      },
      onDragEnd: () => { sendFreq.flush(); sendGain.flush(); setTimeout(() => { overlay = null; graph.draw(); }, 400); },
      onSelect: () => renderTable(),
    });
    renderTable();
  };

  const renderTable = () => {
    const d = overlay || eqData();
    table.replaceChildren(h('tr', {}, h('th', {}, ''), h('th', {}, 'Frekvens'), h('th', {}, 'Gain'), h('th', {}, 'Område')));
    bands().forEach((b, i) => {
      const [lo, hi] = ranges()[i];
      const fIn = h('input', { type: 'number', min: lo, max: hi, step: 1, value: Math.round(d.frequency[b]) });
      fIn.addEventListener('change', () => setFreq(b, Math.min(Math.max(Number(fIn.value), lo), hi)));
      const gIn = h('input', { type: 'number', min: -9, max: 9, step: 1, value: d.gain[b] });
      gIn.addEventListener('change', () => setGain(b, Math.min(Math.max(Math.round(Number(gIn.value)), -9), 9)));
      table.append(h('tr', { class: graph?.selected === i ? 'sel' : '' },
        h('td', {}, h('span', { class: 'band-dot', style: { background: BAND_COLORS[i % BAND_COLORS.length] } })),
        h('td', {}, fIn, ' Hz'), h('td', {}, gIn, ' dB'), h('td', { class: 'hint' }, `${formatFreq(lo)} – ${formatFreq(hi)}`)));
    });
  };

  const fineToggle = h('button', { class: 'btn sm', onclick: () => table.classList.toggle('hidden') }, 'Tal');
  const reset = h('button', { class: 'btn sm', onclick: () => bands().forEach((b) => setGain(b, 0)) }, 'Nulstil gain');
  eqCard.append(h('h2', {}, 'Mikrofon-EQ (i GoXLR’en)', h('span', { class: 'row' }, reset, fineToggle)),
    h('div', { class: 'eq-wrap' }, canvas), table,
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Træk punkterne for at ændre frekvens og gain. EQ’en kører i GoXLR’ens egen DSP – nul CPU og ingen forsinkelse.'));

  binder.add(() => {
    const key = bands().join();
    if (key !== bandsKey) { bandsKey = key; queueMicrotask(build); return; }
    if (!overlay && graph && !graph.drag) { graph.draw(); if (!eqCard.contains(document.activeElement)) renderTable(); }
  });

  const micType = segmented(binder, {
    options: [['Dynamic', 'Dynamisk'], ['Condenser', 'Kondensator (+48V)'], ['Jack', '3,5 mm jack']],
    get: () => mic().mic_type, set: (v) => conn.command('SetMicrophoneType', v),
  });

  const setup = h('div', { class: 'card' }, h('h2', {}, 'Mikrofon'),
    h('div', { class: 'row' }, h('label', {}, 'Type'), micType),
    slider(binder, { label: 'Gain', min: 0, max: 72, get: () => mic().mic_gains[mic().mic_type], set: (v) => conn.command('SetMicrophoneGain', mic().mic_type, v), fmt: (v) => `${v} dB` }),
    slider(binder, { label: 'De-esser', min: 0, max: 100, get: () => m().levels.deess, set: (v) => conn.command('SetDeeser', v), fmt: (v) => `${v} %` }),
  );

  const gate = h('div', { class: 'card' }, h('h2', {}, 'Noise gate', toggle(binder, { get: () => mic().noise_gate.enabled, set: (v) => conn.command('SetGateActive', v) })),
    slider(binder, { label: 'Tærskel', min: -59, max: 0, get: () => mic().noise_gate.threshold, set: (v) => conn.command('SetGateThreshold', v), fmt: (v) => `${v} dB` }),
    slider(binder, { label: 'Dæmpning', min: 0, max: 100, get: () => mic().noise_gate.attenuation, set: (v) => conn.command('SetGateAttenuation', v), fmt: (v) => `${v} %` }),
    enumSlider(binder, { label: 'Attack', list: GATE_TIMES, get: () => mic().noise_gate.attack, set: (v) => conn.command('SetGateAttack', v), fmt: ms }),
    enumSlider(binder, { label: 'Release', list: GATE_TIMES, get: () => mic().noise_gate.release, set: (v) => conn.command('SetGateRelease', v), fmt: ms }),
  );

  const comp = h('div', { class: 'card' }, h('h2', {}, 'Kompressor'),
    slider(binder, { label: 'Tærskel', min: -40, max: 0, get: () => mic().compressor.threshold, set: (v) => conn.command('SetCompressorThreshold', v), fmt: (v) => `${v} dB` }),
    enumSlider(binder, { label: 'Ratio', list: RATIOS, get: () => mic().compressor.ratio, set: (v) => conn.command('SetCompressorRatio', v), fmt: ratio }),
    enumSlider(binder, { label: 'Attack', list: ATTACKS, get: () => mic().compressor.attack, set: (v) => conn.command('SetCompressorAttack', v), fmt: ms }),
    enumSlider(binder, { label: 'Release', list: RELEASES, get: () => mic().compressor.release, set: (v) => conn.command('SetCompressorReleaseTime', v), fmt: ms }),
    slider(binder, { label: 'Make-up gain', min: -6, max: 24, get: () => mic().compressor.makeup_gain, set: (v) => conn.command('SetCompressorMakeupGain', v), fmt: (v) => `${v} dB` }),
  );

  const profiles = h('div', { class: 'card' }, h('h2', {}, 'Mikrofonprofil'));
  const profSel = selectBox(binder, { options: [], get: () => m().mic_profile_name, set: (v) => conn.command('LoadMicProfile', v, true) });
  binder.add(() => {
    const names = conn.status.files?.mic_profiles || [];
    if (profSel.options.length !== names.length) profSel.replaceChildren(...names.map((n) => h('option', { value: n }, n)));
    profSel.value = m().mic_profile_name;
  });
  profiles.append(h('div', { class: 'row' }, h('label', {}, 'Aktiv'), profSel,
    h('button', { class: 'btn sm', onclick: () => conn.command('SaveMicProfile') }, 'Gem'),
    h('button', { class: 'btn sm', 'data-testid': 'mic-profile-save-as', onclick: async () => { const n = await promptDialog('Navn på ny mikrofonprofil'); if (n) conn.command('SaveMicProfileAs', n); } }, 'Gem som…')));

  return h('div', { class: 'grid' }, micPresetCard(ctx), eqCard, h('div', { class: 'grid cols-2' }, setup, profiles, gate, comp));
}
