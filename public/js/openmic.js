// "Fang alt": while a key or a foot pedal is held, the microphone's noise gate is off (and, if
// chosen, the gain a few dB up), so quiet sounds that are not speech get through. Let go = the
// mic is back exactly as it was. The GoXLR's own Bleep button cannot do this: the GoXLR itself
// mutes the mic and plays the bleep while it is held.
import { h, toast } from './ui.js';
import { prettyAccel, accelFromEvent } from './views-hotkeys.js';

export const OPEN_MIC_ACTION = 'hold:open-mic';
export const BOOST_CHOICES = [0, 3, 6, 10];
const MAX_GAIN = 72;

/** What to send when held, and what is needed to put the mic back. Pure. */
export function openMicCommands(mic, opts = {}) {
  const press = [];
  const gate = !!mic?.noise_gate?.enabled;
  const type = mic?.mic_type;
  const gain = mic?.mic_gains?.[type];
  const boost = Math.max(0, Math.min(20, Number(opts.boost) || 0));
  if (gate) press.push(['SetGateActive', false]);
  let boosted = false;
  if (boost > 0 && type && Number.isFinite(gain) && gain < MAX_GAIN) {
    press.push(['SetMicrophoneGain', type, Math.min(MAX_GAIN, gain + boost)]);
    boosted = true;
  }
  return { press, saved: { gate, type, gain: boosted ? gain : null } };
}

/** The commands that put the mic back as it was before "Fang alt". Pure. */
export function restoreCommands(saved) {
  if (!saved) return [];
  const out = [];
  if (saved.gate) out.push(['SetGateActive', true]);
  if (saved.type && Number.isFinite(saved.gain)) out.push(['SetMicrophoneGain', saved.type, saved.gain]);
  return out;
}

const settings = (ctx) => (ctx.prefs.openMic ??= { boost: 0 });

/** Pressed: open the mic up (a held key repeating does nothing). */
export function openMicDown(ctx) {
  const s = settings(ctx);
  const m = ctx.conn.mixer;
  if (s.saved || !m) return;
  const { press, saved } = openMicCommands(m.mic_status, s);
  s.saved = saved; // in prefs, so the mic is put back even if the app closed while held
  ctx.savePrefs?.();
  for (const c of press) ctx.conn.command(...c);
  // Ren mikrofon steps aside too (voiceclean.js), so nothing is removed while held.
  if (ctx.prefs.voiceClean?.enabled) ctx.applyOutputEq?.();
  ctx.notify?.('Fang alt: mikrofonen tager alt med', 'ok');
}

/** Let go: the mic as it was. */
export function openMicUp(ctx) {
  const s = settings(ctx);
  if (!s.saved) return;
  const cmds = restoreCommands(s.saved);
  delete s.saved;
  ctx.savePrefs?.();
  if (ctx.conn.mixer) for (const c of cmds) ctx.conn.command(...c);
  if (ctx.prefs.voiceClean?.enabled) ctx.applyOutputEq?.();
}

/** At start: the app closed while "Fang alt" was held – put the mic back. */
export function restoreOpenMic(ctx) {
  if (ctx.prefs.openMic?.saved && ctx.conn.mixer) openMicUp(ctx);
}

// ---------- card on the Mikrofon page ----------
export function openMicCard(ctx) {
  const s = settings(ctx);
  const binding = () => ctx.hotkeys.find((b) => b.id === 'open-mic');
  const keyBtn = h('button', { class: 'btn keycap', 'data-testid': 'open-mic-key' });
  const remove = h('button', { class: 'btn sm', 'data-testid': 'open-mic-remove', onclick: async () => {
    ctx.hotkeys = ctx.hotkeys.filter((b) => b.id !== 'open-mic');
    await ctx.saveHotkeys();
    render();
  } }, 'Fjern tasten');
  const boost = h('select', { 'data-testid': 'open-mic-boost', onchange: () => { s.boost = Number(boost.value); ctx.savePrefs(); } },
    ...BOOST_CHOICES.map((b) => h('option', { value: String(b) }, b ? `Gain +${b} dB mens du holder` : 'Kun noise gate fra')));
  keyBtn.addEventListener('click', () => {
    keyBtn.textContent = 'Tryk tasten … (Esc = annullér)';
    ctx.capturingHotkey = true;
    ctx.pauseHotkeys?.();
    const onKey = async (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') return done();
      const a = accelFromEvent(e);
      if (!a) return;
      const clash = ctx.hotkeys.find((x) => x.id !== 'open-mic' && x.accel === a);
      if (clash) { toast(`${prettyAccel(a)} bruges allerede af en anden genvej`); return; }
      const b = binding();
      if (b) b.accel = a; else ctx.hotkeys.push({ id: 'open-mic', accel: a, action: OPEN_MIC_ACTION });
      done();
      await ctx.saveHotkeys();
      render();
    };
    const done = () => { window.removeEventListener('keydown', onKey, true); ctx.capturingHotkey = false; ctx.resumeHotkeys?.(); render(); };
    window.addEventListener('keydown', onKey, true);
  });
  const render = () => {
    keyBtn.textContent = binding()?.accel ? prettyAccel(binding().accel) : 'Vælg tast';
    remove.style.display = binding() ? '' : 'none';
    boost.value = String(BOOST_CHOICES.includes(s.boost) ? s.boost : 0);
  };
  render();
  return h('div', { class: 'card', 'data-testid': 'open-mic-card' }, h('h2', {}, 'Fang alt (hold)'),
    h('div', { class: 'hint' }, 'Mens du holder tasten, slås noise gaten og Ren mikrofon (støj- og ekkofjerner) fra, så mikrofonen også tager stille lyde med, der ikke er tale – grin, prut og andet sjov. Slip tasten, og mikrofonen er som før.'),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('label', {}, 'Tast'), keyBtn, remove),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('label', {}, 'Ekstra'), boost),
    h('div', { class: 'hint' }, 'Kan også lægges på en fodpedal (Fodpedal → Hold → Fang alt). GoXLR’ens Bleep-knap kan ikke bruges: GoXLR’en muter selv mikrofonen og bipper, mens den holdes.'),
    h('div', { class: 'hint' }, 'Discord fjerner selv lyde, der ikke er tale. Skal de andre høre det, så slå Discords støjfjernelse (Krisp) fra under Stemme og video – og sæt indgangsfølsomheden lavt, eller brug push-to-talk.'));
}
