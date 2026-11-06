// Stemmeskifter card on the Lydbank page: a button per voice, how much of it, a key per voice
// (also for Stream Deck and pedals) and "Hør dig selv". The effect runs in GoXLR Studio's plugin on
// Chat Mic (plugins/voiceclean/src/fx.rs), so Discord and games hear it; the pure parts are in
// voicefx.js.
import { h, toast, slider } from './ui.js';
import { engineInfo, engineTask, voiceStatus } from './native.js';
import { VOICE_FX, fxSettings, fxNow, fxStatusText, fxTarget } from './voicefx.js';
import { voiceSettings } from './voicemodel.js';
import { pushVoiceNow, saveVoiceTest } from './voiceclean.js';
import { prettyAccel } from './views-hotkeys.js';

// Opens the mic Discord records (the GoXLR's Chat Mic, with the effect) and plays it in the
// default output, so you hear yourself. Null if it cannot be opened.
async function monitorChatMic() {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  let stream = await navigator.mediaDevices.getUserMedia({ audio: raw });
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const chat = inputs.find((d) => /chat mic/i.test(d.label) && /goxlr|tc-helicon/i.test(d.label));
  if (chat && stream.getAudioTracks()[0]?.getSettings().deviceId !== chat.deviceId) {
    stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({ audio: { ...raw, deviceId: { exact: chat.deviceId } } });
  }
  const ac = new AudioContext({ latencyHint: 'interactive' });
  ac.createMediaStreamSource(stream).connect(ac.destination);
  return () => { stream.getTracks().forEach((t) => t.stop()); ac.close().catch(() => {}); };
}

export function voiceFxCard(ctx, { keyPool }) {
  const s = fxSettings(ctx.prefs);
  const status = h('div', { class: 'hint', 'data-testid': 'fx-status' });
  const pads = h('div', { class: 'fx-pads', 'data-testid': 'fx-pads' });
  const setup = h('div');
  let engine = { at: 0, info: null };
  let stopMonitor = null;

  const apply = () => ctx.applyOutputEq?.()?.catch?.((e) => toast(`EQ-motor: ${e?.message || e}`));
  const keyOf = (action) => ctx.hotkeys.find((b) => b.action === action && b.accel)?.accel;
  const actionFor = (e) => (s.holdKeys ? `hold:voice-fx:${e.id}` : `voice-fx:${e.id}`);
  const giveKey = async (e) => {
    const accel = keyPool.find((k) => !ctx.hotkeys.some((b) => b.accel === k));
    if (!accel) { toast('Alle ledige taster er brugt – giv stemmen en tast under Genveje'); return; }
    ctx.hotkeys.push({ id: crypto.randomUUID(), accel, action: actionFor(e) });
    await ctx.saveHotkeys();
    toast(`${e.label}: ${prettyAccel(accel)}`, 'info');
    render();
  };
  const choose = (id) => ctx.runAction(`voice-fx:${id}`, 'Lydbank');

  const sw = h('input', { type: 'checkbox', 'data-testid': 'fx-on', checked: !!s.enabled, onchange: () => {
    s.enabled = sw.checked;
    ctx.savePrefs();
    apply();
    pushVoiceNow();
    render();
  } });

  const render = () => {
    sw.checked = !!s.enabled;
    const now = fxNow(s, ctx.voiceFxHeld);
    pads.replaceChildren(
      h('div', { class: `sound-pad${!now ? ' on' : ''}` },
        h('button', { class: 'sound-play', 'data-testid': 'fx-normal', title: 'Din egen stemme', onclick: () => ctx.runAction('voice-fx:off', 'Lydbank') }, h('span', { class: 'sound-name' }, 'Normal'), keyOf('voice-fx:off') ? h('span', { class: 'sound-key' }, prettyAccel(keyOf('voice-fx:off'))) : null)),
      ...VOICE_FX.map((e) => {
        const key = keyOf(`voice-fx:${e.id}`) || keyOf(`hold:voice-fx:${e.id}`);
        return h('div', { class: `sound-pad${now?.id === e.id ? ' on' : ''}`, 'data-testid': 'fx-pad', 'data-fx': e.id },
          h('button', { class: 'sound-play', title: e.hint, onclick: () => choose(e.id) },
            h('span', { class: 'sound-name' }, e.label),
            key ? h('span', { class: 'sound-key' }, prettyAccel(key)) : h('span', { class: 'fx-hint' }, e.hint)),
          key ? null : h('div', { class: 'sound-tools' }, h('button', { class: 'btn sm', title: 'Giv stemmen en genvejstast (også til Stream Deck)', onclick: () => giveKey(e) }, 'Tast')));
      }));
  };

  // Status and the setup button, every second while the card is shown.
  const refresh = async () => {
    if (Date.now() - engine.at > 5000) engine = { at: Date.now(), info: await engineInfo().catch(() => null) };
    const info = engine.info;
    const { mic, installed } = fxTarget(voiceSettings(ctx.prefs).device, info?.mics || []);
    const st = s.enabled ? await voiceStatus().catch(() => null) : null;
    status.textContent = fxStatusText(s, st, { installed, outdated: installed && !!info?.voice_outdated, held: ctx.voiceFxHeld });
    let need = null;
    if (s.enabled && info?.kind === 'builtin' && info.voice_bundled && mic) {
      if (!installed) need = { text: `EQ-motoren skal sættes på ${mic.name} (kræver administrator én gang; Windows’ lyd genstarter et øjeblik).`, button: 'Sæt den på', devices: [mic.id] };
      else if (info.voice_outdated) need = { text: 'Stemmeskifter kræver den nye udgave af pluginnet på mikrofonen (administrator; Windows’ lyd genstarter et øjeblik).', button: 'Opdatér', devices: info.mics.filter((d) => d.installed).map((d) => d.id) };
    }
    const key = need ? need.button + need.devices.join() : '';
    if (setup.dataset.key === key) return;
    setup.dataset.key = key;
    setup.replaceChildren(need ? h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'hint' }, need.text),
      h('button', { class: 'btn sm primary', 'data-testid': 'fx-install', onclick: async (ev) => {
        ev.target.disabled = true;
        try {
          const r = await engineTask({ action: 'set-mics', devices: need.devices });
          saveVoiceTest(r);
          toast(r?.ok ? 'Stemmeskifter er klar på mikrofonen' : `Det lykkedes ikke: ${r?.error || '?'}`, r?.ok ? 'info' : 'error');
        } catch (err) { toast(String(err)); }
        engine.at = 0;
        apply();
      } }, need.button)) : '');
  };
  let lastNow = null;
  const timer = setInterval(() => {
    if (!card.isConnected) { clearInterval(timer); stopMonitor?.(); stopMonitor = null; return; }
    const id = fxNow(s, ctx.voiceFxHeld)?.id || null;
    if (id !== lastNow || sw.checked !== !!s.enabled) { lastNow = id; render(); }
    refresh();
  }, 1000);

  const listen = h('button', { class: 'btn sm', 'data-testid': 'fx-listen', onclick: async () => {
    if (stopMonitor) { stopMonitor(); stopMonitor = null; listen.textContent = 'Hør dig selv'; return; }
    try {
      stopMonitor = await monitorChatMic();
      if (stopMonitor) listen.textContent = 'Stop med at lytte';
      else toast('Mikrofonen kunne ikke åbnes');
    } catch (e) { toast(`Mikrofonen kunne ikke åbnes: ${e?.message || e}`); }
  } }, 'Hør dig selv');

  const hold = h('input', { type: 'checkbox', 'data-testid': 'fx-hold', checked: !!s.holdKeys, onchange: () => { s.holdKeys = hold.checked; ctx.savePrefs(); } });

  const card = h('div', { class: 'card', 'data-testid': 'voice-fx' },
    h('h2', {}, 'Stemmeskifter', h('label', { class: 'switch', title: 'Stemmeskifter til/fra' }, sw, h('span'))),
    status, setup,
    h('div', { style: { marginTop: '8px' } }, pads),
    slider(ctx.binder, { label: 'Styrke', min: 10, max: 100, get: () => s.mix ?? 100, set: (v) => { s.mix = v; ctx.savePrefs(); pushVoiceNow(); }, fmt: (v) => `${v} %` }),
    h('label', { class: 'engine-dev' }, hold, h('span', {}, 'Nye taster virker kun, mens de holdes nede')),
    h('div', { class: 'row', style: { marginTop: '8px' } }, listen, h('span', { class: 'hint' }, 'Brug hovedtelefoner, ellers hyler det.')),
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Stemmen ændres på Chat Mic – det Discord, spil og opkald hører. Stream og optagelse (Broadcast Mix) får din normale stemme. Kører i GoXLR Studio, så den er hurtig og bruger næsten ingen CPU. Under Genveje kan du også vælge "Stemme: …, mens tasten holdes".'));
  render();
  refresh();
  return card;
}
