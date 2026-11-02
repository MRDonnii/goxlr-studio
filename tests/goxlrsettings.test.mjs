import { test } from 'node:test';
import assert from 'node:assert/strict';
const { powerCommands, readPowerCommands } = await import('../public/js/views-goxlr.js');
const { trimPct, MODES, PADS } = await import('../public/js/views-sampler.js');

test('sleep/wake commands as GoXLR Utility reads them, and back', () => {
  const cmds = powerCommands({ mute: true, profile: 'Mørk' });
  assert.deepEqual(cmds, [{ LoadProfile: ['Mørk', false] }, { SetCoughMuteState: 'MutedToAll' }]);
  assert.deepEqual(readPowerCommands(cmds), { mute: true, unmute: false, profile: 'Mørk', other: 0 });
  assert.deepEqual(readPowerCommands([{ SetCoughMuteState: 'Unmuted' }, { SetGlobalColour: '000000' }]), { mute: false, unmute: true, profile: '', other: 1 });
  assert.deepEqual(powerCommands({}), []);
});

test('sampler values', () => {
  assert.equal(trimPct('12.34'), 12.3);
  assert.equal(trimPct(-5), 0);
  assert.equal(trimPct(150), 100);
  assert.equal(trimPct('x'), 0);
  assert.equal(PADS.length, 4);
  assert.ok(MODES.some(([m]) => m === 'Loop'));
});
