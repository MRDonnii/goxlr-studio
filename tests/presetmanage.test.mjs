import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyName, nameProblem, renamePreset, duplicatePreset, deletePresets, presetUses, replaceStrings, decodeText } from '../public/js/presetmanage.js';
import { parseApoConfigReport } from '../public/js/eq.js';

const eqState = () => ({
  presets: { Spil: { bands: [{ type: 'PK', freq: 100, gain: 2, q: 1 }] }, Musik: { bands: [] }, Film: { bands: [] } },
  presetName: 'Spil',
  profileLinks: { Headset: 'Spil', Speakers: 'Musik' },
  channelEq: { '*': { Game: 'Spil', Music: 'Musik' }, Headset: { Chat: 'Spil' } },
  appEq: [{ exe: 'game.exe', preset: 'Spil' }, { exe: 'player.exe', preset: 'Musik' }],
});

test('copy names count up', () => {
  assert.equal(copyName({ A: 1 }, 'A'), 'A (2)');
  assert.equal(copyName({ A: 1, 'A (2)': 1 }, 'A (2)'), 'A (3)');
});

test('name problems', () => {
  const p = { Spil: 1 };
  assert.ok(nameProblem(p, '  '));
  assert.ok(nameProblem(p, 'spil'));
  assert.equal(nameProblem(p, 'SPIL', 'Spil'), null, 'a case change of the same preset is fine');
  assert.ok(nameProblem(p, 'a|b'));
  assert.equal(nameProblem(p, 'Nyt'), null);
});

test('rename moves every reference and keeps the order', () => {
  const eq = eqState();
  const others = {
    hotkeys: [{ accel: 'F13', action: 'eq-preset:Spil' }, { accel: 'F14', action: 'eq-preset:Spil 2' }],
    pedals: [{ action: 'mute-mic', holdAction: 'eq-preset:Spil' }],
    deviceTriggers: [{ onConnect: ['profile:Headset', 'eq-preset:Spil'], onDisconnect: [] }],
    prefs: { schedule: { rules: [{ actions: ['eq-preset:Spil'] }] }, gameMode: { onEnter: ['eq-preset:Spil'] } },
  };
  const r = renamePreset(eq, 'Spil', 'FPS', others);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(eq.presets), ['FPS', 'Musik', 'Film']);
  assert.equal(eq.presetName, 'FPS');
  assert.equal(eq.profileLinks.Headset, 'FPS');
  assert.equal(eq.channelEq['*'].Game, 'FPS');
  assert.equal(eq.channelEq.Headset.Chat, 'FPS');
  assert.equal(eq.appEq[0].preset, 'FPS');
  assert.equal(others.hotkeys[0].action, 'eq-preset:FPS');
  assert.equal(others.hotkeys[1].action, 'eq-preset:Spil 2', 'only exact ids');
  assert.equal(others.pedals[0].holdAction, 'eq-preset:FPS');
  assert.deepEqual(others.deviceTriggers[0].onConnect, ['profile:Headset', 'eq-preset:FPS']);
  assert.deepEqual(others.prefs.schedule.rules[0].actions, ['eq-preset:FPS']);
  assert.deepEqual(others.prefs.gameMode.onEnter, ['eq-preset:FPS']);
  assert.equal(r.moved, 10);
});

test('rename refuses a taken name', () => {
  const eq = eqState();
  const r = renamePreset(eq, 'Spil', 'musik');
  assert.equal(r.ok, false);
  assert.ok(eq.presets.Spil);
  assert.equal(renamePreset(eq, 'Findes ikke', 'X').ok, false);
});

test('duplicate makes an independent copy', () => {
  const eq = eqState();
  const n = duplicatePreset(eq, 'Spil');
  assert.equal(n, 'Spil (2)');
  eq.presets[n].bands[0].gain = 9;
  assert.equal(eq.presets.Spil.bands[0].gain, 2);
  assert.equal(duplicatePreset(eq, 'Indbygget', { bands: [] }), 'Indbygget (2)');
});

test('delete removes links to the preset', () => {
  const eq = eqState();
  const gone = deletePresets(eq, ['Spil', 'Ukendt']);
  assert.deepEqual(gone, ['Spil']);
  assert.equal(eq.presetName, null);
  assert.deepEqual(eq.profileLinks, { Speakers: 'Musik' });
  assert.deepEqual(eq.channelEq, { '*': { Music: 'Musik' } });
  assert.deepEqual(eq.appEq, [{ exe: 'player.exe', preset: 'Musik' }]);
  deletePresets(eq, ['Musik', 'Film']);
  assert.deepEqual(eq.presets, {});
  assert.deepEqual(eq.channelEq, {});
});

test('uses are listed for the delete question', () => {
  const uses = presetUses(eqState(), 'Spil', { hotkeys: [{ action: 'eq-preset:Spil' }] });
  assert.equal(uses.length, 5);
  assert.deepEqual(presetUses(eqState(), 'Film'), []);
});

test('replaceStrings walks nested data', () => {
  const v = { a: ['x', { b: 'x', c: ['y', 'x'] }], d: 'x' };
  assert.equal(replaceStrings(v, 'x', 'z'), 4);
  assert.deepEqual(v, { a: ['z', { b: 'z', c: ['y', 'z'] }], d: 'z' });
});

test('Peace files in ANSI and UTF-16 are read and parsed', () => {
  // "Device: Højttalere …" with ø = 0xF8 (ANSI), as Peace writes it.
  const ansi = Uint8Array.from([...'Device: H'].map((c) => c.charCodeAt(0)).concat([0xf8], [...'jttalere\r\nPreamp: -4 dB\r\nFilter1: ON PK Fc 1000 Hz Gain 3 dB Q 1.41\r\n'].map((c) => c.charCodeAt(0))));
  const text = decodeText(ansi);
  assert.match(text, /Højttalere/);
  const { eq } = parseApoConfigReport(text);
  assert.equal(eq.preamp, -4);
  assert.equal(eq.bands.length, 1);
  const s = 'Preamp: -2 dB\r\nFilter 1: ON LSC Fc 100 Hz Gain 3 dB Q 0.7\r\n';
  const le = new Uint8Array(2 + s.length * 2);
  le.set([0xff, 0xfe]);
  for (let i = 0; i < s.length; i++) le[2 + i * 2] = s.charCodeAt(i);
  assert.equal(decodeText(le), s);
  assert.equal(decodeText(le.subarray(2)), s, 'UTF-16 without BOM');
  assert.equal(decodeText(new TextEncoder().encode('﻿Preamp: 1 dB ø')), 'Preamp: 1 dB ø');
  assert.equal(decodeText(new TextEncoder().encode('Preamp: 1 dB ø')), 'Preamp: 1 dB ø');
});
