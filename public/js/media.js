// Medieknapper og "spiller nu": Windows' media controls (media.rs) – play/pause, next and previous
// as actions (hotkeys, pedals, Stream Deck, phone), a "Spiller nu" card on the Mixer page and, on a
// song change, a short message or the Musik-popup (musicpop.rs, public/music.html) over games.
// Everything can be switched off (prefs.media, musicmodel.js).
import { h, toggle, toast } from './ui.js';
import { mediaNow, mediaControl, mediaArt, showOsd, musicPopup, onMusicPopup, isNative } from './native.js';
import { mediaPrefs, SONG_CHANGE, CORNERS, POPUP_SECONDS, songKey } from './musicmodel.js';
import { language } from './i18n.js';

export const MEDIA_COMMANDS = [['previous', '⏮ Forrige'], ['play-pause', '⏯ Afspil/pause'], ['next', '⏭ Næste'], ['stop', '⏹ Stop']];
export const mediaSettings = (ctx) => mediaPrefs(ctx.prefs);

/** "Titel – Kunstner" (or the app's name when the player gives no title). */
export const songText = (np) => (np?.title ? (np.artist ? `${np.title} – ${np.artist}` : np.title) : np?.app || '');

/** The song changed (a new title while something plays) – for the message over games. */
export const songChanged = (prev, next) => !!next?.playing && !!next.title && (prev?.title !== next.title || prev?.artist !== next.artist);

/** Shows/hides/toggles the Musik-popup with the user's corner and time. */
export function showMusicPopup(ctx, show = null, auto = false) {
  const s = mediaSettings(ctx);
  return musicPopup(show, { auto, corner: s.corner, seconds: s.seconds });
}

// Song changes (polled every 3 s while wanted) and the pop-up's Music slider.
export function startMediaWatch(ctx) {
  let last = null;
  const tick = async () => {
    const mode = mediaSettings(ctx).songChange;
    if (mode !== 'off') {
      const np = await mediaNow().catch(() => null);
      ctx.nowPlaying = np;
      if (last && songChanged(last, np)) {
        if (mode === 'popup') showMusicPopup(ctx, true, true).catch(() => {});
        else showOsd(`♪ ${songText(np)}`, 'info').catch(() => {});
      }
      last = np;
    } else last = null;
    setTimeout(tick, 3000);
  };
  setTimeout(tick, 4000);
  onMusicPopup({
    want: () => ({ lang: language(), volume: ctx.conn.mixer?.levels?.volumes?.Music ?? null }),
    volume: (v) => { if (ctx.conn.mixer && Number.isFinite(v)) ctx.conn.command('SetVolume', 'Music', Math.round(Math.min(255, Math.max(0, v)))); },
  }).catch(() => {});
}

/** The "Spiller nu" card on the Mixer page (null when switched off). */
export function nowPlayingCard(ctx) {
  if (mediaSettings(ctx).card === false) return null;
  const title = h('div', { class: 'np-title', 'data-testid': 'np-title' }, '…');
  const sub = h('div', { class: 'hint', 'data-testid': 'np-sub' });
  const cover = h('div', { class: 'np-cover', 'data-testid': 'np-cover' }, '♪');
  let key = '';
  const btn = (cmd, label, tip) => h('button', { class: 'btn sm', title: tip, 'data-testid': `np-${cmd}`, onclick: () => mediaControl(cmd).then(refresh).catch(() => {}) }, label);
  const playBtn = btn('play-pause', '⏯', 'Afspil/pause');
  const refresh = async () => {
    const np = await mediaNow().catch(() => null);
    ctx.nowPlaying = np;
    const k = songKey(np);
    if (k !== key) {
      key = k;
      const art = k ? await mediaArt().catch(() => null) : null;
      cover.replaceChildren(art?.startsWith('data:image/') ? h('img', { src: art, alt: '' }) : '♪');
    }
    if (!np?.available) { title.textContent = 'Intet spiller'; sub.textContent = 'Start musik i fx Spotify – så kan den styres her, med genveje, pedaler og telefonen.'; return; }
    title.textContent = np.title || np.app || 'Ukendt';
    sub.textContent = [np.artist, np.app].filter(Boolean).join(' · ');
    playBtn.textContent = np.playing ? '⏸' : '▶';
  };
  refresh();
  const timer = setInterval(() => { if (document.body.contains(title)) refresh(); }, 2000);
  ctx.cleanup.push(() => clearInterval(timer));
  const popup = isNative() ? h('button', { class: 'btn sm', title: 'Vis musik-popuppen (den kan også få en genvejstast under Genveje)', 'data-testid': 'np-popup', onclick: () => showMusicPopup(ctx, true).catch(() => {}) }, '⧉') : null;
  return h('div', { class: 'card now-playing', 'data-testid': 'now-playing' }, h('h2', {}, 'Spiller nu'),
    h('div', { class: 'row' }, cover, h('div', { class: 'np-text' }, title, sub), h('div', { class: 'spacer' }),
      btn('previous', '⏮', 'Forrige'), playBtn, btn('next', '⏭', 'Næste'), popup));
}

/** Settings card: "Spiller nu", what a song change shows, and the pop-up's place and time. */
export function mediaCard(ctx, binder) {
  const s = mediaSettings(ctx);
  const save = () => ctx.savePrefs?.();
  const pick = (testid, options, get, set) => {
    const sel = h('select', { 'data-testid': testid, onchange: () => { set(sel.value); save(); } }, ...options.map(([v, label]) => h('option', { value: v }, label)));
    sel.value = String(get());
    return sel;
  };
  const test = h('button', { class: 'btn sm', 'data-testid': 'music-popup-test', onclick: () => {
    if (!isNative()) { toast('Musik-popuppen findes kun i Windows-appen'); return; }
    showMusicPopup(ctx, true).catch((e) => toast(String(e)));
  } }, 'Vis musik-popup');
  return h('div', { class: 'card', 'data-testid': 'media-card' }, h('h2', {}, 'Medier'),
    toggle(binder, { label: 'Vis "Spiller nu" på Mixer-siden', get: () => s.card !== false, set: (v) => { s.card = v; save(); } }),
    h('div', { class: 'row' }, h('label', {}, 'Når sangen skifter'), pick('media-song-change', SONG_CHANGE, () => s.songChange, (v) => { s.songChange = v; s.osd = v === 'text'; })),
    h('div', { class: 'row' }, h('label', {}, 'Musik-popup'), pick('media-corner', CORNERS, () => s.corner, (v) => { s.corner = v; }),
      pick('media-seconds', POPUP_SECONDS.map((n) => [String(n), `${n} s`]), () => s.seconds, (v) => { s.seconds = Number(v); })),
    h('div', { class: 'row' }, test),
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Musik-popuppen viser cover, sang og tid, har ⏮ ⏯ ⏭ og GoXLR’ens Musik-lydstyrke, og den tager ikke fokus fra spillet. Giv den en tast under Genveje ("Musik-popup (vis/skjul)") eller læg den på Stream Deck. Afspil/pause, næste og forrige styrer den afspiller, Windows viser i lydstyrke-boksen – ellers sendes medietasterne.'));
}
