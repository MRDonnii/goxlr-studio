import { test } from 'node:test';
import assert from 'node:assert/strict';
const s = await import('../public/js/soundcheckmodel.js');

const ep = (id, name, flow, extra = {}) => ({ id, name, flow, default: false, default_comm: false, volume: 1, muted: false, format: { rate: 48000, bits: 24, channels: 2, float: false }, ...extra });
const goxlr = [
  ep('sys', 'System (TC-HELICON GoXLR Mini)', 'render', { default: true, default_comm: true }),
  ep('music', 'Music (TC-HELICON GoXLR Mini)', 'render'),
  ep('chatmic', 'Chat Mic (TC-HELICON GoXLR Mini)', 'capture', { default: true, default_comm: true }),
];

test('all good: ducking off, 100 %, GoXLR as default', () => {
  const f = s.soundcheckFindings({ ducking: 3, ducking_backup: true, endpoints: goxlr });
  assert.ok(f.every((x) => x.level === 'ok'), JSON.stringify(f.map((x) => [x.id, x.level])));
  assert.equal(f.find((x) => x.id === 'ducking').fix.kind, 'ducking-restore');
  assert.match(f.find((x) => x.id === 'format').title, /48 kHz · 24 bit/);
});

test('Windows ducking (not set = 80 %) is the first warning', () => {
  const f = s.soundcheckFindings({ ducking: null, endpoints: goxlr });
  assert.equal(f[0].id, 'ducking');
  assert.equal(f[0].level, 'warn');
  assert.match(f[0].text, /80 %/);
  assert.equal(f[0].fix.kind, 'ducking-off');
});

test('muted and turned-down GoXLR devices in Windows', () => {
  const eps = [
    ep('sys', 'System (TC-HELICON GoXLR Mini)', 'render', { default: true, volume: 0.63 }),
    ep('chatmic', 'Chat Mic (TC-HELICON GoXLR Mini)', 'capture', { muted: true, default_comm: true }),
    ep('bcast', 'Broadcast Stream Mix (TC-HELICON GoXLR Mini)', 'capture', { volume: 0.5 }),
  ];
  const f = s.soundcheckFindings({ ducking: 3, endpoints: eps });
  const mute = f.find((x) => x.id === 'mute-chatmic');
  assert.equal(mute.level, 'warn');
  assert.match(mute.text, /Discord/);
  const vol = f.find((x) => x.id === 'vol-sys');
  assert.match(vol.title, /63 %/);
  assert.equal(vol.fix.confirm, true);
  // Only the chat mic's level matters among the inputs.
  assert.ok(!f.some((x) => x.id === 'vol-bcast'));
  assert.ok(!f.some((x) => x.id === 'goxlr-levels'));
});

test('default devices that bypass the GoXLR, and 16 bit', () => {
  const eps = [
    ...goxlr.map((e) => ({ ...e, default: false, default_comm: false, format: { ...e.format, bits: 16 } })),
    ep('spk', 'Højttalere (Realtek USB Audio)', 'render', { default: true }),
    ep('cam', 'Mikrofon (Logitech BRIO)', 'capture', { default_comm: true }),
  ];
  const f = s.soundcheckFindings({ ducking: 3, endpoints: eps });
  assert.deepEqual(f.find((x) => x.id === 'default-out').fix, { kind: 'default', id: 'sys', label: 'Brug System' });
  assert.equal(f.find((x) => x.id === 'default-in').fix.id, 'chatmic');
  assert.match(f.find((x) => x.id === 'format-bits').title, /16 bit/);
});

test('EQ engine state', () => {
  assert.equal(s.soundcheckFindings({ ducking: 3, endpoints: [] }, { engine: { kind: 'builtin', unregistered: true } }).find((x) => x.id === 'eq').level, 'warn');
  assert.equal(s.soundcheckFindings({ ducking: 3, endpoints: [] }, { engine: { kind: 'builtin', summary: { ok: true, text: 'kører' } } }).find((x) => x.id === 'eq').level, 'ok');
  assert.equal(s.soundcheckFindings({ ducking: 3, endpoints: [] }, { engine: { kind: 'none' } }).find((x) => x.id === 'eq').fix.page, 'outeq');
});
