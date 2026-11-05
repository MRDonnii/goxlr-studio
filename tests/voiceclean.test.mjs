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
  assert.equal(cfg.noise, 'isolate', 'new users start with Stemmeisolering');
  assert.equal(prefs.voiceClean, cfg);
  cfg.noise = 'off';
  assert.equal(voiceSettings(prefs), cfg, 'the same object every time');
  assert.equal(cfg.noise, 'off');
  cfg.noise = 'normal';
  const mics = [{ id: '{0.0.1.00000000}.{AAA}', name: 'Chat Mic (TC-Helicon GoXLR)', installed: true }, { id: 'x', name: 'Broadcast Stream Mix (TC-Helicon GoXLR)', installed: false }];
  assert.equal(pickChatMic(mics).id, mics[0].id);
  assert.equal(pickChatMic([{ id: 'w', name: 'Mikrofon (Webcam)' }]), null);
  Object.assign(cfg, { enabled: true, device: '{0.0.1.00000000}.{aaa}', noise: 'strong' });
  assert.deepEqual(micPayload(cfg, mics), { devices: [mics[0].id], echo: true, noise: 1, high_pass: true, isolate: false, amount: 1 });
  // Stemmeisolering: the Isolate parameter, with strong noise suppression for an older plugin.
  assert.deepEqual(micPayload({ ...cfg, noise: 'isolate' }, mics), { devices: [mics[0].id], echo: true, noise: 1, high_pass: true, isolate: true, amount: 1 });
  assert.equal(micPayload({ ...cfg, noise: 'isolate', amount: 'medium' }, mics).amount, 0.5);
  assert.equal(micPayload({ ...cfg, noise: 'isolate', amount: 'light' }, mics).amount, 0);
  assert.equal(micPayload({ ...cfg, noise: 'strong', amount: 'light' }, mics).amount, 1);
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
  assert.match(voiceStatusLine(cfg, { plugin: true, noise: true, isolate: 'running', echo: true, reference: true, erle_db: 20 }, { installed: true }).text, /^stemmeisolering kører · ekko dæmpes 20 dB$/);
  assert.match(voiceStatusLine(cfg, { plugin: true, noise: true, isolate: 'loading' }, { installed: true }).text, /starter/);
  assert.match(voiceStatusLine(cfg, { plugin: true, noise: true, isolate: 'unavailable' }, { installed: true }).text, /Stærk/);
});

test('the check finds what stops Ren mikrofon from working', async () => {
  const { voiceDiagnosis, diagnosisText } = await import('../public/js/voicemodel.js');
  const mic = { id: '{0.0.1.00000000}.{aaaa}', name: 'Chat Mic (TC-Helicon GoXLR)', installed: true, mode: 'sfx-mfx' };
  const cfg = { enabled: true, echo: true, noise: 'isolate' };
  const config = { devices: ['{AAAA}'], plugin: true, isolate: true };
  const discordOn = (device, active = true) => ({ device, pid: 1, exe: 'Discord.exe', active });
  const ok = { plugin: true, reference: true, isolate: 'running', in_db: -30.4, out_db: -58.2 };
  // Everything right.
  let d = voiceDiagnosis({ cfg, mic, check: { recordings: [discordOn(mic.id)], config }, status: ok });
  assert.equal(d.allGood, true, diagnosisText(d));
  assert.match(diagnosisText(d), /✓ Discord optager fra Chat Mic/);
  assert.match(diagnosisText(d), /ind -30 dB → ud -58 dB/);
  // Discord on another mic: the most likely reason teammates hear everything.
  d = voiceDiagnosis({ cfg, mic, check: { recordings: [discordOn('{0.0.1.00000000}.{webcam}')], config }, status: { plugin: false }, nameOf: () => 'Mikrofon (Webcam)' });
  assert.equal(d.allGood, false);
  assert.match(diagnosisText(d), /✗ Discord optager fra "Mikrofon \(Webcam\)"/);
  // Discord on Chat Mic but the plugin never starts: the engine is not loaded on the mic.
  d = voiceDiagnosis({ cfg, mic, check: { recordings: [discordOn(mic.id)], config }, status: { plugin: false } });
  assert.equal(d.items.find((i) => i.id === 'running').fix, 'mode');
  // Config without the mic part, and an old plugin.
  d = voiceDiagnosis({ cfg, mic, outdated: true, check: { recordings: [], config: { devices: [], plugin: false, isolate: false } }, status: null });
  assert.deepEqual(d.items.filter((i) => i.fix).map((i) => i.fix), ['update', 'apply']);
  assert.equal(d.items.find((i) => i.id === 'discord').ok, null);
  // Not installed / off.
  assert.equal(voiceDiagnosis({ cfg, mic: { ...mic, installed: false } }).items[0].fix, 'install');
  assert.equal(voiceDiagnosis({ cfg: { enabled: false }, mic }).allGood, false);
});

test('the check catches Discord getting the mic around the cleaner (0.14.2)', async () => {
  const { voiceDiagnosis, diagnosisText } = await import('../public/js/voicemodel.js');
  const mic = { id: '{0.0.1.00000000}.{aaaa}', name: 'Chat Mic (TC-Helicon GoXLR)', installed: true, mode: 'sfx-mfx', voice_programs: true };
  const cfg = { enabled: true, echo: false, noise: 'strong' };
  const config = { devices: ['{AAAA}'], plugin: true, isolate: false };
  const rec = (exe, device = mic.id, active = true) => ({ device, pid: 1, exe, active });
  const st = (instances) => ({ plugin: true, instances });
  // Each recording has its cleaner: proven, Discord's own suppression may go.
  let d = voiceDiagnosis({ cfg, mic, check: { recordings: [rec('Discord.exe')], config }, status: st(1) });
  assert.equal(d.allGood, true, diagnosisText(d));
  assert.match(diagnosisText(d), /✓ Discords optagelse bliver renset/);
  // Discord and OBS record, only one is cleaned: Discord goes around it.
  d = voiceDiagnosis({ cfg, mic, check: { recordings: [rec('Discord.exe'), rec('obs64.exe')], config }, status: st(1) });
  assert.equal(d.allGood, false);
  const bad = d.items.find((i) => i.id === 'cleaned');
  assert.equal(bad.ok, false);
  assert.equal(bad.fix, 'test');
  assert.match(bad.text, /Optager fra Chat Mic: 2 · renses: 1 – Discord får/);
  assert.match(bad.text, /Legacy/);
  // A paused recording does not count; another mic does not count.
  d = voiceDiagnosis({ cfg, mic, check: { recordings: [rec('Discord.exe'), rec('obs64.exe', mic.id, false), rec('x.exe', '{0.0.1.00000000}.{cam}')], config }, status: st(1) });
  assert.equal(d.items.find((i) => i.id === 'cleaned').ok, true);
  // Installed by 0.14.1: registered for normal recordings only → Opdatér.
  d = voiceDiagnosis({ cfg, mic: { ...mic, voice_programs: false }, check: { recordings: [], config }, status: null });
  assert.equal(d.items.find((i) => i.id === 'programs').fix, 'update');
  // The engine test's verdict.
  const streams = (communications, all_modes = true) => ({ streams: { default: true, communications, raw: true, all_modes, errors: [] } });
  d = voiceDiagnosis({ cfg, mic, check: { recordings: [], config }, status: null, test: streams(true) });
  assert.equal(d.items.find((i) => i.id === 'streams').ok, true);
  d = voiceDiagnosis({ cfg, mic, check: { recordings: [], config }, status: null, test: streams(false) });
  assert.match(d.items.find((i) => i.id === 'streams').text, /ikke renset.*Legacy/);
  // Rolled back by the test (Windows refused): no Opdatér that would not help.
  d = voiceDiagnosis({ cfg, mic: { ...mic, voice_programs: false }, check: { recordings: [], config }, status: null, test: streams(null, false) });
  assert.equal(d.items.find((i) => i.id === 'programs'), undefined);
  assert.match(d.items.find((i) => i.id === 'streams').text, /Windows afviste/);
  // Never tested and no count yet (plugin before 0.14.2): offer the test.
  d = voiceDiagnosis({ cfg, mic, check: { recordings: [], config }, status: { plugin: true, instances: null } });
  assert.equal(d.items.find((i) => i.id === 'streams').fix, 'test');
  // Old plugin (no count): the check works as before.
  d = voiceDiagnosis({ cfg, mic: { ...mic, voice_programs: undefined }, check: { recordings: [rec('Discord.exe')], config }, status: { plugin: true } });
  assert.equal(d.allGood, true, diagnosisText(d));
});

test('the newest mic test is used, and the count is smoothed', async () => {
  const { latestMicTest, smoothInstances } = await import('../public/js/voicemodel.js');
  const a = { at: 1, tests: [{ guid: '{AAAA}', capture: true, streams: { communications: false } }, { guid: '{out}', capture: false }] };
  const b = { at: 5, tests: [{ guid: '{aaaa}', capture: true, streams: { communications: true } }] };
  assert.equal(latestMicTest([a, b], '{0.0.1.00000000}.{aaaa}').streams.communications, true);
  assert.equal(latestMicTest([b, a, null], '{0.0.1.00000000}.{aaaa}').streams.communications, true);
  assert.equal(latestMicTest([a], '{0.0.1.00000000}.{bbbb}'), null);
  assert.equal(latestMicTest([null, undefined], 'x'), null);
  const hist = [];
  assert.equal(smoothInstances(hist, null, 0), null);
  assert.equal(smoothInstances(hist, 2, 1000), 2);
  // A program stopped: the count drops at once, the recordings list notices up to 3 s later.
  assert.equal(smoothInstances(hist, 1, 2000), 2);
  assert.equal(smoothInstances(hist, 1, 5500), 1);
  assert.equal(smoothInstances(hist, null, 9000), 1);
  assert.equal(smoothInstances(hist, null, 10000), null);
});

test('the mic test tells typing from the voice', async () => {
  const { micTestVerdict } = await import('../public/js/voicemodel.js');
  const s = (inDb, outDb) => ({ in_db: inDb, out_db: outDb });
  // Keys removed 40 dB, the voice untouched.
  let r = micTestVerdict({ typing: [s(-40, -80), s(-35, -75), s(-70, -90)], speech: [s(-25, -26), s(-30, -31), s(-28, -28), s(-60, -80)] });
  assert.equal(r.code, 'good');
  assert.equal(Math.round(r.typingCut), 40);
  assert.ok(r.voiceLoss <= 1);
  assert.match(r.lines.join(' '), /Tasterne dæmpes 40 dB.*uændret/);
  // Keys only dampened 7 dB (Stærk): weak.
  r = micTestVerdict({ typing: [s(-40, -47), s(-38, -45)], speech: [s(-25, -26)] });
  assert.equal(r.code, 'weak');
  assert.match(r.lines.join(' '), /Stemmeisolering/);
  // The voice cut by 15 dB.
  assert.equal(micTestVerdict({ typing: [s(-40, -80)], speech: [s(-45, -60), s(-44, -59)] }).code, 'voice-cut');
  // Nothing heard while typing (the GoXLR's gate), voice fine.
  assert.equal(micTestVerdict({ typing: [s(-90, -120)], speech: [s(-25, -25)] }).code, 'no-typing');
  assert.equal(micTestVerdict({ typing: [s(-80, -120)], speech: [s(-25, -25)] }).code, 'no-typing');
  // No speech, no sound at all.
  assert.equal(micTestVerdict({ typing: [s(-40, -80)], speech: [s(-80, -100)] }).code, 'no-speech');
  assert.equal(micTestVerdict({ typing: [{ in_db: null }], speech: [] }).code, 'not-running');
  // Styrke "Let" keeps the background 10 dB down on purpose: that is not weak.
  const light = { typing: [s(-40, -50), s(-38, -48)], speech: [s(-25, -25)] };
  assert.equal(micTestVerdict({ ...light, amount: 'light' }).code, 'good');
  assert.equal(micTestVerdict({ ...light, amount: 'full' }).code, 'weak');
  assert.match(micTestVerdict({ typing: [s(-40, -47)], speech: [s(-25, -25)], amount: 'medium' }).lines.join(' '), /Styrke på "Fuld"/);
  assert.match(micTestVerdict({ typing: [s(-40, -47)], speech: [s(-25, -25)], noise: 'strong' }).lines.join(' '), /Vælg Støjfjerner "Stemmeisolering"/);
  // Passed through untouched: the cause, not "choose Stemmeisolering".
  const through = { typing: [s(-40, -40)], speech: [s(-25, -25)] };
  assert.equal(micTestVerdict({ ...through, passing: 'rate' }).code, 'passing');
  assert.match(micTestVerdict({ ...through, passing: 'rate' }).lines[0], /48 kHz/);
  assert.match(micTestVerdict({ ...through, passing: 'broken' }).lines[0], /fejl/);
  // A very quiet voice (a user's GoXLR Mini: −55 dB while talking): cleaned, but turn the gain up.
  const quiet = micTestVerdict({ typing: [s(-60, -100)], speech: [s(-55, -55), s(-57, -57)] });
  assert.equal(quiet.code, 'good');
  assert.match(quiet.lines.join(' '), /meget svag \(-55 dB/);
  assert.doesNotMatch(micTestVerdict({ typing: [s(-40, -80)], speech: [s(-25, -25)] }).lines.join(' '), /svag/);
});

test('passing the mic through: only the cause is shown', async () => {
  const { voiceDiagnosis, voiceStatusLine } = await import('../public/js/voicemodel.js');
  const mic = { id: '{0.0.1.00000000}.{aaaa}', name: 'Chat Mic (TC-Helicon GoXLR)', installed: true, mode: 'sfx-mfx', voice_programs: true };
  const cfg = { enabled: true, echo: true, noise: 'isolate' };
  const config = { devices: ['{AAAA}'], plugin: true, isolate: true };
  const recordings = [{ device: mic.id, pid: 1, exe: 'Discord.exe', active: true }];
  for (const [flag, re] of [['bypassed', /48 kHz/], ['broken', /fejl/]]) {
    const status = { plugin: true, [flag]: true, instances: 1, in_db: -30, out_db: -30 };
    const d = voiceDiagnosis({ cfg, mic, check: { recordings, config }, status });
    const bad = d.items.filter((i) => i.ok === false);
    assert.equal(bad.length, 1, JSON.stringify(bad));
    assert.match(bad[0].text, re);
    assert.equal(d.items.find((i) => i.id === 'cleaned'), undefined);
    assert.equal(d.items.find((i) => i.id === 'isolate'), undefined);
    assert.equal(d.allGood, false);
    assert.match(voiceStatusLine(cfg, status, { installed: true }).text, re);
  }
});
