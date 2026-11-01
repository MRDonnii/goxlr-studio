import { test } from 'node:test';
import assert from 'node:assert/strict';
const x = await import('../public/js/extras.js');
const { parseApoConfig } = await import('../public/js/eq.js');

const devs = [
  { id: 'new-music', name: 'Music (TC-Helicon GoXLR)', flow: 'render' },
  { id: 'chat-mic', name: 'Chat Mic (TC-Helicon GoXLR)', flow: 'capture' },
];

test('resolveDevice keeps live ids, follows renamed ids by name and reports gone devices', () => {
  assert.equal(x.resolveDevice(devs, 'new-music', null, 'render'), 'new-music');
  assert.equal(x.resolveDevice(devs, 'old-music', 'Music (TC-Helicon GoXLR)', 'render'), 'new-music');
  assert.equal(x.resolveDevice(devs, 'old-music', 'Music (TC-Helicon GoXLR)', 'capture'), undefined);
  assert.equal(x.resolveDevice(devs, 'old', 'Ukendt', 'render'), undefined);
  assert.equal(x.resolveDevice(devs, null, 'x', 'render'), null);
});

test('crossfeed lines mix a low-passed copy and compensate the level', () => {
  const lines = x.crossfeedLines({ level: -6, cutoff: 700, delay: 0.3 });
  assert.ok(lines.includes('Copy: XL=L XR=R'));
  assert.ok(lines.includes('Filter: ON LP Fc 700 Hz'));
  assert.match(lines.find((l) => l.startsWith('Copy: L=')), /L=L\+0\.501\d\*XR R=R\+0\.501\d\*XL/);
  assert.equal(lines.at(-1), 'Preamp: -3.5 dB');
});

test('engine payload adds loudness shelves with headroom and crossfeed lines', () => {
  const eq = { enabled: true, preamp: -2, bands: [{ enabled: true, type: 'PK', freq: 1000, gain: 3, q: 1 }] };
  const p = x.enginePayload(eq, { loudness: { enabled: true, amount: 4 }, crossfeed: { enabled: true, level: -8 } }, 'dev');
  assert.equal(p.bands.length, 3);
  assert.equal(p.preamp, -6);
  assert.equal(p.target, 'dev');
  assert.ok(p.extra.length > 0);
  const plain = x.enginePayload(eq, {});
  assert.deepEqual(plain.extra, []);
  assert.equal(plain.bands.length, 1);
});

test('presetModified ignores band ids but notices edits', () => {
  const preset = { preamp: -3, bands: [{ type: 'LSC', freq: 105, gain: 4, q: 0.7 }] };
  const eq = { preamp: -3, bands: [{ id: 'a', enabled: true, type: 'LSC', freq: 105, gain: 4, q: 0.7 }] };
  assert.equal(x.presetModified(eq, preset), false);
  eq.bands[0].gain = 5;
  assert.equal(x.presetModified(eq, preset), true);
});

test('AutoEQ index parsing, search and file url', () => {
  const md = '# Index\n\n- [Sennheiser HD 650](./oratory1990/over-ear/Sennheiser%20HD%20650) by oratory1990\n- [1MORE Aero (ANC Off)](./HypetheSonics/GRAS%20RA0045%20in-ear/1MORE%20Aero%20(ANC%20Off)) by HypetheSonics on GRAS RA0045\n';
  const idx = x.parseAutoEqIndex(md);
  assert.equal(idx.length, 2);
  assert.equal(idx[1].name, '1MORE Aero (ANC Off)');
  assert.deepEqual(x.searchAutoEq(idx, 'hd 650').map((e) => e.name), ['Sennheiser HD 650']);
  assert.equal(x.autoEqUrl(idx[0]), `${x.AUTOEQ_RAW}/oratory1990/over-ear/Sennheiser%20HD%20650/Sennheiser%20HD%20650%20ParametricEQ.txt`);
  const parsed = parseApoConfig('Preamp: -6.0 dB\nFilter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70\nFilter 2: ON PK Fc 180 Hz Gain -3.3 dB Q 0.57\n');
  assert.equal(parsed.bands.length, 2);
  assert.equal(parsed.preamp, -6);
});

test('version comparison and update asset choice', () => {
  assert.equal(x.compareVersions('v0.2.0', '0.1.9'), 1);
  assert.equal(x.compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(x.compareVersions('0.2', '0.10.0'), -1);
  const rel = { assets: [
    { name: 'GoXLR Studio_0.2.0_x64-setup.exe', browser_download_url: 'https://github.com/MRDonnii/goxlr-studio/releases/download/v0.2.0/a.exe', digest: 'sha256:ab' },
    { name: 'GoXLR Studio (portable).exe', browser_download_url: 'https://github.com/MRDonnii/goxlr-studio/releases/download/v0.2.0/b.exe' },
    { name: 'GoXLR Studio_0.2.0_x64_en-US.msi', browser_download_url: 'c' },
  ] };
  assert.match(x.pickUpdateAsset(rel, true).name, /setup/);
  assert.match(x.pickUpdateAsset(rel, false).name, /portable/);
  assert.equal(x.pickUpdateAsset({ assets: [] }, true), null);
});

test('app triggers fire on start and exit, case-insensitively', () => {
  const t = [{ exe: 'cod.exe', onStart: 'scene:gaming', onExit: 'scene:normal' }];
  assert.deepEqual(x.triggerActions(t, new Set(), new Set(['COD.exe'])), ['scene:gaming']);
  assert.deepEqual(x.triggerActions(t, new Set(['cod.exe']), new Set(['cod.exe'])), []);
  assert.deepEqual(x.triggerActions(t, new Set(['cod.exe']), new Set()), ['scene:normal']);
});

test('AutoHotkey hotkeys map to accelerators', () => {
  assert.equal(x.ahkHotkeyToAccel('F13'), 'F13');
  assert.equal(x.ahkHotkeyToAccel('^PgUp'), 'Ctrl+PageUp');
  assert.equal(x.ahkHotkeyToAccel('$^!m'), 'Ctrl+Alt+M');
  assert.equal(x.ahkHotkeyToAccel('#Numpad1'), 'Super+Numpad1');
  assert.equal(x.ahkHotkeyToAccel('a & b'), null);
  assert.equal(x.ahkHotkeyToAccel('XButton1'), null);
});

test('AutoHotkey scripts calling goxlr-client become GoXLR Studio hotkeys', () => {
  const v1 = [
    '#NoEnv ; comment',
    'F13::Run, "C:\\Program Files\\GoXLR Utility\\goxlr-client-quiet.exe" profiles device load Headset, , Hide',
    'F14::',
    '  Run, "C:\\Program Files\\GoXLR Utility\\goxlr-client-quiet.exe" profiles device load "Speakers",, Hide',
    'return',
    '^PgUp::Run "goxlr-client-quiet.exe profiles device load Headset"',
    '^PgDn::',
    '{',
    '  Run("goxlr-client-quiet.exe profiles device load Speakers")',
    '}',
    '^!v::Run goxlr-client.exe volume music 40',
    '^!x::Run goxlr-client.exe cough-button mute-state muted-to-x',
    'F15::Run goxlr-client.exe lighting global 00FF00',
    '^Up::Send {Volume_Up}',
  ].join('\r\n');
  const r = x.parseAhk(v1);
  const map = Object.fromEntries(r.bindings.map((b) => [b.accel, b.action]));
  assert.equal(map.F13, 'profile:Headset');
  assert.equal(map.F14, 'profile:Speakers');
  assert.equal(map['Ctrl+PageUp'], 'profile:Headset');
  assert.equal(map['Ctrl+PageDown'], 'profile:Speakers');
  assert.equal(map['Ctrl+Alt+V'], 'vol-set:Music|40');
  assert.equal(map['Ctrl+Alt+X'], 'cough:MutedToX');
  assert.equal(r.unknown.length, 1);
  assert.equal(r.unknown[0].hotkey, 'F15');
  assert.ok(!r.bindings.some((b) => b.accel === 'Ctrl+Up'));
});

test('A hotkey that alternates between two profiles becomes a toggle', () => {
  const s = 'F16::\ntoggle := !toggle\nif toggle\n  Run goxlr-client-quiet.exe profiles device load Headset\nelse\n  Run goxlr-client-quiet.exe profiles device load Speakers\nreturn\n';
  const r = x.parseAhk(s);
  assert.deepEqual(r.bindings.map((b) => [b.accel, b.action]), [['F16', 'profile-toggle:Headset|Speakers']]);
});

test('fader LEDs follow the hardware: bottom colour below the knob, top colour above', () => {
  // System fader on the GoXLR Mini in the user's photo: green above, pink below, knob around 2/3 up.
  const leds = x.faderLeds('TwoColour', '00FF80', 'FF0080', 170);
  assert.equal(leds.length, 15);
  assert.equal(leds[0], 'FF0080');
  assert.equal(leds[10], 'FF0080'); // ceil(15/255*170 + .25) = 11 LEDs lit with the bottom colour
  assert.equal(leds[11], '00FF80');
  assert.equal(leds[14], '00FF80');
  // Fader at the bottom: everything shows the top colour except the lowest LED.
  assert.deepEqual(x.faderLeds('TwoColour', 'FFFFFF', '000000', 0).filter((c) => c === '000000').length, 1);
  // Gradient: dark above the knob, blend below.
  const g = x.faderLeds('Gradient', 'FFFFFF', '000000', 128);
  assert.equal(g[0], '000000');
  assert.equal(g[14], null);
  assert.ok(g.slice(0, 8).every((c) => c !== null));
});

test('mic mute for Discord: cough button and Mic fader, only when chat is affected', () => {
  const m = (cough, coughFn, fader, faderFn) => ({
    cough_button: { state: cough, mute_type: coughFn },
    fader_status: { A: { channel: 'Mic', mute_state: fader, mute_type: faderFn }, B: { channel: 'Chat', mute_state: 'MutedToAll', mute_type: 'All' } },
  });
  assert.equal(x.micMutedForChat(m('Unmuted', 'All', 'Unmuted', 'All')), false);
  assert.equal(x.micMutedForChat(m('MutedToX', 'All', 'Unmuted', 'All')), true);
  assert.equal(x.micMutedForChat(m('MutedToX', 'ToStream', 'Unmuted', 'All')), false, 'muted to stream only – Discord still hears you');
  assert.equal(x.micMutedForChat(m('MutedToAll', 'ToStream', 'Unmuted', 'All')), true);
  assert.equal(x.micMutedForChat(m('Unmuted', 'All', 'MutedToX', 'ToVoiceChat')), true);
  assert.equal(x.micMutedForChat(m('Unmuted', 'All', 'MutedToX', 'All'), { fader: false }), false);
});

test('VU meter scale, channel → GoXLR output and ballistics', () => {
  assert.equal(x.peakToMeter(0), 0);
  assert.equal(x.peakToMeter(1), 1);
  assert.ok(Math.abs(x.peakToMeter(0.1) - 2 / 3) < 1e-9); // −20 dB
  assert.equal(x.dbToMeter(-90), 0);
  const devs = [
    { id: 'chatmic', name: 'Chat Mic (TC-Helicon GoXLR)', flow: 'capture' },
    { id: 'chat', name: 'Chat (TC-Helicon GoXLR)', flow: 'render' },
    { id: 'sys', name: '2- System (TC-Helicon GoXLR Mini)', flow: 'render' },
    { id: 'realtek', name: 'Music (Realtek Audio)', flow: 'render' },
  ];
  assert.equal(x.channelEndpoint('Chat', devs), 'chat');
  assert.equal(x.channelEndpoint('System', devs), 'sys');
  assert.equal(x.channelEndpoint('Music', devs), null, 'only GoXLR outputs');
  assert.equal(x.channelEndpoint('Mic', devs), null);
  let s = { level: 0, peak: 0, peakAt: 0 };
  s = x.vuStep(s, 0.8, 0);
  assert.equal(s.level, 0.8);
  s = x.vuStep(s, 0, 100);
  assert.ok(s.level < 0.8 && s.level > 0.6);
  assert.equal(s.peak, 0.8);
  s = x.vuStep(s, 0, 2000);
  assert.ok(s.peak < 0.8, 'peak falls after the hold time');
});

test('takeoverMessage only says "koblet fra" when GoXLR Utility will not start again', async () => {
  const { takeoverMessage } = await import('../public/js/extras.js');
  const task = { kind: 'task', name: 'GoXLR Utility Startup (Single Instance)', enabled: true, owner: 'utility' };
  const panel = { kind: 'link', name: 'GoXLR Control Panel Autostart', enabled: true, owner: 'driver' };
  assert.equal(takeoverMessage({ stopped: ['goxlr-daemon.exe'], autostart_remaining: [task, panel] }).ok, false);
  assert.match(takeoverMessage({ stopped: ['goxlr-daemon.exe'], autostart_remaining: [task] }).text, /starter igen med Windows via den planlagte opgave "GoXLR Utility Startup \(Single Instance\)"/);
  assert.equal(takeoverMessage({ stopped: ['goxlr-daemon.exe'], autostart_remaining: [panel] }).ok, true);
  assert.equal(takeoverMessage({ stopped: ['x'], autostart_remaining: [{ ...task, enabled: false }] }).ok, true);
  assert.match(takeoverMessage({ stopped: [], old_engine_removed: true }).text, /separate motor er fjernet/);
});

test('startLevelCommands sets only enabled, known channels (0-100 % -> 0-255)', async () => {
  const { startLevelCommands } = await import('../public/js/extras.js');
  const cfg = { enabled: true, channels: { Music: 50, Chat: 100, Sample: 30, Game: 140, Mic: null } };
  assert.deepEqual(startLevelCommands(cfg, ['Music', 'Chat', 'Game', 'Mic']), [['SetVolume', 'Music', 128], ['SetVolume', 'Chat', 255], ['SetVolume', 'Game', 255]]);
  assert.deepEqual(startLevelCommands({ ...cfg, enabled: false }, ['Music']), []);
  assert.deepEqual(startLevelCommands(undefined, ['Music']), []);
});
