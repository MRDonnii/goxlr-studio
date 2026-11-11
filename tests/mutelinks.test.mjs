import test from 'node:test';
import assert from 'node:assert/strict';
import { muteLinkStep, muteLinkSettings, faderOf } from '../public/js/mutelinks.js';

const fader = (channel, mute_state = 'Unmuted') => ({ channel, mute_state, mute_type: 'All' });
const mixer = (over = {}) => ({
  fader_status: { A: fader('Mic'), B: fader('Music'), C: fader('Chat'), D: fader('System'), ...over.faders },
  levels: { volumes: { Sample: 200, Game: 150, Music: 120, Chat: 180, ...over.volumes }, submix: over.submix ?? null },
});

test('settings have a list per mute button', () => {
  const p = {};
  assert.deepEqual(muteLinkSettings(p), { A: [], B: [], C: [], D: [] });
  assert.deepEqual(p.muteLinkSaved, {});
  assert.equal(faderOf(mixer(), 'Chat'), 'C');
  assert.equal(faderOf(mixer(), 'Sample'), null);
});

test('the Chat button also mutes Sample (no fader) and gives it back', () => {
  const links = { C: ['Sample'] };
  let s = muteLinkStep({}, mixer(), links);
  assert.deepEqual(s.commands, [], 'nothing on the first look');
  s = muteLinkStep(s, mixer({ faders: { C: fader('Chat', 'MutedToX') } }), links);
  assert.deepEqual(s.commands, [['SetVolume', 'Sample', 0]]);
  assert.deepEqual(s.saved, { Sample: { a: 200 } });
  // Still muted: nothing more.
  s = muteLinkStep(s, mixer({ faders: { C: fader('Chat', 'MutedToX') }, volumes: { Sample: 0 } }), links);
  assert.deepEqual(s.commands, []);
  s = muteLinkStep(s, mixer({ volumes: { Sample: 0 } }), links);
  assert.deepEqual(s.commands, [['SetVolume', 'Sample', 200]]);
  assert.deepEqual(s.saved, {});
});

test('a linked channel on another fader gets its mute button pressed', () => {
  const links = { C: ['Music'] };
  let s = muteLinkStep({}, mixer(), links);
  s = muteLinkStep(s, mixer({ faders: { C: fader('Chat', 'MutedToAll') } }), links);
  assert.deepEqual(s.commands, [['SetFaderMuteState', 'B', 'MutedToAll']]);
  s = muteLinkStep(s, mixer({ faders: { C: fader('Chat'), B: fader('Music', 'MutedToAll') } }), links);
  assert.deepEqual(s.commands, [['SetFaderMuteState', 'B', 'Unmuted']]);
});

test('with Submix, the headphones level (Mix B) is muted too', () => {
  const submix = { inputs: { Sample: { volume: 90, linked: false, ratio: 1 } }, outputs: { Headphones: 'B' } };
  const links = { C: ['Sample'] };
  let s = muteLinkStep({}, mixer({ submix }), links);
  s = muteLinkStep(s, mixer({ submix, faders: { C: fader('Chat', 'MutedToX') } }), links);
  assert.deepEqual(s.commands, [['SetVolume', 'Sample', 0], ['SetSubMixVolume', 'Sample', 0]]);
  const zero = { inputs: { Sample: { volume: 0, linked: false, ratio: 1 } }, outputs: { Headphones: 'B' } };
  s = muteLinkStep(s, mixer({ submix: zero, volumes: { Sample: 0 } }), links);
  assert.deepEqual(s.commands, [['SetVolume', 'Sample', 200], ['SetSubMixVolume', 'Sample', 90]]);
});

test('turned up by hand while muted: not put back; two buttons share a channel', () => {
  const links = { C: ['Sample'], D: ['Sample'] };
  let s = muteLinkStep({}, mixer(), links);
  s = muteLinkStep(s, mixer({ faders: { C: fader('Chat', 'MutedToX') } }), links);
  s = muteLinkStep(s, mixer({ faders: { C: fader('Chat', 'MutedToX'), D: fader('System', 'MutedToX') }, volumes: { Sample: 0 } }), links);
  assert.deepEqual(s.commands, [], 'already down');
  s = muteLinkStep(s, mixer({ faders: { D: fader('System', 'MutedToX') }, volumes: { Sample: 0 } }), links);
  assert.deepEqual(s.commands, [], 'the other button still holds it');
  s = muteLinkStep(s, mixer({ volumes: { Sample: 0 } }), links);
  assert.deepEqual(s.commands, [['SetVolume', 'Sample', 200]]);
  // By hand meanwhile:
  s = muteLinkStep(s, mixer({ faders: { C: fader('Chat', 'MutedToX') } }), links);
  s = muteLinkStep(s, mixer({ volumes: { Sample: 140 } }), links);
  assert.deepEqual(s.commands, []);
  assert.deepEqual(s.saved, {});
});

test('after a restart, a level saved while muted comes back once released', () => {
  const links = { C: ['Sample'] };
  const s = muteLinkStep({ saved: { Sample: { a: 170 } } }, mixer({ volumes: { Sample: 0 } }), links);
  assert.deepEqual(s.commands, [['SetVolume', 'Sample', 170]]);
  const still = muteLinkStep({ saved: { Sample: { a: 170 } } }, mixer({ faders: { C: fader('Chat', 'MutedToX') }, volumes: { Sample: 0 } }), links);
  assert.deepEqual(still.commands, []);
  assert.deepEqual(still.saved, { Sample: { a: 170 } });
});

test('a button never takes its own channel or an output along', () => {
  const links = { C: ['Chat', 'Headphones', 'Sample'] };
  let s = muteLinkStep({}, mixer(), links);
  s = muteLinkStep(s, mixer({ faders: { C: fader('Chat', 'MutedToX') } }), links);
  assert.deepEqual(s.commands, [['SetVolume', 'Sample', 0]]);
});

test('the first press after choosing channels is not missed', async () => {
  const { createMuteLinks } = await import('../public/js/mutelinks.js');
  const m = mixer();
  const sent = [];
  const ctx = { prefs: {}, conn: { mode: 'demo', serial: 'S', mixer: m, command: (...c) => sent.push(c) }, savePrefs() {} };
  const follow = createMuteLinks(ctx);
  follow(); // seen while nothing is linked
  ctx.prefs.muteLinks.C = ['Sample'];
  m.fader_status.C.mute_state = 'MutedToX';
  follow();
  assert.deepEqual(sent, [['SetVolume', 'Sample', 0]]);
});
