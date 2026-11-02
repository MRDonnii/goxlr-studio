import { test } from 'node:test';
import assert from 'node:assert/strict';
const { chatMixVolumes, chatMixLabel } = await import('../public/js/chatmix.js');

const base = { Chat: 200, Game: 180, Music: 100, System: 150 };
test('middle = normal, toward chat lowers the rest, toward game lowers chat', () => {
  assert.deepEqual(chatMixVolumes(base, 0, ['Game', 'Music']), { Chat: 200, Game: 180, Music: 100 });
  assert.deepEqual(chatMixVolumes(base, 50, ['Game', 'Music']), { Chat: 200, Game: 90, Music: 50 });
  assert.deepEqual(chatMixVolumes(base, -25, ['Game']), { Chat: 150, Game: 180 });
  assert.deepEqual(chatMixVolumes(base, 100, ['Game']), { Chat: 200, Game: 0 });
  assert.deepEqual(chatMixVolumes(base, 300, ['Game']), { Chat: 200, Game: 0 }, 'clamped');
  const all = chatMixVolumes(base, 70, ['Game', 'Music', 'System']);
  assert.ok(Object.entries(all).every(([ch, v]) => v <= base[ch]), 'never above normal');
});

test('labels', () => {
  assert.equal(chatMixLabel(0), 'Midt');
  assert.equal(chatMixLabel(-60), 'Spil 60 %');
  assert.equal(chatMixLabel(30), 'Chat 30 %');
});
