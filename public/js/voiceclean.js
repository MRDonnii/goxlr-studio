// Ren mikrofon: echo and noise removal on your own microphone, so teammates do not hear the game,
// themselves or your keyboard when you play on speakers. GoXLR Studio's plugin (plugins/voiceclean)
// runs in the EQ engine on the GoXLR's "Chat Mic" – what Discord, games and the like record – and
// GoXLR Studio sends it what the speakers play (voiceref.rs), so the echo canceller knows what to
// remove. The pure parts are in voicemodel.js.
import { h, toast, confirmDialog, logActivity } from './ui.js';
import { engineInfo, engineTask, listAudioDevices, deviceFormat, voiceConfigure, voiceStatus, voiceCheck } from './native.js';
import { channelEndpoint } from './extras.js';
import { voiceSettings, NOISE_LEVELS, NOISE_HINT, GOXLR_SPEAKER_OUTPUTS, referenceSources, referencePayload, micPayload, pickChatMic, voiceStatusLine, noteText, voiceDiagnosis, diagnosisText } from './voicemodel.js';

let devCache = { at: 0, list: [] };
async function audioDevices(force = false) {
  if (force || Date.now() - devCache.at > 10000) devCache = { at: Date.now(), list: await listAudioDevices().catch(() => devCache.list) };
  return devCache.list;
}
let micCache = { at: 0, list: [] };
async function engineMics(force = false) {
  if (force || Date.now() - micCache.at > 5000) micCache = { at: Date.now(), list: (await engineInfo().catch(() => null))?.mics || micCache.list };
  return micCache.list;
}

/** The mic part of the EQ engine's config (apo.rs MicClean), or null. */
export async function voiceMicPayload(ctx) {
  const cfg = voiceSettings(ctx.prefs);
  if (!cfg.enabled) return null;
  return micPayload(cfg, await engineMics(), { openMicHeld: !!ctx.prefs.openMic?.saved });
}

/** Keeps the echo reference in step with the GoXLR's faders, mutes and routing (every 0,5 s). */
export function startVoiceClean(ctx) {
  let last = '';
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const cfg = voiceSettings(ctx.prefs);
      const devs = cfg.enabled && cfg.echo ? await audioDevices() : [];
      const payload = referencePayload(cfg, ctx.conn.mixer, (ch) => channelEndpoint(ch, devs));
      const key = JSON.stringify(payload);
      if (key !== last) {
        await voiceConfigure(payload);
        last = key;
      }
    } catch { /* tried again in half a second */ } finally { busy = false; }
  };
  tick();
  setInterval(tick, 500);
}

// Each part in its own element, so every sentence is translated on its own (i18n.js).
const joined = (parts) => parts.flatMap((p, i) => (i ? [' · ', h('span', {}, p)] : [h('span', {}, p)]));

const ROUTE_NAME = { Music: 'Musik', Game: 'Spil', System: 'System', Chat: 'Chat', Samples: 'Samples' };
const UNROUTE = { Music: 'Send ikke musikken til chatten', Game: 'Send ikke spillyden til chatten', System: 'Send ikke systemlyde til chatten', Chat: 'Send ikke chatten tilbage til chatten', Samples: 'Send ikke samples til chatten' };

export function voiceCleanCard(ctx) {
  const cfg = voiceSettings(ctx.prefs);
  const statusDot = h('span', { class: 'voice-dot' });
  const statusText = h('span', { 'data-testid': 'voice-status' });
  const detail = h('div', { class: 'hint', 'data-testid': 'voice-detail' });
  const body = h('div');
  // Tjek: step by step what works and what does not, with a fix where there is one.
  const checkList = h('div', { class: 'voice-check', 'data-testid': 'voice-check' });
  const discordHint = h('div', { class: 'hint', 'data-testid': 'voice-discord-hint' });
  const seen = { info: null, target: null, devs: [], check: null, checkedAt: 0, diag: null };
  const card = h('div', { class: 'card', 'data-testid': 'voice-clean' },
    h('h2', {}, 'Ren mikrofon'),
    h('div', { class: 'voice-status row' }, statusDot, statusText), detail, checkList, body);
  let installed = false;
  let rendering = false;

  const changed = () => { ctx.savePrefs(); ctx.applyOutputEq?.(); render(); };

  const render = async () => {
    if (rendering) return;
    rendering = true;
    try {
      const [info, devs] = await Promise.all([engineInfo().catch(() => null), audioDevices(true)]);
      micCache = { at: Date.now(), list: info?.mics || [] };
      const mics = info?.mics || [];
      const chat = pickChatMic(mics);
      if (chat && (!cfg.device || !mics.some((d) => d.id.toLowerCase() === cfg.device.toLowerCase()))) { cfg.device = chat.id; cfg.deviceName = chat.name; ctx.savePrefs(); }
      const target = mics.find((d) => cfg.device && d.id.toLowerCase() === cfg.device.toLowerCase()) || null;
      installed = !!target?.installed;
      Object.assign(seen, { info, target, devs });
      const fmt = target ? await deviceFormat(target.id).catch(() => null) : null;
      const builtin = info?.kind === 'builtin';

      const sw = h('input', { type: 'checkbox', 'data-testid': 'voice-on', checked: !!cfg.enabled, onchange: () => { cfg.enabled = sw.checked; logActivity(cfg.enabled ? 'Ren mikrofon slået til' : 'Ren mikrofon slået fra'); changed(); } });
      const noise = h('div', { class: 'seg', 'data-testid': 'voice-noise' }, ...NOISE_LEVELS.map(([v, label]) =>
        h('button', { class: cfg.noise === v ? 'on' : '', 'data-value': v, onclick: () => { cfg.noise = v; changed(); } }, label)));
      const echo = h('input', { type: 'checkbox', 'data-testid': 'voice-echo', checked: !!cfg.echo, onchange: () => { cfg.echo = echo.checked; changed(); } });
      const hp = h('input', { type: 'checkbox', 'data-testid': 'voice-highpass', checked: cfg.highPass !== false, onchange: () => { cfg.highPass = hp.checked; changed(); } });
      const others = devs.filter((d) => d.flow === 'render' && !/goxlr|tc-helicon/i.test(d.name));
      const speakers = h('select', { 'data-testid': 'voice-speakers', onchange: () => { cfg.speakers = speakers.value; changed(); } },
        h('option', { value: 'Headphones' }, 'GoXLR’ens hovedtelefon-udgang'),
        h('option', { value: 'LineOut' }, 'GoXLR’ens Line Out'),
        ...others.map((d) => h('option', { value: d.id }, d.name)));
      speakers.value = cfg.speakers || 'Headphones';
      if (speakers.value !== (cfg.speakers || 'Headphones')) speakers.append(h('option', { value: cfg.speakers, selected: true }, 'Udgang der ikke er tilsluttet'));

      // What stands in the way, with a fix where there is one.
      const notes = [];
      if (!info) notes.push(h('div', { class: 'hint warn-text' }, 'Kunne ikke læse EQ-motorens status.'));
      else if (!info.voice_bundled) notes.push(h('div', { class: 'hint warn-text' }, 'Denne udgave af appen har ikke Ren mikrofon med.'));
      else if (!builtin) notes.push(h('div', { class: 'hint warn-text' }, 'Kræver GoXLR Studios egen EQ-motor – installér den på EQ-siden først.'));
      else if (!target) notes.push(h('div', { class: 'hint warn-text' }, 'Fandt ikke GoXLR’ens "Chat Mic" i Windows.'));
      if (fmt?.rate && fmt.rate !== 48000) notes.push(h('div', { class: 'hint warn-text' }, `Chat Mic kører ${fmt.rate / 1000} kHz – Ren mikrofon virker kun ved 48 kHz. Skift det i Windows: Lyd → Optagelse → Chat Mic (TC-Helicon GoXLR) → Egenskaber → Avanceret → 48000 Hz.`));
      if (cfg.enabled && cfg.echo) {
        const { notes: ref } = referenceSources(ctx.conn.mixer, cfg.speakers, (ch) => channelEndpoint(ch, devs));
        for (const n of ref) {
          const fix = n.code === 'to-chat' && ROUTE_NAME[n.channel]
            ? h('button', { class: 'btn sm', 'data-testid': `voice-unroute-${n.channel}`, onclick: async () => {
              await ctx.conn.command('SetRouter', n.channel, 'ChatMic', false);
              logActivity(`Ren mikrofon: ${ROUTE_NAME[n.channel]} sendes ikke længere til Chat Mic`);
              setTimeout(render, 400);
            } }, UNROUTE[n.channel])
            : '';
          notes.push(h('div', { class: 'hint warn-text voice-note' }, noteText(n), fix ? ' ' : '', fix));
        }
      }

      // A plugin from an older version (without Stemmeisolering): put the new one in.
      const update = installed && info?.voice_outdated
        ? h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'hint warn-text' }, cfg.noise === 'isolate' ? 'Ren mikrofon skal opdateres for at få Stemmeisolering – indtil da bruges Stærk. Kræver administrator; Windows’ lyd genstarter et øjeblik.' : 'Der er en nyere udgave af Ren mikrofon. Kræver administrator; Windows’ lyd genstarter et øjeblik.'),
          h('button', { class: 'btn sm primary', 'data-testid': 'voice-update', onclick: async (e) => {
            e.target.disabled = true;
            try {
              const r = await engineTask({ action: 'set-mics', devices: mics.filter((d) => d.installed).map((d) => d.id) });
              toast(r?.ok ? 'Ren mikrofon er opdateret' : `Det lykkedes ikke: ${r?.error || '?'}`, r?.ok ? 'info' : 'error');
            } catch (err) { toast(String(err)); }
            await engineMics(true);
            ctx.applyOutputEq?.();
            render();
          } }, 'Opdatér'))
        : '';
      const install = builtin && info.voice_bundled && target && !installed
        ? h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'hint' }, `EQ-motoren skal sættes på ${target.name} (kræver administrator én gang; Windows’ lyd genstarter et øjeblik).`),
          h('button', { class: 'btn sm primary', 'data-testid': 'voice-install', onclick: async (e) => {
            e.target.disabled = true;
            try {
              const r = await engineTask({ action: 'set-mics', devices: [target.id] });
              toast(r?.ok ? 'Ren mikrofon er sat på Chat Mic' : `Det lykkedes ikke: ${r?.error || '?'}`, r?.ok ? 'info' : 'error');
              if (r?.ok) { cfg.enabled = true; ctx.savePrefs(); }
            } catch (err) { toast(String(err)); }
            await engineMics(true);
            ctx.applyOutputEq?.();
            render();
          } }, 'Sæt den på'))
        : '';
      const remove = installed
        ? h('button', { class: 'btn sm', 'data-testid': 'voice-remove', onclick: async () => {
          if (!(await confirmDialog('Fjerne EQ-motoren fra mikrofonen?\n\nMikrofonen virker som før, bare uden Ren mikrofon. Kræver administrator; Windows’ lyd genstarter et øjeblik.', { ok: 'Fjern' }))) return;
          try {
            const r = await engineTask({ action: 'set-mics', devices: [] });
            toast(r?.ok ? 'EQ-motoren er fjernet fra mikrofonen' : `Det lykkedes ikke: ${r?.error || '?'}`, r?.ok ? 'info' : 'error');
            if (r?.ok) { cfg.enabled = false; ctx.savePrefs(); }
          } catch (err) { toast(String(err)); }
          await engineMics(true);
          ctx.applyOutputEq?.();
          render();
        } }, 'Fjern fra mikrofonen')
        : '';

      body.replaceChildren(
        h('div', { class: 'row' }, h('label', {}, 'Rens mikrofonen'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, sw, h('span'))),
        h('div', { class: cfg.enabled ? '' : 'disabled-block' },
          h('div', { class: 'row' }, h('label', {}, 'Støjfjerner'), noise),
          h('div', { class: 'hint', 'data-testid': 'voice-noise-hint' }, NOISE_HINT[cfg.noise] || NOISE_HINT.normal),
          h('div', { class: 'row' }, h('label', {}, 'Ekkofjerner (spiller du med højttalere)'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, echo, h('span'))),
          cfg.echo ? h('div', { class: 'row' }, h('label', {}, 'Højttalerne sidder på'), speakers) : '',
          h('div', { class: 'row' }, h('label', {}, 'Fjern rumlen (dybe lyde fra bord og fødder)'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, hp, h('span')))),
        update, ...notes, install,
        h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Det dine medspillere hører, renses: det, højttalerne spiller (spil, deres egne stemmer, musik), fjernes fra mikrofonen, og støj dæmpes. Det sker i GoXLR Studios EQ-motor på GoXLR’ens Chat Mic, som Discord og spil optager fra – ca. 10 ms forsinkelse (40 ms med Stemmeisolering). Streamen (Broadcast Mix) får mikrofonen som før.'),
        discordHint,
        h('div', { class: 'hint' }, 'Prøv det: "Optag og lyt" i Mikrofon-assistenten optager fra Chat Mic. Sæt noget til at spille på højttalerne, og tal imens – spillyden skal være væk i optagelsen.'),
        remove ? h('div', { class: 'row', style: { marginTop: '6px' } }, remove) : '');
    } finally { rendering = false; }
    poll();
  };

  const poll = async () => {
    const st = await voiceStatus().catch(() => null);
    const line = voiceStatusLine(cfg, st, { installed });
    const key = JSON.stringify([line.level, line.parts]);
    if (statusText.dataset.key !== key) {
      statusText.dataset.key = key;
      statusText.replaceChildren(...joined(line.parts));
    }
    statusDot.className = `voice-dot ${line.level}`;
    const bits = [];
    if (cfg.enabled && st?.plugin && cfg.echo) {
      bits.push(st.playing ? 'Højttalerne spiller' : 'Højttalerne er stille');
      if (Number.isFinite(st.delay_ms) && st.delay_ms >= 0) bits.push(`Ekkoets forsinkelse: ${st.delay_ms} ms`);
    }
    const bad = (st?.sources || []).find((s) => s.error);
    if (cfg.enabled && cfg.echo && bad) bits.push(`Kan ikke lytte til en udgang: ${bad.error}`);
    const dkey = JSON.stringify(bits);
    if (detail.dataset.key !== dkey) { detail.dataset.key = dkey; detail.replaceChildren(...joined(bits)); }
    // Who records from which mic: every 3 s.
    if (Date.now() - seen.checkedAt > 3000) {
      seen.checkedAt = Date.now();
      seen.check = await voiceCheck().catch(() => null);
    }
    const nameOf = (id) => seen.devs.find((d) => d.id === id)?.name || id;
    const diag = voiceDiagnosis({ cfg, mic: seen.target, outdated: !!seen.info?.voice_outdated, check: seen.check, status: st, nameOf });
    seen.diag = diag;
    renderCheck(diag);
  };

  const FIX_LABEL = { install: 'Sæt den på', update: 'Opdatér', apply: 'Skriv igen', mode: 'Prøv en anden måde' };
  const runFix = async (fix, button) => {
    button.disabled = true;
    const mic = seen.target;
    try {
      if (fix === 'apply') {
        await ctx.applyOutputEq?.();
        toast('Indstillingerne er skrevet til EQ-motoren igen', 'info');
      } else if (mic) {
        const task = fix === 'mode'
          ? { action: 'set-mics', devices: [mic.id], mode: mic.mode === 'lfx-gfx' ? 'sfx-mfx' : 'lfx-gfx' }
          : { action: 'set-mics', devices: fix === 'update' ? (seen.info?.mics || []).filter((d) => d.installed).map((d) => d.id) : [mic.id] };
        const r = await engineTask(task);
        toast(r?.ok ? 'Færdig – tjekket opdateres om et øjeblik' : `Det lykkedes ikke: ${r?.error || '?'}`, r?.ok ? 'info' : 'error');
        if (r?.ok && fix === 'install') { cfg.enabled = true; ctx.savePrefs(); }
        logActivity(`Ren mikrofon: ${FIX_LABEL[fix]} (${r?.ok ? 'ok' : 'fejlede'})`);
        await engineMics(true);
        ctx.applyOutputEq?.();
      }
    } catch (err) { toast(String(err)); }
    seen.checkedAt = 0;
    render();
  };

  const renderCheck = (diag) => {
    const key = JSON.stringify(diag);
    if (checkList.dataset.key === key) return;
    checkList.dataset.key = key;
    const icon = (ok) => (ok === true ? '✓' : ok === false ? '✗' : '–');
    checkList.replaceChildren(
      ...diag.items.map((i) => h('div', { class: `voice-check-item ${i.ok === true ? 'ok' : i.ok === false ? 'bad' : 'wait'}`, 'data-check': i.id },
        h('span', { class: 'voice-check-icon' }, icon(i.ok)), h('span', {}, i.text),
        i.fix ? h('button', { class: 'btn sm primary', 'data-testid': `voice-fix-${i.fix}`, onclick: (e) => runFix(i.fix, e.target) }, FIX_LABEL[i.fix]) : '')),
      cfg.enabled ? h('div', { class: 'row', style: { marginTop: '4px' } },
        h('span', { class: 'hint' }, diag.allGood ? 'Alt ser rigtigt ud.' : 'Ret det, der har ✗, fra oven og ned.'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', 'data-testid': 'voice-copy-check', onclick: async () => {
          try { await navigator.clipboard.writeText(['Ren mikrofon – tjek', diagnosisText(diag)].join('\n')); toast('Tjekket er kopieret', 'info'); } catch { toast('Kunne ikke kopiere'); }
        } }, 'Kopiér tjek')) : '');
    // Discord's own noise suppression: off only once ours is proven to work on Discord's sound.
    discordHint.textContent = diag.allGood
      ? 'Ren mikrofon renser Discords lyd. Slå Discords egen Støjreduktion (Krisp) og Ekko-annullering fra under Stemme og video, så lyden ikke renses to gange.'
      : 'Lad Discords egen Støjreduktion være slået til, indtil tjekket herover er i orden – så er du dækket ind imens.';
  };
  const timer = setInterval(() => { if (!card.isConnected) { clearInterval(timer); return; } poll(); }, 1000);
  render();
  return card;
}
