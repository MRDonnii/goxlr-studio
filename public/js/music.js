// The Musik-popup's own page (public/music.html in the "music" window, musicpop.rs): what plays,
// its cover and progress, ⏮ ⏯ ⏭, and the GoXLR's Music volume (the main window does the
// GoXLR command – onMusicPopup in native.js). It hides itself after a while unless the mouse is on it.
import { mediaNow, mediaControl, mediaArt, musicPopup, isNative } from './native.js';
import { timeText, livePosition, hideDelay, volumePct, volumeValue, songKey } from './musicmodel.js';
import { setLanguage } from './i18n.js';

const $ = (id) => document.getElementById(id);
const card = $('card');
let np = null;
let readAt = 0;
let key = '';
let hideTimer = null;
let delay = 6000;
let hovering = false;
let poll = null;
let tick = null;
let dragging = false;

const emit = (name, payload) => window.__TAURI__?.event.emit(name, payload);

function paint() {
  if (!np?.available) {
    $('title').textContent = 'Intet spiller';
    $('sub').textContent = 'Start musik i fx Spotify';
    $('bar').style.width = '0';
    $('pos').textContent = '';
    $('len').textContent = '';
    return;
  }
  $('title').textContent = np.title || np.app || 'Ukendt';
  $('sub').textContent = [np.artist, np.app].filter(Boolean).join(' · ');
  $('play').textContent = np.playing ? '⏸' : '▶';
  const pos = livePosition(np, Date.now() - readAt);
  $('bar').style.width = np.duration_ms ? `${(pos / np.duration_ms) * 100}%` : '0';
  $('pos').textContent = np.duration_ms ? timeText(pos) : '';
  $('len').textContent = np.duration_ms ? timeText(np.duration_ms) : '';
}

async function refresh() {
  np = await mediaNow().catch(() => null);
  readAt = Date.now();
  const k = songKey(np);
  if (k !== key) {
    key = k;
    const art = k ? await mediaArt().catch(() => null) : null;
    const cover = $('cover');
    cover.replaceChildren();
    if (art?.startsWith('data:image/')) {
      const img = document.createElement('img');
      img.alt = '';
      img.src = art;
      cover.append(img);
    } else cover.textContent = '♪';
  }
  paint();
  emit('music-want-state');
}

function armHide() {
  clearTimeout(hideTimer);
  if (!hovering) hideTimer = setTimeout(hide, delay);
}

function hide() {
  card.classList.remove('show');
  clearInterval(poll);
  clearInterval(tick);
  poll = tick = null;
  setTimeout(() => { if (!card.classList.contains('show')) musicPopup(false).catch(() => {}); }, 200);
}

function show({ auto = false, seconds = 6 } = {}) {
  delay = hideDelay(auto, seconds);
  refresh();
  if (!poll) poll = setInterval(refresh, 1500);
  if (!tick) tick = setInterval(paint, 250);
  requestAnimationFrame(() => card.classList.add('show'));
  armHide();
}

for (const b of document.querySelectorAll('[data-cmd]')) {
  b.addEventListener('click', async () => {
    await mediaControl(b.dataset.cmd).catch(() => {});
    setTimeout(refresh, 350);
    armHide();
  });
}
$('close').addEventListener('click', hide);
card.addEventListener('mouseenter', () => { hovering = true; clearTimeout(hideTimer); });
card.addEventListener('mouseleave', () => { hovering = false; armHide(); });

// The Music channel: the main window answers music-want-state with music-state.
const vol = $('volume');
let sendTimer = null;
vol.addEventListener('input', () => {
  dragging = true;
  $('volpct').textContent = `${vol.value} %`;
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => emit('music-volume', { value: volumeValue(vol.value) }), 40);
});
vol.addEventListener('change', () => { dragging = false; });

if (isNative()) {
  const { listen } = window.__TAURI__.event;
  listen('music-show', (ev) => show(ev.payload || {}));
  listen('music-state', (ev) => {
    const s = ev.payload || {};
    if (s.lang) setLanguage(s.lang);
    $('vol').classList.toggle('off', s.volume == null);
    if (s.volume != null && !dragging) {
      vol.value = volumePct(s.volume);
      $('volpct').textContent = `${vol.value} %`;
    }
  });
} else {
  // Opened in a browser (demo/screenshots): a pretend player, always shown.
  $('vol').classList.remove('off');
  vol.value = 70;
  $('volpct').textContent = '70 %';
  if (new URLSearchParams(location.search).has('en')) setLanguage('en');
  show({ auto: false, seconds: 3600 });
}
