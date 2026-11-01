export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Binds keep an element in sync with daemon state without rebuilding the DOM.
export class Binder {
  constructor() { this.fns = []; }
  add(fn) { this.fns.push(fn); fn(); return fn; }
  run() { for (const fn of this.fns) fn(); }
}

export function throttle(fn, ms = 45) {
  let last = 0, timer = null, pendingArgs = null;
  const call = () => { last = Date.now(); timer = null; fn(...pendingArgs); };
  const t = (...args) => {
    pendingArgs = args;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) call();
    else if (!timer) timer = setTimeout(call, wait);
  };
  t.flush = () => { if (timer) { clearTimeout(timer); call(); } };
  return t;
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function setRangeFill(input) {
  const min = Number(input.min || 0), max = Number(input.max || 100);
  input.style.setProperty('--p', `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

// Slider that ignores daemon echoes while the user is dragging it.
export function slider(binder, { min, max, step = 1, get, set, fmt = (v) => v, label }) {
  const input = h('input', { type: 'range', min, max, step });
  const val = h('span', { class: 'val' });
  let active = false;
  const send = throttle((v) => set(v), 50);
  input.addEventListener('pointerdown', () => { active = true; });
  input.addEventListener('pointerup', () => { active = false; send.flush(); });
  input.addEventListener('input', () => {
    setRangeFill(input);
    val.textContent = fmt(Number(input.value));
    send(Number(input.value));
  });
  binder.add(() => {
    if (active) return;
    const v = get();
    if (v == null) return;
    input.value = v;
    setRangeFill(input);
    val.textContent = fmt(v);
  });
  return h('div', { class: 'row' }, label ? h('label', {}, label) : null, input, val);
}

export function toggle(binder, { get, set, label }) {
  const input = h('input', { type: 'checkbox' });
  input.addEventListener('change', () => set(input.checked));
  binder.add(() => { input.checked = !!get(); });
  const sw = h('label', { class: 'switch' }, input, h('span'));
  return label ? h('div', { class: 'row' }, h('label', {}, label), h('div', { class: 'spacer' }), sw) : sw;
}

export function segmented(binder, { options, get, set }) {
  const wrap = h('div', { class: 'seg' });
  const btns = options.map(([value, text]) => {
    const b = h('button', { onclick: () => set(value) }, text);
    wrap.append(b);
    return [value, b];
  });
  binder.add(() => { const v = get(); for (const [value, b] of btns) b.classList.toggle('on', value === v); });
  return wrap;
}

export function selectBox(binder, { options, get, set }) {
  const sel = h('select', { onchange: () => set(sel.value) }, options.map(([v, t]) => h('option', { value: v }, t)));
  binder.add(() => { const v = get(); if (v != null && document.activeElement !== sel) sel.value = v; });
  return sel;
}

// Recent errors for the diagnostics page.
export const errorLog = [];
// What the app did by itself or on request (preset switches and why, admin tasks …) – shown on
// Diagnose and included in "Kopiér rapport".
export const activityLog = [];
export function logActivity(msg) {
  activityLog.push({ at: new Date().toISOString(), msg: String(msg) });
  if (activityLog.length > 100) activityLog.shift();
}

// The same text shown again (e.g. one error per step of a slider) restarts its timer and counts up
// instead of stacking a new box for every repeat.
const openToasts = new Map();
export function toast(msg, kind = 'error') {
  const text = String(msg);
  if (kind === 'error') { errorLog.push({ at: new Date().toISOString(), msg: text }); if (errorLog.length > 50) errorLog.shift(); }
  const key = `${kind}|${text}`;
  const ms = kind === 'error' ? 6000 : 3000;
  const open = openToasts.get(key);
  if (open) {
    open.count += 1;
    open.badge.textContent = `×${open.count}`;
    clearTimeout(open.timer);
    open.timer = setTimeout(open.close, ms);
    return;
  }
  const badge = h('span', { class: 'toast-count' });
  const el = h('div', { class: `toast ${kind}` }, msg, badge);
  const entry = { count: 1, badge, timer: 0, close: () => { el.remove(); openToasts.delete(key); } };
  entry.timer = setTimeout(entry.close, ms);
  openToasts.set(key, entry);
  document.getElementById('toasts').append(el);
}

export const icon = (d) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.8');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.innerHTML = d;
  return el;
};

export const ICONS = {
  deck: '<rect x="3" y="5" width="5" height="5" rx="1"/><rect x="9.5" y="5" width="5" height="5" rx="1"/><rect x="16" y="5" width="5" height="5" rx="1"/><rect x="3" y="13" width="5" height="5" rx="1"/><rect x="9.5" y="13" width="5" height="5" rx="1"/><rect x="16" y="13" width="5" height="5" rx="1"/>',
  mixer: '<path d="M6 4v16M12 4v16M18 4v16"/><rect x="4" y="13" width="4" height="3" rx="1"/><rect x="10" y="7" width="4" height="3" rx="1"/><rect x="16" y="15" width="4" height="3" rx="1"/>',
  routing: '<circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 6c6 0 6 6 10 6M7 18c6 0 6-6 10-6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  eq: '<path d="M3 12c3 0 3-6 6-6s3 12 6 12 3-6 6-6"/>',
  fx: '<path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.3z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  scenes: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M8 4v5M16 4v5"/>',
  light: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  profile: '<path d="M4 5h16v14H4z"/><path d="M8 9h8M8 13h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  key: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  apps: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M17.5 14v7M14 17.5h7"/>',
  diag: '<path d="M3 12h4l2-5 4 10 2-5h6"/>',
  move: '<path d="M4 12h13M13 7l5 5-5 5"/><path d="M4 5v14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
};

// In-app dialogs instead of the browser's confirm()/prompt(): those block the whole window and
// cannot be driven by tests (mindre fejl 8, P1.4). Resolves true/false, or the text (null = cancel).
export function dialog({ title = '', text = '', input = null, ok = 'OK', cancel = 'Annullér', danger = false } = {}) {
  return new Promise((resolve) => {
    let field = null;
    if (input) {
      field = h(input.multiline ? 'textarea' : 'input', { class: 'dlg-input', 'data-testid': 'dialog-input', placeholder: input.placeholder || '', rows: input.multiline ? 10 : null });
      field.value = input.value || '';
    }
    const close = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const okBtn = h('button', { class: `btn sm ${danger ? 'danger on' : 'primary'}`, 'data-testid': 'dialog-ok', onclick: () => close(field ? field.value : true) }, ok);
    const cancelBtn = h('button', { class: 'btn sm', 'data-testid': 'dialog-cancel', onclick: () => close(field ? null : false) }, cancel);
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(field ? null : false); }
      else if (e.key === 'Enter' && !(field && input.multiline)) { e.preventDefault(); e.stopPropagation(); okBtn.click(); }
    };
    const overlay = h('div', { class: 'dlg-overlay', 'data-testid': 'dialog' },
      h('div', { class: 'dlg', role: 'dialog', 'aria-modal': 'true' },
        title ? h('h3', {}, title) : null,
        String(text).split('\n').filter((l) => l.trim()).map((l) => h('p', {}, l)),
        field,
        h('div', { class: 'row dlg-actions' }, cancelBtn, okBtn)));
    document.body.append(overlay);
    document.addEventListener('keydown', onKey, true);
    (field || okBtn).focus();
  });
}
export const confirmDialog = (text, opts = {}) => dialog({ text, ...opts });
export const promptDialog = (text, value = '', opts = {}) => dialog({ text, ...opts, input: { value, ...(opts.input || {}) } });
