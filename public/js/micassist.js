// Mikrofon-assistenten and "Fortryd" for the mic settings – pure parts, tested in tests/mic.test.mjs.
//
// The GoXLR's mic meter (GetMicLevel) is in dB from −72 to 0 after the mic gain, the same scale as
// the noise gate's threshold (−59 … 0). The assistant listens to the room for a few seconds, then
// to normal speech, and from that sets the gain (speech around −15 dB, peaks below −6 dB) and a
// gate a little above the room's noise but well below the voice.
import { EQ_BANDS, MINI_EQ_BANDS } from './demo.js';
import { GATE_TIMES, RATIOS, ATTACKS, RELEASES, enumIndex } from './micenums.js';

export const SPEECH_TARGET = -15;
export const PEAK_LIMIT = -6;

export function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.round((p / 100) * (v.length - 1))))];
}

/** From levels (dB) measured in silence and while speaking: new gain and gate threshold. */
export function analyzeMicTest({ silence, speech, gain, maxGain = 72 }) {
  const noise = percentile(silence, 90);
  const talk = percentile(speech, 90);
  const peak = speech.length ? Math.max(...speech.filter(Number.isFinite)) : null;
  if (noise == null || talk == null || peak == null) return { error: 'Fik ingen måling fra mikrofonen. Er GoXLR’en forbundet?' };
  if (talk - noise < 6) {
    return { error: 'Kunne ikke høre forskel på stilhed og tale. Tjek, at mikrofonen er tændt (og har +48V, hvis den er en kondensator), og prøv igen tættere på.' };
  }
  const warnings = [];
  // Loud speech to the target, but never so much that the peaks come near 0 dB.
  const wanted = Math.max(-24, Math.min(24, Math.min(Math.round(SPEECH_TARGET - talk), Math.floor(PEAK_LIMIT - peak))));
  const newGain = Math.max(0, Math.min(maxGain, gain + wanted));
  const delta = newGain - gain;
  if (gain + wanted > maxGain) {
    warnings.push('Mikrofonen er svag: selv fuld gain når ikke helt op. Tal tættere på (5–10 cm) – en dynamisk mikrofon kan også få en forforstærker (fx Cloudlifter).');
  }
  const noiseAfter = noise + delta;
  const talkAfter = talk + delta;
  // A little above the room, well below the voice.
  const gate = Math.max(-59, Math.min(-10, Math.round(Math.min(noiseAfter + 8, talkAfter - 12))));
  if (talkAfter - noiseAfter < 18) {
    warnings.push('Der er meget baggrundsstøj i forhold til din stemme (fx en blæser eller pc). Tal tættere på mikrofonen, eller dæmp støjen – noise gate’en kan kun skære det værste væk.');
  }
  return { noise, talk, peak, gain, newGain, delta, gate, noiseAfter, talkAfter, warnings };
}

/** Everything "Indstil til min mikrofon" and the assistant can change, as it is now. */
export function micSnapshot(mixer) {
  const mic = mixer.mic_status;
  return {
    type: mic.mic_type,
    gains: { ...mic.mic_gains },
    eq: mic.equaliser ? structuredClone(mic.equaliser) : null,
    eqMini: mic.equaliser_mini ? structuredClone(mic.equaliser_mini) : null,
    gate: { ...mic.noise_gate },
    comp: { ...mic.compressor },
    deess: mixer.levels?.deess ?? null,
  };
}

/** The commands that put a snapshot back (times and ratios as list positions, see micenums.js). */
export function snapshotCommands(s, mini) {
  const out = [['SetMicrophoneType', s.type]];
  if (Number.isFinite(s.gains?.[s.type])) out.push(['SetMicrophoneGain', s.type, s.gains[s.type]]);
  const eq = mini ? s.eqMini : s.eq;
  for (const b of mini ? MINI_EQ_BANDS : EQ_BANDS) {
    if (eq?.frequency?.[b] == null || eq?.gain?.[b] == null) continue;
    out.push([mini ? 'SetEqMiniFreq' : 'SetEqFreq', b, eq.frequency[b]], [mini ? 'SetEqMiniGain' : 'SetEqGain', b, eq.gain[b]]);
  }
  const g = s.gate || {};
  out.push(['SetGateActive', !!g.enabled], ['SetGateThreshold', g.threshold], ['SetGateAttenuation', g.attenuation],
    ['SetGateAttack', enumIndex(GATE_TIMES, g.attack)], ['SetGateRelease', enumIndex(GATE_TIMES, g.release)]);
  const c = s.comp || {};
  out.push(['SetCompressorThreshold', c.threshold], ['SetCompressorRatio', enumIndex(RATIOS, c.ratio)], ['SetCompressorAttack', enumIndex(ATTACKS, c.attack)],
    ['SetCompressorReleaseTime', enumIndex(RELEASES, c.release)], ['SetCompressorMakeupGain', c.makeup_gain]);
  if (Number.isFinite(s.deess)) out.push(['SetDeeser', s.deess]);
  return out.filter((cmd) => cmd.slice(1).every((a) => a !== undefined && a !== null));
}
