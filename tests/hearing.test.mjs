import { test } from 'node:test';
import assert from 'node:assert/strict';
const hr = await import('../public/js/hearing.js').catch(() => null);

test('høreværn: loud listening adds up, quiet lets the ears recover', { skip: !hr }, () => {
  const o = { threshold: 80, minutes: 1 };
  let s = hr.exposureStep(0, { ...o, pct: 90, playing: true, dt: 30 });
  assert.deepEqual(s, { loud: 30, remind: false });
  s = hr.exposureStep(s.loud, { ...o, pct: 90, playing: false, dt: 5 });
  assert.equal(s.loud, 20);
  s = hr.exposureStep(s.loud, { ...o, pct: 70, playing: true, dt: 5 });
  assert.equal(s.loud, 10);
  s = hr.exposureStep(50, { ...o, pct: 85, playing: true, dt: 10 });
  assert.deepEqual(s, { loud: 0, remind: true });
});

test('høreværn: the ceiling only turns down', { skip: !hr }, () => {
  assert.equal(hr.capVolume(255, { cap: true, max: 80 }), 204);
  assert.equal(hr.capVolume(150, { cap: true, max: 80 }), null);
  assert.equal(hr.capVolume(255, { cap: false, max: 80 }), null);
});
