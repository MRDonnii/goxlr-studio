import { h, toast, errorLog } from './ui.js';
import { engineStatus, listAudioDevices, appSessions, appInfo, isNative, daemonInfo } from './native.js';
import { prettyAccel } from './views-hotkeys.js';
import { describeAction } from './actions.js';

const fmtFw = (fw) => (Array.isArray(fw) ? fw.join('.') : fw ? Object.values(fw).join('.') : '–');

export async function collectDiagnostics(ctx) {
  const { conn } = ctx;
  const m = conn.mixer;
  const [info, engine, devs, apps, daemon] = await Promise.all([
    appInfo().catch((e) => ({ error: String(e) })),
    engineStatus().catch((e) => ({ error: String(e) })),
    listAudioDevices().catch(() => []),
    appSessions().catch(() => []),
    daemonInfo().catch((e) => ({ error: String(e) })),
  ]);
  const hotkeys = await Promise.all(ctx.hotkeys.map(async (b) => ({
    key: prettyAccel(b.accel),
    action: b.action ? await describeAction(ctx, b.action) : '–',
    status: ctx.hotkeyStatus[b.id] ? (ctx.hotkeyStatus[b.id].ok ? 'aktiv' : ctx.hotkeyStatus[b.id].error) : 'ikke registreret',
  })));
  return {
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
    } : { mode: conn.mode, engine: daemon },
    eq: {
      engine: { kind: engine.kind, version: engine.engine_version, running: engine.running, available: engine.available, apo_installed: engine.apo_installed, taken_over: engine.taken_over, reason: engine.reason || engine.error || null },
      apo_devices: (engine.devices || []).map((d) => `${d.apo ? '✓' : '✕'} ${d.name}`),
      preset: ctx.outputEq?.presetName || null,
      enabled: !!ctx.outputEq?.slots[ctx.outputEq.active]?.enabled,
      extras: ctx.outputEq?.extras || {},
      profile_links: ctx.outputEq?.profileLinks || {},
    },
    devices: devs.map((d) => `${d.flow === 'render' ? 'Ud' : 'Ind'}${d.default ? ' [standard]' : ''}${d.default_comm ? ' [kommunikation]' : ''}: ${d.name}`),
    apps: apps.map((a) => `${a.exe}: ud=${devs.find((d) => d.id === a.output)?.name || (a.output ? 'FORÆLDET' : 'standard')} ind=${devs.find((d) => d.id === a.input)?.name || (a.input ? 'FORÆLDET' : 'standard')}`),
    hotkeys,
    app_rules: ctx.appRules.length,
    app_triggers: ctx.appTriggers?.length || 0,
    api: ctx.prefs.api ? { enabled: ctx.prefs.api.enabled, port: ctx.prefs.api.port, lan: ctx.prefs.api.lan, error: ctx.apiError || null } : null,
    errors: errorLog.slice(-20),
  };
}

function section(title, rows) {
  return h('div', { class: 'card' }, h('h2', {}, title), h('div', { class: 'list' }, rows.length ? rows : h('div', { class: 'hint' }, 'Intet')));
}
const row = (k, v, cls) => h('div', { class: 'item' }, k, h('div', { class: 'spacer' }), cls ? h('span', { class: `badge ${cls}` }, v) : v);

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
          h('button', { class: 'btn sm primary', onclick: () => navigator.clipboard.writeText(JSON.stringify(r, null, 2)).then(() => toast('Rapport kopieret – indsæt den, hvor du beder om hjælp', 'info')).catch((err) => toast(String(err))) }, 'Kopiér rapport'))),
        h('div', { class: 'hint' }, 'Alt her bliver på din pc. "Kopiér rapport" lægger en tekst på udklipsholderen, som du selv kan sende videre.')),
      h('div', { class: 'grid cols-3' },
        section('App', [row('Version', r.app.version || '–'), row('Installation', r.app.browser ? 'Browser' : r.app.installed ? 'Installeret' : 'Portable'),
          row('API', r.api?.enabled ? (r.api.error ? 'Fejl' : `Port ${r.api.port}`) : 'Fra', r.api?.error ? 'warn' : null)]),
        section('GoXLR', [row('Forbindelse', g.mode === 'live' ? 'Live' : g.mode, g.mode === 'live' ? 'ok' : 'warn'),
          row('GoXLR-motor', g.engine?.started_by_us ? `I appen (${g.engine.version})` : g.engine?.foreign?.length ? 'GoXLR Utility' : g.engine?.last_error ? `Stoppet: ${g.engine.last_error}` : 'Kører ikke', g.engine?.started_by_us ? 'ok' : 'warn'),
          g.model ? row('Model', g.model === 'Mini' ? 'GoXLR Mini' : 'GoXLR') : null, g.firmware ? row('Firmware', g.firmware) : null,
          g.daemon ? row('Motor-version', g.daemon) : null, g.profile ? row('Profil', `${g.profile} / ${g.mic_profile}`) : null].filter(Boolean)),
        section('Afspilnings-EQ', [row('EQ-motor', e.running ? 'Aktiv' : e.available ? 'Klar' : 'Ikke aktiv', e.running ? 'ok' : 'warn'),
          row('Type', { builtin: `Indbygget (${e.version || '?'})`, external: 'Separat Equalizer APO', none: 'Ingen' }[e.kind] || '–'),
          row('Læser GoXLR Studios EQ', e.taken_over ? 'Ja' : 'Nej', e.taken_over ? 'ok' : null), row('Preset', r.eq.preset || 'Tilpasset'),
          ...r.eq.apo_devices.map((d) => h('div', { class: 'item hint' }, d))])),
      h('div', { class: 'grid cols-2' },
        section(`Genveje${bad.length ? ` – ${bad.length} virker ikke` : ''}`, r.hotkeys.map((x) => row(`${x.key} → ${x.action}`, x.status === 'aktiv' ? 'Aktiv' : x.status, x.status === 'aktiv' ? 'ok' : 'warn'))),
        section('Seneste fejl', r.errors.slice().reverse().map((x) => h('div', { class: 'item' }, h('span', { class: 'hint' }, new Date(x.at).toLocaleTimeString('da-DK')), x.msg)))),
      h('div', { class: 'grid cols-2' },
        section('Lydenheder', r.devices.map((d) => h('div', { class: 'item' }, d))),
        section('Apps', r.apps.map((a) => h('div', { class: `item ${a.includes('FORÆLDET') ? 'stale' : ''}` }, a)))));
  };
  const load = async () => { report = await collectDiagnostics(ctx); if (document.body.contains(root)) render(); };
  load();
  return root;
}
