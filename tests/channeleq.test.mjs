import test from 'node:test';
import assert from 'node:assert/strict';
import { engineConfig, channelPresetFor, activeChannels, hasProfileSets, usesChannelEq, FLAT, ALL_PROFILES } from '../public/js/channeleq.js';

const devices = [
  { id: '{0}.{sys}', name: 'System (TC-Helicon GoXLR)', flow: 'render' },
  { id: '{0}.{game}', name: 'Game (TC-Helicon GoXLR)', flow: 'render' },
  { id: '{0}.{music}', name: 'Music (TC-Helicon GoXLR)', flow: 'render' },
  { id: '{0}.{chat}', name: 'Chat (TC-Helicon GoXLR)', flow: 'render' },
  { id: '{0}.{spk}', name: 'Speakers (Realtek)', flow: 'render' },
  { id: '{0}.{mic}', name: 'Chat Mic (TC-Helicon GoXLR)', flow: 'capture' },
];
const base = (over = {}) => ({
  active: 'A',
  slots: { A: { enabled: true, preamp: -1, bands: [{ enabled: true, type: 'PK', freq: 1000, gain: 2, q: 1 }] }, B: { enabled: true, preamp: 0, bands: [] } },
  presets: { Mine: { enabled: true, preamp: -2, bands: [{ enabled: true, type: 'PK', freq: 3000, gain: 6, q: 1 }] } },
  extras: { crossfeed: { enabled: true, level: -8, cutoff: 700 } },
  clipGuard: true,
  abMatch: false,
  ...over,
});

test('without channel EQ the payload is unchanged (old behaviour)', () => {
  const p = engineConfig(base(), { devices });
  assert.equal(p.channels, undefined);
  assert.equal(p.devices, undefined);
  assert.equal(p.target, null);
});

test('channels get their own section and are left out of the main EQ', () => {
  const st = base({ channelEq: { [ALL_PROFILES]: { Music: 'Musik', Chat: FLAT } } });
  const p = engineConfig(st, { devices });
  assert.deepEqual(p.channels.map((c) => [c.channel, c.target]), [['Music', '{0}.{music}'], ['Chat', '{0}.{chat}']]);
  assert.deepEqual(p.devices, ['{0}.{sys}', '{0}.{game}', '{0}.{spk}']);
  // "Ingen EQ": nothing at all, not even crossfeed; the music preset keeps the listening extras.
  const chat = p.channels.find((c) => c.channel === 'Chat');
  assert.deepEqual([chat.bands.length, chat.extra.length, chat.preamp], [0, 0, 0]);
  assert.ok(p.channels.find((c) => c.channel === 'Music').extra.length > 0);
});

test('the clip guard lowers a boosting channel preset', () => {
  const p = engineConfig(base({ channelEq: { [ALL_PROFILES]: { Game: 'Mine' } } }), { devices });
  const g = p.channels[0];
  assert.ok(g.preamp < -2, `preamp ${g.preamp}`);
  const off = engineConfig(base({ clipGuard: false, channelEq: { [ALL_PROFILES]: { Game: 'Mine' } } }), { devices });
  assert.equal(off.channels[0].preamp, -2);
});

test('a profile has its own set, falling back to "Alle profiler"', () => {
  const st = base({ channelEq: { [ALL_PROFILES]: { Music: 'Musik', Game: 'Mine' }, Speakers: { Music: FLAT } } });
  assert.equal(channelPresetFor(st, 'Music', 'Speakers'), FLAT);
  assert.equal(channelPresetFor(st, 'Game', 'Speakers'), 'Mine');
  assert.equal(channelPresetFor(st, 'Music', 'Headset'), 'Musik');
  assert.equal(channelPresetFor(st, 'Chat', 'Headset'), null);
  assert.ok(hasProfileSets(st));
  assert.ok(!hasProfileSets(base({ channelEq: { [ALL_PROFILES]: { Music: 'Musik' } } })));
  assert.ok(usesChannelEq(st) && !usesChannelEq(base()));
});

test('a single EQ target keeps its output unless a channel takes it', () => {
  const st = base({ target: '{0}.{sys}', channelEq: { [ALL_PROFILES]: { System: 'Musik' } } });
  const p = engineConfig(st, { devices });
  assert.deepEqual(p.devices, []);
  assert.equal(p.channels[0].target, '{0}.{sys}');
});

test('EQ off turns the channels off too; unknown presets and missing outputs are skipped', () => {
  const off = base({ channelEq: { [ALL_PROFILES]: { Music: 'Musik' } } });
  off.slots.A.enabled = false;
  assert.equal(engineConfig(off, { devices }).channels, undefined);
  const st = base({ channelEq: { [ALL_PROFILES]: { Music: 'Slettet', Game: 'Musik' } } });
  assert.deepEqual(activeChannels(st, devices.filter((d) => !/Game/.test(d.name))).map((c) => c.channel), []);
  assert.equal(engineConfig(st, { devices }).channels.length, 1);
});

test('EQ pr. app: apps keep their channel, same preset shares one, music/chat/games go where they belong', async () => {
  const { planAppEq, preferredChannel } = await import('../public/js/channeleq.js');
  assert.equal(preferredChannel('Spotify.exe'), 'Music');
  assert.equal(preferredChannel('Discord.exe'), 'Chat');
  assert.equal(preferredChannel('cod.exe'), 'Game');
  const plan = planAppEq([
    { exe: 'cod.exe', preset: 'Fodtrin (FPS)' },
    { exe: 'Spotify.exe', preset: 'Musik' },
    { exe: 'valorant.exe', preset: 'Fodtrin (FPS)' },
  ], { channelOf: (exe) => (exe === 'cod.exe' ? 'System' : exe === 'Spotify.exe' ? 'Music' : null) });
  // CoD leaves System (Windows' default, where every other sound plays too) for Game.
  assert.deepEqual(plan.sets, { Game: 'Fodtrin (FPS)', Music: 'Musik' });
  assert.deepEqual(plan.assignments.map((a) => a.channel), ['Game', 'Music', 'Game']);
  assert.deepEqual(plan.full, []);
});

test('EQ pr. app: a taken channel moves the app, and more presets than channels are reported', async () => {
  const { planAppEq } = await import('../public/js/channeleq.js');
  const plan = planAppEq([
    { exe: 'a.exe', preset: 'A' }, { exe: 'b.exe', preset: 'B' }, { exe: 'c.exe', preset: 'C' },
  ], { channelOf: () => 'Game', available: ['Game', 'Music'] });
  assert.deepEqual(plan.sets, { Game: 'A', Music: 'B' });
  assert.deepEqual(plan.full, ['C']);
  assert.equal(plan.assignments[2].channel, null);
});
