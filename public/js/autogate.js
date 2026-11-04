// Automatisk noise gate – as Discord's "Automatically determine input sensitivity", but on the
// GoXLR's own (hardware) gate: GoXLR Studio listens to the mic meter all the time, learns the
// room's noise (fan, pc, game sound from speakers) and keeps the gate's threshold a few dB above
// it – and below the voice. When the noise changes, the threshold follows.
//
// The meter (GetMicLevel) is in dB from −72 to 0 after the mic gain, the same scale as the gate's
// threshold (−59 … 0), see micassist.js.
import { micIsMuted } from './extras.js';

/** dB above the room's noise, per choice ("Følsomhed"). */
export const SENSITIVITY = { high: 4, normal: 7, low: 11 };
export const GATE_MIN = -59;
export const GATE_MAX = -12;
const WINDOW_MS = 8000; // the room's noise: the quiet part of the last 8 s
const SPEECH_MS = 30000; // the voice: the loud part of the last 30 s
const WARMUP_MS = 3000;
const MIN_CHANGE = 2; // dB – smaller changes are not sent
const HOLD_MS = 1500; // at most one change per 1.5 s
const SPEECH_GAP = 10; // the gate stays this far below the voice
// Safety: if the threshold goes up and down again and again (as it would if the meter were ever
// measured after the gate), it is held still for a while instead of swinging.
const SWING_WINDOW_MS = 20000;
const SWING_REVERSALS = 2; // up-down-up within 20 s (speakers on, then off, is only one)
const SWING_HOLD_MS = 60000; // doubled each time it happens again, at most 10 minutes
const SWING_HOLD_MAX = 600000;

export function percentile(values, p) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

/** The threshold for a noise floor and a voice level (pure). */
export function gateThreshold(noise, speech, margin) {
  let t = noise + margin;
  if (Number.isFinite(speech)) t = Math.min(t, speech - SPEECH_GAP);
  return Math.round(Math.max(GATE_MIN, Math.min(GATE_MAX, t)));
}

/**
 * The learning part (pure, time is passed in). step(db, now, margin) → { threshold, noise, speech,
 * changed }: `changed` = send the threshold to the GoXLR now.
 */
export function createAutoGate() {
  let samples = []; // [t, db]
  let first = null;
  let noise = null;
  let threshold = null;
  let lastSet = -Infinity;
  let moves = []; // [t, direction]
  let heldUntil = -Infinity;
  let holdMs = SWING_HOLD_MS;
  return {
    reset() { samples = []; first = null; noise = null; threshold = null; lastSet = -Infinity; moves = []; heldUntil = -Infinity; holdMs = SWING_HOLD_MS; },
    /** Paused (mic muted, "Fang alt" held): the samples would not be the room. */
    pause() { first = null; samples = []; },
    step(db, now, margin = SENSITIVITY.normal) {
      if (!Number.isFinite(db)) return { threshold, noise, speech: null, changed: false };
      const v = Math.max(-72, Math.min(0, db));
      first ??= now;
      samples.push([now, v]);
      while (samples.length && samples[0][0] < now - SPEECH_MS) samples.shift();
      const recent = samples.filter(([t]) => t >= now - WINDOW_MS).map(([, x]) => x);
      const floor = percentile(recent, 0.1);
      // Falls quickly (the room got quiet), rises slowly (someone talks for a long time).
      noise = noise == null ? floor : floor < noise ? noise + (floor - noise) * 0.5 : noise + (floor - noise) * 0.03;
      const loud = samples.map(([, x]) => x).filter((x) => x > noise + 12);
      const speech = loud.length >= 10 ? percentile(loud, 0.5) : null;
      if (now - first < WARMUP_MS) return { threshold, noise, speech, changed: false };
      const want = gateThreshold(noise, speech, margin);
      const held = now < heldUntil;
      if (threshold == null || (!held && Math.abs(want - threshold) >= MIN_CHANGE && now - lastSet >= HOLD_MS)) {
        if (threshold != null) {
          moves = moves.filter(([t]) => t >= now - SWING_WINDOW_MS);
          moves.push([now, Math.sign(want - threshold)]);
          let reversals = 0;
          for (let i = 1; i < moves.length; i++) if (moves[i][1] !== moves[i - 1][1]) reversals++;
          if (reversals >= SWING_REVERSALS) {
            // Hold still at the higher of the two (less noise through) and wait longer each time.
            heldUntil = now + holdMs;
            holdMs = Math.min(SWING_HOLD_MAX, holdMs * 2);
            moves = [];
            const hold = Math.max(want, threshold);
            const changed = hold !== threshold;
            threshold = hold;
            lastSet = now;
            return { threshold, noise, speech, changed, held: true };
          }
        }
        threshold = want;
        lastSet = now;
        return { threshold, noise, speech, changed: true, held: false };
      }
      return { threshold, noise, speech, changed: false, held };
    },
    get threshold() { return threshold; },
  };
}

// ---------- in the app ----------
const gate = createAutoGate();

export const autoGateSettings = (ctx) => (ctx.prefs.autoGate ??= { enabled: false, sensitivity: 'normal' });

/** Called with every mic meter reading (app.js meterLoop, ~14 a second). */
export function autoGateTick(ctx, db) {
  const s = ctx.prefs.autoGate;
  const m = ctx.conn.mixer;
  if (!s?.enabled || !m || (ctx.conn.mode !== 'live' && ctx.conn.mode !== 'demo')) return;
  if (micIsMuted(m) || ctx.prefs.openMic?.saved) { gate.pause(); return; }
  const r = gate.step(db, Date.now(), SENSITIVITY[s.sensitivity] ?? SENSITIVITY.normal);
  ctx.autoGate = r;
  if (r.changed && r.threshold !== m.mic_status?.noise_gate?.threshold) {
    s.lastSet = r.threshold;
    ctx.conn.command('SetGateThreshold', r.threshold);
  }
}

/** Switch the automatic gate on/off. On: the gate is switched on and the user's threshold kept
 *  for later; off: that threshold is put back. */
export function setAutoGate(ctx, on, { restore = true, message = null } = {}) {
  const s = autoGateSettings(ctx);
  const m = ctx.conn.mixer;
  if (on === s.enabled) return;
  s.enabled = on;
  gate.reset();
  if (on && m) {
    s.saved = { threshold: m.mic_status.noise_gate.threshold, enabled: m.mic_status.noise_gate.enabled };
    if (!m.mic_status.noise_gate.enabled) ctx.conn.command('SetGateActive', true);
  } else if (!on && s.saved && m && restore) {
    ctx.conn.command('SetGateThreshold', s.saved.threshold);
    if (!s.saved.enabled) ctx.conn.command('SetGateActive', false);
  }
  if (!on) delete s.saved;
  ctx.savePrefs?.();
  ctx.notify?.(message || (on ? 'Automatisk noise gate til' : 'Automatisk noise gate fra'), on ? 'ok' : 'info');
}

/** The user moved the threshold (or switched the gate off) by hand: automatic is switched off. */
export function manualGateChange(ctx) {
  if (!ctx.prefs.autoGate?.enabled) return;
  setAutoGate(ctx, false, { restore: false, message: 'Automatisk noise gate er slået fra – du satte gaten selv' });
}
