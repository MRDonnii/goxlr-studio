import { test } from 'node:test';
import assert from 'node:assert/strict';
const { songText, songChanged, MEDIA_COMMANDS } = await import('../public/js/media.js');

test('the song text and when a new song is shown', () => {
  assert.equal(songText({ title: 'A', artist: 'B', app: 'Spotify' }), 'A – B');
  assert.equal(songText({ title: '', app: 'Spotify' }), 'Spotify');
  assert.ok(songChanged({ title: 'A', artist: 'B' }, { title: 'C', artist: 'B', playing: true }));
  assert.ok(!songChanged({ title: 'A', artist: 'B' }, { title: 'A', artist: 'B', playing: true }));
  assert.ok(!songChanged({ title: 'A' }, { title: 'C', playing: false }), 'not while paused');
  assert.deepEqual(MEDIA_COMMANDS.map(([c]) => c), ['previous', 'play-pause', 'next', 'stop']);
});
