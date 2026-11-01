import { micMutedForChat, discordMode, discordKeyFor, discordNotice, DISCORD_MUTE_KEY, DISCORD_DEAF_KEY } from './extras.js';
import { sendKeys, discordRunning } from './native.js';
import { toast } from './ui.js';

export const DEFAULT_DISCORD_KEY = DISCORD_MUTE_KEY;
export const DEFAULT_DISCORD_DEAF_KEY = DISCORD_DEAF_KEY;

// Mirrors the GoXLR's mic mute (hardware button, fader mute or the app) into Discord by pressing a
// Discord keybind whenever the state flips: "Toggle Mute" (mode 'mute'), or "Toggle Deafen" (mode
// 'both' – Discord shows both the mic and the headphones crossed out, so friends see you are away).
export function startDiscordSync(ctx) {
  let last = null;
  const settings = () => ctx.prefs.discord || {};
  const press = async (accel) => {
    if (!(await discordRunning().catch(() => false))) { toast('Discord kører ikke'); return false; }
    await sendKeys(accel).catch((e) => toast(`Discord: ${e}`));
    return true;
  };
  // Manual presses ("Test / ret", hotkeys, Stream Deck), without touching the GoXLR.
  ctx.discordToggle = () => press(discordKeyFor(settings(), 'mute'));
  ctx.discordDeafen = () => press(discordKeyFor(settings(), 'both'));
  // Called when sync is switched on: Discord is assumed unmuted, so mute it now if the GoXLR is.
  ctx.discordAlign = async () => {
    last = micMutedForChat(ctx.conn.mixer, settings());
    if (last) await press(discordKeyFor(settings()));
  };
  // Mute ↔ mute+deafen while the GoXLR is muted: undo the old key in Discord, then press the new one.
  ctx.discordModeChanged = async (from, to) => {
    const d = settings();
    if (!d.enabled || from === to || !micMutedForChat(ctx.conn.mixer, d)) return;
    if (await press(discordKeyFor(d, from))) {
      await new Promise((r) => setTimeout(r, 250));
      await press(discordKeyFor(d, to));
    }
  };
  ctx.conn.addEventListener('change', async () => {
    const d = settings();
    const m = ctx.conn.mixer;
    if (!d.enabled || !m) { last = null; return; }
    const now = micMutedForChat(m, d);
    if (last === null) { last = now; return; }
    if (now === last) return;
    last = now;
    if (!(await discordRunning().catch(() => false))) return;
    await sendKeys(discordKeyFor(d)).catch((e) => toast(`Discord: ${e}`));
    if (ctx.prefs.osd !== false) ctx.notify?.(discordNotice(discordMode(d), now), now ? 'mute' : 'ok');
  });
}
