// Stemmeskifter (pure parts, tested in tests/voicefx.test.mjs): voice effects in GoXLR Studio's
// plugin on Chat Mic (plugins/voiceclean/src/fx.rs) – what Discord and games hear. The GoXLR Mini
// has no voice effects of its own. The effect is sent through the shared memory (voiceref.rs), so a
// key switches it at once; config.txt only needs the plugin on the mic (`micPayload(..., {fx})`).

// `n` = the plugin's number (fx.rs Effect::from_id) – never renumber.
export const VOICE_FX = [
  { id: 'deep', n: 1, label: 'Dyb', hint: 'Dybere og større stemme' },
  { id: 'high', n: 2, label: 'Lysere', hint: 'Lysere og lettere stemme' },
  { id: 'chipmunk', n: 3, label: 'Jordegern', hint: 'Højt og spinkelt' },
  { id: 'monster', n: 4, label: 'Monster', hint: 'Dyb og knurrende' },
  { id: 'robot', n: 5, label: 'Robot', hint: 'Én tone, metallisk' },
  { id: 'megaphone', n: 6, label: 'Megafon', hint: 'Som gennem et horn' },
  { id: 'radio', n: 7, label: 'Radio', hint: 'Walkie-talkie med sus' },
  { id: 'cave', n: 8, label: 'Hule', hint: 'Stort stenrum' },
  { id: 'echo', n: 9, label: 'Ekko', hint: 'Ekko efter 0,3 s' },
];

export const FX_DEFAULTS = { enabled: false, active: null, mix: 100 };

/** prefs.voiceFx, filled with defaults in place. */
export function fxSettings(prefs) {
  const s = (prefs.voiceFx ??= {});
  for (const [k, v] of Object.entries(FX_DEFAULTS)) if (s[k] === undefined) s[k] = v;
  return s;
}

export const fxById = (id) => VOICE_FX.find((e) => e.id === id) || null;

/**
 * The command for the plugin: effect number in the low byte, how much of it (1–100 %) in the
 * next (fx.rs `decode`). `held` = an effect held on a key (wins over the chosen one). 0 = none.
 */
export function fxCommand(s, held = null) {
  if (!s?.enabled) return 0;
  const e = fxById(held || s.active);
  if (!e) return 0;
  const m = Number(s.mix);
  const mix = Math.round(Math.min(100, Math.max(1, Number.isFinite(m) ? m : 100)));
  return e.n | (mix << 8);
}

/** The effect heard now (held or chosen), or null. */
export function fxNow(s, held = null) {
  return s?.enabled ? fxById(held || s.active) : null;
}

/**
 * What an action does to the settings (pure): `voice-fx:<id>` chooses it (again = off),
 * `voice-fx:off` turns it off. Returns { enable } when Stemmeskifter had to be switched on first.
 */
export function fxAction(s, arg) {
  const enable = !s.enabled && arg !== 'off';
  if (arg === 'off') s.active = null;
  else if (fxById(arg)) {
    s.active = s.enabled && s.active === arg ? null : arg;
    s.enabled = true;
  }
  return { enable };
}

/** The status line of the card. */
export function fxStatusText(s, status, { installed, outdated, held = null } = {}) {
  if (!s?.enabled) return 'Slået fra';
  if (!installed) return 'EQ-motoren er ikke sat på Chat Mic endnu';
  if (outdated) return 'Pluginnet skal opdateres for at få Stemmeskifter';
  const e = fxNow(s, held);
  if (!e) return 'Klar – vælg en stemme';
  if (status?.plugin && status.fx) return `${e.label} kører`;
  if (status?.plugin) return `${e.label} starter …`;
  return `${e.label} – starter, når en app (fx Discord) bruger mikrofonen`;
}

/**
 * The mic the effect goes on (the one Ren mikrofon uses, else the GoXLR's Chat Mic – as
 * voicemodel.js micPayload) and whether the EQ engine is on it. `mics` = engine_info's mics.
 */
export function fxTarget(device, mics = []) {
  const goxlr = mics.filter((d) => /goxlr|tc-helicon/i.test(d.name));
  const chat = goxlr.find((d) => /chat\s*mic/i.test(d.name)) || null;
  const mic = (device && mics.find((d) => d.id.toLowerCase() === device.toLowerCase())) || chat;
  return { mic, installed: !!mic?.installed };
}
