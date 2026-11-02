import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { THEMES, resolveTheme } = await import('../public/js/theme.js');

test('"Automatisk" follows Windows; unknown themes fall back to Mørkt', () => {
  assert.equal(resolveTheme('auto', true), 'light');
  assert.equal(resolveTheme('auto', false), 'dark');
  assert.equal(resolveTheme('nord'), 'nord');
  assert.equal(resolveTheme('nope'), 'dark');
  assert.equal(resolveTheme(undefined), 'dark');
});

test('every theme sets every colour variable of the default', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
  const vars = [...root.matchAll(/(--[a-z0-9-]+):\s*#/g)].map((m) => m[1]);
  assert.ok(vars.length > 20);
  for (const t of THEMES.filter((x) => x.colors && x.id !== 'dark')) {
    const block = css.match(new RegExp(`:root\\[data-theme="${t.id}"\\] \\{([^}]*)\\}`))?.[1];
    assert.ok(block, t.id);
    for (const v of vars) assert.ok(block.includes(`${v}:`), `${t.id} misses ${v}`);
  }
});
