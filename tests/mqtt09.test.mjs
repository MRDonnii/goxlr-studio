import { test } from 'node:test';
import assert from 'node:assert/strict';

test('0.9.0: ChatMix, limiter, game mode and clips in Home Assistant', async () => {
  const { discoveryConfigs, stateMessages, parseCommand } = await import('../public/js/mqttmodel.js');
  const node = 'goxlr_abc123';
  const topics = [...discoveryConfigs({ node }).keys()];
  for (const o of ['number/goxlr_abc123/chatmix', 'switch/goxlr_abc123/mic_limiter', 'binary_sensor/goxlr_abc123/game_active', 'button/goxlr_abc123/clip_save']) assert.ok(topics.includes(`homeassistant/${o}/config`), o);
  const s = stateMessages(node, { connected: true, limiter: true, gameActive: false, chatMix: 35 });
  assert.equal(s['goxlr-studio/goxlr_abc123/mic_limiter/state'], 'ON');
  assert.equal(s['goxlr-studio/goxlr_abc123/game_active/state'], 'OFF');
  assert.equal(s['goxlr-studio/goxlr_abc123/chatmix/state'], '35');
  assert.deepEqual(parseCommand('goxlr-studio/goxlr_abc123/chatmix/set', '250', node), { kind: 'chatmix', value: 100 });
  assert.equal(parseCommand('goxlr-studio/goxlr_abc123/mic_limiter/set', 'ON', node).id, 'mic-limiter:on');
  assert.equal(parseCommand('goxlr-studio/goxlr_abc123/clip_save/set', 'PRESS', node).id, 'clip-save');
  assert.equal(parseCommand('goxlr-studio/goxlr_abc123/chatmix/set', 'x', node), null);
});
