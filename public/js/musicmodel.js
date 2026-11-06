// Musik-popup and "Spiller nu" (pure parts, tested in tests/music.test.mjs). The pop-up window is
// public/music.html (js/music.js), shown by musicpop.rs.

export const SONG_CHANGE = [['off', 'Intet'], ['text', 'Kort besked'], ['popup', 'Musik-popup']];
export const CORNERS = [['bottom-right', 'Nederst til højre'], ['bottom-left', 'Nederst til venstre'], ['top-right', 'Øverst til højre'], ['top-left', 'Øverst til venstre']];
export const POPUP_SECONDS = [4, 6, 10, 15];

/** prefs.media with defaults; the old "Vis sangskift over spil" (osd: true) becomes "Kort besked". */
export function mediaPrefs(prefs) {
  const s = (prefs.media ??= {});
  if (s.card === undefined) s.card = true;
  if (!s.songChange) s.songChange = s.osd ? 'text' : 'off';
  if (!CORNERS.some(([c]) => c === s.corner)) s.corner = 'bottom-right';
  if (!POPUP_SECONDS.includes(s.seconds)) s.seconds = 6;
  return s;
}

/** 83 000 ms → "1:23", 3 723 000 → "1:02:03". */
export function timeText(ms) {
  const t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Where the song is `elapsed` ms after it was read (counting on while it plays, never past the end). */
export function livePosition(np, elapsed = 0) {
  if (!np?.duration_ms) return 0;
  const p = (np.position_ms || 0) + (np.playing ? Math.max(0, elapsed) : 0);
  return Math.min(p, np.duration_ms);
}

/** How long the pop-up stays: a song change briefly, a key press longer (the mouse on it holds it). */
export const hideDelay = (auto, seconds = 6) => (auto ? seconds : Math.max(12, seconds * 2)) * 1000;

/** The GoXLR's fader value (0–255) ↔ percent. */
export const volumePct = (v) => Math.round((Math.min(255, Math.max(0, Number(v) || 0)) / 255) * 100);
export const volumeValue = (pct) => Math.round((Math.min(100, Math.max(0, Number(pct) || 0)) / 100) * 255);

/** Identifies a song (a new cover is read when it changes). */
export const songKey = (np) => (np?.available ? `${np.app}\u0001${np.title}\u0001${np.artist}` : '');
