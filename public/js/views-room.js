// EQ-siden: Rumkorrektion (REW-målinger → et preset) and Højttalere (afstand → forsinkelse,
// polaritet, eget FIR-filter). The maths is in roomcorrect.js / rew.js / extras.js.
import { h, toast, promptDialog, confirmDialog } from './ui.js';
import { storeGet, storeSet, firSave } from './native.js';
import { readMeasurementFile, readCalFile } from './rew.js';
import { GRID, toGrid, powerAverage, smooth, designCorrection, correctionNotes, applyCalibration, TARGETS, DEFAULT_MAX_BOOST } from './roomcorrect.js';
import { speakerDelay } from './extras.js';
import { toApoConfig, formatFreq } from './eq.js';
import { fileBase64 } from './views-sampler.js';

const HIGH_CHOICES = [2000, 5000, 8000, 12000, 20000];
const LOW_CHOICES = [30, 40, 50, 60, 70, 80, 100, 120];
const dec = (v, d = 1) => String(Math.round(v * 10 ** d) / 10 ** d).replace('.', ',');

/** opts: { state (outputEq), save(), makePreset(eq, name) } */
export function roomCorrectionCard(ctx, { state, save, makePreset }) {
  state.room ??= { v: 2, target: 'room', maxBoost: DEFAULT_MAX_BOOST, high: 8000, low: 'auto' };
  const cfg = state.room;
  // 0.10.0 started at +6 dB, which was too much bass: earlier settings move to the new default once.
  if (cfg.v !== 2) { cfg.v = 2; cfg.maxBoost = Math.min(cfg.maxBoost ?? DEFAULT_MAX_BOOST, DEFAULT_MAX_BOOST); }
  let meas = []; // [{ id, name, date, calibrated, on, curve }]
  let result = null;
  const saveMeas = () => storeSet('room-measurements', meas).catch(() => {});

  const list = h('div', { class: 'room-meas', 'data-testid': 'room-measurements' });
  const notes = h('div', { class: 'room-notes', 'data-testid': 'room-notes' });
  const filters = h('div', { class: 'room-filters hint', 'data-testid': 'room-filters' });
  const canvas = h('canvas', { class: 'room-graph', 'data-testid': 'room-graph', height: 240 });
  const actions = h('div', { class: 'row wrap' });

  const fileIn = h('input', { type: 'file', multiple: true, accept: '.mdat,.txt,.frd,.csv', style: { display: 'none' }, 'data-testid': 'room-file' });
  fileIn.addEventListener('change', async () => {
    const files = [...fileIn.files];
    fileIn.value = '';
    let added = 0;
    for (const f of files) {
      try {
        for (const m of readMeasurementFile(await f.arrayBuffer(), f.name)) {
          meas.push({ id: crypto.randomUUID(), name: m.name, date: m.date, calibrated: m.calibrated, on: true, curve: toGrid(m).map((x) => Math.round(x * 10) / 10) });
          added++;
        }
      } catch (e) { toast(`${f.name}: ${String(e.message || e)}`); }
    }
    if (!added) return;
    toast(added === 1 ? 'Importeret 1 måling' : `Importeret ${added} målinger`, 'info');
    saveMeas(); render();
  });

  // Measured without the mic's calibration file: it can be applied here afterwards.
  const calIn = h('input', { type: 'file', accept: '.txt,.cal,.frd', style: { display: 'none' }, 'data-testid': 'room-cal-file' });
  calIn.addEventListener('change', async () => {
    const f = calIn.files[0];
    calIn.value = '';
    if (!f) return;
    try {
      const cal = readCalFile(await f.text());
      const targets = meas.filter((m) => m.calibrated === false);
      for (const m of targets) { m.curve = applyCalibration(m.curve, cal).map((x) => Math.round(x * 10) / 10); m.calibrated = true; m.cal = f.name; }
      toast(targets.length === 1 ? `Kalibreringsfilen "${f.name}" er lagt på 1 måling` : `Kalibreringsfilen "${f.name}" er lagt på ${targets.length} målinger`, 'info');
      saveMeas(); render();
    } catch (e) { toast(String(e.message || e)); }
  });
  const calBtn = h('button', { class: 'btn sm', 'data-testid': 'room-cal', title: 'Fx UMIK-1: hent filen til din mikrofons serienummer hos miniDSP. Brug 90°-filen, hvis mikrofonen pegede op mod loftet.', onclick: () => calIn.click() }, 'Læg kalibreringsfil på…');
  const uncalibrated = () => meas.some((m) => m.on && m.calibrated === false);
  const compute = () => {
    const on = meas.filter((m) => m.on);
    if (!on.length) { result = null; return; }
    result = designCorrection(powerAverage(on.map((m) => m.curve)), { target: cfg.target, maxBoost: cfg.maxBoost, high: cfg.high, low: cfg.low });
  };

  const draw = () => {
    const w = canvas.clientWidth || 600;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr; canvas.height = 240 * dpr;
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const v = (n, f) => css.getPropertyValue(n).trim() || f;
    const H = 240, L = 34, B = 18, T = 8;
    const x = (f) => L + (Math.log10(f / 20) / 3) * (w - L - 6);
    const y = (db) => T + ((15 - db) / 45) * (H - T - B);
    g.clearRect(0, 0, w, H);
    g.font = '10px system-ui, sans-serif';
    g.fillStyle = v('--graph-label', '#5d6a85');
    g.strokeStyle = v('--graph-grid', '#1a2335');
    g.lineWidth = 1;
    for (const f of [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]) { g.beginPath(); g.moveTo(x(f), T); g.lineTo(x(f), H - B); g.stroke(); g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x(f) - 8, H - 4); }
    for (let db = 15; db >= -30; db -= 5) { g.beginPath(); g.moveTo(L, y(db)); g.lineTo(w - 6, y(db)); g.stroke(); g.fillText(`${db}`, 4, y(db) + 3); }
    if (!result) { g.fillText('Importér en REW-måling for at se frekvensgangen', L + 10, H / 2); return; }
    // The corrected range.
    g.fillStyle = v('--graph-zero', '#33415f');
    g.globalAlpha = 0.18;
    g.fillRect(x(result.low), T, x(result.high) - x(result.low), H - T - B);
    g.globalAlpha = 1;
    const line = (curve, color, width, dash = []) => {
      g.strokeStyle = color; g.lineWidth = width; g.setLineDash(dash); g.beginPath();
      curve.forEach((db, i) => { const px = x(GRID[i]), py = y(Math.max(-30, Math.min(15, db))); if (i) g.lineTo(px, py); else g.moveTo(px, py); });
      g.stroke(); g.setLineDash([]);
    };
    line(smooth(result.measured, 6), v('--muted', '#8a94a8'), 1.5);
    line(result.target, v('--accent-2', '#a855f7'), 1.5, [5, 4]);
    line(smooth(result.predicted, 6), v('--accent', '#22d3ee'), 2);
  };

  const legend = h('div', { class: 'room-legend hint' },
    h('span', { class: 'lg lg-meas' }, 'Målt'), h('span', { class: 'lg lg-target' }, 'Målkurve'), h('span', { class: 'lg lg-pred' }, 'Med korrektion'), h('span', { class: 'lg lg-range' }, 'Rettes'));

  const sel = (opts, value, onchange, testid) => {
    const s = h('select', { 'data-testid': testid, onchange: () => onchange(s.value) }, opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) }, l)));
    return s;
  };
  const boostVal = h('span', { class: 'val' });
  const boost = h('input', { type: 'range', min: 0, max: 10, step: 1, value: cfg.maxBoost, 'data-testid': 'room-max-boost' });
  const fillBoost = () => { boostVal.textContent = `${cfg.maxBoost} dB`; boost.style.setProperty('--p', `${cfg.maxBoost * 10}%`); };
  boost.addEventListener('input', () => { cfg.maxBoost = Number(boost.value); fillBoost(); });
  boost.addEventListener('change', () => { save(); render(); });
  fillBoost();

  const render = () => {
    calBtn.style.display = meas.some((m) => m.calibrated === false) ? '' : 'none';
    list.replaceChildren(...meas.map((m) => {
      const cb = h('input', { type: 'checkbox', checked: m.on, onchange: () => { m.on = cb.checked; saveMeas(); render(); } });
      return h('div', { class: 'preset-row' }, cb,
        h('span', { class: 'preset-name', title: m.date || '' }, m.name, m.date ? h('span', { class: 'hint' }, ` ${m.date.split(' ')[0]}`) : ''),
        m.calibrated === false ? h('span', { class: 'badge warn', title: 'REW brugte ingen kalibreringsfil til mikrofonen' }, 'ukalibreret') : m.cal ? h('span', { class: 'badge ok', title: m.cal }, 'kalibreret') : null,
        h('button', { class: 'btn sm ghost', title: 'Fjern målingen', 'aria-label': 'Fjern målingen', onclick: () => { meas = meas.filter((x) => x !== m); saveMeas(); render(); } }, '✕'));
    }));
    if (!meas.length) list.append(h('div', { class: 'hint' }, 'Ingen målinger endnu.'));
    compute();
    notes.replaceChildren(...(result ? correctionNotes(result, { calibrated: uncalibrated() ? false : null }) : []).map((n) => h('div', {}, n)));
    filters.replaceChildren(...(result?.bands || []).map((b) => h('div', {}, `${formatFreq(b.freq).replace('.', ',')}  ${b.gain > 0 ? '+' : ''}${dec(b.gain)} dB  Q ${dec(b.q, 2)}`)));
    actions.replaceChildren(...(result?.bands.length ? [
      h('button', { class: 'btn sm primary', 'data-testid': 'room-make-preset', onclick: async () => {
        const name = (await promptDialog('Navn på preset', 'Rumkorrektion', { ok: 'Lav preset' }))?.trim();
        if (!name) return;
        if (state.presets[name] && !(await confirmDialog(`Overskriv "${name}"?`, { ok: 'Overskriv' }))) return;
        makePreset({ enabled: true, preamp: result.preamp, bands: result.bands.map((b) => ({ ...b })) }, name);
        toast(`"${name}" er lavet og i brug – sammenlign med A/B øverst på siden`, 'info');
      } }, 'Lav preset og brug det'),
      h('button', { class: 'btn sm', onclick: () => {
        navigator.clipboard?.writeText(toApoConfig({ enabled: true, preamp: result.preamp, bands: result.bands })).then(() => toast('Kopieret som Equalizer APO-tekst', 'info'), () => toast('Kunne ikke kopiere'));
      } }, 'Kopiér som APO-tekst'),
    ] : []));
    requestAnimationFrame(draw);
  };

  const onTheme = () => draw();
  window.addEventListener('studio-theme', onTheme);
  window.addEventListener('resize', onTheme);
  ctx.cleanup?.push(() => { window.removeEventListener('studio-theme', onTheme); window.removeEventListener('resize', onTheme); });
  storeGet('room-measurements', []).then((m) => { meas = Array.isArray(m) ? m : []; render(); }).catch(() => render());

  return h('div', { class: 'card', 'data-testid': 'room-card' }, h('h2', {}, 'Rumkorrektion (REW-målinger)'),
    h('div', { class: 'hint' }, 'Mål dine højttalere der, hvor du sidder, med REW og en målemikrofon (fx UMIK-1 – husk dens kalibreringsfil), og importér målingerne (.mdat eller "Export measurement as text"). Flere målinger rundt om lyttepladsen giver det bedste resultat – de lægges sammen.'),
    h('div', { class: 'row wrap', style: { marginTop: '8px' } }, h('button', { class: 'btn sm primary', 'data-testid': 'room-import', onclick: () => fileIn.click() }, 'Importér målinger…'), calBtn, fileIn, calIn),
    list,
    h('div', { class: 'row wrap' },
      h('label', {}, 'Målkurve'), sel(Object.entries(TARGETS).map(([k, t]) => [k, t.label]), cfg.target, (v) => { cfg.target = v; save(); render(); }, 'room-target'),
      h('label', {}, 'Ret op til'), sel(HIGH_CHOICES.map((f) => [f, formatFreq(f)]), cfg.high, (v) => { cfg.high = Number(v); save(); render(); }, 'room-high')),
    h('div', { class: 'row wrap' }, h('label', {}, 'Laveste frekvens'),
      sel([['auto', 'Automatisk'], ...LOW_CHOICES.map((f) => [f, `${f} Hz`])], cfg.low ?? 'auto', (v) => { cfg.low = v === 'auto' ? 'auto' : Number(v); save(); render(); }, 'room-low')),
    h('div', { class: 'row' }, h('label', {}, 'Højst løft'), boost, boostVal),
    h('div', { class: 'hint' }, 'Lyder det tungt i bunden: sæt "Højst løft" ned (0 dB = kun toppe dæmpes) eller "Laveste frekvens" op. Under den frekvens løftes højst 1,5 dB.'),
    canvas, legend, notes, filters, actions);
}

/** Højttalere: distance → delay, polarity, own FIR filter. opts: { state, save() } (save also applies). */
export function speakersCard(ctx, { state, save }) {
  state.extras ??= {};
  const ch = (state.extras.channels ??= { mono: false, balance: 0 });
  const fir = (state.extras.fir ??= { enabled: false });
  const delayText = h('div', { class: 'hint', 'data-testid': 'speaker-delay' });
  const showDelay = () => {
    const d = speakerDelay(ch.distL, ch.distR);
    delayText.textContent = d.ms ? `${d.channel === 'L' ? 'Venstre' : 'Højre'} højttaler venter ${dec(d.ms, 2)} ms, så lyden fra begge når dig samtidig.` : 'Samme afstand – ingen forsinkelse.';
  };
  const dist = (key, label) => {
    const i = h('input', { type: 'number', min: 0, max: 2000, step: 1, value: ch[key] || '', placeholder: 'cm', style: { width: '90px' }, 'data-testid': `speaker-${key}` });
    i.addEventListener('change', () => { ch[key] = Math.max(0, Math.min(2000, Number(i.value) || 0)); showDelay(); save(); });
    return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'spacer' }), i, h('span', { class: 'hint' }, 'cm'));
  };
  const flip = (key, label) => {
    const i = h('input', { type: 'checkbox', checked: !!ch[key], 'data-testid': `speaker-${key}`, onchange: () => { ch[key] = i.checked; save(); } });
    return h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, i, h('span')));
  };
  showDelay();

  const firInfo = h('div', { class: 'hint', 'data-testid': 'fir-info' });
  const firSwitch = h('input', { type: 'checkbox', checked: !!fir.enabled, disabled: !fir.file, 'data-testid': 'fir-enabled', onchange: () => { fir.enabled = firSwitch.checked; save(); } });
  const showFir = () => {
    firSwitch.disabled = !fir.file;
    firSwitch.checked = !!fir.enabled;
    firInfo.textContent = fir.file
      ? `${fir.name || fir.file}: ${fir.channels === 1 ? 'mono' : `${fir.channels} kanaler`}, ${dec((fir.frames || 0) / (fir.rate || 48000) * 1000, 0)} ms, ${dec((fir.rate || 0) / 1000)} kHz – virker kun, når udgangen kører ${dec((fir.rate || 0) / 1000)} kHz.`
      : 'Intet filter valgt.';
  };
  showFir();
  const firIn = h('input', { type: 'file', accept: '.wav,audio/wav', style: { display: 'none' }, 'data-testid': 'fir-file' });
  firIn.addEventListener('change', async () => {
    const f = firIn.files[0];
    firIn.value = '';
    if (!f) return;
    try {
      const r = await firSave(f.name, await fileBase64(f));
      Object.assign(fir, { enabled: true, file: r.file, name: f.name, rate: r.rate, channels: r.channels, frames: r.frames });
      showFir(); save();
      toast(`FIR-filteret "${f.name}" er sat på`, 'info');
    } catch (e) { toast(String(e.message || e)); }
  });

  return h('div', { class: 'card', 'data-testid': 'speakers-card' }, h('h2', {}, 'Højttalere'),
    h('div', { class: 'hint' }, 'Afstand fra din lytteplads til hver højttaler. Står du tættere på den ene, venter den, så lyden fra begge rammer dig på samme tid – det giver et skarpere stereobillede.'),
    dist('distL', 'Venstre højttaler'), dist('distR', 'Højre højttaler'), delayText,
    h('h3', { style: { marginTop: '12px' } }, 'Polaritet'),
    flip('invertL', 'Vend venstre'), flip('invertR', 'Vend højre'),
    h('div', { class: 'hint' }, 'Hvis + og − er byttet om på den ene højttaler, forsvinder bassen og midten. Vend den ene – eller ret ledningen.'),
    h('h3', { style: { marginTop: '12px' } }, 'Eget FIR-filter'),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', 'data-testid': 'fir-choose', onclick: () => firIn.click() }, fir.file ? 'Skift fil…' : 'Vælg WAV-fil…'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, firSwitch, h('span')), firIn),
    firInfo,
    h('div', { class: 'hint' }, 'Et impulssvar (WAV) fra fx REW, rePhase eller DRC – til lineær-fase-korrektion. Lægges oven i EQ’en.'));
}
