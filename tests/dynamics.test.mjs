import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dynamicsParams, dynamicsPayload, DYN_MODES } from '../public/js/dynamicsmodel.js';
import { enginePayload } from '../public/js/extras.js';

// The plugin's own mapping (plugins/dynamics/src/lib.rs, map::*), to check the round trip.
const fromN = (p) => ({
  threshold: -40 + 40 * p[0], ratio: 1 + 19 * p[1], attack: 0.1 * 1000 ** p[2], release: 10 * 200 ** p[3],
  makeup: 24 * p[4], limiter: p[5] >= 0.5, ceiling: -12 + 12 * p[6], limRelease: 1000 ** p[7],
});

test('every mode survives the trip to the plugin and back', () => {
  for (const m of Object.values(DYN_MODES)) {
    const back = fromN(dynamicsParams(m));
    for (const k of ['threshold', 'ratio', 'makeup', 'ceiling']) assert.ok(Math.abs(back[k] - m[k]) < 0.01, `${k} ${back[k]} ${m[k]}`);
    for (const k of ['attack', 'release', 'limRelease']) assert.ok(Math.abs(back[k] / m[k] - 1) < 0.005, `${k} ${back[k]} ${m[k]}`);
    assert.equal(back.limiter, true);
  }
  // The same vector the Rust test checks (app_values_mean_what_the_app_thinks).
  assert.deepEqual(dynamicsParams(DYN_MODES.night), [0.2, 0.1579, 0.5663, 0.6419, 0.4167, 1, 0.9167, 0.6344]);
});

test('values are clamped and the payload is only there when on', () => {
  const p = dynamicsParams({ threshold: -99, ratio: 50, attack: 0.001, release: 99999, makeup: -5, ceiling: 3, limRelease: 0, limiter: false });
  assert.deepEqual(p, [0, 1, 0, 1, 0, 0, 1, 0]);
  assert.equal(dynamicsPayload({ enabled: false }), null);
  assert.equal(dynamicsPayload({ enabled: true, ceiling: -3 }).params[6], 0.75);
  const eng = enginePayload({ enabled: true, preamp: 0, bands: [] }, { dynamics: { enabled: true, ...DYN_MODES.limiter } });
  assert.equal(eng.dynamics.params.length, 8);
  assert.equal(enginePayload({ enabled: true, preamp: 0, bands: [] }, {}).dynamics, null);
});
