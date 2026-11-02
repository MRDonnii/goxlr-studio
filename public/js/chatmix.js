// ChatMix: one control for the balance between your friends (Chat) and everything else (game,
// music …), like the wheel on a gaming headset. In the middle both are at their normal level; toward
// "Chat" the rest is turned down, toward "Spil" the chat is turned down – nothing is ever raised
// above the normal level. The normal levels are taken from the faders when ChatMix is switched on.
// prefs.chatMix = { enabled, position (-100 = all game … 0 … 100 = all chat), others: [...], base: { Chat, Game, … } }
import { h, toggle, slider } from './ui.js';
import { CHANNEL_LABEL } from './views-mixer.js';

export const CHATMIX_OTHERS = ['Game', 'Music', 'System', 'Console', 'LineIn', 'Sample'];
export const CHATMIX_STEP = 10;
const MIN_LEFT = 0; // at the far end the other side is silent (as on a headset)

export function chatMixSettings(ctx) {
  const c = (ctx.prefs.chatMix ??= {});
  c.enabled ??= false;
  c.position ??= 0;
  c.others ??= ['Game', 'Music', 'System'];
  c.base ??= {};
  return c;
}

/** The volumes (0–255) for a position. base = the normal levels. */
export function chatMixVolumes(base, position, others) {
  const p = Math.max(-100, Math.min(100, Number(position) || 0));
  const scale = (v, f) => Math.round(Math.max(MIN_LEFT, (v ?? 0) * f));
  const out = {};
  out.Chat = scale(base.Chat, p < 0 ? 1 + p / 100 : 1);
  for (const ch of others) if (base[ch] != null) out[ch] = scale(base[ch], p > 0 ? 1 - p / 100 : 1);
  return out;
}

/** "Spil 60 %" / "Midt" / "Chat 30 %" */
export function chatMixLabel(position) {
  const p = Math.round(Number(position) || 0);
  return p === 0 ? 'Midt' : p < 0 ? `Spil ${-p} %` : `Chat ${p} %`;
}

/** Take the normal levels from the faders now. */
export function captureBase(ctx) {
  const c = chatMixSettings(ctx);
  const v = ctx.conn.mixer?.levels?.volumes || {};
  c.base = Object.fromEntries(['Chat', ...CHATMIX_OTHERS].filter((ch) => v[ch] != null).map((ch) => [ch, v[ch]]));
  c.position = 0;
  ctx.savePrefs?.();
}

let sendTimer = null;
export function setChatMix(ctx, position) {
  const c = chatMixSettings(ctx);
  if (!c.enabled) return;
  if (!Object.keys(c.base).length) captureBase(ctx);
  c.position = Math.max(-100, Math.min(100, Math.round(position)));
  ctx.savePrefs?.();
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    for (const [ch, v] of Object.entries(chatMixVolumes(c.base, c.position, c.others))) ctx.conn.command('SetVolume', ch, v);
  }, 30);
}

/** Actions: chatmix:chat / chatmix:game (a step), chatmix:center. */
export function chatMixAction(ctx, arg) {
  const c = chatMixSettings(ctx);
  if (!c.enabled) { ctx.notify?.('ChatMix er slået fra (Mixer-siden)', 'info'); return; }
  const pos = arg === 'center' ? 0 : c.position + (arg === 'chat' ? CHATMIX_STEP : -CHATMIX_STEP);
  setChatMix(ctx, pos);
  ctx.notify?.(`ChatMix: ${chatMixLabel(chatMixSettings(ctx).position)}`, 'info');
}

export function chatMixCard(ctx) {
  const { binder } = ctx;
  const c = chatMixSettings(ctx);
  const others = h('div', { class: 'fx-toggle' });
  for (const ch of CHATMIX_OTHERS) {
    const b = h('button', { class: 'btn sm', onclick: () => {
      c.others = c.others.includes(ch) ? c.others.filter((x) => x !== ch) : [...c.others, ch];
      if (!c.others.includes(ch) && c.base[ch] != null) ctx.conn.command('SetVolume', ch, c.base[ch]); // back to normal
      ctx.savePrefs?.(); binder.run(); setChatMix(ctx, c.position);
    } }, CHANNEL_LABEL[ch] || ch);
    binder.add(() => b.classList.toggle('on', c.others.includes(ch)));
    others.append(b);
  }
  return h('div', { class: 'card', 'data-testid': 'chatmix-card' }, h('h2', {}, 'ChatMix'),
    toggle(binder, { label: 'Én knap til balancen mellem chat og spil', get: () => c.enabled, set: (v) => {
      if (v) { c.enabled = true; captureBase(ctx); } else {
        // Off: everything back to the normal levels.
        for (const [ch, vol] of Object.entries(c.base)) ctx.conn.command('SetVolume', ch, vol);
        c.enabled = false; c.position = 0; ctx.savePrefs?.();
      }
      binder.run();
    } }),
    h('div', { class: 'row chatmix-ends' }, h('span', { class: 'hint' }, 'Spil'), h('div', { class: 'spacer' }), h('span', { class: 'hint' }, 'Chat')),
    slider(binder, { label: 'Balance', min: -100, max: 100, step: 5, get: () => c.position, set: (v) => setChatMix(ctx, v), fmt: chatMixLabel }),
    h('div', { class: 'hint', style: { margin: '6px 0' } }, '"Spil" er:'), others,
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', { class: 'btn sm', 'data-testid': 'chatmix-center', onclick: () => setChatMix(ctx, 0) }, 'Midt'),
      h('button', { class: 'btn sm', 'data-testid': 'chatmix-capture', title: 'Brug faderne, som de står nu, som det normale niveau', onclick: () => { captureBase(ctx); binder.run(); } }, 'Brug nuværende niveauer som midte')),
    h('div', { class: 'hint' }, 'I midten spiller alt som normalt. Mod "Chat" skrues spillet ned, mod "Spil" skrues chatten ned – intet bliver højere end normalt. Kan også ligge på genveje, Stream Deck eller en MIDI-fader (Fodpedal → Fader → ChatMix).'));
}
