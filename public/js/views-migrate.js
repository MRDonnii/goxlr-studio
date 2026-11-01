import { h, toast } from './ui.js';
import {
  isNative, migrateScan, migrateBackup, migrateCopyProfiles, migrateDisableStartup, migrateStopAhk,
  installedApps, runUninstaller, openPath, engineInfo, daemonInfo, daemonTakeover, appSessions, listAudioDevices, storeGet,
} from './native.js';
import { parseAhk, deviceName } from './extras.js';
import { importPeacePresets } from './views-outeq.js';
import { prettyAccel } from './views-hotkeys.js';
import { actionLabel } from './actions.js';
import { BACKUP_KEYS } from './views-system.js';

const CATEGORY = {
  keep: ['BEHOLD', 'ok'],
  replace: ['Kan fjernes', ''],
  engine: ['Erstattes af EQ-motoren', ''],
  check: ['Tjek først', 'warn'],
};

function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

// "Overflytning": finds the old setup, imports it, backs it up and helps uninstall the old programs.
export function migrateView(ctx) {
  const done = (ctx.prefs.migrate ??= {});
  const save = () => ctx.savePrefs();
  const root = h('div', { class: 'grid' }, h('div', { class: 'card hint' }, 'Leder efter din gamle opsætning…'));
  let scan = null, apps = [], engine = null, daemon = null;

  const check = (ok, text, sub) => h('div', { class: `check-row ${ok === true ? 'ok' : ok === false ? 'todo' : 'info'}` },
    h('span', { class: 'check-icon' }, ok === true ? '✓' : ok === false ? '•' : 'i'), h('div', {}, h('div', {}, text), sub ? h('div', { class: 'hint' }, sub) : null));

  // ---------- 1. backup ----------
  const backupCard = () => {
    const out = h('div', { class: 'hint' }, done.backup ? `Seneste backup: ${done.backup}` : 'Ingen backup endnu.');
    const btn = h('button', { class: 'btn sm primary', onclick: async () => {
      btn.disabled = true; btn.textContent = 'Tager backup…';
      try {
        const data = {};
        for (const k of BACKUP_KEYS) data[k] = await storeGet(k, null);
        const paths = ctx.conn.status?.paths || {};
        const dirs = Object.entries({ Profiler: paths.profile_directory, Mikrofonprofiler: paths.mic_profile_directory, Presets: paths.presets_directory, Samples: paths.samples_directory, Ikoner: paths.icons_directory })
          .filter(([, v]) => v).map(([k, v]) => [k, String(v)]);
        const r = await migrateBackup(stampNow(), dirs, JSON.stringify({ app: 'goxlr-studio', created: new Date().toISOString(), data }, null, 2));
        done.backup = r.path; save();
        toast(`Backup gemt (${r.files} filer)`, 'info');
      } catch (e) { toast(`Backup: ${e}`); }
      render();
    } }, done.backup ? 'Tag ny backup' : 'Tag fuld backup nu');
    return h('div', { class: 'card' }, h('h2', {}, '1 · Backup af det hele'),
      h('div', { class: 'hint' }, 'Kopierer Equalizer APO/Peace-mappen, GoXLR-profiler og -indstillinger, TC-Helicon-profiler, AutoHotkey-scripts og GoXLR Studios egne indstillinger til én mappe – før noget afinstalleres.'),
      h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, btn,
        done.backup && isNative() ? h('button', { class: 'btn sm', onclick: () => openPath(done.backup).catch((e) => toast(String(e))) }, 'Åbn mappen') : null),
      out);
  };

  // ---------- 2. AutoHotkey ----------
  const ahkCard = () => {
    const scripts = scan.ahk.map((s) => ({ ...s, parsed: parseAhk(s.text) }));
    const all = scripts.flatMap((s) => s.parsed.bindings);
    const fresh = all.filter((b) => !ctx.hotkeys.some((x) => x.accel === b.accel && x.action === b.action));
    const importBtn = h('button', { class: 'btn sm primary', disabled: !fresh.length, onclick: () => {
      let added = 0, skipped = 0;
      for (const b of fresh) {
        if (ctx.hotkeys.some((x) => x.accel === b.accel && x.action !== b.action)) { skipped++; continue; }
        ctx.hotkeys.push({ id: crypto.randomUUID(), accel: b.accel, action: b.action });
        added++;
      }
      done.hotkeys = true; save();
      ctx.saveHotkeys();
      toast(`Importeret ${added} genveje${skipped ? ` (${skipped} sprunget over – tasten bruges allerede)` : ''}`, 'info');
      render();
    } }, fresh.length ? `Importér ${fresh.length} genveje` : 'Alle genveje er importeret');
    const stopBtn = h('button', { class: 'btn sm', onclick: async () => {
      if (!confirm('Luk alle kørende AutoHotkey-scripts nu? Så kan GoXLR Studio bruge tasterne.')) return;
      await migrateStopAhk().catch((e) => toast(String(e)));
      setTimeout(async () => { await ctx.saveHotkeys(); toast('AutoHotkey er lukket – genvejene virker nu i GoXLR Studio', 'info'); reload(); }, 800);
    } }, 'Luk AutoHotkey nu');
    return h('div', { class: 'card' }, h('h2', {}, '2 · Genveje fra AutoHotkey'),
      scripts.length ? scripts.map((s) => h('div', { class: 'ahk-script' },
        h('div', { class: 'row' }, h('b', { class: 'path', title: s.path }, s.path.split('\\').pop()), s.autostart ? h('span', { class: 'badge warn' }, 'starter med Windows') : null,
          h('div', { class: 'spacer' }),
          s.startup_entry ? h('button', { class: 'btn sm', onclick: async () => {
            try { const p = await migrateDisableStartup(s.startup_entry); toast(`Fjernet fra autostart (gemt i ${p})`, 'info'); reload(); } catch (e) { toast(String(e)); }
          } }, 'Fjern fra autostart') : null),
        h('div', { class: 'list compact' },
          s.parsed.bindings.map((b) => h('div', { class: 'item' }, h('span', { class: 'kbd' }, prettyAccel(b.accel)), '→', actionLabel(ctx, b.action),
            ctx.hotkeys.some((x) => x.accel === b.accel && x.action === b.action) ? h('span', { class: 'badge ok' }, 'importeret') : null)),
          s.parsed.unknown.map((u) => h('div', { class: 'item hint' }, h('span', { class: 'kbd' }, u.hotkey), `${u.reason}: ${u.text.slice(0, 80)}`))),
        !s.parsed.bindings.length && !s.parsed.unknown.length ? h('div', { class: 'hint' }, 'Ingen GoXLR-genveje i dette script.') : null))
        : h('div', { class: 'hint' }, 'Fandt ingen AutoHotkey-scripts, der styrer GoXLR’en.'),
      h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, importBtn, scan.ahk_running ? stopBtn : null),
      h('div', { class: 'hint', style: { marginTop: '6px' } }, scan.ahk_running ? 'AutoHotkey kører stadig og optager tasterne. Importér først, luk så AutoHotkey.' : 'AutoHotkey kører ikke.'));
  };

  // ---------- 3. EQ ----------
  const eqCard = () => {
    const presetsBtn = h('button', { class: 'btn sm primary', onclick: async () => {
      presetsBtn.disabled = true;
      try {
        const { names } = await importPeacePresets(ctx);
        done.presets = names.length; save();
        toast(names.length ? `Importeret ${names.length} Peace-presets` : 'Fandt ingen presets med filtre', names.length ? 'info' : 'error');
        ctx.onStateChanged?.('eq-local');
      } catch (e) { toast(String(e)); }
      render();
    } }, done.presets ? `Importér igen (${done.presets} sidst)` : `Importér ${scan.apo.preset_files || 'alle'} Peace-presets`);
    const kindText = { builtin: 'GoXLR Studios indbyggede EQ-motor kører.', external: 'Equalizer APO er stadig installeret separat.', none: 'Ingen EQ-motor installeret endnu.' }[engine.kind];
    return h('div', { class: 'card' }, h('h2', {}, '3 · EQ, Peace og Equalizer APO'),
      check(!!done.presets || !scan.apo.config_dir, 'Peace-presets', scan.apo.config_dir ? `${scan.apo.preset_files} filer fundet i ${scan.apo.config_dir}` : 'Ingen Equalizer APO-mappe fundet.'),
      check(engine.kind === 'builtin', 'EQ-motor', kindText),
      h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } },
        scan.apo.config_dir ? presetsBtn : null,
        engine.kind !== 'builtin' ? h('button', { class: 'btn sm', onclick: () => ctx.navigate('outeq') }, engine.kind === 'external' ? 'Erstat Equalizer APO…' : 'Installér EQ-motor…') : null),
      h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Når den indbyggede motor kører, har du ikke brug for Equalizer APO og Peace. GoXLR Studio afinstallerer selv Equalizer APO, når du trykker "Erstat" på EQ-siden – efter at have gemt presets.'));
  };

  // ---------- 4. GoXLR ----------
  const goxlrCard = () => {
    const tc = scan.tc_helicon;
    const paths = ctx.conn.status?.paths || {};
    const tcBtn = tc.dir && (tc.profiles.length || tc.mic_profiles.length) ? h('button', { class: 'btn sm primary', onclick: async () => {
      try {
        const n1 = paths.profile_directory ? await migrateCopyProfiles(tc.profiles.map((p) => `${tc.dir}\\Profiles\\${p}.goxlr`), String(paths.profile_directory)) : 0;
        const n2 = paths.mic_profile_directory ? await migrateCopyProfiles(tc.mic_profiles.map((p) => `${tc.dir}\\Mic Profiles\\${p}.goxlrMicProfile`), String(paths.mic_profile_directory)) : 0;
        toast(`Kopierede ${n1 + n2} profiler (eksisterende blev ikke overskrevet)`, 'info');
      } catch (e) { toast(String(e)); }
    } }, `Kopiér ${tc.profiles.length + tc.mic_profiles.length} TC-Helicon-profiler`) : null;
    const state = daemon.foreign?.length ? [false, 'GoXLR Utility styrer stadig GoXLR’en. Lad GoXLR Studio overtage – GoXLR Utility stoppes og starter ikke længere med Windows.']
      : daemon.started_by_us ? [true, 'GoXLR-motoren kører inde i GoXLR Studio. GoXLR Utility kan afinstalleres.']
        : [false, `Ingen GoXLR-motor kører.${daemon.last_error ? ` ${daemon.last_error}` : ''}`];
    const takeBtn = daemon.bundled && daemon.foreign?.length ? h('button', { class: 'btn sm primary', onclick: async () => {
      takeBtn.disabled = true;
      try { const t = await daemonTakeover(); toast(`${t.started} – GoXLR Utility er koblet fra`, 'info'); } catch (e) { toast(String(e)); }
      reload();
    } }, 'Lad GoXLR Studio overtage nu') : null;
    return h('div', { class: 'card' }, h('h2', {}, '4 · GoXLR-motor og profiler'),
      check(state[0], 'GoXLR-motor', daemon.bundled ? state[1] : 'Denne version har ikke GoXLR-motoren indbygget – behold GoXLR Utility.'),
      check(null, 'Profiler', `Dine profiler (${(ctx.conn.status?.files?.profiles || []).join(', ') || '–'}) ligger i GoXLR-motorens mappe og bliver ved med at virke.`),
      tc.dir ? check(null, 'TC-Helicons app', `${tc.profiles.length} profiler og ${tc.mic_profiles.length} mikrofonprofiler i ${tc.dir}`) : null,
      h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, takeBtn, tcBtn));
  };

  // ---------- 5. per-app audio ----------
  const appsCard = () => {
    const btn = h('button', { class: 'btn sm primary', onclick: async () => {
      try {
        const [sessions, devs] = await Promise.all([appSessions(), listAudioDevices()]);
        let n = 0;
        for (const s of sessions) {
          if (ctx.appRules.some((r) => r.exe.toLowerCase() === s.exe.toLowerCase())) continue;
          const ok = (id, flow) => id && devs.some((d) => d.id === id && d.flow === flow);
          const output = ok(s.output, 'render') ? s.output : null;
          const input = ok(s.input, 'capture') ? s.input : null;
          if (!output && !input) continue;
          ctx.appRules.push({ exe: s.exe, output, output_name: deviceName(devs, output), input, input_name: deviceName(devs, input) });
          n++;
        }
        ctx.saveAppRules();
        done.rules = true; save();
        toast(n ? `Husker nu ${n} apps` : 'Ingen nye apps med egen udgang', 'info');
      } catch (e) { toast(String(e)); }
      render();
    } }, 'Husk nuværende lyd pr. app');
    return h('div', { class: 'card' }, h('h2', {}, '5 · Lyd pr. app'),
      check(!!done.rules, 'Regler', `${ctx.appRules.length} apps huskes – fx Spotify → Music og Discord → Chat. Apps, der peger på forældede GoXLR-enheder, rettes under Lyd pr. app.`),
      h('div', { class: 'row', style: { marginTop: '10px', flexWrap: 'wrap' } }, btn, h('button', { class: 'btn sm', onclick: () => ctx.navigate('apps') }, 'Åbn Lyd pr. app')));
  };

  // ---------- 6. uninstall ----------
  const uninstallCard = () => {
    const ready = { 'GoXLR Utility': daemon.bundled && !daemon.foreign?.length, AutoHotkey: !!done.hotkeys || !scan.ahk.length };
    return h('div', { class: 'card' }, h('h2', {}, '6 · Afinstallér de gamle programmer'),
      h('div', { class: 'hint' }, 'Hvert program åbner sin egen afinstallation, så du bekræfter selv. Tag backup først (trin 1).'),
      h('div', { class: 'list', style: { marginTop: '10px' } }, apps.length ? apps.map((a) => {
        const [label, cls] = CATEGORY[a.category] || ['', ''];
        const warnFirst = (a.name.startsWith('GoXLR Utility') && !ready['GoXLR Utility']) || (a.name.startsWith('AutoHotkey') && !ready.AutoHotkey);
        const action = a.category === 'keep' ? null
          : a.category === 'engine' ? h('button', { class: 'btn sm', onclick: () => ctx.navigate('outeq') }, 'Erstat på EQ-siden')
            : h('button', { class: 'btn sm', onclick: async () => {
              const pre = !done.backup ? 'Du har ikke taget backup endnu (trin 1).\n\n' : '';
              if (!confirm(`${pre}Afinstallér "${a.name}"?\n\n${a.note}`)) return;
              try { const n = await runUninstaller(a.key); toast(`Afinstallationen af ${n} er startet – følg dens vejledning`, 'info'); setTimeout(reload, 8000); } catch (e) { toast(String(e)); }
            } }, 'Afinstallér');
        return h('div', { class: `item app-item ${a.category}` },
          h('div', { class: 'app-name' }, h('b', {}, a.name), h('span', { class: 'hint' }, [a.publisher, a.version].filter(Boolean).join(' · ')), h('span', { class: 'hint' }, a.note)),
          h('div', { class: 'spacer' }),
          warnFirst ? h('span', { class: 'badge warn' }, 'Vent') : null,
          h('span', { class: `badge ${cls}` }, label), action);
      }) : h('div', { class: 'hint' }, 'Ingen af de gamle programmer er installeret længere. 🎉')));
  };

  const summary = () => {
    const leftovers = apps.filter((a) => a.category !== 'keep');
    return h('div', { class: 'card migrate-head' },
      h('h2', {}, 'Ét program i stedet for mange', h('button', { class: 'btn sm', onclick: reload }, 'Scan igen')),
      h('div', { class: 'hint' }, 'GoXLR Studio har sin egen GoXLR-motor og EQ-motor og erstatter GoXLR Utility, Equalizer APO, Peace og AutoHotkey. Kun TC-Helicons USB-driver skal blive – den gør GoXLR’en til et lydkort i Windows.'),
      h('div', { class: 'checks' },
        check(!!done.backup, 'Backup taget'),
        check(!!done.hotkeys || !scan.ahk.length, 'Genveje flyttet'),
        check(!!done.presets || !scan.apo.config_dir, 'Peace-presets importeret'),
        check(engine.kind === 'builtin', 'Indbygget EQ-motor'),
        check(!daemon.foreign?.length && (daemon.started_by_us || daemon.bundled), 'Indbygget GoXLR-motor'),
        check(!leftovers.length, leftovers.length ? `${leftovers.length} gamle programmer tilbage` : 'Gamle programmer fjernet')));
  };

  const render = () => {
    if (!document.body.contains(root) && root.isConnected === false && root.parentNode) return;
    root.replaceChildren(summary(), h('div', { class: 'grid cols-2' }, backupCard(), ahkCard(), eqCard(), goxlrCard(), appsCard(), uninstallCard()));
  };

  async function reload() {
    try {
      [scan, apps, engine, daemon] = await Promise.all([migrateScan(), installedApps(), engineInfo(), daemonInfo()]);
      render();
    } catch (e) {
      root.replaceChildren(h('div', { class: 'card' }, `Kunne ikke scanne: ${e}`));
    }
  }
  reload();
  return root;
}
