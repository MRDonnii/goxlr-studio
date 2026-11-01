import { micMutedForChat } from './extras.js';
import { sendKeys, discordRunning } from './native.js';
import { toast } from './ui.js';

export const DEFAULT_DISCORD_KEY = 'Ctrl+Shift+Alt+D';

// Mirrors the GoXLR's mic mute (hardware button, fader mute or the app) into Discord by pressing
// Discord's "Toggle Mute" keybind whenever the state flips.
export function startDiscordSync(ctx) {
  let last = null;
  const settings = () => ctx.prefs.discord || {};
  ctx.discordToggle = async () => {
    if (!(await discordRunning().catch(() => false))) { toast('Discord kører ikke'); return; }
    await sendKeys(settings().accel || DEFAULT_DISCORD_KEY).catch((e) => toast(`Discord: ${e}`));
  };
  // Called when sync is switched on: Discord is assumed unmuted, so mute it now if the GoXLR is.
  ctx.discordAlign = async () => {
    last = micMutedForChat(ctx.conn.mixer, settings());
    if (last) await ctx.discordToggle();
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
    await sendKeys(d.accel || DEFAULT_DISCORD_KEY).catch((e) => toast(`Discord: ${e}`));
    if (ctx.prefs.osd !== false) ctx.notify?.(now ? 'Discord: mikrofon slået fra' : 'Discord: mikrofon slået til', now ? 'mute' : 'ok');
  });
}
