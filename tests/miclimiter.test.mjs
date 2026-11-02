import { test } from 'node:test';
import assert from 'node:assert/strict';
const { compSnapshot, isLimited, limiterCommands, restoreCommands, setLimiter, limiterSettings } = await import('../public/js/miclimiter.js');

test('the limiter is 64:1 with 0 ms attack and keeps the make-up gain', () => {
  const cmds = limiterCommands(-8);
  assert.deepEqual(cmds.map((c) => c[0]), ['SetCompressorThreshold', 'SetCompressorRatio', 'SetCompressorAttack', 'SetCompressorReleaseTime']);
  assert.deepEqual(cmds.map((c) => c[1]), [-8, 14, 0, 9]);
  assert.ok(isLimited({ threshold: -8, ratio: 14, attack: 0 }, -8));
  assert.ok(isLimited({ threshold: -8, ratio: 'Ratio64_0', attack: 'Comp0ms' }, -8), 'names too');
  assert.ok(!isLimited({ threshold: -8, ratio: 8, attack: 0 }, -8));
  assert.ok(!isLimited(null, -8));
});

test('switching on saves the compressor, switching off puts it back', async () => {
  const sent = [];
  const mixer = { mic_status: { compressor: { threshold: -18, ratio: 'Ratio3_2', attack: 4, release: 11, makeup_gain: 4 } } };
  const ctx = { prefs: {}, conn: { mixer, command: async (...c) => { sent.push(c); } } };
  await setLimiter(ctx, true);
  assert.deepEqual(limiterSettings(ctx).saved, { threshold: -18, ratio: 8, attack: 4, release: 11, makeup_gain: 4 });
  assert.equal(sent.length, 4);
  Object.assign(mixer.mic_status.compressor, { threshold: -8, ratio: 14, attack: 0, release: 9 });
  await setLimiter(ctx, true);
  assert.equal(limiterSettings(ctx).saved.threshold, -18, 'on twice does not save the limiter as "yours"');
  sent.length = 0;
  await setLimiter(ctx, false);
  assert.deepEqual(sent, restoreCommands({ threshold: -18, ratio: 8, attack: 4, release: 11, makeup_gain: 4 }));
  assert.equal(limiterSettings(ctx).saved, null);
  assert.deepEqual(compSnapshot({ threshold: 1, ratio: 'Ratio2_0', attack: 'Comp5ms', release: 'Comp100ms', makeup_gain: 0 }), { threshold: 1, ratio: 6, attack: 4, release: 9, makeup_gain: 0 });
});
