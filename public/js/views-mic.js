import { h, slider, segmented, selectBox, toggle, throttle } from './ui.js';
import { EQ_BANDS, MINI_EQ_BANDS } from './demo.js';
import { EqGraph, BAND_COLORS } from './eqgraph.js';
import { coefficients, magnitudeDb, formatFreq } from './eq.js';

const FULL_RANGES = [[30, 300], [30, 300], [30, 300], [30, 300], [300, 2000], [300, 2000], [300, 2000], [2000, 18000], [2000, 18000], [2000, 18000]];
const MINI_RANGES = [[30, 90], [100, 300], [310, 800], [800, 2500], [2600, 5000], [5100, 18000]];
// The hardware doesn't expose Q; this approximates the GoXLR's fixed band width for the drawing.
const HW_Q = 1.3;

const GATE_TIMES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 850, 900, 950, 1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 1900, 2000].map((t) => `Gate${t}ms`);
const RATIOS = ['Ratio1_0', 'Ratio1_1', 'Ratio1_2', 'Ratio1_4', 'Ratio1_6', 'Ratio1_8', 'Ratio2_0', 'Ratio2_5', 'Ratio3_2', 'Ratio4_0', 'Ratio5_6', 'Ratio8_0', 'Ratio16_0', 'Ratio32_0', 'Ratio64_0'];
const ATTACKS = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 23, 26, 30, 35, 40].map((t) => `Comp${t}ms`);
const RELEASES = [0, 15, 25, 35, 45, 55, 65, 75, 85, 100, 115, 140, 170, 230, 340, 680, 1000, 1500, 2000, 3000].map((t) => `Comp${t}ms`);
const ms = (s) => s.replace(/^(Gate|Comp)/, '').replace('ms', ' ms');
const ratio = (s) => s.replace('Ratio', '').replace('_', '.') + ' : 1';

function enumSlider(binder, { label, list, get, set, fmt }) {
  return slider(binder, {
    label, min: 0, max: list.length - 1,
    get: () => Math.max(0, list.indexOf(get())),
    set: (i) => set(list[i]),
    fmt: (i) => fmt(list[i]),
  });
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
    h('button', { class: 'btn sm', onclick: () => { const n = prompt('Navn på ny mikrofonprofil'); if (n) conn.command('SaveMicProfileAs', n); } }, 'Gem som…')));

  return h('div', { class: 'grid' }, eqCard, h('div', { class: 'grid cols-2' }, setup, profiles, gate, comp));
}
