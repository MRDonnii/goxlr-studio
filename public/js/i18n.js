// Danish / English. The app is written in Danish; in English, every Danish text that shows up in
// the window – pages, toasts, dialogs, tooltips, also texts from the Rust side – is replaced with
// its translation from i18n-en.js as it appears (a MutationObserver). Texts with values in them
// ("Kopieret til {0}") are patterns. Data (preset names, ids, settings) stays as it is; only what is
// shown changes. scripts/i18n-extract.py finds texts that are missing a translation.
import { EN, KEEP } from './i18n-en.js';

let lang = 'da';
let exact = new Map();
let patterns = [];
let cache = new Map();
let observer = null;

/** 'auto' → Danish on a Danish Windows, otherwise English. */
export function resolveLanguage(pref, navLangs = (typeof navigator !== 'undefined' ? navigator.languages || [navigator.language] : [])) {
  if (pref === 'da' || pref === 'en') return pref;
  return (navLangs || []).some((l) => /^da\b/i.test(l || '')) ? 'da' : 'en';
}

export const language = () => lang;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Builds the lookup tables from a { danish: english } dictionary. */
export function buildTables(dict, keep = []) {
  const ex = new Map();
  const pats = [];
  // Texts with values that read the same in English still need their numbers (2,5 → 2.5).
  const entries = [...Object.entries(dict), ...keep.filter((k) => /\{\d+\}/.test(k)).map((k) => [k, k])];
  for (const [rawDa, rawEn] of entries) {
    // The shown text is looked up without the spaces around it.
    const da = rawDa.trim();
    const en = rawEn?.trim();
    if (!en || (en === da && !/\{\d+\}/.test(da))) continue;
    if (/\{\d+\}/.test(da)) {
      const literal = da.replace(/\{\d+\}/g, '');
      const letters = literal.replace(/[^A-Za-zÆØÅæøå]/g, '').length;
      // Values and punctuation only would match anything; "{0} og {1}" would match half a sentence.
      if (letters < 2 || (/^\{\d+\}/.test(da) && /\{\d+\}$/.test(da) && letters < 6)) continue;
      const order = [];
      const re = new RegExp(`^${da.split(/(\{\d+\})/).map((part) => {
        const m = part.match(/^\{(\d+)\}$/);
        if (m) { order.push(Number(m[1])); return '([\\s\\S]*?)'; }
        return escapeRe(part);
      }).join('')}$`);
      pats.push({ re, order, en, weight: literal.length });
    } else {
      ex.set(da, en);
    }
  }
  pats.sort((a, b) => b.weight - a.weight);
  return { exact: ex, patterns: pats };
}

const NUMBER = /^[\s\d.,:%+−-]*(?:dB|Hz|kHz|ms|s|%)?\s*$/;
// "2,5 dB" → "2.5 dB": a decimal comma in front of a unit.
const DECIMAL = /(\d),(\d+)(?=\s?(?:dB|Hz|kHz|ms|%|bit|V)\b)/g;

/** English for one shown text (or the text itself when there is none). */
export function translateText(text, tables = { exact, patterns }) {
  const r = translateCore(text, tables);
  return typeof r === 'string' ? r.replace(DECIMAL, '$1.$2') : r;
}

function translateCore(text, tables, depth = 0) {
  if (!text || NUMBER.test(text)) return text;
  const lead = text.match(/^\s*/)[0];
  const trail = text.slice(lead.length).match(/\s*$/)[0];
  const core = text.slice(lead.length, text.length - trail.length);
  if (!core) return text;
  const hit = tables.exact.get(core);
  if (hit !== undefined) return lead + hit + trail;
  for (const p of tables.patterns) {
    const m = core.match(p.re);
    if (!m) continue;
    const values = {};
    p.order.forEach((n, i) => { values[n] = translateValue(m[i + 1], tables, depth); });
    return lead + p.en.replace(/\{(\d+)\}/g, (_, n) => values[n] ?? '') + trail;
  }
  // "+ EQ til/fra", "✓ Gemt": a symbol in front of a known text.
  const sym = core.match(/^([+✓✗✕⚠ℹ•→←·–-]\s+)(.+)$/s);
  if (sym) {
    const rest = translateCore(sym[2], tables, depth + 1);
    if (rest !== sym[2]) return lead + sym[1] + rest + trail;
  }
  // "Film / serier: Tydeligere dialog …": a name and a text, each known.
  const colon = core.indexOf(': ');
  if (colon > 0 && depth < 2) {
    const a = translateCore(core.slice(0, colon), tables, depth + 1);
    const b = translateCore(core.slice(colon + 2), tables, depth + 1);
    if (a !== core.slice(0, colon) || b !== core.slice(colon + 2)) return lead + a + ': ' + b + trail;
  }
  // "Ctrl + Alt + E → EQ til/fra": a key (or a name) and a known text.
  if (core.includes(' → ') && depth < 2) {
    const parts = core.split(' → ');
    const out = parts.map((x) => translateCore(x, tables, depth + 1));
    if (out.some((x, i) => x !== parts[i])) return lead + out.join(' → ') + trail;
  }
  // "Standard · Kommunikation": translate each part.
  if (core.includes(' · ')) {
    const parts = core.split(' · ');
    const out = parts.map((x) => translateCore(x, tables, depth + 1));
    if (out.some((x, i) => x !== parts[i])) return lead + out.join(' · ') + trail;
  }
  return text;
}

// A value inside a pattern: a known text is translated, a Danish decimal number gets a point.
function translateValue(v, tables, depth) {
  if (/^[\s\d,+−-]+$/.test(v)) return v.replace(/(\d),(\d)/g, '$1.$2');
  return depth < 2 ? translateCore(v, tables, depth + 1) : v;
}

/** For texts made in code that don't pass through the window (OSD, tray menu, tooltip). */
export function t(text) {
  if (lang !== 'en' || typeof text !== 'string') return text;
  let r = cache.get(text);
  if (r === undefined) {
    r = translateText(text);
    if (cache.size > 4000) cache = new Map();
    cache.set(text, r);
  }
  return r;
}

const ATTRS = ['title', 'placeholder', 'aria-label'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'CODE', 'PRE']);

function translateNode(node) {
  if (node.nodeType === 3) {
    const p = node.parentNode;
    if (!p || SKIP.has(p.nodeName) || p.closest?.('[data-no-i18n]')) return;
    const v = node.nodeValue;
    const r = t(v);
    if (r !== v) node.nodeValue = r;
    return;
  }
  if (node.nodeType !== 1 || SKIP.has(node.nodeName) && node.nodeName !== 'INPUT' && node.nodeName !== 'TEXTAREA') return;
  if (node.hasAttribute?.('data-no-i18n')) return;
  for (const a of ATTRS) {
    const v = node.getAttribute?.(a);
    if (v) { const r = t(v); if (r !== v) node.setAttribute(a, r); }
  }
  if (SKIP.has(node.nodeName)) return;
  for (let c = node.firstChild; c; c = c.nextSibling) translateNode(c);
}

/** Translates what is shown now and everything that appears later. */
export function setLanguage(l) {
  lang = l === 'en' ? 'en' : 'da';
  cache = new Map();
  if (typeof document !== 'undefined') document.documentElement.lang = lang;
  if (lang === 'en' && !exact.size) ({ exact, patterns } = buildTables(EN, KEEP));
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  observer?.disconnect();
  observer = null;
  if (lang !== 'en') return;
  translateNode(document.body);
  observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') translateNode(m.target);
      else if (m.type === 'attributes') translateNode(m.target);
      else for (const n of m.addedNodes) translateNode(n);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
