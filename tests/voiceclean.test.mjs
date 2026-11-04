import test from 'node:test';
import assert from 'node:assert/strict';
import { faderGain, mutedOn, referenceSources, referencePayload, micPayload, pickChatMic, chatMicRoutes, voiceStatusLine, noteText, voiceSettings } from '../public/js/voicemodel.js';

const ROUTER = {
  Microphone: { Headphones: false, BroadcastMix: true, ChatMic: true, Sampler: true, LineOut: false },
  Chat: { Headphones: true, BroadcastMix: true, ChatMic: false, Sampler: true, LineOut: false },
  Music: { Headphones: true, BroadcastMix: true, ChatMic: true, Sampler: true, LineOut: false },
  Game: { Headphones: true, BroadcastMix: true, ChatMic: false, Sampler: true, LineOut: false },
  Console: { Headphones: true, BroadcastMix: true, ChatMic: false, Sampler: true, LineOut: false },
  LineIn: { Headphones: true, BroadcastMix: true, ChatMic: false, Sampler: true, LineOut: false },
  System: { Headphones: true, BroadcastMix: true, ChatMic: false, Sampler: true, LineOut: false },
  Samples: { Headphones: true, BroadcastMix: true, ChatMic: false, Sampler: false, LineOut: false },
};
const fader = (channel, mute_state = 'Unmuted', mute_type = 'All') => ({ channel, mute_state, mute_type });
const mixer = (over = {}) => ({
  router: structuredClone(ROUTER),
  levels: { volumes: { Mic: 200, System: 255, Game: 255, Chat: 128, Music: 200, Sample: 0, Console: 0, LineIn: 0, Headphones: 255, MicMonitor: 0, LineOut: 255 }, submix: null },
  fader_status: { A: fader('Mic'), B: fader('Chat'), C: fader('Game'), D: fader('System') },
  ...over,
});
const endpointOf = (ch) => `out-${ch.toLowerCase()}`;

test('fader gain follows the GoXLR fader, muted channels give 0', () => {
  assert.equal(faderGain(255), 1);
  assert.equal(faderGain(0), 0);
  assert.ok(Math.abs(20 * Math.log10(faderGain(128)) - -12) < 0.2);
  const m = mixer();
  assert.equal(mutedOn(m, 'Game', 'Headphones'), false);
  m.fader_status.C = fader('Game', 'MutedToX', 'ToPhones');
  assert.equal(mutedOn(m, 'Game', 'Headphones'), true);
  assert.equal(mutedOn(m, 'Game', 'LineOut'), false);
  m.fader_status.C = fader('Game', 'MutedToX', 'ToStream');
  assert.equal(mutedOn(m, 'Game', 'Headphones'), false);
  m.fader_status.C = fader('Game', 'MutedToAll', 'ToStream');
  assert.equal(mutedOn(m, 'Game', 'Headphones'), true);
});

test('the reference is the channels on the speaker output, weighted, without what goes to the chat', () => {
  const m = mixer();
  const { sources, notes } = referenceSources(m, 'Headphones', endpointOf);
  assert.deepEqual(sources.map((s) => s.channel), ['System', 'Game', 'Chat', 'Sample']);
  assert.equal(sources.find((s) => s.channel === 'Game').gain, 1);
  assert.ok(Math.abs(sources.find((s) => s.channel === 'Chat').gain - faderGain(128)) < 1e-3);
  assert.equal(sources.find((s) => s.channel === 'Sample').gain, 0, 'fader at 0');
  // Music is sent to the Chat Mic on purpose: not in the reference, but noted.
  assert.deepEqual(notes, [{ code: 'to-chat', channel: 'Music' }]);
  // Muted to the headphones: still captured (so it is ready), with gain 0.
  m.fader_status.C = fader('Game', 'MutedToX', 'ToPhones');
  assert.equal(referenceSources(m, 'Headphones', endpointOf).sources.find((s) => s.channel === 'Game').gain, 0);
  // The master volume of the output scales everything.
  m.levels.volumes.Headphones = 128;
  assert.ok(Math.abs(referenceSources(m, 'Headphones', endpointOf).sources.find((s) => s.channel === 'System').gain - faderGain(128)) < 1e-3);
  // Nothing routed to Line Out.
  assert.deepEqual(referenceSources(m, 'LineOut', endpointOf).sources, []);
});

test('submix B, missing outputs and sounds the echo canceller cannot remove are handled', () => {
  const m = mixer();
  m.levels.submix = { inputs: { Game: { volume: 64, linked: false } }, outputs: { Headphones: 'B', LineOut: 'A' } };
  assert.ok(Math.abs(referenceSources(m, 'Headphones', endpointOf).sources.find((s) => s.channel === 'Game').gain - faderGain(64)) < 1e-3);
  const none = referenceSources(m, 'Headphones', (ch) => (ch === 'Game' ? 'out-game' : null));
  assert.ok(none.notes.some((n) => n.code === 'no-endpoint' && n.channel === 'System'));
  m.router.Microphone.Headphones = true;
  m.levels.volumes.MicMonitor = 100;
  m.levels.volumes.Console = 200;
  const codes = referenceSources(m, 'Headphones', endpointOf).notes.map((n) => n.code);
  assert.ok(codes.includes('mic-monitor') && codes.includes('hardware-input'));
  assert.ok(noteText({ code: 'to-chat', channel: 'Music' }).startsWith('Musik sendes'));
  assert.deepEqual(chatMicRoutes(m), ['Music']);
});

test('speakers on another output: that output is the reference', () => {
  assert.deepEqual(referenceSources(null, 'out-realtek', endpointOf), { sources: [{ device: 'out-realtek', gain: 1, channel: null }], notes: [] });
  assert.deepEqual(referenceSources(null, null, endpointOf).notes, [{ code: 'no-speakers' }]);
  assert.deepEqual(referenceSources(null, 'Headphones', endpointOf).notes, [{ code: 'no-goxlr' }]);
});

test('payloads: the mic part only on a microphone with the engine, the reference only with echo on', () => {
  const prefs = {};
  const cfg = voiceSettings(prefs);
  assert.equal(cfg.enabled, false);
  assert.equal(prefs.voiceClean, cfg);
  cfg.noise = 'off';
  assert.equal(voiceSettings(prefs), cfg, 'the same object every time');
  assert.equal(cfg.noise, 'off');
  cfg.noise = 'normal';
  const mics = [{ id: '{0.0.1.00000000}.{AAA}', name: 'Chat Mic (TC-Helicon GoXLR)', installed: true }, { id: 'x', name: 'Broadcast Stream Mix (TC-Helicon GoXLR)', installed: false }];
  assert.equal(pickChatMic(mics).id, mics[0].id);
  assert.equal(pickChatMic([{ id: 'w', name: 'Mikrofon (Webcam)' }]), null);
  Object.assign(cfg, { enabled: true, device: '{0.0.1.00000000}.{aaa}', noise: 'strong' });
  assert.deepEqual(micPayload(cfg, mics), { devices: [mics[0].id], echo: true, noise: 1, high_pass: true });
  assert.equal(micPayload(cfg, [{ ...mics[0], installed: false }]), null);
  assert.equal(micPayload({ ...cfg, enabled: false }, mics), null);
  // "Fang alt" held: everything comes through untouched.
  assert.equal(micPayload(cfg, mics, { openMicHeld: true }), null);
  const ref = referencePayload(cfg, mixer(), endpointOf);
  assert.equal(ref.enabled, true);
  assert.deepEqual(Object.keys(ref.sources[0]), ['device', 'gain']);
  assert.deepEqual(referencePayload({ ...cfg, echo: false }, mixer(), endpointOf), { enabled: true, sources: [] });
  assert.deepEqual(referencePayload({ ...cfg, enabled: false }, mixer(), endpointOf), { enabled: false, sources: [] });
});

test('status line tells what is happening', () => {
  const cfg = { enabled: true };
  assert.equal(voiceStatusLine({ enabled: false }, null).level, 'off');
  assert.equal(voiceStatusLine(cfg, null).level, 'warn');
  assert.equal(voiceStatusLine(cfg, { plugin: false }, { installed: true }).level, 'idle');
  assert.match(voiceStatusLine(cfg, { plugin: true, echo: true, noise: true, reference: true, erle_db: 23.4 }, { installed: true }).text, /støjfjerner kører · ekko dæmpes 23 dB/);
  const noRef = voiceStatusLine(cfg, { plugin: true, echo: true, reference: false }, { installed: true });
  assert.equal(noRef.level, 'warn');
  assert.match(voiceStatusLine(cfg, { plugin: true, bypassed: true }, { installed: true }).text, /48 kHz/);
});
