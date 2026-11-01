import { test } from 'node:test';
import assert from 'node:assert/strict';
const q = await import('../public/js/mqttmodel.js');

const node = 'goxlr_abc123';
const base = 'goxlr-studio/goxlr_abc123';

test('discovery: one device with mic, profile, EQ, scene and volumes', () => {
  const c = q.discoveryConfigs({ node, version: '0.5.2', model: 'GoXLR Mini', profiles: ['Headset', 'Speakers'], presets: ['Flad', 'Bas-boost'], scenes: ['Gaming'] });
  const mute = c.get(`homeassistant/switch/${node}/mic_mute/config`);
  assert.equal(mute.command_topic, `${base}/mic_mute/set`);
  assert.equal(mute.availability_topic, `${base}/status`);
  assert.deepEqual(mute.device.identifiers, [node]);
  assert.equal(mute.device.model, 'GoXLR Mini');
  assert.deepEqual(c.get(`homeassistant/select/${node}/profile/config`).options, ['Headset', 'Speakers']);
  assert.equal(c.get(`homeassistant/number/${node}/vol_headphones/config`).max, 100);
  assert.ok(c.has(`homeassistant/binary_sensor/${node}/mic_live/config`));
  assert.equal(c.get(`homeassistant/select/${node}/scene/config`).optimistic, true);
  // Unique ids are unique.
  const ids = [...c.values()].map((x) => x.unique_id);
  assert.equal(new Set(ids).size, ids.length);
  // No profiles yet (GoXLR not connected): no empty select.
  assert.ok(!q.discoveryConfigs({ node }).has(`homeassistant/select/${node}/profile/config`));
});

test('state: mute, open mic, profile and volumes in percent', () => {
  const s = q.stateMessages(node, { connected: true, micMuted: true, profile: 'Headset', volumes: { Headphones: 255, Music: 128, Mic: 200 }, eqOn: true, eqPreset: 'Flad', presets: ['Flad'] });
  assert.equal(s[`${base}/mic_mute/state`], 'ON');
  assert.equal(s[`${base}/mic_live/state`], 'OFF');
  assert.equal(s[`${base}/vol_headphones/state`], '100');
  assert.equal(s[`${base}/vol_music/state`], '50');
  assert.ok(!(`${base}/vol_mic/state` in s));
  assert.equal(s[`${base}/eq_preset/state`], 'Flad');
  // A changed preset isn't one of the options; the GoXLR away: only connected/EQ.
  const off = q.stateMessages(node, { connected: false, eqOn: false, eqPreset: 'Mit eget', presets: ['Flad'] });
  assert.deepEqual(Object.keys(off).sort(), [`${base}/connected/state`, `${base}/eq/state`]);
});

test('commands from Home Assistant', () => {
  const opts = { profiles: ['Headset', 'Speakers'], presets: ['Flad'], scenes: [{ id: 's1', name: 'Gaming' }] };
  assert.deepEqual(q.parseCommand(`${base}/mic_mute/set`, 'ON', node, opts), { kind: 'mic_mute', on: true });
  assert.deepEqual(q.parseCommand(`${base}/eq/set`, 'OFF', node, opts), { kind: 'eq', on: false });
  assert.equal(q.parseCommand(`${base}/profile/set`, 'Speakers', node, opts).id, 'profile:Speakers');
  assert.equal(q.parseCommand(`${base}/profile/set`, 'Ukendt', node, opts), null);
  assert.equal(q.parseCommand(`${base}/scene/set`, 'Gaming', node, opts).id, 'scene:s1');
  assert.deepEqual(q.parseCommand(`${base}/vol_music/set`, '50', node, opts), { kind: 'volume', channel: 'Music', value: 128 });
  assert.equal(q.parseCommand(`${base}/vol_music/set`, '150', node, opts).value, 255);
  assert.equal(q.parseCommand(`${base}/vol_lineout/set`, '0', node, opts).channel, 'LineOut');
  assert.equal(q.parseCommand(`${base}/vol_music/set`, 'høj', node, opts), null);
  assert.deepEqual(q.parseCommand('homeassistant/status', 'online', node), { kind: 'republish' });
  assert.equal(q.parseCommand('goxlr-studio/other/mic_mute/set', 'ON', node), null);
});

test('only changes are sent; removed entities get an empty message', () => {
  const prev = { a: '1', b: '2' };
  assert.deepEqual(q.diffMessages(prev, { a: '1', b: '3' }), [{ topic: 'b', payload: '3', retain: true }]);
  assert.deepEqual(q.diffMessages(prev, { a: '1' }, { removeMissing: true }), [{ topic: 'b', payload: '', retain: true }]);
  assert.equal(q.slug('LineOut'), 'lineout');
  assert.equal(q.slug('Højttalere – ét'), 'hojttalere_et');
  assert.match(q.newNodeId(), /^goxlr_[0-9a-f]{6}$/);
});
