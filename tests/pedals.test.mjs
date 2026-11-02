import { test } from 'node:test';
import assert from 'node:assert/strict';
const { midiEvent, midiMatches, stealsTyping, faderValue, createPedalRunner, describeInput } = await import('../public/js/pedals.js');

test('MIDI: note on/off and sustain pedal (CC 64) become down/up', () => {
  assert.deepEqual(midiEvent([0x90, 60, 100]), { type: 'note', channel: 1, number: 60, value: 100, down: true });
  assert.equal(midiEvent([0x90, 60, 0]).down, false, 'note on with velocity 0 is note off');
  assert.equal(midiEvent([0x83, 60, 64]).down, false);
  assert.deepEqual(midiEvent([0xb1, 64, 127]), { type: 'cc', channel: 2, number: 64, value: 127, down: true });
  assert.equal(midiEvent([0xb1, 64, 0]).down, false);
  assert.equal(midiEvent([0xe0, 0, 64]), null);
  assert.ok(midiMatches({ kind: 'midi', type: 'cc', channel: 2, number: 64 }, midiEvent([0xb1, 64, 127])));
  assert.ok(!midiMatches({ kind: 'midi', type: 'cc', channel: 1, number: 64 }, midiEvent([0xb1, 64, 127])));
  assert.equal(faderValue(127), 255);
  assert.equal(faderValue(0), 0);
  assert.match(describeInput({ kind: 'midi', type: 'note', channel: 1, number: 60 }), /tone 60/);
});

test('a pedal key that would steal typing is caught', () => {
  assert.ok(stealsTyping('B'));
  assert.ok(stealsTyping('Space'));
  assert.ok(stealsTyping('Shift+A'));
  assert.ok(!stealsTyping('F13'));
  assert.ok(!stealsTyping('Ctrl+Alt+Shift+F5'));
  assert.ok(!stealsTyping('Alt+B'));
  assert.ok(!stealsTyping('MediaPlayPause'));
});

function fakeRunner() {
  const log = [];
  let timer = null;
  const r = createPedalRunner({
    run: (id) => log.push(`run ${id}`), release: (id) => log.push(`release ${id}`),
    setTimer: (fn) => { timer = fn; return 1; }, clearTimer: () => { timer = null; },
  });
  return { r, log, fire: () => { const t = timer; timer = null; t?.(); } };
}

test('Tryk, Hold and key repeat', () => {
  const { r, log } = fakeRunner();
  const press = { id: 'a', mode: 'press', action: 'mute-mic' };
  r.down(press); r.down(press); r.up(press);
  const hold = { id: 'b', mode: 'hold', holdAction: 'hold:ptt' };
  r.down(hold); r.down(hold); r.up(hold); r.up(hold);
  assert.deepEqual(log, ['run mute-mic', 'run hold:ptt', 'release hold:ptt']);
});

test('Tryk og hold: a short tap runs the tap action, holding runs the hold action until release', () => {
  const { r, log, fire } = fakeRunner();
  const p = { id: 'c', mode: 'taphold', action: 'sound:ding.wav', holdAction: 'hold:ptt' };
  r.down(p); r.up(p);
  r.down(p); fire(); r.up(p);
  assert.deepEqual(log, ['run sound:ding.wav', 'run hold:ptt', 'release hold:ptt']);
});
