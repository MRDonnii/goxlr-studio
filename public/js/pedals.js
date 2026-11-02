// Fodpedal: foot pedals and MIDI controllers as GoXLR Studio buttons.
// - A USB pedal that types a key (also Elgato's Stream Deck Pedal through a "Hotkey" action) is a
//   global hotkey with the id "pedal:<id>" (registered with the other hotkeys in app.js).
// - A MIDI pedal, key or fader comes from midi.rs as `midi` events, also with the window hidden.
// Each pedal: "Tryk" runs an action, "Hold" works while held (push-to-talk/-mute), "Tryk og hold"
// does one thing on a short tap and another while held, "Fader" sets a channel's volume.
import { setChatMix } from './chatmix.js';
import { storeGet, storeSet, isNative, midiStart } from './native.js';
import { releaseAction } from './actions.js';

/** A MIDI fader on this "channel" moves ChatMix instead of a volume. */
export const CHATMIX = 'ChatMix';

export const HOLD_MS = 400;
export const HOLD_ACTIONS = [['hold:ptt', 'Push-to-talk (tal mens du holder)'], ['hold:ptm', 'Push-to-mute (mute mens du holder)']];
export const PEDAL_MODES = { press: 'Tryk', hold: 'Hold', taphold: 'Tryk og hold', fader: 'Fader → lydstyrke' };

/** A MIDI message as a pedal sees it. Note on (velocity > 0) is down, note off is up; a control
 *  change is down from 64 (a sustain pedal sends 0 and 127) and also carries its value for faders. */
export function midiEvent(data) {
  if (!data || data.length < 3) return null;
  const kind = data[0] & 0xf0;
  const channel = (data[0] & 0x0f) + 1;
  if (kind === 0x90 || kind === 0x80) return { type: 'note', channel, number: data[1], value: data[2], down: kind === 0x90 && data[2] > 0 };
  if (kind === 0xb0) return { type: 'cc', channel, number: data[1], value: data[2], down: data[2] >= 64 };
  return null;
}

export const midiMatches = (input, ev) => input?.kind === 'midi' && input.type === ev.type && input.number === ev.number && input.channel === ev.channel;

export function describeInput(input) {
  if (!input) return 'Ikke lært endnu';
  if (input.kind === 'key') return `Tast ${input.accel.replace(/\+/g, ' + ')}`;
  return `MIDI ${input.type === 'note' ? 'tone' : 'CC'} ${input.number} (kanal ${input.channel})${input.port ? ` · ${input.port}` : ''}`;
}

/** A key a pedal should not send: without Ctrl/Alt/Win it is "stolen" from typing while the app runs. */
export function stealsTyping(accel) {
  if (!accel) return false;
  const parts = accel.split('+');
  if (parts.some((p) => p === 'Ctrl' || p === 'Alt' || p === 'Super')) return false;
  const key = parts[parts.length - 1];
  return !/^(F([1-9]|1\d|2[0-4])|Media\w*|AudioVolume\w*|Launch\w*|Browser\w*|Pause|ScrollLock|Insert)$/.test(key);
}

export const faderValue = (v) => Math.round((Math.min(127, Math.max(0, v)) / 127) * 255);

/** Tap/hold logic for all pedals; actions go through run(id) and release(id). */
export function createPedalRunner({ run, release, setTimer = setTimeout, clearTimer = clearTimeout, holdMs = HOLD_MS, onChange = () => {} }) {
  const st = new Map();
  return {
    down(p) {
      const s = st.get(p.id) || {};
      if (s.down) return; // key repeat, or a controller sending 127 twice
      st.set(p.id, { down: true });
      onChange(p.id, true);
      if (p.mode === 'hold') { if (p.holdAction) run(p.holdAction); return; }
      if (p.mode === 'taphold') {
        const t = { down: true, held: false };
        t.timer = setTimer(() => { t.held = true; if (p.holdAction) run(p.holdAction); }, holdMs);
        st.set(p.id, t);
        return;
      }
      if (p.action) run(p.action);
    },
    up(p) {
      const s = st.get(p.id);
      if (!s?.down) return;
      st.set(p.id, { down: false });
      onChange(p.id, false);
      if (p.mode === 'hold') { if (p.holdAction) release(p.holdAction); return; }
      if (p.mode === 'taphold') {
        clearTimer(s.timer);
        if (s.held) { if (p.holdAction) release(p.holdAction); } else if (p.action) run(p.action);
      }
    },
    isDown: (id) => !!st.get(id)?.down,
  };
}

// ---------- in the app ----------
export async function loadPedals(ctx) {
  ctx.pedals = await storeGet('pedals', []).catch(() => []);
  ctx.pedalRunner = createPedalRunner({
    run: (id) => ctx.runAction(id, 'fodpedal'),
    release: (id) => releaseAction(ctx, id),
    onChange: (id, down) => ctx.onPedal?.(id, down),
  });
}

export const usesMidi = (ctx) => (ctx.pedals || []).some((p) => p.input?.kind === 'midi');

export function savePedals(ctx) {
  storeSet('pedals', ctx.pedals).catch(() => {});
  if (usesMidi(ctx)) midiStart().catch(() => {});
  return ctx.registerHotkeys?.();
}

/** A key pedal pressed or released (from the global hotkey events). */
export function keyPedal(ctx, hotkeyId, down) {
  const p = ctx.pedals?.find((x) => `pedal:${x.id}` === hotkeyId);
  if (!p) return false;
  if (down) ctx.pedalRunner.down(p); else ctx.pedalRunner.up(p);
  return true;
}

// Faders: at most ~20 volume commands a second per channel.
const faderAt = new Map();
function midiMessage(ctx, msg) {
  const ev = midiEvent(msg?.data);
  if (!ev) return;
  if (ctx.pedalLearn) { ctx.pedalLearn({ ...ev, port: msg.port }); return; }
  for (const p of ctx.pedals || []) {
    if (!midiMatches(p.input, ev)) continue;
    if (p.mode === 'fader') {
      if (!p.channel || !ctx.conn.mixer) continue;
      const key = p.channel, now = Date.now();
      const f = faderAt.get(key) || { at: 0 };
      clearTimeout(f.timer);
      const send = () => {
        if (p.channel === CHATMIX) setChatMix(ctx, (ev.value / 127) * 200 - 100);
        else ctx.conn.command('SetVolume', p.channel, faderValue(ev.value));
        faderAt.set(key, { at: Date.now() });
      };
      if (now - f.at > 50) send(); else faderAt.set(key, { at: f.at, timer: setTimeout(send, 60) });
      ctx.onPedal?.(p.id, true, ev.value);
      continue;
    }
    if (ev.down) ctx.pedalRunner.down(p); else ctx.pedalRunner.up(p);
  }
}

/** Listens for MIDI (native events, or window.studioDemo.midi([...]) in the browser demo). */
export async function startPedals(ctx) {
  if (isNative()) {
    await window.__TAURI__.event.listen('midi', (e) => midiMessage(ctx, e.payload));
  } else {
    window.studioDemo = { ...(window.studioDemo || {}), midi: (data, port = 'Demo MIDI-pedal') => midiMessage(ctx, { port, data }) };
  }
  if (usesMidi(ctx)) midiStart().catch(() => {});
}
