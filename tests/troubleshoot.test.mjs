import { test } from 'node:test';
import assert from 'node:assert/strict';
import { troubleshoot, classifyError, sessionLines, logProblems, lineLevel, scrubLine, bannerFinding, PROBLEMS } from '../public/js/troubleshoot.js';

const base = { native: true, mode: 'demo', autoStart: true, driver: { installed: true }, daemon: { started_by_us: false, foreign: [], last_error: null, attempts: [] }, log: [] };
const ids = (f) => f.map((x) => x.id);

test('nothing in the browser demo', () => {
  assert.deepEqual(troubleshoot({ ...base, native: false }), []);
});

test('every problem has a title, a text and fixes', () => {
  for (const [id, p] of Object.entries(PROBLEMS)) {
    assert.ok(p.title && p.text && Array.isArray(p.fixes), id);
    assert.ok(['error', 'warn', 'info'].includes(p.level), id);
  }
});

test('the engine that does not start after an update: another engine still answers', () => {
  const daemon = { ...base.daemon, last_error: 'En anden GoXLR-motor svarer allerede – typisk den gamle GoXLR Studio, der stadig er ved at lukke efter en opdatering, eller GoXLR Utility',
    attempts: [{ at: 1, ok: false, text: 'En anden GoXLR-motor svarer allerede' }, { at: 2, ok: false, text: 'Prøver igen om 2 s' }, { at: 3, ok: false, text: 'En anden GoXLR-motor svarer allerede' }] };
  const f = troubleshoot({ ...base, daemon });
  assert.equal(f[0].id, 'old-instance');
  assert.equal(f[0].fixes[0].action, 'start-engine');
  assert.ok(f[0].details.some((d) => d.includes('2 gange')));
});

test('engine errors are classified from both Danish and English texts', () => {
  assert.equal(classifyError('TC-Helicons GoXLR-driver blev ikke fundet – installér den'), 'driver-missing');
  assert.equal(classifyError('The official GoXLR Application is currently running'), 'tc-app');
  assert.equal(classifyError('Port 14564 er optaget af et andet program (Unable to Start HTTP Server: …)'), 'port-busy');
  assert.equal(classifyError('GoXLR Utility kører stadig og styrer GoXLR\'en'), 'utility-running');
  assert.equal(classifyError('noget helt andet'), 'engine-error');
});

test('a running GoXLR Utility is offered a takeover', () => {
  const f = troubleshoot({ ...base, daemon: { ...base.daemon, foreign: ['C:\\Program Files\\GoXLR Utility\\goxlr-daemon.exe'] } });
  assert.deepEqual(ids(f), ['utility-running']);
  assert.equal(f[0].fixes[0].action, 'takeover');
});

test('missing driver comes first and explains the stopped engine', () => {
  const f = troubleshoot({ ...base, driver: { installed: false }, daemon: { ...base.daemon, last_error: 'TC-Helicons GoXLR-driver blev ikke fundet' } });
  assert.deepEqual(ids(f), ['driver-missing']);
});

test('engine not started: plain finding, or autostart switched off', () => {
  assert.deepEqual(ids(troubleshoot(base)), ['engine-stopped']);
  assert.deepEqual(ids(troubleshoot({ ...base, autoStart: false })), ['autostart-off']);
});

test('engine runs but no GoXLR: USB advice, more specific when the log shows USB errors', () => {
  const running = { ...base.daemon, started_by_us: true };
  assert.deepEqual(ids(troubleshoot({ ...base, daemon: running })), ['no-device']);
  const log = ['10:00:00 [INFO] Starting GoXLR Daemon v1.2.4 (inside GoXLR Studio)', '10:00:05 [WARN] Failed to receive response (Attempt 20 of 20), possible Dead GoXLR?'];
  const f = troubleshoot({ ...base, daemon: running, log });
  assert.deepEqual(ids(f), ['usb-unstable']);
  assert.match(f[0].details[0], /Dead GoXLR/);
});

test('only the current run of the log counts', () => {
  const log = ['09:00:00 [INFO] Starting GoXLR Daemon v1.2.4', '09:00:01 [ERROR] Unable to Start HTTP Server: os error 10048',
    '10:00:00 [INFO] Starting GoXLR Daemon v1.2.4', '10:00:01 [INFO] Bound IPC Socket'];
  assert.deepEqual(sessionLines(log).length, 2);
  assert.deepEqual(logProblems(sessionLines(log)), []);
  assert.deepEqual(logProblems(log).map((p) => p.id), ['port-busy']);
});

test('while live, start problems in the log are ignored but USB and profile problems are shown', () => {
  const log = ['[INFO] Starting GoXLR Daemon', '[WARN] Failed to Load Profile: missing file, checking for backup..', '[ERROR] Unable to Start HTTP Server: x', '[WARN] Error Received from S000000000AAA: Pipe'];
  const f = troubleshoot({ ...base, mode: 'live', daemon: { ...base.daemon, started_by_us: true }, log });
  assert.deepEqual(ids(f), ['usb-unstable', 'profile-load']);
  assert.equal(bannerFinding(f).id, 'usb-unstable');
  assert.equal(bannerFinding([f[1]]), null, 'info is not a banner');
  assert.equal(bannerFinding(f, { skip: ['usb-unstable'] }), null);
});

test('a crash in the log explains the stopped engine', () => {
  const log = ['[INFO] Starting GoXLR Daemon', "thread 'goxlr-engine' panicked at src/device.rs:12:5"];
  const f = troubleshoot({ ...base, daemon: { ...base.daemon, last_error: 'something odd' }, log });
  assert.deepEqual(ids(f), ['crash']);
});

test('log levels and scrubbing of user names', () => {
  assert.equal(lineLevel('10:00:00 [ERROR] x'), 'error');
  assert.equal(lineLevel('10:00:00 [ WARN] x'), 'warn');
  assert.equal(lineLevel('10:00:00 [INFO] Error handling enabled'), null);
  assert.equal(scrubLine('Loading C:\\Users\\Someone\\AppData\\Roaming\\x.goxlr'), 'Loading C:\\Users\\<bruger>\\AppData\\Roaming\\x.goxlr');
});
