// Lydbanken: plays sound files on the GoXLR's "Sample" output (Windows device "Sample (… GoXLR …)"),
// so the GoXLR's routing sends them to Discord (Chat Mic), the stream and/or the headphones.
import { soundsList, soundsRead } from './native.js';
import { toast } from './ui.js';

const playing = new Set();
const urls = new Map(); // file -> blob URL
let sinkId = null; // the "Sample" output, once found

const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm' };

/** The GoXLR's "Sample" output among the browser's audio outputs, or null. */
export function findSampleOutput(devices) {
  return devices.find((d) => d.kind === 'audiooutput' && /\bsample\b/i.test(d.label) && /goxlr|tc-helicon/i.test(d.label)) || null;
}

async function sampleSink() {
  if (sinkId) return sinkId;
  if (!navigator.mediaDevices?.enumerateDevices) return null;
  let devs = await navigator.mediaDevices.enumerateDevices();
  // Device names are only shown once the page may use the microphone (the app allows that for
  // itself); ask once, then let go of the microphone again.
  if (!devs.some((d) => d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      devs = await navigator.mediaDevices.enumerateDevices();
    } catch { /* no permission – default output */ }
  }
  sinkId = findSampleOutput(devs)?.deviceId || null;
  return sinkId;
}

async function urlFor(file) {
  if (urls.has(file)) return urls.get(file);
  const b64 = await soundsRead(file);
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: MIME[file.split('.').pop().toLowerCase()] || 'audio/mpeg' }));
  urls.set(file, url);
  return url;
}

/** Forget cached audio (after rename/delete). */
export function forgetSound(file) {
  const u = urls.get(file);
  if (u) URL.revokeObjectURL(u);
  urls.delete(file);
}

export async function playSound(ctx, file) {
  const s = ctx.prefs.soundboard || {};
  const audio = new Audio(await urlFor(file));
  audio.volume = Math.max(0, Math.min(1, (s.volume ?? 80) / 100));
  const sink = await sampleSink().catch(() => null);
  if (sink && audio.setSinkId) {
    await audio.setSinkId(sink).catch(() => { sinkId = null; });
  } else if (!ctx.soundSinkWarned) {
    ctx.soundSinkWarned = true;
    toast('Fandt ikke GoXLR’ens Sample-udgang – lyden spilles på standardudgangen', 'info');
  }
  if (s.overlap === false) stopSounds();
  playing.add(audio);
  audio.onended = () => playing.delete(audio);
  await audio.play();
  return audio;
}

export function stopSounds() {
  for (const a of playing) { a.pause(); a.currentTime = 0; }
  playing.clear();
}

export async function soundNames() {
  return soundsList().catch(() => []);
}
