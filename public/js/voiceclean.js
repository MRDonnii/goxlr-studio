// Ren mikrofon: echo and noise removal on your own microphone, so teammates do not hear the game,
// themselves or your keyboard when you play on speakers. GoXLR Studio's plugin (plugins/voiceclean)
// runs in the EQ engine on the GoXLR's "Chat Mic" – what Discord, games and the like record – and
// GoXLR Studio sends it what the speakers play (voiceref.rs), so the echo canceller knows what to
// remove. The pure parts are in voicemodel.js.
import { h, toast, confirmDialog, logActivity } from './ui.js';
import { engineInfo, engineTask, listAudioDevices, deviceFormat, voiceConfigure, voiceStatus, voiceCheck, storeGet, storeSet, setDemoVoicePhase } from './native.js';
import { channelEndpoint } from './extras.js';
import { voiceSettings, NOISE_LEVELS, NOISE_HINT, AMOUNT_LEVELS, AMOUNT_HINT, GOXLR_SPEAKER_OUTPUTS, referenceSources, referencePayload, micPayload, pickChatMic, voiceStatusLine, noteText, voiceDiagnosis, diagnosisText, latestMicTest, smoothInstances, MIC_TEST_STEPS, micTestVerdict } from './voicemodel.js';

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

/** Saves the microphone tests of an engine task (set-mics/test), so the check can show them. */
export function saveVoiceTest(r) {
  const tests = (r?.tests || []).filter((t) => t.capture);
  if (tests.length) storeSet('voice-test', { at: Date.now(), tests }).catch(() => {});
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

// Opens a recording from the GoXLR's "Chat Mic" (as Discord does, so the cleaner runs on it) and
// records it, so the test can be listened to afterwards. Null if the mic cannot be opened.
async function openChatMic() {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  const raw = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  try {
    let stream = await navigator.mediaDevices.getUserMedia({ audio: raw });
    const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    const chat = inputs.find((d) => /chat mic/i.test(d.label) && /goxlr|tc-helicon/i.test(d.label));
    if (chat && stream.getAudioTracks()[0]?.getSettings().deviceId !== chat.deviceId) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...raw, deviceId: { exact: chat.deviceId } } });
    }
    const chunks = [];
    let rec = null;
    try {
      rec = new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.start();
    } catch { rec = null; }
    return {
      async stop() {
        let url = null;
        if (rec && rec.state !== 'inactive') {
          const stopped = new Promise((r) => { rec.onstop = r; });
          rec.stop();
          await stopped;
          if (chunks.length) url = URL.createObjectURL(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        }
        stream.getTracks().forEach((t) => t.stop());
        return url;
      },
    };
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function voiceCleanCard(ctx) {
  const cfg = voiceSettings(ctx.prefs);
  const statusDot = h('span', { class: 'voice-dot' });
  const statusText = h('span', { 'data-testid': 'voice-status' });
  const detail = h('div', { class: 'hint', 'data-testid': 'voice-detail' });
  const body = h('div');
  // Tjek: step by step what works and what does not, with a fix where there is one.
  const checkList = h('div', { class: 'voice-check', 'data-testid': 'voice-check' });
  const discordHint = h('div', { class: 'hint', 'data-testid': 'voice-discord-hint' });
  const testBox = h('div', { class: 'voice-test', 'data-testid': 'voice-test' });
  let testing = false;
  let lastTest = null;
  const seen = { info: null, target: null, devs: [], check: null, checkedAt: 0, diag: null, test: null, inst: [] };
  const card = h('div', { class: 'card', 'data-testid': 'voice-clean' },
    h('h2', {}, 'Ren mikrofon'),
    h('div', { class: 'voice-status row' }, statusDot, statusText), detail, checkList, testBox, body);
  let installed = false;
  let rendering = false;

  const apply = () => ctx.applyOutputEq?.()?.catch?.((e) => toast(`EQ-motor: ${e?.message || e}`));
  const changed = () => { ctx.savePrefs(); apply(); render(); };
  // Runs an engine task for the mic and keeps its test results.
  const micTask = async (task) => {
    const r = await engineTask(task);
    saveVoiceTest(r);
    return r;
  };

  const render = async () => {
    if (rendering) return;
    rendering = true;
    try {
      const [info, devs, voiceTest, engineTest] = await Promise.all([engineInfo().catch(() => null), audioDevices(true), storeGet('voice-test', null).catch(() => null), storeGet('engine-test', null).catch(() => null)]);
      micCache = { at: Date.now(), list: info?.mics || [] };
      const mics = info?.mics || [];
      const chat = pickChatMic(mics);
      if (chat && (!cfg.device || !mics.some((d) => d.id.toLowerCase() === cfg.device.toLowerCase()))) { cfg.device = chat.id; cfg.deviceName = chat.name; ctx.savePrefs(); }
      const target = mics.find((d) => cfg.device && d.id.toLowerCase() === cfg.device.toLowerCase()) || null;
      installed = !!target?.installed;
      Object.assign(seen, { info, target, devs, test: target ? latestMicTest([voiceTest, engineTest], target.id) : null });
      const fmt = target ? await deviceFormat(target.id).catch(() => null) : null;
      const builtin = info?.kind === 'builtin';

      const sw = h('input', { type: 'checkbox', 'data-testid': 'voice-on', checked: !!cfg.enabled, onchange: () => { cfg.enabled = sw.checked; logActivity(cfg.enabled ? 'Ren mikrofon slået til' : 'Ren mikrofon slået fra'); changed(); } });
      const noise = h('div', { class: 'seg', 'data-testid': 'voice-noise' }, ...NOISE_LEVELS.map(([v, label]) =>
        h('button', { class: cfg.noise === v ? 'on' : '', 'data-value': v, onclick: () => { cfg.noise = v; changed(); } }, label)));
      const amount = h('div', { class: 'seg', 'data-testid': 'voice-amount' }, ...AMOUNT_LEVELS.map(([v, label]) =>
        h('button', { class: (cfg.amount || 'full') === v ? 'on' : '', 'data-value': v, onclick: () => { cfg.amount = v; changed(); } }, label)));
      // Stærk/Normal leave most of the typing (measured: Stærk about 7 dB, Stemmeisolering 70–80 dB).
      const suggest = (cfg.noise === 'strong' || cfg.noise === 'normal')
        ? h('div', { class: 'row hint warn-text', 'data-testid': 'voice-suggest-isolate' }, h('span', {}, 'Kan de stadig høre dine taster? Stemmeisolering fjerner dem næsten helt (Stærk dæmper dem kun lidt).'),
          h('button', { class: 'btn sm primary', onclick: () => { cfg.noise = 'isolate'; logActivity('Ren mikrofon: skiftet til Stemmeisolering'); changed(); } }, 'Brug Stemmeisolering'))
        : '';
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
              const r = await micTask({ action: 'set-mics', devices: mics.filter((d) => d.installed).map((d) => d.id) });
              toast(r?.ok ? 'Ren mikrofon er opdateret' : `Det lykkedes ikke: ${r?.error || '?'}`, r?.ok ? 'info' : 'error');
            } catch (err) { toast(String(err)); }
            await engineMics(true);
            apply();
            render();
          } }, 'Opdatér'))
        : '';
      const install = builtin && info.voice_bundled && target && !installed
        ? h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'hint' }, `EQ-motoren skal sættes på ${target.name} (kræver administrator én gang; Windows’ lyd genstarter et øjeblik).`),
          h('button', { class: 'btn sm primary', 'data-testid': 'voice-install', onclick: async (e) => {
            e.target.disabled = true;
            try {
              const r = await micTask({ action: 'set-mics', devices: [target.id] });
              toast(r?.ok ? 'Ren mikrofon er sat på Chat Mic' : `Det lykkedes ikke: ${r?.error || '?'}`, r?.ok ? 'info' : 'error');
              if (r?.ok) { cfg.enabled = true; ctx.savePrefs(); }
            } catch (err) { toast(String(err)); }
            await engineMics(true);
            apply();
            render();
          } }, 'Sæt den på'))
        : '';
      const remove = installed
        ? h('button', { class: 'btn sm', 'data-testid': 'voice-remove', onclick: async () => {
          if (!(await confirmDialog('Fjerne EQ-motoren fra mikrofonen?\n\nMikrofonen virker som før, bare uden Ren mikrofon. Kræver administrator; Windows’ lyd genstarter et øjeblik.', { ok: 'Fjern' }))) return;
          try {
            const r = await micTask({ action: 'set-mics', devices: [] });
            toast(r?.ok ? 'EQ-motoren er fjernet fra mikrofonen' : `Det lykkedes ikke: ${r?.error || '?'}`, r?.ok ? 'info' : 'error');
            if (r?.ok) { cfg.enabled = false; ctx.savePrefs(); }
          } catch (err) { toast(String(err)); }
          await engineMics(true);
          apply();
          render();
        } }, 'Fjern fra mikrofonen')
        : '';

      body.replaceChildren(
        h('div', { class: 'row' }, h('label', {}, 'Rens mikrofonen'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, sw, h('span'))),
        h('div', { class: cfg.enabled ? '' : 'disabled-block' },
          h('div', { class: 'row' }, h('label', {}, 'Støjfjerner'), noise),
          h('div', { class: 'hint', 'data-testid': 'voice-noise-hint' }, NOISE_HINT[cfg.noise] || NOISE_HINT.normal),
          suggest,
          cfg.noise === 'isolate' ? h('div', { class: 'row' }, h('label', {}, 'Styrke'), amount) : '',
          cfg.noise === 'isolate' ? h('div', { class: 'hint', 'data-testid': 'voice-amount-hint' }, AMOUNT_HINT[cfg.amount || 'full']) : '',
          h('div', { class: 'row' }, h('label', {}, 'Ekkofjerner (spiller du med højttalere)'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, echo, h('span'))),
          cfg.echo ? h('div', { class: 'row' }, h('label', {}, 'Højttalerne sidder på'), speakers) : '',
          h('div', { class: 'row' }, h('label', {}, 'Fjern rumlen (dybe lyde fra bord og fødder)'), h('div', { class: 'spacer' }), h('label', { class: 'switch' }, hp, h('span')))),
        update, ...notes, install,
        h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Det dine medspillere hører, renses: det, højttalerne spiller (spil, deres egne stemmer, musik), fjernes fra mikrofonen, og støj dæmpes. Det sker i GoXLR Studios EQ-motor på GoXLR’ens Chat Mic, som Discord og spil optager fra – ca. 10 ms forsinkelse (40 ms med Stemmeisolering). Streamen (Broadcast Mix) får mikrofonen som før.'),
        discordHint,
        h('div', { class: 'hint' }, 'Prøv det: "Optag og lyt" i Mikrofon-assistenten optager fra Chat Mic. Sæt noget til at spille på højttalerne, og tal imens – spillyden skal være væk i optagelsen.'),
        remove ? h('div', { class: 'row', style: { marginTop: '6px' } }, remove) : '');
    } finally { rendering = false; }
    renderTest();
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
    const instances = smoothInstances(seen.inst, st?.instances, Date.now());
    const diag = voiceDiagnosis({ cfg, mic: seen.target, outdated: !!seen.info?.voice_outdated, check: seen.check, status: st && { ...st, instances }, test: seen.test, nameOf });
    seen.diag = diag;
    renderCheck(diag);
  };

  const FIX_LABEL = { install: 'Sæt den på', update: 'Opdatér', apply: 'Skriv igen', mode: 'Prøv en anden måde', test: 'Test' };
  const runFix = async (fix, button) => {
    button.disabled = true;
    const mic = seen.target;
    try {
      if (fix === 'apply') {
        await ctx.applyOutputEq?.();
        toast('Indstillingerne er skrevet til EQ-motoren igen', 'info');
      } else if (mic) {
        const task = fix === 'test'
          ? { action: 'test' }
          : fix === 'mode'
            ? { action: 'set-mics', devices: [mic.id], mode: mic.mode === 'lfx-gfx' ? 'sfx-mfx' : 'lfx-gfx' }
            : { action: 'set-mics', devices: fix === 'update' ? (seen.info?.mics || []).filter((d) => d.installed).map((d) => d.id) : [mic.id] };
        if (fix === 'test') toast('Ren mikrofon testes – Windows beder om administrator-adgang, og lyden afbrydes et par gange', 'info');
        const r = await micTask(task);
        if (fix === 'test' && r?.tests?.length) storeSet('engine-test', { at: Date.now(), tests: r.tests, sound: r.sound }).catch(() => {});
        toast(r?.ok ? 'Færdig – tjekket opdateres om et øjeblik' : `Det lykkedes ikke: ${r?.error || '?'}`, r?.ok ? 'info' : 'error');
        if (r?.ok && fix === 'install') { cfg.enabled = true; ctx.savePrefs(); }
        logActivity(`Ren mikrofon: ${FIX_LABEL[fix]} (${r?.ok ? 'ok' : 'fejlede'})`);
        for (const l of (r?.log || []).filter((x) => /renses|Discord|afviste/.test(x))) logActivity(`Ren mikrofon: ${l}`);
        await engineMics(true);
        apply();
      }
    } catch (err) { toast(String(err)); }
    seen.checkedAt = 0;
    render();
  };

  // "Test din mikrofon": 2 × 6 s, measured in the plugin (in → out), recorded to listen to.
  const renderTest = () => {
    if (testing) return;
    const show = installed && cfg.enabled;
    const btn = h('button', { class: 'btn sm', 'data-testid': 'voice-test-start', onclick: () => runTest() }, lastTest ? 'Test igen' : 'Test din mikrofon');
    const parts = [h('div', { class: 'row' }, h('label', {}, 'Virker det? Test din mikrofon (12 sekunder)'), h('div', { class: 'spacer' }), btn)];
    if (lastTest) {
      parts.push(h('div', { class: `voice-test-result ${lastTest.code}`, 'data-testid': 'voice-test-result', 'data-code': lastTest.code }, ...lastTest.lines.map((l) => h('div', {}, l))));
      if (lastTest.url) parts.push(h('div', { class: 'row' }, h('span', { class: 'hint' }, 'Sådan lød din mikrofon efter renseren:'), h('audio', { controls: true, src: lastTest.url, 'data-testid': 'voice-test-audio' })));
    }
    testBox.replaceChildren(...(show ? parts : []));
  };

  const runTest = async () => {
    if (testing) return;
    testing = true;
    const say = h('div', { class: 'voice-test-step', 'data-testid': 'voice-test-step' });
    const live = h('div', { class: 'hint', 'data-testid': 'voice-test-live' });
    testBox.replaceChildren(say, live);
    const samples = { typing: [], speech: [] };
    let passing = null;
    if (lastTest?.url) URL.revokeObjectURL(lastTest.url);
    const mic = await openChatMic();
    try {
      say.textContent = 'Gør klar …';
      await sleep(1500);
      for (const step of MIC_TEST_STEPS) {
        setDemoVoicePhase(step.id);
        const end = Date.now() + step.seconds * 1000;
        while (Date.now() < end) {
          say.replaceChildren(h('span', {}, step.text), ` (${Math.ceil((end - Date.now()) / 1000)} s)`);
          const st = await voiceStatus().catch(() => null);
          if (st?.plugin) {
            if (st.broken) passing = 'broken';
            else if (st.bypassed && !passing) passing = 'rate';
            samples[step.id].push({ in_db: st.in_db, out_db: st.out_db });
            if (Number.isFinite(st.in_db) && Number.isFinite(st.out_db)) live.textContent = `ind ${Math.round(st.in_db)} dB → ud ${Math.round(st.out_db)} dB`;
          }
          await sleep(250);
        }
      }
    } finally {
      setDemoVoicePhase(null);
    }
    const url = mic ? await mic.stop() : null;
    const v = micTestVerdict({ ...samples, noise: cfg.noise, amount: cfg.amount || 'full', passing });
    if (!mic && v.code === 'not-running') v.lines.push('Appen kunne ikke åbne Chat Mic – tillad mikrofonen, eller start "Mikrofontest" i Discord under testen.');
    lastTest = { ...v, url, at: Date.now() };
    logActivity(`Ren mikrofon – test: ${v.lines.slice(0, 2).join(' · ')}`);
    testing = false;
    renderTest();
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
          const test = lastTest ? ['', 'Test af mikrofonen:', ...lastTest.lines] : [];
          try { await navigator.clipboard.writeText(['Ren mikrofon – tjek', diagnosisText(diag), ...test].join('\n')); toast('Tjekket er kopieret', 'info'); } catch { toast('Kunne ikke kopiere'); }
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
