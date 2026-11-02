// Tidsstyring: run actions at a time of day on chosen weekdays – e.g. 22:00 → EQ-preset "Sen aften"
// and a ceiling on the headphones; 07:00 → back again. Off until switched on. Rules live in
// prefs.schedule = { enabled, catchUp, rules: [{ id, at: 'HH:MM', days: [0–6, 0 = Sunday], actions: [] }] }.
import { h, logActivity, toggle } from './ui.js';
import { actionCatalog, actionLabel } from './actions.js';
import { t } from './i18n.js';

export const DAYS = [[1, 'man'], [2, 'tir'], [3, 'ons'], [4, 'tor'], [5, 'fre'], [6, 'lør'], [0, 'søn']];
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const GAP_MS = 5 * 60 * 1000; // a longer gap = the pc slept: only the latest rule is run

export function scheduleSettings(ctx) {
  const s = (ctx.prefs.schedule ??= {});
  s.enabled ??= false;
  s.catchUp ??= true;
  s.rules ??= [];
  return s;
}

const parseAt = (at) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at || '');
  return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? [Number(m[1]), Number(m[2])] : null;
};

/** Every time a rule fires between two moments (ms, local time): [{ rule, at }] oldest first. */
export function occurrences(rules, from, to) {
  const out = [];
  const day = new Date(from); day.setHours(0, 0, 0, 0);
  for (let i = 0; i < 9 && day.getTime() <= to; i++, day.setDate(day.getDate() + 1)) {
    for (const rule of rules) {
      const hm = parseAt(rule.at);
      if (!hm || !(rule.days?.length ? rule.days : ALL_DAYS).includes(day.getDay()) || !rule.actions?.some(Boolean)) continue;
      const at = new Date(day); at.setHours(hm[0], hm[1], 0, 0);
      if (at.getTime() > from && at.getTime() <= to) out.push({ rule, at: at.getTime() });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The rules to run now, given when we last looked. After a long gap (sleep), only the latest. */
export function scheduleStep(rules, last, now) {
  const due = occurrences(rules, last, now);
  return now - last > GAP_MS ? due.slice(-1) : due;
}

/** The rule that fired most recently (within a week) – what "should" be in effect now. */
export function lastDue(rules, now) {
  return occurrences(rules, now - 7 * 864e5, now).at(-1) || null;
}

/** The next time a rule fires (within a week), or null. */
export function nextDue(rules, now) {
  return occurrences(rules, now, now + 7 * 864e5)[0] || null;
}

async function run(ctx, { rule }, atStart) {
  const ids = rule.actions.filter(Boolean);
  const t0 = Date.now();
  while (!ctx.conn.mixer && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 300));
  const what = ids.map((id) => actionLabel(ctx, id)).join(', ');
  logActivity(atStart ? `Tidsstyring kl. ${rule.at} (da appen startede) → ${what}` : `Tidsstyring kl. ${rule.at} → ${what}`);
  for (const id of ids) {
    try { await ctx.runAction(id, `tidsstyring kl. ${rule.at}`); } catch { /* next action */ }
  }
}

export function startSchedule(ctx) {
  let last = Date.now();
  let first = true;
  const tick = async () => {
    const s = scheduleSettings(ctx);
    const now = Date.now();
    if (s.enabled) {
      if (first && s.catchUp) {
        const hit = lastDue(s.rules, now);
        if (hit) await run(ctx, hit, true);
      } else if (!first) {
        for (const hit of scheduleStep(s.rules, last, now)) await run(ctx, hit, false);
      }
    }
    first = false;
    last = now;
    setTimeout(tick, 20000);
  };
  setTimeout(tick, 4000);
}

const fmtDay = (ms) => {
  const d = new Date(ms), today = new Date();
  const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 864e5);
  return t(diff === 0 ? 'i dag' : diff === 1 ? 'i morgen' : DAYS.find(([n]) => n === d.getDay())[1]);
};

export function scheduleCard(ctx, binder) {
  const s = scheduleSettings(ctx);
  const list = h('div', { class: 'list' });
  const next = h('div', { class: 'hint', 'data-testid': 'schedule-next', style: { marginTop: '8px' } });
  let catalog = [];
  const save = () => { ctx.savePrefs?.(); render(); };

  const actionSel = (arr, i) => {
    const known = catalog.some((g) => g.items.some((it) => it.id === arr[i]));
    return h('select', { class: 'trigger-sel', onchange: (e) => { if (e.target.value) arr[i] = e.target.value; else arr.splice(i, 1); save(); } },
      h('option', { value: '' }, '— ingen —'),
      arr[i] && !known ? h('option', { value: arr[i], selected: true }, actionLabel(ctx, arr[i])) : null,
      catalog.map((g) => h('optgroup', { label: g.title }, g.items.map((it) => h('option', { value: it.id, selected: it.id === arr[i] }, it.label)))));
  };
  const render = () => {
    list.replaceChildren(...s.rules.map((rule) => {
      rule.days ??= [...ALL_DAYS];
      rule.actions ??= [];
      const time = h('input', { type: 'time', value: rule.at, 'data-testid': 'schedule-time', 'aria-label': 'Klokken', onchange: (e) => { if (parseAt(e.target.value)) { rule.at = e.target.value; save(); } } });
      const days = h('div', { class: 'day-row' }, DAYS.map(([n, label]) => h('button', {
        class: `btn sm day ${rule.days.includes(n) ? 'on' : ''}`, 'aria-pressed': String(rule.days.includes(n)), 'data-testid': `schedule-day-${n}`,
        onclick: () => { rule.days = rule.days.includes(n) ? rule.days.filter((x) => x !== n) : [...rule.days, n]; save(); },
      }, label)));
      return h('div', { class: 'item schedule-rule', 'data-testid': 'schedule-rule' },
        h('div', { class: 'row', style: { flexWrap: 'wrap' } },
          h('span', { class: 'lbl app-lbl' }, 'Kl.'), time,
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn sm', title: 'Slet reglen', onclick: () => { s.rules.splice(s.rules.indexOf(rule), 1); save(); } }, '✕')),
        days,
        h('div', { class: 'row trigger-actions' }, h('span', { class: 'lbl app-lbl' }, 'Gør →'),
          ...rule.actions.map((_, i) => actionSel(rule.actions, i)),
          h('button', { class: 'btn sm', title: 'Tilføj en handling mere', 'data-testid': 'schedule-add-action', onclick: () => { rule.actions.push(''); render(); } }, rule.actions.length ? '+' : '+ Handling')));
    }));
    if (!s.rules.length) list.append(h('div', { class: 'hint' }, 'Ingen tider endnu.'));
    const n = nextDue(s.rules, Date.now());
    next.textContent = !s.enabled ? 'Tidsstyring er slået fra.' : n
      ? `Næste: ${fmtDay(n.at)} kl. ${n.rule.at} → ${n.rule.actions.filter(Boolean).map((id) => actionLabel(ctx, id)).join(', ')}`
      : 'Ingen tider med handlinger.';
  };
  const add = () => {
    // The first one suggests the evening; the next the morning after.
    const evening = !s.rules.some((r) => r.at === '22:00');
    const preset = evening ? ['eq-preset:Sen aften', 'hearing-cap:60'] : ['hearing-cap:off'];
    s.rules.push({ id: crypto.randomUUID(), at: evening ? '22:00' : '07:00', days: [...ALL_DAYS], actions: preset });
    save();
  };
  actionCatalog(ctx).then((c) => { catalog = c; render(); });
  render();
  return h('div', { class: 'card', 'data-testid': 'schedule-card' },
    h('h2', {}, 'Tidsstyring', h('button', { class: 'btn sm primary', 'data-testid': 'schedule-new', onclick: add }, '+ Ny')),
    toggle(binder, { label: 'Kør handlinger på bestemte tidspunkter', get: () => s.enabled, set: (v) => { s.enabled = v; save(); } }),
    toggle(binder, { label: 'Når appen starter: kør den seneste, der er gået', get: () => s.catchUp, set: (v) => { s.catchUp = v; save(); } }),
    list, next,
    h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Fx: kl. 22 → EQ-preset "Sen aften" og loft på hovedtelefonerne; kl. 7 → intet loft. Har pc’en sovet, køres kun den seneste tid, der er gået.'));
}
