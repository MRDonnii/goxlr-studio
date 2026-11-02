// A row of action pickers ("Gør → [handling] [handling] +"), shared by Tidsstyring and Spiltilstand.
import { h } from './ui.js';
import { actionLabel } from './actions.js';

/** arr = the action ids (changed in place); getCatalog() = the groups from actionCatalog(). */
export function actionRow(ctx, { arr, label, getCatalog, save, rerender, testid }) {
  const sel = (i) => {
    const catalog = getCatalog();
    const known = catalog.some((g) => g.items.some((it) => it.id === arr[i]));
    return h('select', { class: 'trigger-sel', onchange: (e) => { if (e.target.value) arr[i] = e.target.value; else arr.splice(i, 1); save(); } },
      h('option', { value: '' }, '— ingen —'),
      arr[i] && !known ? h('option', { value: arr[i], selected: true }, actionLabel(ctx, arr[i])) : null,
      catalog.map((g) => h('optgroup', { label: g.title }, g.items.map((it) => h('option', { value: it.id, selected: it.id === arr[i] }, it.label)))));
  };
  return h('div', { class: 'row trigger-actions' }, h('span', { class: 'lbl app-lbl' }, label),
    ...arr.map((_, i) => sel(i)),
    h('button', { class: 'btn sm', title: 'Tilføj en handling mere', 'data-testid': testid, onclick: () => { arr.push(''); rerender(); } }, arr.length ? '+' : '+ Handling'));
}
