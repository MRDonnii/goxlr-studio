// The Høretest card on the Afspilnings-EQ page: a pulsing tone in one ear at a time; you turn it
// down until it just disappears and back up until you just hear it. 10 frequencies × 2 ears.
// The EQ is switched off while testing (and back on after), so the tones are not changed.
import { h, toast, confirmDialog } from './ui.js';
import { TEST_FREQS, START_DB, MIN_DB, MAX_DB, hearingProfile, compensationBands, hearingSummary } from './hearingtest.js';

const fmtHz = (f) => (f >= 1000 ? `${f / 1000} kHz` : `${f} Hz`);
const EAR = { L: 'Venstre øre', R: 'Højre øre' };

/** opts: { setEqEnabled(on) → previous, makePreset(bands), addToCurrent(bands) } */
export function hearingTestCard(ctx, opts) {
  const body = h('div', { 'data-testid': 'hearing-test' });
  let audio = null;

  const stopAudio = () => {
    if (!audio) return;
    clearInterval(audio.pulse);
    try { audio.osc.stop(); } catch { /* stopped */ }
    audio.ac.close().catch(() => {});
    audio = null;
  };
  ctx.cleanup.push(stopAudio);

  // One tone: sine → level → pulse (350 ms on, 350 ms off) → left or right channel.
  const playTone = (freq, ear, db) => {
    stopAudio();
    const ac = new AudioContext();
    const osc = ac.createOscillator(); osc.frequency.value = freq;
    const level = ac.createGain(); level.gain.value = Math.pow(10, db / 20);
    const pulseGain = ac.createGain(); pulseGain.gain.value = 0;
    const merge = ac.createChannelMerger(2);
    osc.connect(level).connect(pulseGain).connect(merge, 0, ear === 'L' ? 0 : 1);
    merge.connect(ac.destination);
    osc.start();
    let on = false;
    const toggle = () => {
      on = !on;
      const t = ac.currentTime;
      pulseGain.gain.cancelScheduledValues(t);
      pulseGain.gain.setTargetAtTime(on ? 1 : 0, t, 0.015);
    };
    toggle();
    const pulse = setInterval(toggle, 350);
    audio = { ac, osc, level, pulse };
  };
  const setLevel = (db) => { if (audio) audio.level.gain.setTargetAtTime(Math.pow(10, db / 20), audio.ac.currentTime, 0.02); };

  const intro = () => {
    stopAudio();
    const last = ctx.prefs.hearingTest;
    body.replaceChildren(
      h('div', { class: 'hint' }, 'Find den svageste tone, du kan høre, på hvert øre – og få en EQ, der passer til dine ører og dine hovedtelefoner. Tager ca. 3 minutter. Det er ikke en lægeundersøgelse.'),
      h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } },
        h('button', { class: 'btn sm primary', 'data-testid': 'hearing-start', onclick: start }, last ? 'Tag testen igen' : 'Start høretest'),
        last ? h('button', { class: 'btn sm', 'data-testid': 'hearing-last', onclick: () => result(last.thresholds) }, 'Vis sidste resultat') : null),
      last ? h('div', { class: 'hint', style: { marginTop: '6px' } }, `Sidst: ${new Date(last.at).toLocaleDateString('da-DK')}`) : null);
  };

  async function start() {
    if (!(await confirmDialog('Før du starter:\n\n• Tag de hovedtelefoner på, du vil have EQ til.\n• Skru ned for lydstyrken – tonerne starter svagt, men skal ikke kunne gøre ondt.\n• Sid et stille sted.\n\nEQ’en slås fra under testen og til igen bagefter.', { ok: 'Start' }))) return;
    const wasOn = opts.setEqEnabled(false);
    const steps = ['L', 'R'].flatMap((ear) => TEST_FREQS.map((freq, i) => ({ ear, freq, i })));
    const thresholds = { L: TEST_FREQS.map(() => null), R: TEST_FREQS.map(() => null) };
    let k = 0;
    const finish = (done) => {
      stopAudio();
      opts.setEqEnabled(wasOn);
      if (!done) { intro(); return; }
      ctx.prefs.hearingTest = { at: Date.now(), thresholds };
      ctx.savePrefs?.();
      result(thresholds);
    };
    const step = () => {
      const s = steps[k];
      const slider = h('input', { type: 'range', min: MIN_DB, max: MAX_DB, step: 1, value: START_DB, 'data-testid': 'hearing-level', 'aria-label': 'Lydstyrke' });
      const val = h('span', { class: 'badge', 'data-testid': 'hearing-db' }, `${START_DB} dB`);
      slider.addEventListener('input', () => { val.textContent = `${slider.value} dB`; setLevel(Number(slider.value)); });
      const record = (v) => { thresholds[s.ear][s.i] = v; k += 1; if (k >= steps.length) finish(true); else step(); };
      body.replaceChildren(
        h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('b', { 'data-testid': 'hearing-step' }, `${EAR[s.ear]} · ${fmtHz(s.freq)}`), h('span', { class: 'hint' }, `Trin ${k + 1} af ${steps.length}`)),
        h('div', { class: 'hint', style: { margin: '6px 0' } }, 'Træk ned, til tonen lige netop forsvinder – og så lidt op igen, til du lige akkurat kan høre den. Piletasterne flytter 1 dB.'),
        h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Svagere'), slider, h('span', { class: 'hint' }, 'Kraftigere'), val),
        h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } },
          h('button', { class: 'btn sm primary', 'data-testid': 'hearing-next', onclick: () => record(Number(slider.value)) }, 'Jeg kan lige akkurat høre den'),
          h('button', { class: 'btn sm', 'data-testid': 'hearing-cant', onclick: () => record(null) }, 'Kan slet ikke høre den'),
          k > 0 ? h('button', { class: 'btn sm', onclick: () => { k -= 1; step(); } }, 'Tilbage') : null,
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn sm', 'data-testid': 'hearing-cancel', onclick: () => finish(false) }, 'Afbryd')));
      playTone(s.freq, s.ear, START_DB);
      slider.focus();
    };
    step();
  }

  // The result: the curve per ear (an audiogram – worse hearing is lower), what it means, and the EQ.
  function result(thresholds) {
    stopAudio();
    const prof = hearingProfile(thresholds);
    const bands = compensationBands(thresholds);
    const W = 320, H = 130, lo = Math.log(200), hi = Math.log(14000);
    const x = (f) => 30 + ((Math.log(f) - lo) / (hi - lo)) * (W - 40);
    const y = (d) => 10 + ((Math.max(-10, Math.min(30, d)) + 10) / 40) * (H - 30);
    const line = (ear, color) => `<polyline fill="none" style="stroke:${color}" stroke-width="2" points="${TEST_FREQS.map((f, i) => `${x(f).toFixed(1)},${y(prof[ear][i]).toFixed(1)}`).join(' ')}"/>`
      + TEST_FREQS.map((f, i) => `<circle cx="${x(f).toFixed(1)}" cy="${y(prof[ear][i]).toFixed(1)}" r="3" style="fill:${color}"/>`).join('');
    const svg = h('div', { class: 'hearing-chart' });
    svg.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`
      + `<line x1="30" x2="${W - 10}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--line-hover)" stroke-dasharray="3 3"/>`
      + [250, 1000, 4000, 12000].map((f) => `<text x="${x(f)}" y="${H - 4}" style="fill:var(--muted)" font-size="9" text-anchor="middle">${f >= 1000 ? `${f / 1000}k` : f}</text>`).join('')
      + line('L', 'var(--accent)') + line('R', 'var(--ear-right)') + '</svg>';
    body.replaceChildren(
      h('div', { class: 'row', style: { gap: '14px', flexWrap: 'wrap' } },
        h('span', {}, h('span', { class: 'ear-swatch left' }), 'Venstre øre'), h('span', {}, h('span', { class: 'ear-swatch right', style: { marginLeft: '4px' } }), 'Højre øre'),
        h('span', { class: 'hint' }, 'Lavere = hører dårligere end resten')),
      svg,
      h('div', { class: 'hearing-summary', 'data-testid': 'hearing-summary' }, hearingSummary(thresholds).map((l) => h('div', {}, l))),
      h('div', { class: 'hint', style: { margin: '6px 0' } }, bands.length
        ? `Den personlige EQ har ${bands.length} bånd for hvert sit øre og løfter cirka halvdelen af forskellen (højst +8 dB). Balance sænker resten tilsvarende.`
        : 'Der er ikke noget, der skal rettes.'),
      h('div', { class: 'row', style: { flexWrap: 'wrap' } },
        bands.length ? h('button', { class: 'btn sm primary', 'data-testid': 'hearing-preset', onclick: () => { opts.makePreset(bands); toast('Presettet "Min hørelse" er lavet og i brug', 'info'); } }, 'Lav preset "Min hørelse"') : null,
        bands.length ? h('button', { class: 'btn sm', 'data-testid': 'hearing-add', onclick: () => { opts.addToCurrent(bands); toast(`${bands.length} bånd lagt oven i den aktuelle EQ – Ctrl+Z fortryder`, 'info'); } }, 'Læg oven i den aktuelle EQ') : null,
        h('button', { class: 'btn sm', onclick: intro }, 'Tilbage')));
  }

  intro();
  return h('div', { class: 'card' }, h('h2', {}, 'Høretest – EQ til dine ører'), body);
}
