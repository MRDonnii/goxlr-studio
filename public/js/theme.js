// Udseende: light, dark and a few more themes, plus an optional accent colour. A theme is a set
// of CSS variables in style.css (:root[data-theme="…"]); "Automatisk" follows Windows' light/dark.
import { h } from './ui.js';

// Names: "Lyst"/"Mørkt" (not "Lys" – that is the Lighting page). [background, sidebar/panel, text, accent, accent-2] – for the little previews.
export const THEMES = [
  { id: 'auto', name: 'Automatisk (som Windows)' },
  { id: 'dark', name: 'Mørkt', colors: ['#0b0f17', '#121826', '#e6ebf5', '#22d3ee', '#a855f7'] },
  { id: 'light', name: 'Lyst', colors: ['#f3f5f9', '#ffffff', '#18202e', '#0891b2', '#7c3aed'] },
  { id: 'oled', name: 'Sort (OLED)', colors: ['#000000', '#0a0a0a', '#f2f2f2', '#22d3ee', '#a855f7'] },
  { id: 'nord', name: 'Nordlys', colors: ['#242933', '#2e3440', '#eceff4', '#88c0d0', '#b48ead'] },
  { id: 'sunset', name: 'Solnedgang', colors: ['#140d12', '#1e141b', '#f6e9ee', '#fb923c', '#ec4899'] },
  { id: 'forest', name: 'Skov', colors: ['#0b130f', '#111c16', '#e7f2ea', '#a3e635', '#2dd4bf'] },
  { id: 'paper', name: 'Papir', colors: ['#f6f1e7', '#fffdf8', '#2a241b', '#c2410c', '#0f766e'] },
];
export const ACCENTS = ['#22d3ee', '#3b82f6', '#8b5cf6', '#ec4899', '#f43f5e', '#fb923c', '#eab308', '#84cc16', '#10b981'];
const CACHE = 'studio.theme';
const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;

/** The theme to show: "auto" follows Windows (light → Lys, otherwise Mørk); unknown → Mørk. */
export function resolveTheme(pref, prefersLight = false) {
  if (!pref || pref === 'auto') return prefersLight ? 'light' : 'dark';
  return THEMES.some((t) => t.id === pref && t.id !== 'auto') ? pref : 'dark';
}

export function applyTheme({ theme = 'dark', accent = null } = {}) {
  const el = document.documentElement;
  const id = resolveTheme(theme, !!mq?.matches);
  if (id === 'dark') delete el.dataset.theme; else el.dataset.theme = id;
  if (accent) el.style.setProperty('--accent', accent); else el.style.removeProperty('--accent');
  try { localStorage.setItem(CACHE, JSON.stringify({ theme, accent })); } catch { /* blocked */ }
  window.dispatchEvent(new Event('studio-theme'));
}

/** Follow Windows when the theme is "Automatisk". */
export function watchTheme(ctx) {
  mq?.addEventListener('change', () => { if ((ctx.prefs.theme ?? 'dark') === 'auto') applyTheme(ctx.prefs); });
}

// The last theme straight away, before the settings are loaded (no dark flash on a light theme).
try { const c = JSON.parse(localStorage.getItem(CACHE) || 'null'); if (c) applyTheme(c); } catch { /* none */ }

export function appearanceCard(ctx) {
  const prefs = ctx.prefs;
  const grid = h('div', { class: 'theme-grid', 'data-testid': 'theme-grid' });
  const accents = h('div', { class: 'accent-row', 'data-testid': 'accent-row' });
  const set = (patch) => { Object.assign(prefs, patch); ctx.savePrefs?.(); applyTheme(prefs); render(); };
  const preview = (t) => {
    if (!t.colors) {
      // "Automatisk": half light, half dark.
      const half = (c) => h('div', { class: 'preview', style: { background: c[0] } }, h('div', { class: 'side', style: { background: c[1] } }),
        h('div', { class: 'main' }, h('div', { class: 'bar', style: { background: c[3], width: '70%' } }), h('div', { class: 'bar', style: { background: c[2], opacity: 0.5, width: '45%' } })));
      return h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr' } }, half(THEMES[2].colors), half(THEMES[1].colors));
    }
    const [bg, side, text, a1, a2] = t.colors;
    return h('div', { class: 'preview', style: { background: bg } }, h('div', { class: 'side', style: { background: side } }),
      h('div', { class: 'main' },
        h('div', { class: 'bar', style: { background: `linear-gradient(90deg, ${a1}, ${a2})`, width: '75%' } }),
        h('div', { class: 'bar', style: { background: text, opacity: 0.55, width: '55%' } }),
        h('div', { class: 'bar', style: { background: text, opacity: 0.3, width: '40%' } })));
  };
  const render = () => {
    const cur = prefs.theme ?? 'dark';
    grid.replaceChildren(...THEMES.map((t) => h('button', { class: `theme-card ${cur === t.id ? 'on' : ''}`, 'data-testid': `theme-${t.id}`, title: t.name, onclick: () => set({ theme: t.id }) },
      preview(t), h('span', { class: 'name' }, t.name))));
    accents.replaceChildren(
      h('button', { class: `accent-dot theme ${!prefs.accent ? 'on' : ''}`, title: 'Temaets egen', 'data-testid': 'accent-theme', onclick: () => set({ accent: null }) }),
      ...ACCENTS.map((c) => h('button', { class: `accent-dot ${prefs.accent === c ? 'on' : ''}`, style: { background: c }, title: c, 'data-testid': `accent-${c.slice(1)}`, onclick: () => set({ accent: c }) })));
  };
  render();
  return h('div', { class: 'card', 'data-testid': 'appearance-card' }, h('h2', {}, 'Udseende'),
    h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'Vælg et tema. "Automatisk" skifter mellem lys og mørk sammen med Windows.'),
    grid,
    h('div', { class: 'hint', style: { margin: '12px 0 6px' } }, 'Accentfarve (knapper, kurver og markeringer):'),
    accents);
}
