// Dynamik: GoXLR Studio's own limiter/compressor plugin (plugins/dynamics) last in the EQ engine's
// chain – a limiter that keeps peaks under a ceiling (protects speakers and ears from sudden loud
// sounds), and optionally a compressor ("Natmode": quiet and loud parts closer together).
// The plugin takes 8 normalised parameters (0–1); the maths here mirrors plugins/dynamics/src/lib.rs.
import { h, toast } from './ui.js';
import { engineInfo, engineTask } from './native.js';
import { DYN_MODES } from './dynamicsmodel.js';

export function dynamicsCard(ctx, { state, save }) {
  state.extras ??= {};
  const d = (state.extras.dynamics ??= { enabled: false, mode: 'limiter', ...DYN_MODES.limiter });
  const body = h('div', { 'data-testid': 'dynamics' });
  const range = (key, min, max, step, fmt, testid) => {
    const val = h('span', { class: 'val' }, fmt(d[key]));
    const r = h('input', { type: 'range', min, max, step, value: d[key], 'data-testid': testid });
    const fill = () => r.style.setProperty('--p', `${((d[key] - min) / (max - min)) * 100}%`);
    r.addEventListener('input', () => { d[key] = Number(r.value); val.textContent = fmt(d[key]); fill(); });
    r.addEventListener('change', () => { d.mode = 'custom'; save(); render(); });
    fill();
    return [r, val];
  };
  const dB = (v) => `${String(v).replace('.', ',')} dB`;
  const render = async () => {
    const info = await engineInfo().catch(() => null);
    const sw = h('input', { type: 'checkbox', 'data-testid': 'dynamics-on', checked: !!d.enabled, onchange: () => { d.enabled = sw.checked; save(); render(); } });
    const mode = h('select', { 'data-testid': 'dynamics-mode', onchange: () => {
      if (DYN_MODES[mode.value]) Object.assign(d, DYN_MODES[mode.value]);
      d.mode = mode.value; save(); render();
    } }, [...Object.entries(DYN_MODES).map(([k, m]) => h('option', { value: k, selected: d.mode === k }, m.label)), h('option', { value: 'custom', selected: d.mode === 'custom' }, 'Egen indstilling')]);
    const notes = [];
    if (info && info.kind !== 'builtin') notes.push('Kræver GoXLR Studios EQ-motor.');
    else if (info && !info.dynamics_bundled) notes.push('Denne udgave af appen har ikke Dynamik med.');
    const needFiles = info?.kind === 'builtin' && info.dynamics_bundled && !info.dynamics_installed;
    const comp = d.ratio > 1.01;
    body.replaceChildren(
      h('div', { class: 'row' }, h('label', {}, 'Dynamik'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, sw, h('span'))),
      h('div', { class: 'row' }, mode),
      ...notes.map((n) => h('div', { class: 'hint warn-text' }, n)),
      needFiles ? h('div', { class: 'row', style: { marginTop: '6px' } }, h('span', { class: 'hint' }, 'Dynamik skal lægges ved EQ-motoren først (kræver administrator).'),
        h('button', { class: 'btn sm primary', 'data-testid': 'dynamics-install', onclick: async (e) => {
          e.target.disabled = true;
          try { const r = await engineTask({ action: 'test' }); toast(r?.ok ? 'Dynamik er lagt ind' : `Det lykkedes ikke: ${r?.error || '?'}`, r?.ok ? 'info' : 'error'); } catch (err) { toast(String(err)); }
          save(); render();
        } }, 'Læg den ind')) : '',
      h('div', { class: 'row' }, h('label', {}, 'Loft'), ...range('ceiling', -12, 0, 0.5, dB, 'dynamics-ceiling')),
      h('div', { class: 'row' }, h('label', {}, 'Kompression'), ...range('ratio', 1, 10, 0.5, (v) => (v <= 1.01 ? 'Fra' : `${String(v).replace('.', ',')}:1`), 'dynamics-ratio')),
      comp ? h('div', { class: 'row' }, h('label', {}, 'Tærskel'), ...range('threshold', -40, 0, 1, dB, 'dynamics-threshold')) : '',
      comp ? h('div', { class: 'row' }, h('label', {}, 'Make-up'), ...range('makeup', 0, 18, 0.5, dB, 'dynamics-makeup')) : '',
      h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Sidst i kæden på alle udgange med EQ-motoren: limiteren holder lyden under loftet, så en pludselig eksplosion eller en høj reklame ikke klipper eller giver et chok. Natmode trykker forskellen mellem stille tale og høje effekter sammen – godt til film om aftenen. Giver 2 ms forsinkelse.'));
  };
  render();
  return h('div', { class: 'card' }, h('h2', {}, 'Dynamik (limiter og kompressor)'), body);
}
