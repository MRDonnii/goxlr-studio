import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandResponse, expandBand, setSlope, slopeValue } from '../public/js/eq.js';
import { exportPresets, importPresets } from '../public/js/extras.js';

test('Linkwitz-Riley is −6 dB at the crossover and has the right slope', () => {
  for (const slope of [12, 24, 48]) {
    for (const type of ['HP', 'LP']) {
      const b = { enabled: true, type, freq: 1000, gain: 0, q: 0.707, slope, lr: true };
      const [atFc, octAway] = bandResponse(b, [1000, type === 'HP' ? 250 : 4000]);
      assert.ok(Math.abs(atFc + 6.02) < 0.15, `${type} LR${slope} at Fc: ${atFc}`);
      // Two octaves away: about 2 × slope down.
      assert.ok(Math.abs(octAway + 2 * slope) < 4, `${type} LR${slope} 2 oct: ${octAway}`);
    }
  }
  assert.equal(expandBand({ type: 'HP', freq: 80, slope: 24, lr: true, q: 1 }).length, 2);
  assert.equal(expandBand({ type: 'HP', freq: 80, slope: 48, lr: true, q: 1 }).length, 4);
  assert.equal(expandBand({ type: 'LP', freq: 80, slope: 12, lr: true, q: 1 })[0].q, 0.5);
  // Butterworth stays −3 dB at Fc.
  assert.ok(Math.abs(bandResponse({ type: 'HP', freq: 1000, slope: 24, q: 0.707 }, [1000])[0] + 3.01) < 0.1);
});

test('slope choices and presets keep LR', () => {
  const b = { type: 'HP', freq: 80, q: 0.707 };
  setSlope(b, 'lr24');
  assert.deepEqual([b.lr, b.slope, slopeValue(b)], [true, 24, 'lr24']);
  setSlope(b, '12');
  assert.equal(b.lr, undefined);
  assert.equal(b.slope, undefined);
  setSlope(b, 'lr12');
  const file = exportPresets({ Sub: { enabled: true, preamp: 0, bands: [b] } });
  const back = importPresets({}, file).presets.Sub.bands[0];
  assert.equal(back.lr, true);
  assert.equal(back.slope, 12);
});
