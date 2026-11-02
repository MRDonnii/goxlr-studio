import { test } from 'node:test';
import assert from 'node:assert/strict';
const { buildMoveFile, readMoveFile, stripSecrets, keepSecrets, filesSummary, moveDirs } = await import('../public/js/movepc.js');

const prefs = { theme: 'nord', mqtt: { host: 'h', password: 'secret' }, obs: { port: 4455, password: 'pw' } };

test('passwords stay out unless asked for, and this pc keeps its own', () => {
  const f = buildMoveFile({ data: { prefs, hotkeys: [1] }, files: [] });
  assert.equal(f.data.prefs.mqtt.password, undefined);
  assert.equal(f.data.prefs.obs.password, undefined);
  assert.equal(prefs.mqtt.password, 'secret', 'the original is not changed');
  assert.equal(buildMoveFile({ data: { prefs }, secrets: true }).data.prefs.obs.password, 'pw');
  assert.equal(keepSecrets(stripSecrets(prefs), { mqtt: { password: 'here' } }).mqtt.password, 'here');
  assert.equal(keepSecrets(prefs, { mqtt: { password: 'here' } }).mqtt.password, 'secret', 'the file wins when it has one');
});

test('reading a file: move files, old backups and anything else', () => {
  const f = JSON.parse(JSON.stringify(buildMoveFile({ data: { prefs, hotkeys: [], evil: 1 }, files: [{ kind: 'profiles', name: 'A.goxlr', data: 'eA==' }, { kind: 1 }] })));
  const r = readMoveFile(f);
  assert.deepEqual(Object.keys(r.data).sort(), ['hotkeys', 'prefs']);
  assert.equal(r.files.length, 1);
  assert.equal(readMoveFile({ app: 'goxlr-studio', created: 'x', data: { scenes: [] } }).files.length, 0, 'an older backup');
  assert.throws(() => readMoveFile({ app: 'other', data: {} }));
  assert.throws(() => readMoveFile(null));
});

test('what the file holds, and where it goes', () => {
  const files = [{ kind: 'profiles' }, { kind: 'profiles' }, { kind: 'mic-profiles' }, { kind: 'sounds' }];
  assert.equal(filesSummary(files), '2 GoXLR-profiler, 1 mikrofonprofil, 1 lyd i lydbanken');
  assert.equal(filesSummary([]), '');
  assert.deepEqual(moveDirs({ profile_directory: 'P', mic_profile_directory: 'M', samples_directory: '' }), [['profiles', 'P'], ['mic-profiles', 'M']]);
});
