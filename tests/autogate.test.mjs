import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoGate, gateThreshold, percentile, SENSITIVITY, GATE_MIN, GATE_MAX, autoGateTick, setAutoGate, manualGateChange } from '../public/js/autogate.js';

// A simulated room: ~14 meter readings a second, as app.js' meterLoop.
const STEP = 70;
function run(gate, seconds, levelAt, margin = SENSITIVITY.normal, t0 = 0) {
  const changes = [];
  let last;
  for (let t = t0; t < t0 + seconds * 1000; t += STEP) {
    last = gate.step(levelAt(t), t, margin);
    if (last.changed) changes.push([t, last.threshold]);
  }
  return { last, changes };
}
// Deterministic "noise": a fixed pseudo-random sequence.
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const room = (floor, spread = 4) => () => floor + rnd() * spread;
// Speech: 1.5 s talk, 1 s pause, at a voice level.
const talking = (floor, voice) => (t) => ((t % 2500) < 1500 ? voice + rnd() * 6 - 3 : floor + rnd() * 4);

test('percentile and the threshold rule', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0), 1);
  assert.equal(percentile([5, 1, 3, 2, 4], 1), 5);
  assert.equal(percentile([], 0.5), null);
  assert.equal(gateThreshold(-60, null, 7), -53);
  assert.equal(gateThreshold(-80, null, 7), GATE_MIN, 'never below the gate’s range');
  assert.equal(gateThreshold(-5, null, 7), GATE_MAX, 'never so high that speech is cut');
  assert.equal(gateThreshold(-30, -25, 7), -35, 'stays 10 dB below the voice');
});

test('waits for 3 s of listening before the first threshold', () => {
  const g = createAutoGate();
  const { changes } = run(g, 2.5, room(-60));
  assert.equal(changes.length, 0);
  const r = run(g, 1, room(-60), SENSITIVITY.normal, 2500);
  assert.equal(r.changes.length, 1);
});

test('quiet room: threshold a few dB above the noise, below the voice', () => {
  seed = 1;
  const g = createAutoGate();
  const { last } = run(g, 20, talking(-62, -22));
  assert.ok(last.noise > -63 && last.noise < -56, `noise ${last.noise}`);
  assert.ok(last.threshold > last.noise && last.threshold <= last.noise + 9, `threshold ${last.threshold}`);
  assert.ok(last.threshold < -22 - 9, 'well below the voice');
  assert.ok(last.speech > -26 && last.speech < -18, `speech ${last.speech}`);
});

test('speakers on: the gate rises with the game sound and comes down again', () => {
  seed = 2;
  const g = createAutoGate();
  run(g, 10, room(-60));
  const quiet = g.threshold;
  // Game sound from the speakers: the room is 20 dB louder for 20 s, with talking.
  const loud = run(g, 20, talking(-40, -18), SENSITIVITY.normal, 10000);
  assert.ok(loud.last.threshold >= quiet + 12, `rose from ${quiet} to ${loud.last.threshold}`);
  assert.ok(loud.last.threshold < -18 - 9, 'still below the voice');
  // The game is closed: back down within a few seconds.
  const after = run(g, 6, room(-60), SENSITIVITY.normal, 30000);
  assert.ok(after.last.threshold <= quiet + 2, `back to ${after.last.threshold}`);
});

test('a steady room does not make the threshold jump around', () => {
  seed = 3;
  const g = createAutoGate();
  const { changes } = run(g, 60, talking(-55, -20));
  assert.ok(changes.length <= 4, `${changes.length} changes in a minute`);
  for (let i = 1; i < changes.length; i++) assert.ok(changes[i][0] - changes[i - 1][0] >= 1500, 'at most one change per 1.5 s');
});

test('long talking does not drag the threshold up into the voice', () => {
  seed = 4;
  const g = createAutoGate();
  run(g, 5, room(-60));
  // 25 s of almost non-stop talking (short breaths).
  const { last } = run(g, 25, (t) => ((t % 3000) < 2700 ? -20 + rnd() * 6 - 3 : -60 + rnd() * 3), SENSITIVITY.normal, 5000);
  assert.ok(last.threshold <= -30, `threshold ${last.threshold}`);
});

test('sensitivity: "Følsom" sits lower than "Kun tydelig tale"', () => {
  seed = 5;
  const a = run(createAutoGate(), 10, room(-58), SENSITIVITY.high).last.threshold;
  seed = 5;
  const b = run(createAutoGate(), 10, room(-58), SENSITIVITY.low).last.threshold;
  assert.ok(b - a >= 6, `${a} vs ${b}`);
});

test('missing readings are ignored', () => {
  const g = createAutoGate();
  const r = g.step(null, 0);
  assert.equal(r.changed, false);
  assert.equal(r.threshold, null);
});

// ---------- in the app (fake ctx) ----------
function fakeCtx(gateOn = true, threshold = -40) {
  const sent = [];
  const mixer = { mic_status: { noise_gate: { enabled: gateOn, threshold } }, cough_button: { state: 'Unmuted' }, fader_status: {} };
  return { sent, ctx: { prefs: {}, savePrefs() {}, notify() {}, conn: { mode: 'live', mixer, command: (...c) => { sent.push(c); if (c[0] === 'SetGateThreshold') mixer.mic_status.noise_gate.threshold = c[1]; if (c[0] === 'SetGateActive') mixer.mic_status.noise_gate.enabled = c[1]; } } } };
}

test('switching it on keeps the user’s gate, switching it off puts it back', () => {
  const { ctx, sent } = fakeCtx(false, -44);
  setAutoGate(ctx, true);
  assert.deepEqual(sent, [['SetGateActive', true]]);
  assert.deepEqual(ctx.prefs.autoGate.saved, { threshold: -44, enabled: false });
  setAutoGate(ctx, false);
  assert.deepEqual(sent.slice(1), [['SetGateThreshold', -44], ['SetGateActive', false]]);
  assert.equal(ctx.prefs.autoGate.saved, undefined);
});

test('the tick sets the threshold, pauses while muted, and a manual change switches it off', () => {
  seed = 6;
  const { ctx, sent } = fakeCtx(true, -40);
  setAutoGate(ctx, true);
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    for (let i = 0; i < 100; i++) { now += STEP; autoGateTick(ctx, -60 + rnd() * 4); }
    const set = sent.filter((c) => c[0] === 'SetGateThreshold');
    assert.equal(set.length, 1);
    assert.ok(set[0][1] > -60 && set[0][1] < -45, `threshold ${set[0][1]}`);
    // Muted: nothing is learnt or sent.
    ctx.conn.mixer.cough_button.state = 'MutedToAll';
    const before = sent.length;
    for (let i = 0; i < 200; i++) { now += STEP; autoGateTick(ctx, -20); }
    assert.equal(sent.length, before);
    ctx.conn.mixer.cough_button.state = 'Unmuted';
    // The user moves the threshold: automatic off, and their value stays (no restore).
    manualGateChange(ctx);
    assert.equal(ctx.prefs.autoGate.enabled, false);
    assert.equal(sent.length, before);
  } finally { Date.now = realNow; }
});

test('safety: a meter that reads after the gate cannot make the threshold swing', () => {
  // Worst case: a closed gate makes the meter read nearly nothing, an open one the real room.
  seed = 7;
  const g = createAutoGate();
  const changes = [];
  for (let t = 0; t < 120000; t += STEP) {
    const roomDb = -50 + rnd() * 4;
    const reading = g.threshold != null && roomDb < g.threshold ? -72 : roomDb;
    const r = g.step(reading, t);
    if (r.changed) changes.push(t);
  }
  assert.ok(changes.length <= 10, `${changes.length} changes in two minutes`);
  // It holds still for a long time once it has seen it swing.
  const gaps = changes.slice(1).map((t, i) => t - changes[i]);
  assert.ok(Math.max(...gaps) >= 55000, `longest still period ${Math.max(...gaps)} ms`);
  // And it holds at a threshold above the room (noise stays out).
  assert.ok(g.threshold >= -50, `held at ${g.threshold}`);
});
