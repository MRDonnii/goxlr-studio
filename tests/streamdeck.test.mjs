import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const dir = new URL('../streamdeck/com.goxlrstudio.sdPlugin/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir)));
const version = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url))).version;

test('the Stream Deck plugin follows the app version and has all its files', () => {
  assert.equal(manifest.Version, `${version}.0`, 'manifest Version = tauri.conf.json version + ".0"');
  const files = [manifest.CodePath, ...manifest.Actions.map((a) => a.PropertyInspectorPath)];
  const images = [manifest.Icon, manifest.CategoryIcon, ...manifest.Actions.flatMap((a) => [a.Icon, ...a.States.map((s) => s.Image)])];
  for (const f of files) assert.ok(existsSync(new URL(f, dir)), f);
  for (const i of images) for (const suffix of ['.png', '@2x.png']) assert.ok(existsSync(new URL(i + suffix, dir)), i + suffix);
  for (const html of files) {
    for (const [, src] of readFileSync(new URL(html, dir), 'utf8').matchAll(/(?:src|href)="([^"]+)"/g)) assert.ok(existsSync(new URL(src, dir)), `${html} → ${src}`);
  }
  assert.ok(manifest.Actions.every((a) => a.UUID.startsWith('com.goxlrstudio.')));
});

test('the Streonor / StreamDock manifest: same plugin, its own SDK version and knobs', () => {
  const sd = JSON.parse(readFileSync(new URL('manifest.streamdock.json', dir)));
  assert.equal(sd.Version, manifest.Version);
  assert.equal(sd.SDKVersion, 1);
  assert.equal(sd.CodePath, manifest.CodePath);
  assert.deepEqual(sd.Actions.map((a) => a.UUID), manifest.Actions.map((a) => a.UUID), 'the same actions (keys keep working across both apps)');
  assert.ok(sd.Actions.find((a) => a.UUID === 'com.goxlrstudio.volume').Controllers.includes('Knob'));
  assert.ok(!sd.Actions.some((a) => a.Encoder), 'no Elgato encoder layout');
});
