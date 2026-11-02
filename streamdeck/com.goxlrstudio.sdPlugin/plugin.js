// GoXLR Studio for Stream Deck. Two actions:
//  • "GoXLR Studio-handling": runs any GoXLR Studio action and lights up while it is "on"
//    (mic muted, the profile/EQ preset in use, limiter …) – from the API's `active` list.
//  • "GoXLR Studio-lydstyrke": a channel's volume – a dial on Stream Deck + (turn = volume,
//    press = mute), or a key (press = a step up, or down when set so).
// Every second the plugin reads /state from GoXLR Studio's local API (127.0.0.1, token).
// The same code runs in Streonor / MiraBox StreamDock (manifest.streamdock.json): its knobs are
// controller "Knob" (no screen of their own), the events are the same.
/* global GXS */
let ws = null;
let pluginUUID = '';
let globals = {};
let lang = 'en';
const contexts = new Map(); // context → { action, settings, controller, userTitle }
let state = null;
let actions = [];
let online = false;

const L = {
  da: { offline: 'Ikke\nforbundet', token: 'Token?', none: 'Vælg\nhandling', muted: 'muted' },
  en: { offline: 'Not\nconnected', token: 'Token?', none: 'Pick an\naction', muted: 'muted' },
};
const t = (k) => (L[lang] || L.en)[k];
const send = (o) => { if (ws?.readyState === 1) ws.send(JSON.stringify(o)); };
const setState = (context, s) => send({ event: 'setState', context, payload: { state: s } });
const setTitle = (context, title) => send({ event: 'setTitle', context, payload: { title, target: 0 } });

// Called by the Stream Deck app.
// eslint-disable-next-line no-unused-vars
function connectElgatoStreamDeckSocket(port, uuid, registerEvent, info) {
  pluginUUID = uuid;
  try { lang = GXS.lang(JSON.parse(info)); } catch { /* default */ }
  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.onopen = () => {
    send({ event: registerEvent, uuid });
    send({ event: 'getGlobalSettings', context: uuid });
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}

function handle(msg) {
  const { event, context, action, payload } = msg;
  switch (event) {
    case 'didReceiveGlobalSettings': globals = payload?.settings || {}; poll(true); break;
    case 'willAppear': contexts.set(context, { action, settings: payload?.settings || {}, controller: payload?.controller, userTitle: '' }); render(context); break;
    case 'willDisappear': contexts.delete(context); break;
    case 'didReceiveSettings': { const c = contexts.get(context); if (c) { c.settings = payload?.settings || {}; render(context); } break; }
    case 'titleParametersDidChange': { const c = contexts.get(context); if (c) { c.userTitle = payload?.title || ''; render(context); } break; }
    case 'sendToPlugin': if (payload?.reload) { send({ event: 'getGlobalSettings', context: pluginUUID }); } break;
    case 'keyDown': keyDown(context); break;
    case 'dialRotate': rotate(context, payload?.ticks || 0); break;
    case 'dialDown': case 'touchTap': toggleMute(context); break;
    default: break;
  }
}

async function poll(force = false) {
  if (!globals.token) { online = false; renderAll(); return; }
  try {
    state = await GXS.get(globals, '/state');
    if (force || !actions.length) actions = await GXS.get(globals, '/actions');
    online = true;
  } catch { online = false; state = null; }
  renderAll();
}
setInterval(() => poll(), 1000);

const labelOf = (id) => actions.find?.((a) => a.id === id)?.label || id;
const channelOf = (c) => c.settings.channel || 'Music';
const faderFor = (ch) => Object.entries(state?.faders || {}).find(([, f]) => f.channel === ch)?.[0] || null;

function renderAll() { for (const c of contexts.keys()) render(c); }

function render(context) {
  const c = contexts.get(context);
  if (!c) return;
  if (!globals.token) { setState(context, 0); setTitle(context, c.userTitle ? '' : t('token')); return; }
  if (!online) { setState(context, 0); if (!c.userTitle) setTitle(context, t('offline')); return; }
  if (c.action === 'com.goxlrstudio.volume') {
    const ch = channelOf(c);
    const pct = GXS.pct(state.volumes?.[ch]);
    const f = faderFor(ch);
    const muted = f ? state.faders[f].muted : false;
    const name = c.settings.name || ch;
    if (c.controller === 'Knob') return; // StreamDock knobs have no display
    if (c.controller === 'Encoder') {
      send({ event: 'setFeedback', context, payload: { title: name, value: muted ? t('muted') : `${pct} %`, indicator: { value: muted ? 0 : pct } } });
    } else if (!c.userTitle) setTitle(context, `${name}\n${muted ? t('muted') : `${pct} %`}`);
    return;
  }
  const id = c.settings.action;
  if (!id) { setState(context, 0); if (!c.userTitle) setTitle(context, t('none')); return; }
  setState(context, state.active?.includes(id) ? 1 : 0);
  // Without a title of its own, the key shows a short label for the action.
  if (!c.userTitle) setTitle(context, shortLabel(c.settings.label || labelOf(id)));
}

/** At most three short lines that fit a key. */
function shortLabel(s) {
  const words = String(s).replace(/["“”]/g, '').split(/\s+/);
  const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if ((cur + ' ' + w).trim().length > 10 && cur) { if (lines.length === 3) break; lines.push(w); } else lines[lines.length - 1] = (cur + ' ' + w).trim();
  }
  return lines.join('\n');
}

async function keyDown(context) {
  const c = contexts.get(context);
  if (!c) return;
  try {
    if (c.action === 'com.goxlrstudio.volume') {
      const step = Number(c.settings.step) || 10;
      await setVolume(c, (c.settings.direction === 'down' ? -1 : 1) * step);
    } else if (c.settings.action) {
      await GXS.run(globals, c.settings.action);
    } else { send({ event: 'showAlert', context }); return; }
    setTimeout(() => poll(), 150);
  } catch { send({ event: 'showAlert', context }); }
}

async function setVolume(c, deltaPct) {
  const ch = channelOf(c);
  const now = GXS.pct(state?.volumes?.[ch]);
  const next = Math.max(0, Math.min(100, now + deltaPct));
  if (state?.volumes) state.volumes[ch] = Math.round((next / 100) * 255); // show it at once
  await GXS.run(globals, `vol-set:${ch}|${next}`);
}

let rotateTimer = null;
let pending = 0;
function rotate(context, ticks) {
  const c = contexts.get(context);
  if (!c || !state) return;
  pending += ticks;
  render(context);
  clearTimeout(rotateTimer);
  rotateTimer = setTimeout(() => {
    const step = Number(c.settings.step) || 2;
    const d = pending * step;
    pending = 0;
    setVolume(c, d).then(() => render(context)).catch(() => send({ event: 'showAlert', context }));
  }, 40);
}

async function toggleMute(context) {
  const c = contexts.get(context);
  const f = c && faderFor(channelOf(c));
  if (!f) { send({ event: 'showAlert', context }); return; }
  try { await GXS.run(globals, `mute-fader:${f}`); setTimeout(() => poll(), 150); } catch { send({ event: 'showAlert', context }); }
}
