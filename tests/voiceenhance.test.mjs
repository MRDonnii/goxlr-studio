import { test } from 'node:test';
import assert from 'node:assert/strict';
const { enhanceCommands, ENHANCERS } = await import('../public/js/voiceenhance.js');

test('an enhancer adds its dB and takes exactly that away again', () => {
  const body = ENHANCERS.find((e) => e.id === 'body');
  const gains = { Equalizer125Hz: 0, Equalizer250Hz: -1 };
  const on = enhanceCommands(gains, body, false, 1);
  assert.deepEqual(on, [['SetEqGain', 'Equalizer125Hz', 2], ['SetEqGain', 'Equalizer250Hz', 0]]);
  const after = Object.fromEntries(on.map(([, b, v]) => [b, v]));
  assert.deepEqual(enhanceCommands(after, body, false, -1).map((c) => c[2]), [0, -1]);
  assert.deepEqual(enhanceCommands({ Equalizer125Hz: 8 }, body, false, 1)[0], ['SetEqGain', 'Equalizer125Hz', 9], 'never above +9');
  assert.equal(enhanceCommands({}, body, true, 1)[0][0], 'SetEqMiniGain');
});
