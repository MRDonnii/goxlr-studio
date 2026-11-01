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
