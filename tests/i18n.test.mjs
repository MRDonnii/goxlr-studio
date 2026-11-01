import { test } from 'node:test';
import assert from 'node:assert/strict';
const i = await import('../public/js/i18n.js');
const { EN, KEEP } = await import('../public/js/i18n-en.js');

const tables = i.buildTables(EN, KEEP);
const tr = (s) => i.translateText(s, tables);

test('language: auto follows Windows (Danish → Danish, everything else → English)', () => {
  assert.equal(i.resolveLanguage('auto', ['da-DK']), 'da');
  assert.equal(i.resolveLanguage('auto', ['en-US', 'da']), 'da');
  assert.equal(i.resolveLanguage(undefined, ['de-DE']), 'en');
  assert.equal(i.resolveLanguage('en', ['da-DK']), 'en');
  assert.equal(i.resolveLanguage('da', ['en-US']), 'da');
});

test('exact texts, spaces around them kept', () => {
  assert.equal(tr('Indstillinger'), 'Settings');
  assert.equal(tr('  Lydtjek '), '  Sound check ');
  assert.equal(tr('Ikke en kendt tekst'), 'Ikke en kendt tekst');
  assert.equal(tr('-12 dB'), '-12 dB');
});

test('texts with values: patterns, known values translated, decimal comma → point', () => {
  assert.equal(tr('Headroom 2,5 dB'), 'Headroom 2.5 dB');
  assert.equal(tr('B er 3,1 dB højere – udlignet'), EN['{0} er {1} dB højere – udlignet'].replace('{0}', 'B').replace('{1}', '3.1'));
  assert.equal(tr('2 lyde tilføjet'), '2 sounds added');
  assert.equal(tr('H 3 dB'), 'R 3 dB');
});

test('every translation keeps its placeholders', () => {
  for (const [da, en] of Object.entries(EN)) {
    const ph = (s) => (s.match(/\{\d+\}/g) || []).sort().join();
    assert.equal(ph(en), ph(da), da);
  }
});

test('every UI text has an English translation (scripts/i18n-extract.py --missing is empty)', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('python3', ['scripts/i18n-extract.py', '--missing'], { encoding: 'utf8' });
  if (r.error) { t.skip('python3 mangler'); return; }
  const missing = Object.keys(JSON.parse(r.stdout || '{}'));
  assert.deepEqual(missing, [], 'Oversæt: python3 scripts/i18n-extract.py --missing → scripts/i18n-merge.py');
});
