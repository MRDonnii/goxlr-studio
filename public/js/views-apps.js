import { h, toast } from './ui.js';
import { appSessions, setAppDevice, listAudioDevices, isNative } from './native.js';
import { shortName } from './views-mixer.js';

// Rules: [{ exe, output, input }] – a device id, or null for "follow the Windows default".
// A missing key (undefined) means "leave this direction alone".
const sameExe = (a, b) => a.toLowerCase() === b.toLowerCase();
const flowKey = (flow) => (flow === 'capture' ? 'input' : 'output');

function groupByExe(sessions) {
  const map = new Map();
  for (const s of sessions) {
    const k = s.exe.toLowerCase();
    if (!map.has(k)) map.set(k, { exe: s.exe, path: s.path, pids: [], sessions: [] });
    const g = map.get(k);
    g.pids.push(s.pid);
    g.sessions.push(s);
  }
  return [...map.values()].sort((a, b) => a.exe.localeCompare(b.exe));
}

const isStale = (id, devs, flow) => id != null && !devs.some((d) => d.id === id && d.flow === flow);

// One pass: enforce rules and (optionally) reset apps pinned to devices that no longer exist.
export async function enforceAppRules(ctx, { fixStale = ctx.prefs.fixStaleApps } = {}) {
  const [sessions, devs] = await Promise.all([appSessions(), listAudioDevices()]);
  let changed = 0;
  for (const s of sessions) {
    const rule = ctx.appRules.find((r) => sameExe(r.exe, s.exe));
    for (const flow of ['render', 'capture']) {
      const key = flowKey(flow);
      const cur = s[key] ?? null;
      let want;
      if (rule && rule[key] !== undefined && !isStale(rule[key], devs, flow)) want = rule[key];
      else if (fixStale && isStale(cur, devs, flow)) want = null;
      if (want === undefined || want === cur) continue;
      try { await setAppDevice(s.pid, flow, want); changed++; } catch { /* process may have exited */ }
    }
  }
  return changed;
}

export function startAppRules(ctx) {
  let busy = false;
  const tick = async () => {
    if (!busy && (ctx.appRules.length || ctx.prefs.fixStaleApps)) {
      busy = true;
      try {
        if (await enforceAppRules(ctx)) ctx.onAppsChanged?.();
      } catch { /* backend unavailable */ }
      busy = false;
    }
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 1500);
}

export function appsView(ctx) {
  const list = h('div', { class: 'list' });
  const rulesList = h('div', { class: 'list' });
  const staleInfo = h('div', { class: 'hint' });
  let devs = [];
  let groups = [];

  const devName = (id) => {
    if (id == null) return 'Windows-standard';
    const d = devs.find((x) => x.id === id);
    return d ? shortName(d.name) : 'Forældet enhed';
  };

  const deviceSelect = (g, flow) => {
    const key = flowKey(flow);
    const ids = [...new Set(g.sessions.map((s) => s[key] ?? null))];
    const cur = ids.length === 1 ? ids[0] : undefined;
    const stale = ids.some((id) => isStale(id, devs, flow));
    const sel = h('select', { class: stale ? 'stale' : '', onchange: async () => {
      const id = sel.value === '' ? null : sel.value;
      try {
        await Promise.all(g.pids.map((pid) => setAppDevice(pid, flow, id)));
        const rule = ctx.appRules.find((r) => sameExe(r.exe, g.exe));
        if (rule) { rule[key] = id; ctx.saveAppRules(); }
        toast(`${g.exe} → ${devName(id)}`, 'info');
      } catch (e) { toast(String(e)); }
      refresh();
    } },
      cur === undefined ? h('option', { value: '__mixed', selected: true, disabled: true }, 'Blandet') : null,
      h('option', { value: '', selected: cur === null }, 'Windows-standard'),
      devs.filter((d) => d.flow === flow).map((d) => h('option', { value: d.id, selected: d.id === cur }, shortName(d.name))),
      stale && cur !== undefined ? h('option', { value: cur, selected: true, disabled: true }, '⚠ Forældet enhed') : null);
    return sel;
  };

  const render = () => {
    const staleApps = groups.filter((g) => g.sessions.some((s) => isStale(s.output, devs, 'render') || isStale(s.input, devs, 'capture')));
    staleInfo.textContent = staleApps.length
      ? `${staleApps.length} app${staleApps.length > 1 ? 's' : ''} peger på en GoXLR-enhed der ikke findes længere (typisk efter en driver-opdatering): ${staleApps.map((g) => g.exe).join(', ')}.`
      : 'Ingen apps peger på forældede enheder.';
    staleInfo.classList.toggle('warn-text', staleApps.length > 0);

    list.replaceChildren(...groups.map((g) => {
      const rule = ctx.appRules.find((r) => sameExe(r.exe, g.exe));
      const stale = staleApps.includes(g);
      const pin = h('button', { class: `btn sm ${rule ? 'on' : ''}`, title: rule ? 'Glem reglen' : 'Husk valget – håndhæves automatisk hvert 5. sekund', onclick: () => {
        if (rule) ctx.appRules.splice(ctx.appRules.indexOf(rule), 1);
        else {
          const first = g.sessions[0];
          ctx.appRules.push({ exe: g.exe, output: isStale(first.output, devs, 'render') ? null : first.output ?? null, input: isStale(first.input, devs, 'capture') ? null : first.input ?? null });
        }
        ctx.saveAppRules(); render();
      } }, rule ? '📌 Husket' : 'Husk');
      return h('div', { class: `item app-row ${stale ? 'stale' : ''}` },
        h('div', { class: 'app-name' }, h('b', {}, g.exe.replace(/\.exe$/i, '')), h('span', { class: 'hint' }, g.pids.length > 1 ? `${g.pids.length} processer` : g.path)),
        h('div', { class: 'spacer' }),
        h('span', { class: 'lbl app-lbl' }, 'Udgang'), deviceSelect(g, 'render'),
        h('span', { class: 'lbl app-lbl' }, 'Mikrofon'), deviceSelect(g, 'capture'),
        pin);
    }));
    if (!groups.length) list.append(h('div', { class: 'hint' }, 'Ingen apps afspiller eller optager lyd lige nu.'));

    rulesList.replaceChildren(...ctx.appRules.map((r) => {
      const desc = (key) => (r[key] === undefined ? 'uændret' : devName(r[key]));
      const bad = isStale(r.output, devs, 'render') || isStale(r.input, devs, 'capture');
      return h('div', { class: 'item' },
        h('b', {}, r.exe.replace(/\.exe$/i, '')),
        h('span', { class: 'hint' }, `Udgang: ${desc('output')} · Mikrofon: ${desc('input')}`),
        bad ? h('span', { class: 'badge warn', title: 'Enheden findes ikke – reglen springes over' }, 'Enhed mangler') : null,
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: () => { ctx.appRules.splice(ctx.appRules.indexOf(r), 1); ctx.saveAppRules(); render(); } }, '✕'));
    }));
    if (!ctx.appRules.length) rulesList.append(h('div', { class: 'hint' }, 'Ingen regler. Tryk "Husk" ud for en app for at låse dens enheder.'));
  };

  const refresh = async () => {
    try {
      const [s, d] = await Promise.all([appSessions(), listAudioDevices()]);
      groups = groupByExe(s);
      devs = d;
    } catch (e) { toast(`Lyd pr. app: ${e}`); }
    if (document.body.contains(list) && !list.contains(document.activeElement)) render();
  };

  const fixBtn = h('button', { class: 'btn sm primary', onclick: async () => {
    const n = await enforceAppRules(ctx, { fixStale: true }).catch((e) => { toast(String(e)); return 0; });
    toast(n ? `Rettede ${n} app-indstilling${n > 1 ? 'er' : ''}` : 'Intet at rette', 'info');
    refresh();
  } }, 'Ret forældede nu');
  const autoFix = h('input', { type: 'checkbox', checked: !!ctx.prefs.fixStaleApps, onchange: () => { ctx.prefs.fixStaleApps = autoFix.checked; ctx.savePrefs(); } });

  ctx.onAppsChanged = refresh;
  const timer = setInterval(refresh, 5000);
  ctx.cleanup.push(() => { clearInterval(timer); ctx.onAppsChanged = null; });
  refresh();

  return h('div', { class: 'grid' },
    h('div', { class: 'card' },
      h('h2', {}, 'Apps med lyd', h('button', { class: 'btn sm', onclick: refresh }, 'Opdatér')),
      list,
      h('div', { class: 'hint', style: { marginTop: '10px' } },
        isNative() ? 'Samme indstilling som Windows’ "Lydstyrke og enheder for apps" – men hurtigere. "Windows-standard" følger den enhed, der er valgt under Lydenheder.' : 'Demo-data – i Windows-appen vises dine rigtige apps.')),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Forældede enheder'), staleInfo,
        h('div', { class: 'row', style: { marginTop: '10px' } }, fixBtn, h('div', { class: 'spacer' }),
          h('span', { class: 'hint' }, 'Ret automatisk'), h('label', { class: 'switch' }, autoFix, h('span'))),
        h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Apps uden regel sættes tilbage til Windows-standard; apps med regel får deres huskede enhed.')),
      h('div', { class: 'card' }, h('h2', {}, 'Regler'), rulesList,
        h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Reglerne håndhæves hvert 5. sekund, også når appen ligger i bakken – fx Spotify → Music, Discord → Chat.'))));
}
