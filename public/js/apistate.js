// What the local API (and so the Stream Deck plugin, the phone and Home Assistant) can show: which
// actions are "on" right now – a muted fader, the loaded profile, the EQ preset in use, the limiter …
// Pure, from a snapshot of the app, so it can be tested.

/** snap: { mixer, eq: { enabled, preset, crossfeed, loudness }, ducking, limiter, chatMix, game, clips, media } */
export function activeActions(snap) {
  const out = [];
  const m = snap?.mixer;
  if (m) {
    const micMuted = m.cough_button?.state && m.cough_button.state !== 'Unmuted';
    if (micMuted) out.push('mute-mic', `cough:${m.cough_button.state}`);
    else out.push('cough:Unmuted');
    for (const [f, st] of Object.entries(m.fader_status || {})) if (st?.mute_state && st.mute_state !== 'Unmuted') out.push(`mute-fader:${f}`);
    if (m.profile_name) out.push(`profile:${m.profile_name}`);
    if (m.mic_profile_name) out.push(`micprofile:${m.mic_profile_name}`);
    if (m.effects?.is_enabled) out.push('fx-toggle');
    if (m.sampler?.active_bank) out.push(`sampler-bank:${m.sampler.active_bank}`);
    if (m.router?.Music?.BroadcastMix === false) out.push('stream-safe-music');
  }
  const eq = snap?.eq;
  if (eq?.enabled) {
    out.push('eq-toggle');
    if (eq.preset) out.push(`eq-preset:${eq.preset}`);
  }
  if (eq?.crossfeed) out.push('crossfeed-toggle');
  if (eq?.loudness) out.push('loudness-toggle');
  if (snap?.ducking) out.push('ducking-toggle');
  if (snap?.limiter) out.push('mic-limiter');
  if (snap?.chatMix?.enabled) out.push(snap.chatMix.position > 0 ? 'chatmix:chat' : snap.chatMix.position < 0 ? 'chatmix:game' : 'chatmix:center');
  if (snap?.media?.playing) out.push('media:play-pause');
  return out;
}
