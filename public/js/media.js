// Medieknapper og "spiller nu": Windows' media controls (media.rs) – play/pause, next and previous
// as actions (hotkeys, pedals, Stream Deck, phone), a "Spiller nu" card on the Mixer page and,
// if wanted, the song over games when it changes. Everything can be switched off (prefs.media).
import { h, toggle } from './ui.js';
import { mediaNow, mediaControl, showOsd } from './native.js';

export const MEDIA_COMMANDS = [['previous', '⏮ Forrige'], ['play-pause', '⏯ Afspil/pause'], ['next', '⏭ Næste'], ['stop', '⏹ Stop']];
export const mediaSettings = (ctx) => (ctx.prefs.media ??= { card: true, osd: false });

/** "Titel – Kunstner" (or the app's name when the player gives no title). */
export const songText = (np) => (np?.title ? (np.artist ? `${np.title} – ${np.artist}` : np.title) : np?.app || '');

/** The song changed (a new title while something plays) – for the message over games. */
export const songChanged = (prev, next) => !!next?.playing && !!next.title && (prev?.title !== next.title || prev?.artist !== next.artist);

// Sangskift over spil: polls every 3 s while switched on.
export function startMediaWatch(ctx) {
  let last = null;
  const tick = async () => {
    if (mediaSettings(ctx).osd) {
      const np = await mediaNow().catch(() => null);
      ctx.nowPlaying = np;
      if (last && songChanged(last, np)) showOsd(`♪ ${songText(np)}`, 'info').catch(() => {});
      last = np;
    } else last = null;
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 4000);
}

/** The "Spiller nu" card on the Mixer page (null when switched off). */
export function nowPlayingCard(ctx) {
  if (mediaSettings(ctx).card === false) return null;
  const title = h('div', { class: 'np-title', 'data-testid': 'np-title' }, '…');
  const sub = h('div', { class: 'hint', 'data-testid': 'np-sub' });
  const btn = (cmd, label, tip) => h('button', { class: 'btn sm', title: tip, 'data-testid': `np-${cmd}`, onclick: () => mediaControl(cmd).then(refresh).catch(() => {}) }, label);
  const playBtn = btn('play-pause', '⏯', 'Afspil/pause');
  const refresh = async () => {
    const np = await mediaNow().catch(() => null);
    ctx.nowPlaying = np;
    if (!np?.available) { title.textContent = 'Intet spiller'; sub.textContent = 'Start musik i fx Spotify – så kan den styres her, med genveje, pedaler og telefonen.'; return; }
    title.textContent = np.title || np.app || 'Ukendt';
    sub.textContent = [np.artist, np.app].filter(Boolean).join(' · ');
    playBtn.textContent = np.playing ? '⏸' : '▶';
  };
  refresh();
  const timer = setInterval(() => { if (document.body.contains(title)) refresh(); }, 2000);
  ctx.cleanup.push(() => clearInterval(timer));
  return h('div', { class: 'card now-playing', 'data-testid': 'now-playing' }, h('h2', {}, 'Spiller nu'),
    h('div', { class: 'row' }, h('div', { class: 'np-text' }, title, sub), h('div', { class: 'spacer' }),
      btn('previous', '⏮', 'Forrige'), playBtn, btn('next', '⏭', 'Næste')));
}

/** Settings card: switch the card and the song message on/off. */
export function mediaCard(ctx, binder) {
  const s = mediaSettings(ctx);
  const save = () => ctx.savePrefs?.();
  return h('div', { class: 'card' }, h('h2', {}, 'Medier'),
    toggle(binder, { label: 'Vis "Spiller nu" på Mixer-siden', get: () => s.card !== false, set: (v) => { s.card = v; save(); } }),
    toggle(binder, { label: 'Vis sangskift over spil', get: () => !!s.osd, set: (v) => { s.osd = v; save(); } }),
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Afspil/pause, næste og forrige findes som handlinger under Genveje, Fodpedal, Stream Deck og på telefonen. De styrer den afspiller, Windows viser i lydstyrke-boksen – ellers sendes medietasterne.'));
}
