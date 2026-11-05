// Ren mikrofon (pure parts, tested in tests/voiceclean.test.mjs): echo and noise removal on the
// GoXLR's "Chat Mic" by GoXLR Studio's plugin in the EQ engine (plugins/voiceclean). The echo
// canceller needs to know what the speakers play: the GoXLR channels routed to the output the
// speakers are on, each weighted by its fader – or another output that the speakers are on.

export const NOISE_LEVELS = [['off', 'Fra'], ['normal', 'Normal'], ['strong', 'Stærk'], ['isolate', 'Stemmeisolering']];
// Stemmeisolering = the plugin's Isolate parameter; Noise 1 (strong) is what an older plugin uses.
const NOISE_VALUE = { off: 0, normal: 0.5, strong: 1, isolate: 1 };
export const NOISE_HINT = {
  off: 'Ingen støjfjerner.',
  normal: 'Normal: fjerner jævn støj som blæser, pc og brum – stemmen røres næsten ikke.',
  strong: 'Stærk: fjerner også tastatur, klik og spillyd mellem og under ordene (RNNoise, et lille neuralt netværk). Stemmen kan blive en anelse mere "tør".',
  isolate: 'Stemmeisolering: kun din stemme kommer igennem – tastatur, mus, blæser, spillyd, hund og alt andet fjernes, også under ordene, og der er stille mellem ordene. Samme slags neurale netværk som Discords støjreduktion (DeepFilterNet 3). Giver 30 ms ekstra forsinkelse og bruger lidt mere CPU.',
};

export const DEFAULT_VOICE = { enabled: false, echo: true, noise: 'isolate', highPass: true, amount: 'full', device: null, deviceName: null, speakers: 'Headphones' };

// Styrke for Stemmeisolering (the plugin's Amount parameter, see residual() in plugins/voiceclean):
// how much of the background is left – full = nothing, medium −20 dB, light −10 dB.
export const AMOUNT_LEVELS = [['full', 'Fuld'], ['medium', 'Mellem'], ['light', 'Let']];
const AMOUNT_VALUE = { full: 1, medium: 0.5, light: 0 };
export const AMOUNT_HINT = {
  full: 'Kun din stemme – alt andet fjernes.',
  medium: 'Baggrunden dæmpes 20 dB i stedet for at forsvinde helt – lyder mere naturligt.',
  light: 'Baggrunden dæmpes 10 dB – rummet kan høres svagt.',
};

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
  const isolate = cfg.noise === 'isolate';
  const amount = isolate ? AMOUNT_VALUE[cfg.amount] ?? 1 : 1;
  return { devices: [on.id], echo: !!cfg.echo, noise: NOISE_VALUE[cfg.noise] ?? 0.5, high_pass: cfg.highPass !== false, isolate, amount };
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
  if (st.broken) return line('warn', ['Mikrofonen sendes urørt videre – renseren stødte på en fejl']);
  if (st.bypassed) return line('warn', ['Mikrofonen sendes urørt videre – Chat Mic skal køre 48 kHz']);
  const parts = [];
  if (st.isolate === 'running') parts.push('stemmeisolering kører');
  else if (st.isolate === 'loading') parts.push('stemmeisolering starter …');
  else if (st.isolate === 'unavailable') parts.push('stemmeisolering findes ikke i denne udgave – bruger Stærk');
  else if (st.noise) parts.push('støjfjerner kører');
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

// ---------- the check (what is wrong when teammates still hear everything) ----------
const DISCORD = /^discord(ptb|canary|development)?\.exe$/i;
const LEGACY_TIP = 'Prøv i Discord: Indstillinger → Stemme og video → Avanceret → Lyd-undersystem = Legacy, og genstart Discord helt (også i bakken).';
// The GUID at the end of an endpoint id (what config.txt's Device: names); the whole id otherwise.
const guidOf = (id) => (String(id || '').match(/\{[0-9a-f-]+\}$/i)?.[0] || String(id || '')).toLowerCase();

/**
 * Ren mikrofon's check, step by step: { items: [{ id, ok: true|false|null, text, fix? }], allGood }.
 * ok null = cannot tell yet (e.g. Discord is not recording). Inputs: cfg (prefs.voiceClean),
 * mic (the engine's entry for the chosen mic), outdated, check (voice_check: recordings, config),
 * status (voice_status; `instances` = recordings being cleaned, smoothed by the caller), test
 * (the mic's last engine test with `streams`, see engine.rs StreamTest), nameOf(id) for names.
 */
export function voiceDiagnosis({ cfg, mic, outdated = false, check = null, status = null, test = null, nameOf = (id) => id }) {
  const items = [];
  const add = (id, ok, text, fix) => items.push({ id, ok, text, ...(fix ? { fix } : {}) });
  if (!cfg?.enabled) return { items: [{ id: 'off', ok: null, text: 'Ren mikrofon er slået fra' }], allGood: false };
  if (!mic?.installed) {
    add('installed', false, 'EQ-motoren er ikke sat på Chat Mic', 'install');
    return { items, allGood: false };
  }
  add('installed', true, `EQ-motoren sidder på ${mic.name}`);
  if (outdated) add('version', false, 'Ren mikrofon-pluginnet er en ældre udgave', 'update');
  // 0.14.2: registered for normal recordings only, Discord (communications) went around it.
  const streams = test?.streams || null;
  // (An outdated plugin's Opdatér fixes this too.)
  if (mic.voice_programs === false && !outdated && !(streams && !streams.all_modes)) {
    add('programs', false, 'EQ-motoren på mikrofonen er kun sat op til almindelige optagelser – Discord og andre stemmeprogrammer får mikrofonen urenset', 'update');
  }
  const conf = check?.config;
  const nothingOn = !cfg.echo && cfg.noise === 'off' && cfg.highPass === false;
  if (conf && nothingOn) add('config', null, 'Ekkofjerner, støjfjerner og rumlefilter er alle slået fra – der er intet at rense med');
  else if (conf) {
    const here = conf.devices.some((d) => d.toLowerCase() === guidOf(mic.id));
    if (conf.plugin && here) add('config', true, 'EQ-motoren har fået indstillingerne');
    else add('config', false, 'Indstillingerne er ikke skrevet til EQ-motoren', 'apply');
    if (cfg.noise === 'isolate' && conf.plugin && !conf.isolate) add('config-isolate', false, 'Stemmeisolering er ikke slået til i EQ-motoren', outdated ? 'update' : 'apply');
  }
  // Who records from which mic.
  const recs = check?.recordings || [];
  const discord = recs.filter((r) => DISCORD.test(r.exe));
  const fromChat = (r) => guidOf(r.device) === guidOf(mic.id);
  const onChat = discord.some(fromChat);
  if (!discord.length) add('discord', null, 'Discord optager ikke lige nu – start et opkald (eller "Mikrofontest" i Discord) for at tjekke resten');
  else if (onChat) add('discord', true, `Discord optager fra ${mic.name}`);
  else {
    const other = nameOf(discord.find((r) => r.active)?.device || discord[0].device);
    add('discord', false, `Discord optager fra "${other}" – den bliver ikke renset. Vælg "${mic.name}" som inputenhed i Discord (Indstillinger → Stemme og video).`);
  }
  // Does the plugin actually get the sound?
  const anyOnChat = recs.some(fromChat);
  if (status?.plugin) add('running', true, 'Renseren kører på mikrofonens lyd');
  else if (anyOnChat) add('running', false, 'Der optages fra Chat Mic, men renseren kører ikke på lyden – EQ-motoren bliver ikke indlæst på mikrofonen', 'mode');
  else add('running', null, 'Renseren starter, når et program optager fra Chat Mic');
  // Every recording from the mic should have its own cleaner: fewer means a program gets the mic
  // around it (plugins from 0.14.2 count themselves).
  const active = recs.filter((r) => fromChat(r) && r.active);
  // Passing the mic through untouched (not 48 kHz, or after an error): the plugin reports only
  // that, so nothing else about it can be judged.
  const passing = !!(status?.plugin && (status.bypassed || status.broken));
  const counted = status?.plugin && !passing && Number.isFinite(status.instances);
  if (counted && active.length) {
    const discordActive = active.some((r) => DISCORD.test(r.exe));
    if (status.instances >= active.length) {
      add('cleaned', true, discordActive ? 'Discords optagelse bliver renset' : `Alle ${active.length} optagelser fra Chat Mic bliver renset`);
    } else {
      const who = discordActive ? 'Discord' : (active[0]?.exe || 'et program');
      add('cleaned', false, `Optager fra Chat Mic: ${active.length} · renses: ${status.instances} – ${who} får sikkert mikrofonen uden om renseren. ${LEGACY_TIP}`, 'test');
    }
  }
  if (streams) {
    if (streams.communications === true) add('streams', true, 'Testen viser: optagelser som Discords bliver renset');
    else if (streams.communications === false) add('streams', false, `Testen viser: optagelser som Discords bliver ikke renset. ${LEGACY_TIP}`, 'test');
    else if (!streams.all_modes) add('streams', false, `Windows afviste Discords optagetilstand med Ren mikrofon på, så den er slået fra. ${LEGACY_TIP}`);
    else add('streams', null, 'Testen kunne ikke åbne en optagelse som Discords', 'test');
  } else if (mic.voice_programs === true && !counted) {
    add('streams', null, 'Test om optagelser som Discords bliver renset', 'test');
  }
  if (status?.plugin) {
    if (status.broken) add('rate', false, 'Renseren stødte på en fejl og sender mikrofonen urørt videre – en test starter den igen', 'test');
    else if (status.bypassed) add('rate', false, 'Chat Mic kører ikke 48 kHz – lyden sendes urørt videre. Skift det i Windows: Lyd → Optagelse → Chat Mic → Egenskaber → Avanceret → 48000 Hz.');
  }
  if (status?.plugin && !passing) {
    if (cfg.noise === 'isolate') {
      if (status.isolate === 'running') add('isolate', true, 'Stemmeisolering kører');
      else if (status.isolate === 'loading') add('isolate', null, 'Stemmeisolering starter …');
      else add('isolate', false, 'Stemmeisolering kører ikke – Stærk bruges i stedet', outdated ? 'update' : 'apply');
    }
    if (cfg.echo) {
      if (status.reference) add('echo', true, 'Ekkofjerneren får højttalernes lyd');
      else add('echo', false, 'Ekkofjerneren får ingen lyd fra højttalerne – tjek "Højttalerne sidder på"');
    }
    if (Number.isFinite(status.in_db) && Number.isFinite(status.out_db)) {
      add('levels', null, `Mikrofonen ind ${Math.round(status.in_db)} dB → ud ${Math.round(status.out_db)} dB`);
    }
  }
  const allGood = items.every((i) => i.ok !== false) && onChat && !!status?.plugin && !passing && (!counted || items.some((i) => i.id === 'cleaned' && i.ok));
  return { items, allGood };
}

/** The newest engine test of this mic among saved test results ({at, tests}), or null. */
export function latestMicTest(saved, micId) {
  const g = guidOf(micId);
  let best = null;
  for (const r of saved || []) {
    const t = (r?.tests || []).find((x) => x.capture && guidOf(x.guid) === g);
    if (t && (!best || (r.at || 0) > best.at)) best = { at: r.at || 0, test: t };
  }
  return best?.test || null;
}

/** Recordings being cleaned, as the largest count of the last `ms` (a program that just stopped is
 *  gone from the count before the recordings list notices). `hist` = [{at, n}], changed in place. */
export function smoothInstances(hist, n, now, ms = 4000) {
  if (Number.isFinite(n)) hist.push({ at: now, n });
  while (hist.length && now - hist[0].at > ms) hist.shift();
  return hist.length ? Math.max(...hist.map((x) => x.n)) : null;
}

/** The check as plain text (for "Kopiér tjek"). */
export function diagnosisText(d) {
  return d.items.map((i) => `${i.ok === true ? '✓' : i.ok === false ? '✗' : '–'} ${i.text}`).join('\n');
}

// ---------- "Test din mikrofon": typing without talking, then talking, measured in the plugin ----------
export const MIC_TEST_STEPS = [
  { id: 'typing', seconds: 6, text: 'Vær helt stille, og tast løs på tastaturet' },
  { id: 'speech', seconds: 6, text: 'Tal nu normalt – fx tæl langsomt til tyve' },
];
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

/**
 * The verdict of the test from the plugin's levels (voice_status in_db/out_db, every ~¼ s) in each
 * step: { typing: [{in_db, out_db}], speech: [...] } → { code, typingCut, voiceLoss, lines }.
 * Codes: good · weak (typing not removed enough) · voice-cut (the voice is dampened) ·
 * no-typing (nothing heard while typing – the GoXLR's gate already takes it) · no-speech ·
 * not-running (the cleaner got no sound).
 */
export function micTestVerdict({ typing = [], speech = [], noise = 'isolate', amount = 'full', passing = null }) {
  // The plugin passed the mic through (not 48 kHz, or an error): that is the answer.
  if (passing) {
    return { code: 'passing', typingCut: null, voiceLoss: null, lines: [passing === 'broken' ? 'Renseren stødte på en fejl og sendte mikrofonen urørt videre – tryk "Test" i tjekket ovenfor.' : 'Renseren sendte mikrofonen urørt videre, fordi Chat Mic ikke kører 48 kHz – skift det i Windows (Lyd → Optagelse → Chat Mic → Egenskaber → Avanceret).'] };
  }
  const ok = (s) => Number.isFinite(s?.in_db) && Number.isFinite(s?.out_db);
  const t = typing.filter(ok);
  const v = speech.filter(ok);
  if (!t.length && !v.length) return { code: 'not-running', typingCut: null, voiceLoss: null, lines: ['Renseren fik ingen lyd under testen – kører Ren mikrofon på Chat Mic?'] };
  // Quiet mics exist (a GoXLR Mini at −55 dB while talking): only near-silence counts as nothing.
  const heardKeys = t.filter((s) => s.in_db > -75);
  const typingCut = heardKeys.length ? median(heardKeys.map((s) => s.in_db - s.out_db)) : null;
  // The voice: the louder half of the samples with speech in them.
  const talk = v.filter((s) => s.in_db > -72).sort((a, b) => b.in_db - a.in_db);
  const loud = talk.slice(0, Math.max(1, Math.ceil(talk.length / 2)));
  const voiceLoss = talk.length ? median(loud.map((s) => s.in_db - s.out_db)) : null;
  const lines = [];
  if (typingCut === null) lines.push('Tasterne nåede ikke renseren (GoXLR’ens noise gate tog dem allerede) – fint.');
  else lines.push(`Tasterne dæmpes ${Math.round(typingCut)} dB`);
  if (voiceLoss === null) lines.push('Vi hørte ingen tale i anden del – er mikrofonen muted, eller er gain skruet helt ned?');
  else lines.push(voiceLoss <= 3 ? 'Din stemme kommer igennem uændret' : `Din stemme dæmpes ${Math.round(voiceLoss)} dB`);
  let code = 'good';
  if (voiceLoss === null) code = 'no-speech';
  else if (voiceLoss > 6) code = 'voice-cut';
  else if (typingCut === null) code = 'no-typing';
  // What Styrke lets through on purpose (−20 dB medium, −10 dB light) is not too little.
  const isolating = noise === 'isolate';
  const expected = isolating ? { full: 15, medium: 12, light: 6 }[amount] ?? 15 : 15;
  if (code === 'good' && typingCut !== null && typingCut < expected) code = 'weak';
  if (code === 'good' || code === 'no-typing') lines.push('Ren mikrofon virker: det er sådan, Discord får din mikrofon.');
  // A very quiet voice is cleaned all right (0.15.2), but others hear it faintly or with Discord's
  // gain control pumping the noise up.
  const voiceIn = talk.length ? median(loud.map((s) => s.in_db)) : null;
  if (voiceIn !== null && voiceIn < -45) lines.push(`Din stemme er meget svag (${Math.round(voiceIn)} dB, mens du taler). Skru gain op – Mikrofon-assistenten hjælper.`);
  if (code === 'weak') {
    if (!isolating) lines.push('Tasterne er ikke væk. Vælg Støjfjerner "Stemmeisolering".');
    else if (amount !== 'full') lines.push('Tasterne er ikke væk. Sæt Styrke på "Fuld".');
    else lines.push('Tasterne er ikke væk, selv om Stemmeisolering er valgt – tryk "Kopiér tjek", og send teksten.');
  }
  if (code === 'voice-cut') lines.push('Stemmen dæmpes for meget. Skru gain op på GoXLR’en (Mikrofon-assistenten hjælper), eller sæt Styrke ned.');
  return { code, typingCut, voiceLoss, lines };
}
