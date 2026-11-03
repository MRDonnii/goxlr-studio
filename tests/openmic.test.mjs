import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMicCommands, restoreCommands, openMicDown, openMicUp, restoreOpenMic } from '../public/js/openmic.js';
import { HOLD_ACTIONS } from '../public/js/pedals.js';

const mic = (gate = true, gain = 40) => ({ noise_gate: { enabled: gate, threshold: -30 }, mic_type: 'Dynamic', mic_gains: { Dynamic: gain, Condenser: 30, Jack: 20 } });

test('gate off while held, back on after', () => {
  const { press, saved } = openMicCommands(mic());
  assert.deepEqual(press, [['SetGateActive', false]]);
  assert.deepEqual(restoreCommands(saved), [['SetGateActive', true]]);
});

test('a gate that is already off is left alone', () => {
  const { press, saved } = openMicCommands(mic(false));
  assert.deepEqual(press, []);
  assert.deepEqual(restoreCommands(saved), []);
});

test('gain boost is capped at 72 dB and restored', () => {
  const { press, saved } = openMicCommands(mic(true, 68), { boost: 6 });
  assert.deepEqual(press, [['SetGateActive', false], ['SetMicrophoneGain', 'Dynamic', 72]]);
  assert.deepEqual(restoreCommands(saved), [['SetGateActive', true], ['SetMicrophoneGain', 'Dynamic', 68]]);
  assert.deepEqual(openMicCommands(mic(true, 72), { boost: 6 }).press, [['SetGateActive', false]]);
});

test('held key repeats once; release puts the mic back; a leftover is restored at start', () => {
  const sent = [];
  const ctx = { prefs: {}, savePrefs() {}, notify() {}, conn: { mixer: { mic_status: mic(true, 40) }, command: (...c) => sent.push(c) } };
  ctx.prefs.openMic = { boost: 3 };
  openMicDown(ctx); openMicDown(ctx);
  assert.deepEqual(sent, [['SetGateActive', false], ['SetMicrophoneGain', 'Dynamic', 43]]);
  openMicUp(ctx); openMicUp(ctx);
  assert.deepEqual(sent.slice(2), [['SetGateActive', true], ['SetMicrophoneGain', 'Dynamic', 40]]);
  assert.equal(ctx.prefs.openMic.saved, undefined);
  ctx.prefs.openMic.saved = { gate: true, type: 'Dynamic', gain: null };
  restoreOpenMic(ctx);
  assert.deepEqual(sent.slice(4), [['SetGateActive', true]]);
});

test('foot pedals can hold "Fang alt"', () => {
  assert.ok(HOLD_ACTIONS.some(([id]) => id === 'hold:open-mic'));
});
