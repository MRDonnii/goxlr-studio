// Ren mikrofon (pure parts, tested in tests/voiceclean.test.mjs): echo and noise removal on the
// GoXLR's "Chat Mic" by GoXLR Studio's plugin in the EQ engine (plugins/voiceclean). The echo
// canceller needs to know what the speakers play: the GoXLR channels routed to the output the
// speakers are on, each weighted by its fader – or another output that the speakers are on.

export const NOISE_LEVELS = [['off', 'Fra'], ['normal', 'Normal'], ['strong', 'Stærk']];
const NOISE_VALUE = { off: 0, normal: 0.5, strong: 1 };

export const DEFAULT_VOICE = { enabled: false, echo: true, noise: 'normal', highPass: true, device: null, deviceName: null, speakers: 'Headphones' };

// The settings object itself (filled with defaults in place, so every part shares it).
export function voiceSettings(prefs) {
  const v = (prefs.voiceClean ??= {});
  for (const [k, d] of Object.entries(DEFAULT_VOICE)) if (v[k] === undefined) v[k] = d;
  return v;
}

// The Windows-fed GoXLR channels: router input, volume name, Windows output (extras.js channelEndpoint).
export const REFERENCE_CHANNELS = [
  { input: 'System', volume: 'System', endpoint: 'System' },
  { input: 'Game', volume: 'Game', endpoint: 'Game' },
  { input: 'Chat', volume: 'Chat', endpoint: 'Chat' },
  { input: 'Music', volume: 'Music', endpoint: 'Music' },
  { input: 'Samples', volume: 'Sample', endpoint: 'Sample' },
];
export const GOXLR_SPEAKER_OUTPUTS = ['Headphones', 'LineOut'];

// The GoXLR's fader (0–255) as a linear gain – an estimate of its curve (≈ −12 dB at half way).
// The echo canceller learns the overall level by itself; this keeps the channels' balance right.
export function faderGain(v) {
  const x = Math.min(Math.max(Number(v) || 0, 0), 255) / 255;
  return x * x;
}

// Muted on this output? (GoXLR Utility's MuteState/MuteFunction.)
export function mutedOn(mixer, channel, output) {
  const f = Object.values(mixer?.fader_status || {}).find((x) => x?.channel === channel);
  if (!f) return false;
  if (f.mute_state === 'MutedToAll') return true;
  if (f.mute_state !== 'MutedToX') return false;
  const fn = f.mute_type || 'All';
  return fn === 'All' || (fn === 'ToPhones' && output === 'Headphones') || (fn === 'ToLineOut' && output === 'LineOut');
}

function volumeOf(mixer, volume, output) {
  const lv = mixer?.levels || {};
  const sub = lv.submix;
  if (sub && sub.outputs?.[output] === 'B' && Number.isFinite(sub.inputs?.[volume]?.volume)) return sub.inputs[volume].volume;
  return lv.volumes?.[volume] ?? 0;
}

// What the speakers play: { sources: [{device, gain, channel}], notes: [{code, channel?}] }.
// speakers = 'Headphones' | 'LineOut' (a GoXLR output) or a Windows output id.
// `endpointOf(channel)` finds the GoXLR's Windows output for a channel (channelEndpoint).
export function referenceSources(mixer, speakers, endpointOf) {
  const sources = [];
  const notes = [];
  if (!GOXLR_SPEAKER_OUTPUTS.includes(speakers)) {
    if (speakers) sources.push({ device: speakers, gain: 1, channel: null });
    else notes.push({ code: 'no-speakers' });
    return { sources, notes };
  }
  if (!mixer?.router) return { sources, notes: [{ code: 'no-goxlr' }] };
  const master = faderGain(mixer.levels?.volumes?.[speakers] ?? 255);
  for (const c of REFERENCE_CHANNELS) {
    const route = mixer.router[c.input];
    if (!route?.[speakers]) continue;
    const device = endpointOf(c.endpoint);
    // Sent to the chat on purpose (e.g. music): the echo canceller must not remove it.
    if (route.ChatMic) { notes.push({ code: 'to-chat', channel: c.input }); continue; }
    if (!device) { notes.push({ code: 'no-endpoint', channel: c.endpoint }); continue; }
    const gain = mutedOn(mixer, c.volume, speakers) ? 0 : faderGain(volumeOf(mixer, c.volume, speakers)) * master;
    sources.push({ device, gain: Math.round(gain * 10000) / 10000, channel: c.volume });
  }
  // Sound Windows does not play cannot be removed: the mic itself, Console and Line In.
  if (mixer.router.Microphone?.[speakers] && (mixer.levels?.volumes?.MicMonitor ?? 0) > 0) notes.push({ code: 'mic-monitor' });
  for (const input of ['Console', 'LineIn']) {
    if (mixer.router[input]?.[speakers] && (mixer.levels?.volumes?.[input] ?? 0) > 0) notes.push({ code: 'hardware-input', channel: input });
  }
  return { sources, notes };
}

// Channels sent to the Chat Mic (the teammates hear them directly, whatever the speakers do).
export function chatMicRoutes(mixer) {
  return ['Music', 'Game', 'Console', 'LineIn', 'System', 'Chat', 'Samples'].filter((i) => mixer?.router?.[i]?.ChatMic);
}

// The microphone to put it on: the GoXLR's "Chat Mic" (what Discord and games use).
export function pickChatMic(mics = []) {
  const goxlr = mics.filter((d) => /goxlr|tc-helicon/i.test(d.name));
  return goxlr.find((d) => /chat\s*mic/i.test(d.name)) || null;
}

// For config.txt (apo.rs MicClean): on the microphone(s) the engine is on. While "Fang alt" is held
// (`openMicHeld`) the mic passes untouched, so everything comes through.
export function micPayload(cfg, mics = [], { openMicHeld = false } = {}) {
  if (!cfg?.enabled || !cfg.device || openMicHeld) return null;
  const on = mics.find((d) => d.installed && d.id.toLowerCase() === cfg.device.toLowerCase());
  if (!on) return null;
  return { devices: [on.id], echo: !!cfg.echo, noise: NOISE_VALUE[cfg.noise] ?? 0.5, high_pass: cfg.highPass !== false };
}

// For the echo reference writer (voiceref.rs). It also reads the plugin's status, so it runs
// whenever Ren mikrofon is on; the speakers are only captured with the echo canceller on.
export function referencePayload(cfg, mixer, endpointOf) {
  if (!cfg?.enabled) return { enabled: false, sources: [] };
  if (!cfg.echo) return { enabled: true, sources: [] };
  const { sources } = referenceSources(mixer, cfg.speakers, endpointOf);
  return { enabled: true, sources: sources.map(({ device, gain }) => ({ device, gain })) };
}

// One line for the card and the Diagnose page: { level, parts, text }.
export function voiceStatusLine(cfg, st, { installed = false } = {}) {
  const line = (level, parts) => ({ level, parts, text: parts.join(' · ') });
  if (!cfg?.enabled) return line('off', ['Slået fra']);
  if (!installed) return line('warn', ['EQ-motoren er ikke sat på Chat Mic endnu']);
  if (!st?.plugin) return line('idle', ['Klar – starter, når en app (fx Discord) bruger mikrofonen']);
  if (st.bypassed) return line('warn', ['Mikrofonen sendes urørt videre – Chat Mic skal køre 48 kHz']);
  const parts = [];
  if (st.noise) parts.push('støjfjerner kører');
  if (st.echo) {
    if (!st.reference) parts.push('ekkofjerneren får ingen højttalerlyd');
    else if (Number.isFinite(st.erle_db) && st.erle_db > 1) parts.push(`ekko dæmpes ${Math.round(st.erle_db)} dB`);
    else parts.push('ekkofjerner kører');
  }
  return line(st.echo && !st.reference ? 'warn' : 'ok', parts.length ? parts : ['Kører']);
}

// The notes as text (with what to do).
export function noteText(n) {
  const name = { Music: 'Musik', Game: 'Spil', System: 'System', Chat: 'Chat', Samples: 'Samples', Console: 'Console', LineIn: 'Line In' }[n.channel] || n.channel;
  switch (n.code) {
    case 'to-chat': return `${name} sendes også direkte til Chat Mic, så dine medspillere hører det uanset højttalerne – og ekkofjerneren lader det være.`;
    case 'no-endpoint': return `Fandt ikke GoXLR’ens Windows-udgang for ${name}.`;
    case 'mic-monitor': return 'Din mikrofon sendes ud på højttalerne (Mic Monitor) – det kan ikke fjernes som ekko. Skru Mic Monitor ned, eller fjern Mikrofon fra højttaler-udgangen i routingen.';
    case 'hardware-input': return `Sidder der noget i ${name} på GoXLR’en, spiller det på højttalerne uden om Windows – den lyd kan ekkofjerneren ikke fjerne.`;
    case 'no-speakers': return 'Vælg hvor højttalerne sidder.';
    case 'no-goxlr': return 'GoXLR’en er ikke forbundet.';
    default: return n.code;
  }
}
