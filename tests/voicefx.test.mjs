import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VOICE_FX, fxSettings, fxCommand, fxAction, fxNow, fxStatusText } from '../public/js/voicefx.js';

test('the effects match the plugin (fx.rs Effect::from_id)', () => {
  const rs = readFileSync(new URL('../plugins/voiceclean/src/fx.rs', import.meta.url), 'utf8');
  const ids = [...rs.matchAll(/(\d+) => Effect::(\w+),/g)].map((m) => Number(m[1]));
  assert.deepEqual(VOICE_FX.map((e) => e.n), ids);
  assert.equal(new Set(VOICE_FX.map((e) => e.id)).size, VOICE_FX.length);
});

test('command: effect number + how much, only when on', () => {
  const s = fxSettings({});
  assert.deepEqual(s, { enabled: false, active: null, mix: 100 });
  s.active = 'robot';
  assert.equal(fxCommand(s), 0, 'off');
  s.enabled = true;
  assert.equal(fxCommand(s), 5 | (100 << 8));
  s.mix = 40;
  assert.equal(fxCommand(s), 5 | (40 << 8));
  s.mix = 0;
  assert.equal(fxCommand(s) >> 8, 1, 'at least 1 %');
  s.mix = 100;
  // Held on a key: wins over the chosen one, and works with none chosen.
  assert.equal(fxCommand(s, 'deep') & 0xff, 1);
  s.active = null;
  assert.equal(fxCommand(s), 0);
  assert.equal(fxCommand(s, 'echo') & 0xff, 9);
  assert.equal(fxNow(s, 'echo').label, 'Ekko');
  assert.equal(fxCommand(s, 'nope'), 0);
});

test('actions choose, toggle and turn on', () => {
  const s = fxSettings({});
  assert.deepEqual(fxAction(s, 'robot'), { enable: true });
  assert.equal(s.enabled, true);
  assert.equal(s.active, 'robot');
  assert.deepEqual(fxAction(s, 'robot'), { enable: false });
  assert.equal(s.active, null, 'the same again = off');
  fxAction(s, 'deep');
  fxAction(s, 'radio');
  assert.equal(s.active, 'radio');
  fxAction(s, 'off');
  assert.equal(s.active, null);
  assert.equal(s.enabled, true, 'off keeps Stemmeskifter ready');
  fxAction(s, 'unknown');
  assert.equal(s.active, null);
});

test('status line', () => {
  const s = { enabled: true, active: 'robot', mix: 100 };
  assert.equal(fxStatusText({ enabled: false }, null, {}), 'Slået fra');
  assert.match(fxStatusText(s, null, { installed: false }), /ikke sat på/);
  assert.match(fxStatusText(s, null, { installed: true, outdated: true }), /opdateres/);
  assert.equal(fxStatusText(s, { plugin: true, fx: true }, { installed: true }), 'Robot kører');
  assert.match(fxStatusText(s, null, { installed: true }), /starter, når/);
  assert.match(fxStatusText({ ...s, active: null }, null, { installed: true }), /vælg en stemme/);
  assert.equal(fxStatusText({ ...s, active: null }, { plugin: true, fx: true }, { installed: true, held: 'deep' }), 'Dyb kører');
});

test('fxTarget: the mic Ren mikrofon uses, else the GoXLR Chat Mic', async () => {
  const { fxTarget } = await import('../public/js/voicefx.js');
  const mics = [
    { id: '{A}', name: 'Mikrofon (USB Webcam)', installed: false },
    { id: '{B}', name: 'Chat Mic (TC-Helicon GoXLR)', installed: true },
  ];
  assert.deepEqual(fxTarget(null, mics), { mic: mics[1], installed: true });
  assert.deepEqual(fxTarget('{a}', mics), { mic: mics[0], installed: false });
  assert.deepEqual(fxTarget('{gone}', mics), { mic: mics[1], installed: true });
  assert.deepEqual(fxTarget(null, []), { mic: null, installed: false });
});
