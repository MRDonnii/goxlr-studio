// Sampler: the four sample buttons on the big GoXLR, in three banks (A/B/C) – which sounds each
// button plays, how (play/stop, hold, loop …), in which order, and where each sound starts and
// stops. Plus the sample files (gain) and the recorder's settings. GoXLR Mini has no sampler.
// Recording happens on the GoXLR itself: hold an empty sample button while you speak.
import { h, slider, selectBox, toggle, toast, setRangeFill } from './ui.js';
import { isNative, moveRestore } from './native.js';

export const BANKS = ['A', 'B', 'C'];
export const PADS = [['TopLeft', 'Knap 1 (øverst til venstre)'], ['TopRight', 'Knap 2 (øverst til højre)'], ['BottomLeft', 'Knap 3 (nederst til venstre)'], ['BottomRight', 'Knap 4 (nederst til højre)']];
export const MODES = [
  ['PlayNext', 'Afspil (næste ved hvert tryk)'], ['PlayStop', 'Afspil / stop'], ['PlayFade', 'Afspil / fade ud'],
  ['StopOnRelease', 'Spil mens knappen holdes'], ['FadeOnRelease', 'Spil mens den holdes, fade ud'], ['Loop', 'Gentag (loop)'],
];
export const ORDERS = [['Sequential', 'I rækkefølge'], ['Random', 'Tilfældig']];

/** A file's bytes as base64 (FileReader – fine for large files). */
export const fileBase64 = (f) => new Promise((ok, fail) => {
  const r = new FileReader();
  r.onload = () => ok(String(r.result).split(',')[1] || '');
  r.onerror = () => fail(r.error);
  r.readAsDataURL(f);
});

/** A trim point as the engine wants it (0–100, one decimal), from what the user typed. */
export const trimPct = (v) => Math.round(Math.max(0, Math.min(100, Number(v) || 0)) * 10) / 10;

export function samplerView(ctx) {
  const { conn, binder } = ctx;
  const m = () => conn.mixer;
  const sp = () => m()?.sampler;
  if (!sp()) return h('div', { class: 'card' }, 'Sampleren findes kun på den store GoXLR – GoXLR Mini har ingen sampler-knapper. Lydbanken (siden Lydbank) virker på begge.');
  let bank = sp().active_bank || 'A';

  const bankSeg = h('div', { class: 'seg', 'data-testid': 'sampler-banks' });
  const pads = h('div', { class: 'grid cols-2' });
  const renderBanks = () => bankSeg.replaceChildren(...BANKS.map((b) => h('button', {
    class: b === bank ? 'on' : '', 'data-testid': `sampler-bank-${b}`,
    onclick: () => { bank = b; conn.command('SetActiveSamplerBank', b); renderBanks(); renderPads(); },
  }, `Bank ${b}`)));

  const fileOptions = () => Object.keys(conn.status.files?.samples || {}).sort();
  const padCard = (key, title) => {
    const btn = () => sp().banks?.[bank]?.[key];
    const state = h('span', { class: 'badge' });
    const list = h('div', { class: 'list compact' });
    const add = h('select', { class: 'trigger-sel', 'data-testid': `sampler-add-${key}` });
    let listKey = '';
    binder.add(() => {
      const b = btn();
      if (!b) return;
      state.textContent = b.is_recording ? '● optager' : b.is_playing ? '▶ spiller' : b.samples.length === 1 ? '1 lyd' : b.samples.length ? `${b.samples.length} lyde` : 'tom';
      state.className = `badge ${b.is_recording ? 'warn' : b.is_playing ? 'ok' : ''}`;
      const k = JSON.stringify(b.samples) + bank;
      if (k === listKey) return;
      listKey = k;
      list.replaceChildren(...b.samples.map((s, i) => {
        const start = h('input', { type: 'number', min: 0, max: 100, step: 0.5, value: s.start_pct, 'aria-label': 'Start (%)', class: 'num', onchange: (e) => conn.command('SetSampleStartPercent', bank, key, i, trimPct(e.target.value)) });
        const stop = h('input', { type: 'number', min: 0, max: 100, step: 0.5, value: s.stop_pct, 'aria-label': 'Slut (%)', class: 'num', onchange: (e) => conn.command('SetSampleStopPercent', bank, key, i, trimPct(e.target.value)) });
        return h('div', { class: 'item sample-row', 'data-testid': 'sampler-sample' },
          h('span', { class: 'sample-name', title: s.name }, s.name.replace(/\.[^.]+$/, '')),
          h('div', { class: 'spacer' }),
          h('span', { class: 'hint' }, 'Start'), start, h('span', { class: 'hint' }, 'Slut'), stop,
          h('button', { class: 'btn sm', title: 'Afspil', onclick: () => conn.command('PlaySampleByIndex', bank, key, i) }, '▶'),
          h('button', { class: 'btn sm', title: 'Fjern fra knappen', onclick: () => conn.command('RemoveSampleByIndex', bank, key, i) }, '✕'));
      }));
      if (!b.samples.length) list.append(h('div', { class: 'hint' }, 'Ingen lyde – tilføj en fil, eller hold knappen nede på GoXLR’en for at optage.'));
      const files = fileOptions();
      add.replaceChildren(h('option', { value: '' }, '— tilføj lyd —'), ...files.map((f) => h('option', { value: f }, f)));
    });
    add.addEventListener('change', () => { if (add.value) { conn.command('AddSample', bank, key, add.value); add.value = ''; } });
    return h('div', { class: 'card', 'data-testid': `sampler-pad-${key}` },
      h('h2', {}, title, state),
      h('div', { class: 'row' }, h('label', {}, 'Når der trykkes'), selectBox(binder, { options: MODES, get: () => btn()?.function, set: (v) => conn.command('SetSamplerFunction', bank, key, v) })),
      h('div', { class: 'row' }, h('label', {}, 'Rækkefølge'), selectBox(binder, { options: ORDERS, get: () => btn()?.order, set: (v) => conn.command('SetSamplerOrder', bank, key, v) })),
      list,
      h('div', { class: 'row', style: { marginTop: '6px', flexWrap: 'wrap' } }, add,
        h('button', { class: 'btn sm', onclick: () => conn.command('PlayNextSample', bank, key) }, '▶ Afspil'),
        h('button', { class: 'btn sm', onclick: () => conn.command('StopSamplePlayback', bank, key) }, '⏹ Stop')));
  };
  const renderPads = () => pads.replaceChildren(...PADS.map(([k, t]) => padCard(k, t)));

  // Sample files: gain per file, and import of new ones into GoXLR's samples folder.
  const filesList = h('div', { class: 'list compact', 'data-testid': 'sampler-files' });
  let filesKey = '';
  binder.add(() => {
    const files = conn.status.files?.samples || {};
    const k = JSON.stringify(files);
    if (k === filesKey) return;
    filesKey = k;
    filesList.replaceChildren(...Object.values(files).sort((a, b) => a.name.localeCompare(b.name)).map((f) => {
      const val = h('span', { class: 'val' }, `${f.gain_pct} %`);
      const r = h('input', { type: 'range', min: 0, max: 100, value: f.gain_pct, 'aria-label': `Lydstyrke for ${f.name}` });
      setRangeFill(r);
      r.addEventListener('input', () => { val.textContent = `${r.value} %`; setRangeFill(r); });
      r.addEventListener('change', () => conn.daemon('SetSampleGainPct', f.name, Number(r.value)));
      return h('div', { class: 'item' }, h('span', { class: 'sample-name', title: f.name }, f.name), h('div', { class: 'spacer' }), r, val);
    }));
    if (!Object.keys(files).length) filesList.append(h('div', { class: 'hint' }, 'Ingen samples endnu.'));
  });
  const fileIn = h('input', { type: 'file', accept: '.wav,.mp3,.flac,.ogg,audio/*', multiple: true, style: { display: 'none' }, 'data-testid': 'sampler-import-file' });
  fileIn.addEventListener('change', async () => {
    const dir = conn.status.paths?.samples_directory;
    const picked = [...fileIn.files];
    fileIn.value = '';
    if (!picked.length) return;
    if (!dir) { toast('GoXLR’ens samples-mappe er ikke kendt endnu – er GoXLR’en forbundet?'); return; }
    try {
      const files = await Promise.all(picked.map(async (f) => ({ kind: 'samples', name: f.name, data: await fileBase64(f) })));
      const r = await moveRestore(files, [['samples', String(dir)]], new Date().toISOString().slice(0, 16).replace(/[-T:]/g, ''));
      toast(r.skipped.length ? `${r.written} lagt i samples-mappen – ${r.skipped.length} sprunget over (kun WAV, MP3, FLAC og OGG)` : `${r.written} lagt i samples-mappen`, 'info');
      if (!isNative()) for (const f of picked) conn.status.files.samples[f.name] = { name: f.name, gain_pct: 100 };
    } catch (e) { toast(`Samples: ${e.message || e}`); }
  });
  const procState = h('div', { class: 'hint', 'data-testid': 'sampler-processing' });
  binder.add(() => {
    const ps = sp()?.processing_state || {};
    procState.replaceChildren(
      ps.progress != null ? `Behandler sample… ${ps.progress} %` : '',
      ps.last_error ? h('span', { class: 'warn-text', style: { marginRight: '6px' } }, `Fejl: ${ps.last_error}`) : '',
      ps.last_error ? h('button', { class: 'btn sm', onclick: () => conn.command('ClearSampleProcessError') }, 'OK') : '');
  });

  const settingsCard = h('div', { class: 'card' }, h('h2', {}, 'Optagelse og afspilning'),
    slider(binder, { label: 'Optag også sekunderne før', min: 0, max: 30, get: () => sp()?.record_buffer ?? 0, set: (v) => conn.command('SetSamplerPreBufferDuration', v), fmt: (v) => (v ? `${v} s` : 'fra') }),
    slider(binder, { label: 'Fade ud', min: 0, max: 5000, step: 100, get: () => m().settings?.fade_duration ?? 0, set: (v) => conn.command('SetSamplerFadeDuration', v), fmt: (v) => `${v} ms` }),
    toggle(binder, { label: '"Clear" nulstiller knapperne', get: () => m().settings?.reset_sampler_on_clear, set: (v) => conn.command('SetSamplerResetOnClear', v) }),
    h('div', { class: 'hint' }, 'Optag: hold en tom sampler-knap nede på GoXLR’en, mens du taler. "Sekunderne før" gør, at det, der skete lige inden du trykkede, kommer med – smart til klip af noget sjovt, der allerede er sagt.'));
  const filesCard = h('div', { class: 'card' }, h('h2', {}, 'Sample-filer',
    h('button', { class: 'btn sm primary', 'data-testid': 'sampler-import', onclick: () => fileIn.click() }, 'Importér lydfil…')), fileIn,
    filesList, procState,
    h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Lydstyrken gælder filen på alle knapper. Importerede filer lægges i GoXLR’ens samples-mappe.'));

  renderBanks();
  renderPads();
  return h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('h2', {}, 'Sampler', bankSeg), h('div', { class: 'hint' }, 'Vælg bank – den skifter også på GoXLR’en.')),
    pads,
    h('div', { class: 'grid cols-2' }, settingsCard, filesCard));
}
