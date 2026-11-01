// Start levels: a level per channel that GoXLR Studio sets every time it starts, after the GoXLR
// profile is loaded – global, the same whatever profile is active (brugerønske).
import { h, toast, toggle, logActivity } from './ui.js';
import { CHANNELS } from './demo.js';
import { CHANNEL_LABEL } from './views-mixer.js';
import { startLevelCommands } from './extras.js';

const pctOf = (raw) => Math.round(((raw ?? 0) * 100) / 255);

export function applyStartLevels(ctx, reason = 'GoXLR Studio startede') {
  const vols = ctx.conn.mixer?.levels?.volumes || {};
  const cmds = startLevelCommands(ctx.prefs.startLevels, Object.keys(vols));
  for (const c of cmds) ctx.conn.command(...c);
  if (cmds.length) logActivity(`Startniveauer sat (${reason}): ${cmds.map(([, c, v]) => `${CHANNEL_LABEL[c] || c} ${pctOf(v)} %`).join(', ')}`);
  return cmds.length;
}

export function startLevelsCard(ctx) {
  const p = ctx.prefs;
  p.startLevels ??= { enabled: false, channels: {} };
  const cfg = p.startLevels;
  const save = () => ctx.savePrefs();
  const vols = () => ctx.conn.mixer?.levels?.volumes || {};
  const rows = h('div', { class: 'list compact start-levels', 'data-testid': 'start-levels' });
  const render = () => rows.replaceChildren(...CHANNELS.filter((c) => c in vols()).map((c) => {
    const on = cfg.channels[c] != null;
    const val = on ? cfg.channels[c] : pctOf(vols()[c]);
    const out = h('span', { class: 'val' }, `${val} %`);
    const range = h('input', { type: 'range', min: 0, max: 100, value: val, disabled: !on, 'data-testid': `start-level-${c}`,
      oninput: () => { out.textContent = `${range.value} %`; range.style.setProperty('--p', `${range.value}%`); },
      onchange: () => { cfg.channels[c] = +range.value; save(); } });
    range.style.setProperty('--p', `${val}%`);
    const cb = h('input', { type: 'checkbox', checked: on, 'data-testid': `start-level-on-${c}`, title: 'Sæt denne kanal ved start',
      onchange: () => { if (cb.checked) cfg.channels[c] = +range.value; else delete cfg.channels[c]; save(); render(); } });
    const now = h('button', { class: 'btn sm', title: 'Brug den nuværende lydstyrke', 'data-testid': `start-level-now-${c}`,
      onclick: () => { cfg.channels[c] = pctOf(vols()[c]); save(); render(); } }, 'Nu');
    return h('div', { class: 'item' }, cb, h('span', { class: 'start-level-name' }, CHANNEL_LABEL[c] || c), range, out, now);
  }));
  render();
  const binder = { add: (fn) => { fn(); return fn; } };
  return h('div', { class: 'card', 'data-testid': 'start-levels-card' }, h('h2', {}, 'Startniveauer'),
    h('div', { class: 'hint', style: { marginBottom: '10px' } }, 'Faste niveauer, som GoXLR Studio altid sætter, når programmet starter – efter at GoXLR-profilen er indlæst, og uanset hvilken profil der er aktiv. Markér de kanaler, der skal have et startniveau.'),
    toggle(binder, { label: 'Sæt startniveauer, når GoXLR Studio starter', get: () => !!cfg.enabled, set: (v) => { cfg.enabled = v; save(); } }),
    rows,
    h('div', { class: 'row', style: { marginTop: '10px' } },
      h('button', { class: 'btn sm', 'data-testid': 'start-levels-capture', onclick: () => {
        for (const c of CHANNELS) if (c in vols()) cfg.channels[c] = pctOf(vols()[c]);
        cfg.enabled = true; save(); render(); ctx.binder?.run?.();
        toast('Alle kanalers nuværende lydstyrke er gemt som startniveauer', 'info');
      } }, 'Brug alle nuværende'),
      h('button', { class: 'btn sm', 'data-testid': 'start-levels-apply', onclick: () => {
        const n = applyStartLevels({ ...ctx, prefs: { startLevels: { ...cfg, enabled: true } } }, 'sat med knappen');
        toast(n ? `${n} kanaler sat til startniveau` : 'Ingen kanaler markeret', n ? 'info' : undefined);
      } }, 'Sæt nu')));
}
