import { test } from 'node:test';
import assert from 'node:assert/strict';
const { createLevelMeter, levelCuts, levelOffsets, MAX_CUT } = await import('../public/js/levelmatch.js');
const { engineConfig } = await import('../public/js/channeleq.js');

test('the meter counts only while a channel plays', () => {
  const m = createLevelMeter();
  for (let i = 0; i < 100; i++) { m.add('Music', 0.5, 0.1); m.add('Game', i % 2 ? 0.1 : 0.0001, 0.1); }
  const r = m.result();
  assert.equal(r.Music.db, -6);
  assert.equal(r.Music.secs, 10);
  assert.equal(r.Game.secs, 5, 'silence is not counted');
  assert.equal(r.Game.db, -20);
});

test('only the louder channels are lowered, down to the quietest', () => {
  const measured = { Game: { db: -20, secs: 20 }, Music: { db: -8.3, secs: 25 }, Chat: { db: -19.6, secs: 10 }, System: { db: -2, secs: 2 } };
  const r = levelCuts(measured, ['Game', 'Music', 'Chat', 'System']);
  assert.deepEqual(r.offsets, { Music: -11.5 }, 'Chat is within 1 dB; System played too little');
  assert.deepEqual(r.measuredChannels, ['Game', 'Music', 'Chat']);
  assert.equal(levelCuts({ Game: { db: -40, secs: 30 }, Music: { db: -5, secs: 30 } }, ['Game', 'Music']).offsets.Music, -MAX_CUT);
  assert.deepEqual(levelCuts({ Music: { db: -5, secs: 30 } }, ['Game', 'Music']).offsets, {}, 'one channel = nothing to compare');
});

test('the engine gets a section per lowered channel', () => {
  const devices = [
    { id: 'g', name: 'Game (TC-Helicon GoXLR)', flow: 'render' },
    { id: 'm', name: 'Music (TC-Helicon GoXLR)', flow: 'render' },
    { id: 's', name: 'Speakers (Realtek)', flow: 'render' },
  ];
  const eq = { enabled: true, preamp: -2, bands: [] };
  const state = { active: 'A', slots: { A: eq, B: eq }, extras: {}, clipGuard: false, abMatch: false, presets: {}, levelMatch: { enabled: true, offsets: { Music: -6 } } };
  const cfg = engineConfig(state, { devices });
  assert.deepEqual(cfg.devices, ['g', 's']);
  assert.equal(cfg.channels.length, 1);
  assert.equal(cfg.channels[0].target, 'm');
  assert.equal(cfg.channels[0].preamp, -8, 'the main EQ plus the cut');
  assert.deepEqual(levelOffsets({ ...state, levelMatch: { ...state.levelMatch, enabled: false } }), {});
  assert.equal(engineConfig({ ...state, levelMatch: { enabled: false, offsets: { Music: -6 } } }, { devices }).channels, undefined, 'off = as before');
  // With a single EQ target the other channel gets only the cut, no EQ.
  const one = engineConfig(state, { devices, target: 'g' });
  assert.equal(one.channels[0].preamp, -6);
  assert.deepEqual(one.devices, ['g']);
});

test('noise removal puts the Chat output in its own section with the plugin', () => {
  const devices = [
    { id: 'c', name: 'Chat (TC-Helicon GoXLR)', flow: 'render' },
    { id: 's', name: 'Speakers (Realtek)', flow: 'render' },
  ];
  const eq = { enabled: true, preamp: -1, bands: [] };
  const state = { active: 'A', slots: { A: eq, B: eq }, extras: {}, clipGuard: false, abMatch: false, presets: {}, chatDenoise: { enabled: true } };
  const cfg = engineConfig(state, { devices });
  assert.deepEqual(cfg.devices, ['s']);
  assert.equal(cfg.channels.length, 1);
  assert.equal(cfg.channels[0].target, 'c');
  assert.equal(cfg.channels[0].denoise, true);
  assert.equal(cfg.channels[0].preamp, -1, 'the main EQ is kept on the chat');
  assert.equal(engineConfig({ ...state, chatDenoise: { enabled: false } }, { devices }).channels, undefined);
});
