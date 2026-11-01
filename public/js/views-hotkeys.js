import { h, toast } from './ui.js';
import { actionCatalog, actionLabel } from './actions.js';
import { isNative } from './native.js';

const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'];

export function accelFromEvent(e) {
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  let key = e.code;
  if (/^Key[A-Z]$/.test(key)) key = key.slice(3);
  else if (/^Digit\d$/.test(key)) key = key.slice(5);
  else if (key.startsWith('Arrow')) key = key.slice(5);
  if (!key) return null;
  return [...mods, key].join('+');
}

export function prettyAccel(accel) {
  if (!accel) return 'Ikke sat';
  return accel.split('+').map((p) => ({ Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Win', PageUp: 'PgUp', PageDown: 'PgDn', Up: '↑', Down: '↓', Left: '←', Right: '→' }[p] || p)).join(' + ');
}

export function hotkeysView(ctx) {
  const list = h('div', { class: 'list' });
  let catalog = [];

  const save = () => { render(); Promise.resolve(ctx.saveHotkeys()).then(render); };

  const capture = (binding, btn) => {
    btn.textContent = 'Tryk tasten… (Esc = annullér)';
    btn.classList.add('on');
    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { done(); render(); return; }
      const accel = accelFromEvent(e);
      if (!accel) return;
      const clash = ctx.hotkeys.find((b) => b !== binding && b.accel === accel);
      if (clash) toast(`${prettyAccel(accel)} bruges allerede – den gamle binding fjernes`, 'info');
      if (clash) clash.accel = '';
      binding.accel = accel;
      done();
      save();
    };
    const done = () => { window.removeEventListener('keydown', onKey, true); ctx.capturingHotkey = false; ctx.resumeHotkeys?.(); };
    ctx.capturingHotkey = true;
    ctx.pauseHotkeys?.();
    window.addEventListener('keydown', onKey, true);
  };

  const render = () => {
    list.replaceChildren(...ctx.hotkeys.map((b) => {
      const status = ctx.hotkeyStatus[b.id];
      const keyBtn = h('button', { class: 'btn keycap', onclick: () => capture(b, keyBtn) }, prettyAccel(b.accel));
      const sel = h('select', { onchange: () => { b.action = sel.value; save(); } },
        h('option', { value: '' }, 'Vælg handling…'),
        catalog.map((g) => h('optgroup', { label: g.title }, g.items.map((i) => h('option', { value: i.id, selected: i.id === b.action }, i.label)))));
      if (b.action && !catalog.some((g) => g.items.some((i) => i.id === b.action))) {
        const label = actionLabel(ctx, b.action);
        sel.append(h('option', { value: b.action, selected: true }, label === b.action ? `(findes ikke længere) ${b.action}` : label));
      }
      return h('div', { class: 'item' },
        keyBtn, h('span', { class: 'hint' }, '→'), sel,
        h('div', { class: 'spacer' }),
        status && !status.ok ? h('span', { class: 'badge warn', title: status.error }, status.error?.startsWith('Optaget') ? 'Optaget' : 'Fejl') : (b.accel && b.action ? h('span', { class: 'badge ok' }, 'Aktiv') : null),
        h('button', { class: 'btn sm', title: 'Test handlingen', onclick: () => b.action && ctx.runAction(b.action, 'Test-knap under Genveje') }, 'Test'),
        h('button', { class: 'btn sm', onclick: () => { ctx.hotkeys.splice(ctx.hotkeys.indexOf(b), 1); save(); } }, '✕'));
    }));
    if (!ctx.hotkeys.length) list.append(h('div', { class: 'hint' }, 'Ingen genveje endnu.'));
  };

  const add = (action = '', accel = '') => { ctx.hotkeys.push({ id: crypto.randomUUID(), accel, action }); save(); };

  const suggestions = h('div', { class: 'fx-toggle' });
  const buildSuggestions = () => {
    const profiles = ctx.conn.status?.files?.profiles || [];
    const items = [];
    if (profiles.includes('Headset') && profiles.includes('Speakers')) {
      items.push(['F13 → Headset', 'profile:Headset', 'F13'], ['F14 → Speakers', 'profile:Speakers', 'F14'],
        ['Ctrl+PgUp → Headset', 'profile:Headset', 'Ctrl+PageUp'], ['Ctrl+PgDn → Speakers', 'profile:Speakers', 'Ctrl+PageDown']);
    }
    items.push(['Mute mikrofon', 'mute-mic', 'Ctrl+Alt+M'], ['EQ til/fra', 'eq-toggle', 'Ctrl+Alt+E'], ['Næste EQ-preset', 'eq-next', 'Ctrl+Alt+Q'], ['Næste udgang', 'output-next', 'Ctrl+Alt+O']);
    const open = items.filter(([, action, accel]) => !ctx.hotkeys.some((b) => b.action === action && b.accel === accel));
    const free = open.filter(([, , accel]) => !ctx.hotkeys.some((b) => b.accel === accel));
    suggestions.replaceChildren(...open
      .map(([label, action, accel]) => h('button', { class: 'btn sm', onclick: () => { if (!ctx.hotkeys.some((b) => b.accel === accel)) add(action, accel); else toast(`${prettyAccel(accel)} er allerede i brug`); buildSuggestions(); } }, `+ ${label}`)),
      free.length > 1 ? h('button', { class: 'btn sm primary', onclick: () => {
        for (const [, action, accel] of free) ctx.hotkeys.push({ id: crypto.randomUUID(), accel, action });
        save(); buildSuggestions();
      } }, `+ Tilføj alle (${free.length})`) : '');
    if (!open.length) suggestions.append(h('span', { class: 'hint' }, 'Alle forslag er tilføjet.'));
  };

  actionCatalog(ctx).then((c) => { catalog = c; render(); buildSuggestions(); });

  return h('div', { class: 'grid' },
    h('div', { class: 'card' },
      h('h2', {}, 'Globale genveje', h('button', { class: 'btn sm primary', onclick: () => add() }, '+ Ny genvej')),
      list,
      h('div', { class: 'hint', style: { marginTop: '10px' } },
        isNative()
          ? 'Genvejene virker overalt i Windows – også i spil og når appen ligger i bakken. G-taster fra Logitech G HUB kan bindes, hvis de i G HUB er sat til at sende F13–F24.'
          : 'I browseren virker genvejene kun, når fanen har fokus.')),
    h('div', { class: 'card' }, h('h2', {}, 'Forslag'), suggestions,
      h('div', { class: 'hint', style: { marginTop: '10px' } }, 'Kører dit gamle AutoHotkey-script stadig, er de samme taster "optaget". Luk scriptet (og fjern det fra Autostart), når genvejene her virker.')));
}
