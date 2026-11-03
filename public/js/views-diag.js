import { h, toast, errorLog, activityLog } from './ui.js';
import { engineStatus, listAudioDevices, appSessions, appInfo, isNative, daemonInfo, updateLog, driverInfo, soundcheckReport, engineInfo, storeGet, engineLog, openEngineLogDir } from './native.js';
import { troubleshoot, sessionLines, lineLevel, scrubLine } from './troubleshoot.js';
import { soundcheckFindings } from './soundcheckmodel.js';
import { engineTestSummary } from './views-outeq.js';
import { prettyAccel } from './views-hotkeys.js';
import { describeAction } from './actions.js';

const fmtFw = (fw) => (Array.isArray(fw) ? fw.join('.') : fw ? Object.values(fw).join('.') : '–');

export async function collectDiagnostics(ctx) {
  const { conn } = ctx;
  const m = conn.mixer;
  const [info, engine, devs, apps, daemon, updLog] = await Promise.all([
    appInfo().catch((e) => ({ error: String(e) })),
    engineStatus().catch((e) => ({ error: String(e) })),
    listAudioDevices().catch(() => []),
    appSessions().catch(() => []),
    daemonInfo().catch((e) => ({ error: String(e) })),
    updateLog().catch(() => []),
  ]);
  const driver = await driverInfo().catch((e) => ({ error: String(e) }));
  const elog = await engineLog(600).catch(() => ({ path: null, lines: [] }));
  const troubleDemo = new URLSearchParams(location.search).has('engineerror');
  const troubles = troubleshoot({ native: isNative() || troubleDemo, mode: conn.mode, autoStart: ctx.prefs.autoStartDaemon !== false, daemon: daemon.error ? {} : daemon, driver, log: elog.lines || [] });
  // Lydtjek and the last EQ-motor test belong in the report too (no passwords, no tokens).
  const [sc, engInfo, engTest] = await Promise.all([
    soundcheckReport().catch((e) => ({ error: String(e) })),
    engineInfo().catch(() => null),
    storeGet('engine-test', null).catch(() => null),
  ]);
  const findings = sc.error ? [`✗ ${sc.error}`] : soundcheckFindings(sc, {
    engine: engInfo && { kind: engInfo.kind, unregistered: engInfo.kind === 'builtin' && !!engInfo.registration && !engInfo.registration.ok, summary: engInfo.kind !== 'none' ? engineTestSummary(engTest?.tests, engTest?.sound) : null },
  }).map((f) => `${{ warn: '⚠', info: 'ℹ', ok: '✓' }[f.level]} ${f.title}`);
  const hotkeys = await Promise.all(ctx.hotkeys.map(async (b) => ({
    key: prettyAccel(b.accel),
    action: b.action ? await describeAction(ctx, b.action) : '–',
    status: ctx.hotkeyStatus[b.id] ? (ctx.hotkeyStatus[b.id].ok ? 'aktiv' : ctx.hotkeyStatus[b.id].error) : 'ikke registreret',
  })));
  return {
    _troubles: troubles,
    created: new Date().toISOString(),
    app: { ...info, native: isNative(), userAgent: navigator.userAgent },
    goxlr: m ? {
      mode: conn.mode,
      model: m.hardware.device_type,
      firmware: fmtFw(m.hardware.versions?.firmware),
      daemon: conn.status.config?.daemon_version || null,
      profile: m.profile_name,
      mic_profile: m.mic_profile_name,
      profiles: conn.status.files?.profiles || [],
      engine: daemon,
      driver: { installed: driver.installed, api: driver.api || null, version: conn.status.config?.driver_interface?.version || null },
    } : { mode: conn.mode, engine: daemon, driver: { installed: driver.installed, api: driver.api || null } },
    eq: {
      engine: { kind: engine.kind, version: engine.engine_version, running: engine.running, available: engine.available, apo_installed: engine.apo_installed, taken_over: engine.taken_over, reason: engine.reason || engine.error || null },
      apo_devices: (engine.devices || []).map((d) => `${d.apo ? '✓' : '✕'} ${d.name}`),
      preset: ctx.outputEq?.presetName || null,
      enabled: !!ctx.outputEq?.slots[ctx.outputEq.active]?.enabled,
      extras: ctx.outputEq?.extras || {},
      profile_links: ctx.outputEq?.profileLinks || {},
      channel_eq: ctx.outputEq?.channelEq || {},
      app_eq: ctx.outputEq?.appEq || [],
    },
    devices: devs.map((d) => `${d.flow === 'render' ? 'Ud' : 'Ind'}${d.default ? ' [standard]' : ''}${d.default_comm ? ' [kommunikation]' : ''}: ${d.name}`),
    apps: apps.map((a) => {
      const dev = (id) => devs.find((d) => d.id === id)?.name || (id ? 'Forældet enhed' : 'Windows-standard');
      return { exe: a.exe, output: dev(a.output), input: dev(a.input), stale: [a.output, a.input].some((id) => id && !devs.some((d) => d.id === id)) };
    }),
    hotkeys,
    app_rules: ctx.appRules.length,
    app_triggers: ctx.appTriggers?.length || 0,
    api: ctx.prefs.api ? { enabled: ctx.prefs.api.enabled, port: ctx.prefs.api.port, lan: ctx.prefs.api.lan, error: ctx.apiError || null } : null,
    soundcheck: { findings, ducking: sc.ducking ?? null, formats: (sc.endpoints || []).filter((e) => e.format).map((e) => `${e.name}: ${e.format.rate} Hz ${e.format.float ? 'float' : `${e.format.bits} bit`} · ${Math.round((e.volume ?? 1) * 100)} %${e.muted ? ' · muted' : ''}`) },
    engine_test: engTest ? { at: engTest.at ? new Date(engTest.at).toISOString() : null, tests: (engTest.tests || []).map((x) => `${x.ok ? '✓' : x.error ? '✗' : '–'} ${x.name}${x.mode ? ` (${x.mode})` : ''}${x.error ? `: ${x.error}` : ''}`), sound: engTest.sound || [] } : null,
    integrations: {
      mqtt: ctx.prefs.mqtt?.enabled ? { host: ctx.prefs.mqtt.host || null, user: !!ctx.prefs.mqtt.user } : null,
      obs: ctx.prefs.obs?.scenes?.length ? { host: ctx.prefs.obs.host, port: ctx.prefs.obs.port, scenes: ctx.prefs.obs.scenes.length, follow: Object.keys(ctx.prefs.obs.follow || {}).length } : null,
      device_triggers: ctx.deviceTriggers?.length || 0,
      language: ctx.prefs.lang || 'auto',
      hearing: ctx.prefs.hearing || null,
      ducking: ctx.ducker?.settings ? { mic: ctx.ducker.settings.enabled, chat: !!ctx.ducker.settings.chat?.enabled } : null,
    },
    // 0.7–0.9: what is switched on (no file names, games or passwords).
    features: {
      schedule: ctx.prefs.schedule?.enabled ? (ctx.prefs.schedule.rules || []).length : false,
      game_mode: ctx.prefs.gameMode?.enabled ? { mute_system: !!ctx.prefs.gameMode.muteSystem, active: !!ctx.gameMode?.active, muted_by_us: !!ctx.prefs.gameMode.mutedByUs } : false,
      mic_limiter: ctx.prefs.micLimiter?.enabled ? ctx.prefs.micLimiter.threshold : false,
      chatmix: ctx.prefs.chatMix?.enabled ? ctx.prefs.chatMix.position : false,
      level_match: ctx.outputEq?.levelMatch?.enabled ? ctx.outputEq.levelMatch.offsets : false,
      surround: ctx.outputEq?.extras?.surround?.enabled ? { angle: ctx.outputEq.extras.surround.angle, room: ctx.outputEq.extras.surround.room } : false,
      chat_denoise: !!ctx.outputEq?.chatDenoise?.enabled,
      clips: ctx.prefs.clips?.enabled ? ctx.prefs.clips.seconds : false,
      media_card: ctx.prefs.media?.card !== false,
      voice_enhance: Object.keys(ctx.prefs.voiceEnhance || {}).filter((k) => ctx.prefs.voiceEnhance[k]),
      tts: ctx.conn.status?.config?.tts_enabled ?? null,
    },
    // Fejlfinder + the GoXLR engine's own log (this run; user names in paths are removed).
    troubleshoot: troubles.map((f) => ({ level: f.level, problem: f.title, details: f.details.map(scrubLine) })),
    engine_log: {
      file: elog.path ? scrubLine(elog.path) : null,
      starts: (daemon.attempts || []).map((a) => `${new Date(a.at).toISOString()} ${a.ok ? '✓' : '✗'} ${a.text}`),
      problems: (elog.lines || []).filter((l) => lineLevel(l)).slice(-40).map(scrubLine),
      last: sessionLines(elog.lines).slice(-60).map(scrubLine),
    },
    errors: errorLog.slice(-20),
    activity: activityLog.slice(-40),
    update: { latest: ctx.updateState?.latest || null, error: ctx.updateState?.error || null, log: updLog },
  };
}

function section(title, rows) {
  return h('div', { class: 'card' }, h('h2', {}, title), h('div', { class: 'list' }, rows.length ? rows : h('div', { class: 'hint' }, 'Intet')));
}
const row = (k, v, cls) => h('div', { class: 'item' }, k, h('div', { class: 'spacer' }), cls ? h('span', { class: `badge ${cls}` }, v) : v);

const reportText = (r) => JSON.stringify({ ...r, _troubles: undefined }, null, 2);
const LEVEL_TEXT = { error: 'Fejl', warn: 'Advarsel', info: 'Info' };

// Fejlfinding: known problems with what to do about them (troubleshoot.js).
function troubleCard(ctx, r, reload) {
  const list = r._troubles || [];
  return h('div', { class: 'card', 'data-testid': 'trouble-card' },
    h('h2', {}, 'Fejlfinding', h('span', { class: 'row' }, h('button', { class: 'btn sm', 'data-testid': 'trouble-recheck', onclick: () => { ctx.selfCheck?.(); reload(); } }, 'Tjek igen'))),
    h('div', { class: 'hint' }, 'Appen holder selv øje med GoXLR-motoren, driveren og motorens log og foreslår en løsning, når den genkender en fejl. Den starter selv GoXLR-motoren igen, hvis den ikke kommer op.'),
    h('div', { class: 'list' }, list.length ? list.map((f) => h('div', { class: 'item', 'data-testid': 'trouble-item', 'data-trouble': f.id, style: { flexDirection: 'column', alignItems: 'stretch', gap: '6px' } },
      h('div', { class: 'row' }, h('span', { class: `badge ${f.level === 'info' ? '' : 'warn'}` }, LEVEL_TEXT[f.level]), h('b', {}, f.title)),
      h('div', {}, f.text),
      ...f.details.map((d) => h('div', { class: 'hint mono', 'data-no-i18n': '' }, scrubLine(d))),
      f.fixes.length ? h('div', { class: 'row' }, ...f.fixes.map((x, i) => h('button', { class: `btn sm ${i ? '' : 'primary'}`, onclick: () => ctx.runFix ? ctx.runFix(x.action).then(() => setTimeout(reload, 1600)) : toast('Kun i Windows-appen') }, x.label))) : null))
      : h('div', { class: 'item' }, h('span', { class: 'badge ok' }, 'OK'), 'Ingen kendte problemer fundet.')));
}

// GoXLR-motorens log (goxlr-daemon.log): this run, with errors and warnings marked.
function engineLogCard(r) {
  const e = r.engine_log || {};
  const lines = e.last || [];
  return h('div', { class: 'card', 'data-testid': 'engine-log-card' },
    h('h2', {}, 'GoXLR-motorens log',
      h('span', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => openEngineLogDir().catch((err) => toast(String(err.message || err))) }, 'Åbn log-mappen'),
        h('button', { class: 'btn sm', onclick: () => navigator.clipboard.writeText([...(e.starts || []), '', ...lines].join('\n')).then(() => toast('Loggen er kopieret', 'info')).catch((err) => toast(String(err))) }, 'Kopiér log'))),
    e.file ? h('div', { class: 'hint mono', 'data-no-i18n': '' }, e.file) : null,
    e.starts?.length ? h('div', { class: 'list' }, h('div', { class: 'item hint' }, 'Start af motoren'), ...e.starts.slice(-8).reverse().map((x) => h('div', { class: 'item mono', 'data-no-i18n': '' }, x))) : null,
    h('div', { class: 'list log-lines' }, lines.length ? lines.slice().reverse().map((l) => h('div', { class: `item mono log-${lineLevel(l) || 'info'}`, 'data-testid': 'engine-log-line', 'data-no-i18n': '' }, l))
      : h('div', { class: 'hint' }, 'Loggen er tom – GoXLR-motoren er ikke startet endnu.')));
}

export function diagView(ctx) {
  const root = h('div', { class: 'grid' }, h('div', { class: 'card hint' }, 'Samler oplysninger…'));
  let report = null;
  const render = () => {
    const r = report;
    const g = r.goxlr;
    const e = r.eq.engine;
    const bad = r.hotkeys.filter((x) => x.status !== 'aktiv');
    root.replaceChildren(
      h('div', { class: 'card' }, h('h2', {}, 'Rapport',
        h('span', { class: 'row' },
          h('button', { class: 'btn sm', onclick: load }, 'Opdatér'),
          h('button', { class: 'btn sm primary', onclick: () => navigator.clipboard.writeText(reportText(r)).then(() => toast('Rapport kopieret – indsæt den, hvor du beder om hjælp', 'info')).catch((err) => toast(String(err))) }, 'Kopiér rapport'),
          h('button', { class: 'btn sm', 'data-testid': 'diag-save', onclick: () => {
            const a = h('a', { href: URL.createObjectURL(new Blob([reportText(r)], { type: 'application/json' })), download: `GoXLR Studio rapport ${r.created.slice(0, 16).replace(/[T:]/g, '-')}.json` });
            a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          } }, 'Gem som fil'))),
        h('div', { class: 'hint' }, 'Alt her bliver på din pc. "Kopiér rapport" og "Gem som fil" giver én samlet rapport – med lydtjek, EQ-motor-test og log, men uden adgangskoder og tokens – som du selv kan sende videre.')),
      troubleCard(ctx, r, load),
      h('div', { class: 'grid cols-3' },
        section('App', [row('Version', r.app.version || '–'), row('Installation', r.app.browser ? 'Browser' : r.app.installed ? 'Installeret' : 'Portable'),
          row('API', r.api?.enabled ? (r.api.error ? 'Fejl' : `Port ${r.api.port}`) : 'Fra', r.api?.error ? 'warn' : null)]),
        section('GoXLR', [row('Forbindelse', g.mode === 'live' ? 'Live' : g.mode, g.mode === 'live' ? 'ok' : 'warn'),
          row('GoXLR-motor', g.engine?.started_by_us ? `I appen (${g.engine.version})` : g.engine?.foreign?.length ? 'GoXLR Utility' : g.engine?.last_error ? `Stoppet: ${g.engine.last_error}` : 'Kører ikke', g.engine?.started_by_us ? 'ok' : 'warn'),
          row('TC-Helicon-driver', g.driver?.installed === false ? 'Mangler' : g.driver?.installed ? `Installeret${Array.isArray(g.driver.version) ? ` (${g.driver.version.filter((x) => x != null).join('.')})` : ''}` : '–', g.driver?.installed === false ? 'warn' : g.driver?.installed ? 'ok' : null),
          g.model ? row('Model', g.model === 'Mini' ? 'GoXLR Mini' : 'GoXLR') : null, g.firmware ? row('Firmware', g.firmware) : null,
          g.daemon ? row('Motor-version', g.daemon) : null, g.profile ? row('Profil', `${g.profile} / ${g.mic_profile}`) : null].filter(Boolean)),
        section('Afspilnings-EQ', [row('EQ-motor', e.running ? 'Aktiv' : e.available ? 'Klar' : 'Ikke aktiv', e.running ? 'ok' : 'warn'),
          row('Type', { builtin: `Indbygget (${e.version || '?'})`, external: 'Separat Equalizer APO', none: 'Ingen' }[e.kind] || '–'),
          row('Læser GoXLR Studios EQ', e.taken_over ? 'Ja' : 'Nej', e.taken_over ? 'ok' : null), row('Preset', r.eq.preset || 'Tilpasset'),
          ...r.eq.apo_devices.map((d) => h('div', { class: 'item hint' }, d))])),
      h('div', { class: 'grid cols-2' },
        section('Lydtjek', (r.soundcheck?.findings || []).map((x) => h('div', { class: 'item' }, x))),
        section('Sidste EQ-motor-test', r.engine_test ? [h('div', { class: 'item hint' }, r.engine_test.at ? new Date(r.engine_test.at).toLocaleString('da-DK') : '–'), ...r.engine_test.tests.map((x) => h('div', { class: 'item' }, x)), ...r.engine_test.sound.map((x) => h('div', { class: 'item' }, x))] : [])),
      h('div', { class: 'grid cols-2' },
        section(`Genveje${bad.length ? ` – ${bad.length} virker ikke` : ''}`, r.hotkeys.map((x) => row(`${x.key} → ${x.action}`, x.status === 'aktiv' ? 'Aktiv' : x.status, x.status === 'aktiv' ? 'ok' : 'warn'))),
        section('Seneste fejl', r.errors.slice().reverse().map((x) => h('div', { class: 'item' }, h('span', { class: 'hint' }, new Date(x.at).toLocaleTimeString('da-DK')), x.msg)))),
      engineLogCard(r),
      section('Opdateringer (update.log)', (r.update?.log || []).slice(-15).reverse().map((l) => h('div', { class: 'item hint', 'data-testid': 'update-log-line' }, l))),
      section('Seneste hændelser (presetskift, administrator-opgaver …)', (r.activity || []).slice().reverse().map((x) => h('div', { class: 'item', 'data-testid': 'activity-item' }, h('span', { class: 'hint' }, new Date(x.at).toLocaleTimeString('da-DK')), x.msg))),
      h('div', { class: 'grid cols-2' },
        section('Lydenheder', r.devices.map((d) => h('div', { class: 'item' }, d))),
        section('Apps', r.apps.map((a) => h('div', { class: `item ${a.stale ? 'stale' : ''}`, style: { flexWrap: 'wrap', gap: '6px' } },
          h('b', {}, a.exe), h('span', { class: 'hint' }, 'Udgang'), h('span', {}, a.output), h('span', { class: 'hint' }, 'Mikrofon'), h('span', {}, a.input))))));
  };
  const load = async () => { report = await collectDiagnostics(ctx); if (document.body.contains(root)) render(); };
  load();
  return root;
}
