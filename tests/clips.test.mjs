import { test } from 'node:test';
import assert from 'node:assert/strict';
const { pickClipDevice } = await import('../public/js/clips.js');

test('the clip device: the chosen one, else the GoXLR stream mix', () => {
  const devs = [
    { id: 'mic', name: 'Chat Mic (TC-Helicon GoXLR)', flow: 'capture' },
    { id: 'bsm', name: 'Broadcast Stream Mix (TC-Helicon GoXLR)', flow: 'capture' },
    { id: 'spk', name: 'Speakers', flow: 'render' },
  ];
  assert.equal(pickClipDevice(devs, ''), 'bsm');
  assert.equal(pickClipDevice(devs, 'spk'), 'spk');
  assert.equal(pickClipDevice(devs, 'gone'), 'bsm', 'a device that is gone → the stream mix');
  assert.equal(pickClipDevice([devs[0]], ''), '', 'nothing → Windows default mic');
});
