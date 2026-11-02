// Spiltilstand: when a game runs in full screen, Windows' notification sounds are muted (the "ding"
// in the middle of a fight – and on stream), and your own actions can run (fx EQ "Fodtrin", a scene);
// when the game ends, it all goes back. Off until switched on. Browsers and video players in full
// screen don't count (the list can be changed).
import { h, logActivity, toggle } from './ui.js';
import { actionCatalog, actionLabel } from './actions.js';
import { actionRow } from './actionpicker.js';
import { gameState, gameMuteSystemSounds } from './native.js';

export const DEFAULT_IGNORE = 'chrome.exe, msedge.exe, firefox.exe, opera.exe, brave.exe, vlc.exe, mpc-hc64.exe, powerpnt.exe, explorer.exe, goxlr-studio.exe';
const STEPS = 2; // readings in a row (2 s apart) before it counts – no flicker on alt+tab

export function gameSettings(ctx) {
  const g = (ctx.prefs.gameMode ??= {});
  g.enabled ??= false;
  g.muteSystem ??= true;
  g.ignore ??= DEFAULT_IGNORE;
  g.onEnter ??= [];
  g.onExit ??= [];
  return g;
}

export const ignoreList = (text) => String(text || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);

/** One reading: is a game in front? fg = { fullscreen, exe } from Windows. */
export const looksLikeGame = (fg, ignore) => !!fg?.fullscreen && !!fg.exe && !ignore.includes(String(fg.exe).toLowerCase());

/** Debounced on/off: memo = { active, exe, count }. Returns { enter, exit } when it changes. */
export function gameStep(memo, game, exe) {
  if (game === memo.active) { memo.count = 0; if (game) memo.exe = exe; return {}; }
  memo.count = (memo.count || 0) + 1;
  if (memo.count < STEPS) return {};
  memo.count = 0;
  memo.active = game;
  if (game) { memo.exe = exe; return { enter: exe }; }
  const was = memo.exe;
  memo.exe = null;
  return { exit: was };
}

async function runAll(ctx, ids, why) {
  for (const id of ids.filter(Boolean)) {
    try { await ctx.runAction(id, why); } catch { /* next */ }
  }
}

export function startGameMode(ctx) {
  const memo = { active: false, exe: null, count: 0 };
  ctx.gameMode = memo;
  const chip = document.getElementById('game-chip');
  const show = () => {
    if (chip) { chip.hidden = !memo.active; chip.textContent = memo.active ? `🎮 Spiltilstand · ${memo.exe}` : ''; }
    ctx.binder?.run();
  };
  const exit = async (g, exe) => {
    if (g.mutedByUs) { await gameMuteSystemSounds(false).catch(() => {}); g.mutedByUs = false; ctx.savePrefs?.(); }
    logActivity(`Spiltilstand slut (${exe || '?'})${g.onExit.length ? ` → ${g.onExit.filter(Boolean).map((id) => actionLabel(ctx, id)).join(', ')}` : ''}`);
    await runAll(ctx, g.onExit, `spiltilstand slut: ${exe}`);
  };
  const tick = async () => {
    const g = gameSettings(ctx);
    try {
      if (!g.enabled) {
        if (memo.active) { memo.active = false; await exit(g, memo.exe); memo.exe = null; show(); }
      } else {
        const fg = await gameState();
        const r = gameStep(memo, looksLikeGame(fg, ignoreList(g.ignore)), fg.exe);
        if (r.enter) {
          if (g.muteSystem && !fg.system_muted) {
            await gameMuteSystemSounds(true).then((n) => { if (n) { g.mutedByUs = true; ctx.savePrefs?.(); } }).catch(() => {});
          }
          logActivity(`Spiltilstand: ${r.enter}${g.onEnter.length ? ` → ${g.onEnter.filter(Boolean).map((id) => actionLabel(ctx, id)).join(', ')}` : ''}`);
          await runAll(ctx, g.onEnter, `spiltilstand: ${r.enter}`);
          show();
        } else if (r.exit) {
          await exit(g, r.exit);
          show();
        }
      }
    } catch { /* backend unavailable */ }
    setTimeout(tick, 2000);
  };
  // The app was closed in the middle of a game: give the system sounds back.
  const g = gameSettings(ctx);
  if (g.mutedByUs) { gameMuteSystemSounds(false).catch(() => {}); g.mutedByUs = false; ctx.savePrefs?.(); }
  setTimeout(tick, 3000);
}

export function gameModeCard(ctx, binder) {
  const g = gameSettings(ctx);
  const actions = h('div', {});
  const state = h('div', { class: 'hint', 'data-testid': 'game-state' });
  let catalog = [];
  const save = () => { ctx.savePrefs?.(); };
  const renderActions = () => actions.replaceChildren(
    actionRow(ctx, { arr: g.onEnter, label: 'Når et spil starter →', getCatalog: () => catalog, save: () => { save(); renderActions(); }, rerender: renderActions, testid: 'game-add-enter' }),
    actionRow(ctx, { arr: g.onExit, label: 'Når det slutter →', getCatalog: () => catalog, save: () => { save(); renderActions(); }, rerender: renderActions, testid: 'game-add-exit' }));
  binder.add(() => {
    const m = ctx.gameMode;
    state.textContent = !g.enabled ? 'Slået fra.' : m?.active ? `Aktiv: ${m.exe}` : 'Venter på et spil i fuld skærm.';
  });
  const ignore = h('input', { type: 'text', value: g.ignore, 'data-testid': 'game-ignore', 'aria-label': 'Tæller ikke som spil', onchange: () => { g.ignore = ignore.value; save(); } });
  actionCatalog(ctx).then((c) => { catalog = c; renderActions(); });
  renderActions();
  return h('div', { class: 'card', 'data-testid': 'game-card' }, h('h2', {}, 'Spiltilstand'),
    toggle(binder, { label: 'Slå spiltilstand til', get: () => g.enabled, set: (v) => { g.enabled = v; save(); binder.run(); } }),
    toggle(binder, { label: 'Stop Windows’ notifikationslyde under spil', get: () => g.muteSystem, set: (v) => { g.muteSystem = v; save(); } }),
    actions,
    h('div', { class: 'row', style: { marginTop: '6px' } }, h('label', {}, 'Tæller ikke'), ignore),
    state,
    h('div', { class: 'hint' }, 'Et spil = et program i fuld skærm (også "borderless"). Notifikationslydene kommer tilbage, når spillet slutter – også hvis appen lukkes imens.'));
}
