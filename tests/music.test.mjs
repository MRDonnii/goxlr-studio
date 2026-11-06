import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaPrefs, timeText, livePosition, hideDelay, volumePct, volumeValue, songKey, CORNERS, SONG_CHANGE } from '../public/js/musicmodel.js';

test('media settings: defaults, and the old song message carries over', () => {
  assert.deepEqual(mediaPrefs({}), { card: true, songChange: 'off', corner: 'bottom-right', seconds: 6 });
  assert.equal(mediaPrefs({ media: { osd: true } }).songChange, 'text');
  assert.equal(mediaPrefs({ media: { osd: true, songChange: 'popup' } }).songChange, 'popup');
  const odd = mediaPrefs({ media: { corner: 'middle', seconds: 99, card: false } });
  assert.deepEqual([odd.corner, odd.seconds, odd.card], ['bottom-right', 6, false]);
  assert.deepEqual(SONG_CHANGE.map(([v]) => v), ['off', 'text', 'popup']);
  // Rust's musicpop::corner_position knows the same corners.
  assert.deepEqual(CORNERS.map(([c]) => c).sort(), ['bottom-left', 'bottom-right', 'top-left', 'top-right']);
});

test('times and progress', () => {
  assert.equal(timeText(0), '0:00');
  assert.equal(timeText(83_000), '1:23');
  assert.equal(timeText(3_723_000), '1:02:03');
  assert.equal(timeText(-5), '0:00');
  const np = { playing: true, position_ms: 10_000, duration_ms: 60_000 };
  assert.equal(livePosition(np, 2500), 12_500);
  assert.equal(livePosition({ ...np, playing: false }, 2500), 10_000, 'paused stays put');
  assert.equal(livePosition(np, 999_000), 60_000, 'never past the end');
  assert.equal(livePosition({ playing: true }, 1000), 0, 'unknown length');
});

test('the pop-up stays briefly on a song change, longer on a key', () => {
  assert.equal(hideDelay(true, 6), 6000);
  assert.equal(hideDelay(false, 6), 12_000);
  assert.equal(hideDelay(false, 10), 20_000);
});

test('the Music fader and the slider', () => {
  assert.equal(volumePct(255), 100);
  assert.equal(volumePct(128), 50);
  assert.equal(volumePct(300), 100);
  assert.equal(volumeValue(50), 128);
  assert.equal(volumeValue(-1), 0);
  for (const v of [0, 64, 191, 255]) assert.ok(Math.abs(volumeValue(volumePct(v)) - v) <= 2);
});

test('a new song has a new key (its cover is read again)', () => {
  const a = { available: true, app: 'Spotify', title: 'A', artist: 'X' };
  assert.notEqual(songKey(a), songKey({ ...a, title: 'B' }));
  assert.equal(songKey(a), songKey({ ...a, playing: false }));
  assert.equal(songKey({ available: false }), '');
});
