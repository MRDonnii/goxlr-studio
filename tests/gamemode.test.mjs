import { test } from 'node:test';
import assert from 'node:assert/strict';
const { gameStep, looksLikeGame, ignoreList, DEFAULT_IGNORE } = await import('../public/js/gamemode.js');

test('what counts as a game', () => {
  const ignore = ignoreList(DEFAULT_IGNORE);
  assert.ok(looksLikeGame({ fullscreen: true, exe: 'cod.exe' }, ignore));
  assert.ok(!looksLikeGame({ fullscreen: true, exe: 'Chrome.exe' }, ignore), 'a video in the browser');
  assert.ok(!looksLikeGame({ fullscreen: false, exe: 'cod.exe' }, ignore));
  assert.ok(!looksLikeGame({ fullscreen: true, exe: '' }, ignore));
  assert.deepEqual(ignoreList('a.exe, B.exe;c.exe  d.exe'), ['a.exe', 'b.exe', 'c.exe', 'd.exe']);
});

test('on and off only after two readings in a row', () => {
  const m = { active: false, exe: null, count: 0 };
  assert.deepEqual(gameStep(m, true, 'cod.exe'), {});
  assert.deepEqual(gameStep(m, true, 'cod.exe'), { enter: 'cod.exe' });
  assert.deepEqual(gameStep(m, true, 'cod.exe'), {});
  assert.deepEqual(gameStep(m, false, 'explorer.exe'), {}, 'alt+tab for a moment');
  assert.deepEqual(gameStep(m, true, 'cod.exe'), {});
  assert.deepEqual(gameStep(m, false, 'explorer.exe'), {});
  assert.deepEqual(gameStep(m, false, 'explorer.exe'), { exit: 'cod.exe' });
  assert.equal(m.active, false);
});
