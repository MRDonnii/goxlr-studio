// "Muter også": a fader's mute button (on the GoXLR or in the app) also mutes other channels the
// user picks – e.g. Sample together with Chat. The GoXLR only mutes the fader's own channel, so
// GoXLR Studio follows the button: a linked channel on another fader gets that fader's mute
// button pressed too; a channel without a fader is turned down to 0 (Mix A and, with Submix,
// Mix B) and back to its level when the button is released.
// prefs.muteLinks = { A: ['Sample'], B: [], C: [], D: [] }  (by mute button, not by channel)
// prefs.muteLinkSaved = { Sample: { a: 180, b: 120 } }       (levels to put back, kept across restarts)

export const FADERS = ['A', 'B', 'C', 'D'];
/** Channels a mute button can take along (the outputs Headphones/LineOut/MicMonitor cannot). */
export const LINKABLE = ['Mic', 'LineIn', 'Console', 'System', 'Game', 'Chat', 'Sample', 'Music'];

export function muteLinkSettings(prefs) {
  const l = (prefs.muteLinks ??= {});
  for (const f of FADERS) if (!Array.isArray(l[f])) l[f] = [];
  prefs.muteLinkSaved ??= {};
  return l;
}

const isMuted = (fs) => !!fs && fs.mute_state !== 'Unmuted';

/** The fader a channel is on, or null. */
export function faderOf(mixer, channel) {
  return FADERS.find((f) => mixer?.fader_status?.[f]?.channel === channel) || null;
}

/**
 * One step: compares each mute button with the last state seen (`prev`) and returns the GoXLR
 * commands that make the linked channels follow it. Pure – `prev` and `saved` are returned new.
 * The first time a button is seen nothing happens (GoXLR Studio just started), unless levels were
 * saved by an earlier run while it was muted and it has been released since.
 */
export function muteLinkStep({ prev = {}, saved = {} }, mixer, links) {
  const commands = [];
  const nextPrev = { ...prev };
  const nextSaved = { ...saved };
  if (!mixer?.fader_status) return { commands, prev: nextPrev, saved: nextSaved };
  const vol = mixer.levels?.volumes || {};
  const sub = mixer.levels?.submix;
  // Channels still held down by some other muted button.
  const heldBy = (ch, except) => FADERS.some((g) => g !== except && isMuted(mixer.fader_status[g]) && (links[g] || []).includes(ch));

  for (const f of FADERS) {
    const fs = mixer.fader_status[f];
    if (!fs) continue;
    const muted = isMuted(fs);
    const was = prev[f];
    nextPrev[f] = muted;
    const targets = (links[f] || []).filter((ch) => ch !== fs.channel && LINKABLE.includes(ch));
    if (was === undefined) {
      // Started while released: levels a previous run saved can go back.
      if (!muted) for (const ch of targets) restore(ch, f);
      continue;
    }
    if (muted === was) continue;
    for (const ch of targets) {
      const g = faderOf(mixer, ch);
      if (muted) {
        if (g) {
          if (!isMuted(mixer.fader_status[g])) commands.push(['SetFaderMuteState', g, fs.mute_state === 'MutedToAll' ? 'MutedToAll' : 'MutedToX']);
        } else if (!nextSaved[ch]) {
          const s = { a: vol[ch] ?? 0 };
          const b = sub?.inputs?.[ch];
          if (b && !b.linked) s.b = b.volume;
          if (s.a > 0 || (s.b ?? 0) > 0) {
            nextSaved[ch] = s;
            if (s.a > 0) commands.push(['SetVolume', ch, 0]);
            if ((s.b ?? 0) > 0) commands.push(['SetSubMixVolume', ch, 0]);
          }
        }
      } else if (!heldBy(ch, f)) {
        if (g) {
          if (isMuted(mixer.fader_status[g])) commands.push(['SetFaderMuteState', g, 'Unmuted']);
        } else restore(ch, f);
      }
    }
  }
  return { commands, prev: nextPrev, saved: nextSaved };

  // Back to the saved level – unless the user has turned it up again meanwhile.
  function restore(ch, f) {
    const s = nextSaved[ch];
    if (!s || heldBy(ch, f)) return;
    if (s.a > 0 && (vol[ch] ?? 0) === 0) commands.push(['SetVolume', ch, s.a]);
    if ((s.b ?? 0) > 0 && (sub?.inputs?.[ch]?.volume ?? 0) === 0) commands.push(['SetSubMixVolume', ch, s.b]);
    delete nextSaved[ch];
  }
}

/** Follows the mute buttons on every status change (wired in app.js). */
export function createMuteLinks(ctx) {
  let prev = {};
  let serial = null;
  return () => {
    // The Windows app follows the real GoXLR only; the browser demo follows the demo.
    const ok = ctx.conn.mode === 'live' || (!globalThis.window?.__TAURI__ && ctx.conn.mode === 'demo');
    const m = ok ? ctx.conn.mixer : null;
    if (!m) return;
    if (ctx.conn.serial !== serial) { serial = ctx.conn.serial; prev = {}; }
    // Followed always (cheap), so the first press after choosing channels is not missed.
    const links = muteLinkSettings(ctx.prefs);
    const r = muteLinkStep({ prev, saved: ctx.prefs.muteLinkSaved }, m, links);
    prev = r.prev;
    if (JSON.stringify(r.saved) !== JSON.stringify(ctx.prefs.muteLinkSaved)) {
      ctx.prefs.muteLinkSaved = r.saved;
      ctx.savePrefs?.();
    }
    for (const c of r.commands) ctx.conn.command(...c);
  };
}
