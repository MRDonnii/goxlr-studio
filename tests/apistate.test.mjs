import { test } from 'node:test';
import assert from 'node:assert/strict';
const { activeActions } = await import('../public/js/apistate.js');

test('which actions are on', () => {
  const mixer = {
    cough_button: { state: 'MutedToX' },
    fader_status: { A: { mute_state: 'Unmuted' }, B: { mute_state: 'MutedToAll' } },
    profile_name: 'Stream', mic_profile_name: 'SM7B',
    effects: { is_enabled: false }, sampler: { active_bank: 'B' },
    router: { Music: { BroadcastMix: false } },
  };
  const a = activeActions({ mixer, eq: { enabled: true, preset: 'Musik', crossfeed: true }, limiter: true, chatMix: { enabled: true, position: 40 }, media: { playing: true } });
  for (const id of ['mute-mic', 'cough:MutedToX', 'mute-fader:B', 'profile:Stream', 'micprofile:SM7B', 'sampler-bank:B', 'stream-safe-music', 'eq-toggle', 'eq-preset:Musik', 'crossfeed-toggle', 'mic-limiter', 'chatmix:chat', 'media:play-pause']) assert.ok(a.includes(id), id);
  for (const id of ['mute-fader:A', 'fx-toggle', 'cough:Unmuted', 'loudness-toggle']) assert.ok(!a.includes(id), id);
  assert.deepEqual(activeActions(null), []);
  assert.ok(activeActions({ mixer: { cough_button: { state: 'Unmuted' } } }).includes('cough:Unmuted'));
});
