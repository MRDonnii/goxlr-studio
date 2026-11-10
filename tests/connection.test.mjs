import test from 'node:test';
import assert from 'node:assert/strict';

// The Windows app's connection: a GetStatus that fails right after a start is tried again, and a
// command that cannot reach the GoXLR says so instead of vanishing into the demo.
globalThis.window ??= {};
const { GoXLRConnection } = await import('../public/js/api.js');

const STATUS = { mixers: { S1: { levels: { volumes: { Sample: 10 } } } } };

test('the status is fetched again until the engine answers', async () => {
  window.__TAURI__ = {};
  const c = new GoXLRConnection();
  let calls = 0;
  c.transport = async (data) => (data === 'GetStatus' && ++calls >= 3 ? { Status: STATUS } : { Error: 'not ready' });
  await c.onConnection(true);
  assert.equal(c.mode, 'live');
  assert.equal(c.serial, 'S1');
  assert.equal(calls, 3);
});

test('commands while not connected are reported, not dropped in silence', async () => {
  window.__TAURI__ = {};
  const c = new GoXLRConnection();
  c.enterDemo();
  const errors = [];
  c.addEventListener('error', (e) => errors.push(e.detail));
  const sent = [];
  c.transport = async (d) => { sent.push(d); return { Error: 'x' }; };
  await c.command('SetVolume', 'Sample', 200);
  assert.equal(sent.length, 0, 'nothing went to the demo or the engine');
  assert.match(errors[0], /SetVolume: ikke forbundet til GoXLR-motoren/);
  // Live: it is sent.
  c.status = STATUS; c.mode = 'live'; c.pickSerial();
  c.transport = async (d) => { sent.push(d); return { Ok: null }; };
  await c.command('SetVolume', 'Sample', 200);
  assert.deepEqual(sent[0], { Command: ['S1', { SetVolume: ['Sample', 200] }] });
});

test('the browser demo still works without the engine', async () => {
  delete window.__TAURI__;
  const c = new GoXLRConnection();
  c.enterDemo();
  await c.command('SetVolume', 'Sample', 123);
  assert.equal(c.mixer.levels.volumes.Sample, 123);
});
