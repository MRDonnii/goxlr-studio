import { h, toast, setRangeFill } from './ui.js';
import { appSessions, setAppDevice, setAppVolume, listAudioDevices, isNative, storeSet, engineInfo } from './native.js';
import { shortName, CHANNEL_LABEL } from './views-mixer.js';
import { resolveDevice, deviceName, triggerActions, channelEndpoint } from './extras.js';
import { BUILTIN_PRESETS } from './eq.js';
import { EQ_CHANNELS, FLAT, ALL_PROFILES, planAppEq, channelPresetFor } from './channeleq.js';
import { actionCatalog } from './actions.js';

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
  let healed = false;
  for (const s of sessions) {
    const rule = ctx.appRules.find((r) => sameExe(r.exe, s.exe));
    for (const flow of ['render', 'capture']) {
      const key = flowKey(flow);
      const cur = s[key] ?? null;
      let want;
      if (rule && rule[key] !== undefined) {
        // Follow the device by name if a driver update gave it a new id.
        const id = resolveDevice(devs, rule[key], rule[`${key}_name`], flow);
        if (id !== undefined && id !== rule[key]) { rule[key] = id; healed = true; }
        if (id !== undefined) want = id;
      }
      if (want !== undefined) { /* rule wins */ }
      else if (fixStale && isStale(cur, devs, flow)) want = null;
      if (want === undefined || want === cur) continue;
      try { await setAppDevice(s.pid, flow, want); changed++; } catch { /* process may have exited */ }
    }
  }
  if (healed) ctx.saveAppRules();
  return changed;
}

// App triggers: run an action when an app starts or exits (detected via its audio session).
let running = null;
export function checkTriggers(ctx, sessions) {
  const now = new Set(sessions.map((s) => s.exe));
  if (running) for (const id of triggerActions(ctx.appTriggers || [], running, now)) ctx.runAction(id, 'automatik når en app starter/lukker');
  running = now;
}

export function startAppRules(ctx) {
  let busy = false;
  const tick = async () => {
    if (!busy) {
      busy = true;
      try {
        if ((ctx.appRules.length || ctx.prefs.fixStaleApps) && await enforceAppRules(ctx)) ctx.onAppsChanged?.();
        if (ctx.appTriggers?.length) checkTriggers(ctx, await appSessions());
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
        if (rule) { rule[key] = id; rule[`${key}_name`] = deviceName(devs, id); ctx.saveAppRules(); }
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
      const outSel = deviceSelect(g, 'render');
      const inSel = deviceSelect(g, 'capture');
      const pin = h('button', { class: `btn sm ${rule ? 'on' : ''}`, 'data-testid': 'app-remember', title: rule ? 'Glem reglen' : 'Husk valget – håndhæves automatisk hvert 5. sekund', onclick: () => {
        if (rule) { ctx.appRules.splice(ctx.appRules.indexOf(rule), 1); toast(`${g.exe}: reglen er glemt`, 'info'); }
        else {
          // Mindre fejl 7: remember what the row shows (the user may just have changed it – the
          // session scan is a moment behind). Apps like Discord run several processes; without a
          // clear choice in the row, use the process that actually has a device set.
          const pick = (key, flow) => g.sessions.map((x) => x[key]).find((id) => id != null && !isStale(id, devs, flow)) ?? null;
          const shown = (sel, key, flow) => (sel.value === '__mixed' ? pick(key, flow) : sel.value === '' ? null : sel.value);
          const output = shown(outSel, 'output', 'render');
          const input = shown(inSel, 'input', 'capture');
          ctx.appRules.push({ exe: g.exe, output, output_name: deviceName(devs, output), input, input_name: deviceName(devs, input) });
          toast(`${g.exe} huskes: udgang ${devName(output)}, mikrofon ${devName(input)}`, 'info');
        }
        ctx.saveAppRules(); render();
      } }, rule ? '📌 Husket' : 'Husk');
      const eqName = appEqName(ctx, g, devs);
      // The app's own volume (Windows' volume mixer), for all its processes.
      const withVol = g.sessions.filter((x) => x.volume != null);
      const volBox = withVol.length ? (() => {
        const v0 = Math.round(Math.max(...withVol.map((x) => x.volume)) * 100);
        const muted = withVol.every((x) => x.muted);
        const val = h('span', { class: 'val' }, `${v0} %`);
        const r = h('input', { type: 'range', min: 0, max: 100, value: v0, 'aria-label': `Lydstyrke for ${g.exe}`, 'data-testid': 'app-volume' });
        setRangeFill(r);
        let t = null;
        r.addEventListener('input', () => {
          val.textContent = `${r.value} %`; setRangeFill(r);
          clearTimeout(t);
          t = setTimeout(() => { for (const x of withVol) setAppVolume(x.pid, Number(r.value) / 100).catch(() => {}); }, 40);
        });
        const mb = h('button', { class: `btn sm ${muted ? 'danger on' : ''}`, 'data-testid': 'app-mute', title: muted ? 'Slå lyden til' : 'Slå lyden fra', onclick: async () => { for (const x of withVol) await setAppVolume(x.pid, null, !muted).catch(() => {}); mb.blur(); refresh(); } }, muted ? '🔇' : '🔊');
        return h('div', { class: 'app-volume' }, mb, r, val);
      })() : null;
      return h('div', { class: `item app-row ${stale ? 'stale' : ''}` },
        h('div', { class: 'app-name' }, h('b', {}, g.exe.replace(/\.exe$/i, '')), eqName ? h('span', { class: 'badge info', 'data-testid': 'app-eq-badge', title: 'Den EQ, appens lyd får (EQ pr. kanal)' }, `EQ: ${eqName}`) : null,
          h('span', { class: 'hint' }, g.pids.length > 1 ? `${g.pids.length} processer` : g.path)),
        h('div', { class: 'spacer' }),
        volBox,
        h('span', { class: 'lbl app-lbl' }, 'Udgang'), outSel,
        h('span', { class: 'lbl app-lbl' }, 'Mikrofon'), inSel,
        pin);
    }));
    if (!groups.length) list.append(h('div', { class: 'hint' }, 'Ingen apps afspiller eller optager lyd lige nu.'));

    rulesList.replaceChildren(...ctx.appRules.map((r) => {
      const desc = (key) => (r[key] === undefined ? 'uændret' : devName(r[key]));
      const bad = (r.output != null && resolveDevice(devs, r.output, r.output_name, 'render') === undefined)
        || (r.input != null && resolveDevice(devs, r.input, r.input_name, 'capture') === undefined);
      return h('div', { class: 'item' },
        h('b', {}, r.exe.replace(/\.exe$/i, '')),
        h('span', { class: 'hint' }, `Udgang: ${desc('output')} · Mikrofon: ${desc('input')}`),
        bad ? h('span', { class: 'badge warn', title: 'Enheden findes ikke – reglen springes over' }, 'Enhed mangler') : null,
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: () => { ctx.appRules.splice(ctx.appRules.indexOf(r), 1); ctx.saveAppRules(); render(); } }, '✕'));
    }));
    if (!ctx.appRules.length) rulesList.append(h('div', { class: 'hint' }, 'Ingen regler. Tryk "Husk" ud for en app, eller tilføj en nedenfor.'));
    renderAddForm();
  };

  // Rules for apps that aren't running right now (e.g. Spotify → Music).
  const addForm = h('div', { class: 'row add-rule', style: { flexWrap: 'wrap', marginTop: '10px' } });
  let addFormKey = '';
  const renderAddForm = () => {
    const key = devs.map((d) => d.id).join('|');
    if (key === addFormKey || addForm.contains(document.activeElement)) return;
    addFormKey = key;
    const known = [...new Set([...groups.map((g) => g.exe), 'Spotify.exe', 'Discord.exe', 'chrome.exe', 'msedge.exe', 'firefox.exe', 'steam.exe'])];
    const exe = h('input', { type: 'text', placeholder: 'fx Spotify.exe', list: 'rule-exes', style: { width: '150px' } });
    const opts = (flow) => [h('option', { value: '' }, 'Windows-standard'), ...devs.filter((d) => d.flow === flow).map((d) => h('option', { value: d.id }, shortName(d.name)))];
    const out = h('select', {}, h('option', { value: '__keep' }, 'Udgang: uændret'), opts('render'));
    const inp = h('select', {}, h('option', { value: '__keep' }, 'Mikrofon: uændret'), opts('capture'));
    const add = h('button', { class: 'btn sm primary', onclick: () => {
      let name = exe.value.trim();
      if (!name) { exe.focus(); return; }
      if (!/\.exe$/i.test(name)) name += '.exe';
      const val = (sel) => (sel.value === '__keep' ? undefined : sel.value || null);
      const rule = { exe: name, output: val(out), input: val(inp) };
      if (rule.output === undefined && rule.input === undefined) { toast('Vælg en udgang og/eller mikrofon'); return; }
      rule.output_name = rule.output ? deviceName(devs, rule.output) : null;
      rule.input_name = rule.input ? deviceName(devs, rule.input) : null;
      const i = ctx.appRules.findIndex((r) => sameExe(r.exe, name));
      if (i >= 0) ctx.appRules[i] = rule; else ctx.appRules.push(rule);
      ctx.saveAppRules();
      toast(`Regel for ${name} gemt – den bruges, så snart appen spiller lyd`, 'info');
      exe.value = '';
      render();
    } }, 'Tilføj regel');
    addForm.replaceChildren(exe, h('datalist', { id: 'rule-exes' }, known.map((k) => h('option', { value: k }))), out, inp, add);
  };

  const refresh = async () => {
    try {
      const [s, d] = await Promise.all([appSessions(), listAudioDevices()]);
      groups = groupByExe(s);
      devs = d;
    } catch (e) { toast(`Lyd pr. app: ${e}`); }
    if (document.body.contains(list) && !list.contains(document.activeElement)) render();
    eqCard?.refresh();
  };
  let eqCard = null;

  const fixBtn = h('button', { class: 'btn sm primary', onclick: async () => {
    const n = await enforceAppRules(ctx, { fixStale: true }).catch((e) => { toast(String(e)); return 0; });
    toast(n ? `Rettede ${n} app-indstilling${n > 1 ? 'er' : ''}` : 'Intet at rette', 'info');
    refresh();
  } }, 'Ret forældede nu');
  const autoFix = h('input', { type: 'checkbox', checked: !!ctx.prefs.fixStaleApps, onchange: () => { ctx.prefs.fixStaleApps = autoFix.checked; ctx.savePrefs(); } });

  eqCard = appEqCard(ctx, () => devs, () => groups, () => render());
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
      h('div', { class: 'card' }, h('h2', {}, 'Regler'), rulesList, addForm,
        h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Reglerne håndhæves hvert 5. sekund, også når appen ligger i bakken – fx Spotify → Music, Discord → Chat.'))),
    eqCard,
    triggersCard(ctx, () => groups));
}

// ---------- EQ pr. app ----------
// The channel an app plays on: its rule, else what Windows has it on now.
function channelOfExe(ctx, exe, devs, groups) {
  const rule = ctx.appRules.find((r) => sameExe(r.exe, exe));
  const g = groups.find((x) => sameExe(x.exe, exe));
  const id = rule?.output !== undefined ? rule.output : g?.sessions.find((s) => s.output)?.output;
  if (!id) return null;
  return EQ_CHANNELS.find((c) => channelEndpoint(c, devs) === id) || null;
}

/** The channel EQ an app gets right now (for the badge in the list), or null. */
function appEqName(ctx, g, devs) {
  const ch = channelOfExe(ctx, g.exe, devs, [g]);
  const name = ch && channelPresetFor(ctx.outputEq, ch, ctx.conn.mixer?.profile_name);
  return name ? (name === FLAT ? 'ingen' : name) : null;
}

/** Puts each app on a channel and gives the channel the app's preset (see planAppEq). */
async function applyAppEq(ctx, devs, groups) {
  const st = ctx.outputEq;
  const available = EQ_CHANNELS.filter((c) => channelEndpoint(c, devs));
  const plan = planAppEq(st.appEq, { channelOf: (exe) => channelOfExe(ctx, exe, devs, groups), available });
  st.channelEq ??= {};
  const all = (st.channelEq[ALL_PROFILES] ??= {});
  // Channels this card set before and no longer needs go back to the main EQ.
  for (const ch of st.appEqChannels || []) if (!(ch in plan.sets)) delete all[ch];
  Object.assign(all, plan.sets);
  if (!Object.keys(all).length) delete st.channelEq[ALL_PROFILES];
  st.appEqChannels = Object.keys(plan.sets);
  for (const a of plan.assignments) {
    if (!a.channel) continue;
    const id = channelEndpoint(a.channel, devs);
    let rule = ctx.appRules.find((r) => sameExe(r.exe, a.exe));
    if (!rule) ctx.appRules.push((rule = { exe: a.exe }));
    rule.output = id;
    rule.output_name = deviceName(devs, id);
  }
  ctx.saveAppRules();
  await storeSet('output-eq', st);
  ctx.applyOutputEq?.().catch((e) => toast(`EQ-motor: ${e}`));
  enforceAppRules(ctx).catch(() => {});
  return plan;
}

function appEqCard(ctx, getDevs, getGroups, rerenderApps) {
  const st = ctx.outputEq;
  st.appEq ??= [];
  const list = h('div', { class: 'list', 'data-testid': 'app-eq' });
  const shared = h('div', { class: 'hint', 'data-testid': 'app-eq-shared' });
  let installed = null;
  engineInfo().then((i) => { installed = new Set((i.devices || []).filter((d) => d.installed).map((d) => d.id.toLowerCase())); render(); }).catch(() => {});
  const label = (ch) => CHANNEL_LABEL[ch] || ch;
  const commit = async () => {
    const plan = await applyAppEq(ctx, getDevs(), getGroups());
    if (plan.full.length) toast(`Ingen ledig kanal til ${plan.full.join(', ')} – GoXLR'en har fire kanaler, så højst fire forskellige EQ'er ad gangen`);
    render(); rerenderApps();
  };
  const render = () => {
    const devs = getDevs(), groups = getGroups();
    const available = EQ_CHANNELS.filter((c) => channelEndpoint(c, devs));
    const plan = planAppEq(st.appEq, { channelOf: (exe) => channelOfExe(ctx, exe, devs, groups), available });
    const profile = ctx.conn.mixer?.profile_name;
    const mine = Object.keys(st.presets || {});
    const builtin = Object.keys(BUILTIN_PRESETS).filter((n) => !(n in (st.presets || {})));
    list.replaceChildren(...st.appEq.map((r, i) => {
      const exe = h('input', { type: 'text', value: r.exe || '', placeholder: 'fx cod.exe', list: 'appeq-exes', style: { width: '150px' }, 'data-testid': 'app-eq-exe', onchange: () => {
        let v = exe.value.trim();
        if (v && !/\.exe$/i.test(v)) v += '.exe';
        r.exe = v; commit();
      } });
      const sel = h('select', { 'data-testid': 'app-eq-preset', onchange: () => { r.preset = sel.value; commit(); } },
        h('option', { value: '' }, '— vælg preset —'),
        h('option', { value: FLAT }, 'Ingen EQ'),
        mine.length ? h('optgroup', { label: 'Mine' }, mine.map((n) => h('option', { value: n }, n))) : null,
        h('optgroup', { label: 'Indbyggede' }, builtin.map((n) => h('option', { value: n }, n))));
      sel.value = r.preset || '';
      const a = r.exe && r.preset ? plan.assignments.find((x) => x.exe === r.exe && x.preset === r.preset) : null;
      const notes = [];
      if (!r.exe || !r.preset) notes.push(h('span', { class: 'hint' }, 'Vælg app og preset'));
      else if (!a?.channel) notes.push(h('span', { class: 'badge warn' }, 'Ingen ledig kanal'));
      else {
        notes.push(h('span', { class: 'badge ok', 'data-testid': 'app-eq-channel' }, `→ ${label(a.channel)}-kanalen`));
        const id = channelEndpoint(a.channel, devs);
        if (installed && id && !installed.has(id.toLowerCase())) notes.push(h('span', { class: 'badge warn', title: 'Afspilnings-EQ → EQ pr. kanal → "Sæt motoren på"' }, 'EQ-motoren mangler på kanalen'));
        const own = profile && st.channelEq?.[profile]?.[a.channel];
        if (own && own !== r.preset) notes.push(h('span', { class: 'badge warn' }, `Profilen "${profile}" har sit eget valg for kanalen`));
      }
      return h('div', { class: 'item', style: { flexWrap: 'wrap' } }, exe, sel, ...notes, h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', title: 'Fjern', onclick: () => { st.appEq.splice(i, 1); commit(); } }, '✕'));
    }));
    if (!st.appEq.length) list.append(h('div', { class: 'hint' }, 'Ingen endnu. Tryk "+ Tilføj", vælg fx cod.exe og "Fodtrin (FPS)".'));
    // Other apps on the same channels get the same EQ – say so.
    const others = Object.keys(plan.sets).map((ch) => {
      const apps = groups.filter((g) => !st.appEq.some((r) => sameExe(r.exe, g.exe)) && channelOfExe(ctx, g.exe, devs, groups) === ch).map((g) => g.exe.replace(/\.exe$/i, ''));
      return apps.length ? `${label(ch)}: ${apps.join(', ')}` : null;
    }).filter(Boolean);
    shared.textContent = others.length ? `Spiller også på de kanaler og får samme EQ – ${others.join(' · ')}` : '';
    datalist.replaceChildren(...[...new Set([...groups.map((g) => g.exe), 'Spotify.exe', 'Discord.exe', 'chrome.exe', 'cod.exe'])].map((x) => h('option', { value: x })));
  };
  const datalist = h('datalist', { id: 'appeq-exes' });
  render();
  const card = h('div', { class: 'card', 'data-testid': 'app-eq-card' }, h('h2', {}, 'EQ pr. app',
    h('button', { class: 'btn sm primary', 'data-testid': 'app-eq-add', onclick: () => { st.appEq.push({ exe: '', preset: '' }); render(); } }, '+ Tilføj')),
    list, shared, datalist,
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Giv en app sin egen EQ, fx Call of Duty → "Fodtrin (FPS)" og Spotify → "Musik". GoXLR Studio sætter selv appen på en GoXLR-kanal og giver kanalen EQ’en (se Afspilnings-EQ → EQ pr. kanal). Apps med samme preset deler kanal – højst fire forskellige EQ’er ad gangen. Fader-knappen for kanalen styrer så appens lydstyrke.'));
  card.refresh = () => { if (!card.contains(document.activeElement)) render(); };
  return card;
}

// "When cod.exe starts → scene Gaming, when it exits → scene Normal".
function triggersCard(ctx, getGroups) {
  const list = h('div', { class: 'list' });
  let catalog = [];
  const save = () => { ctx.saveAppTriggers(); render(); };
  const actionSel = (t, key) => {
    const sel = h('select', { class: 'trigger-sel', onchange: () => { t[key] = sel.value || null; save(); } },
      h('option', { value: '' }, '— intet —'),
      catalog.map((g) => h('optgroup', { label: g.title }, g.items.map((i) => h('option', { value: i.id, selected: i.id === t[key] }, i.label)))));
    return sel;
  };
  const render = () => {
    list.replaceChildren(...ctx.appTriggers.map((t) => {
      const exe = h('input', { type: 'text', value: t.exe || '', placeholder: 'fx cod.exe', list: 'running-exes', style: { width: '160px' }, onchange: () => { t.exe = exe.value.trim(); save(); } });
      return h('div', { class: 'item', style: { flexWrap: 'wrap' } },
        h('span', { class: 'lbl app-lbl' }, 'Når'), exe,
        h('span', { class: 'lbl app-lbl' }, 'starter →'), actionSel(t, 'onStart'),
        h('span', { class: 'lbl app-lbl' }, 'lukker →'), actionSel(t, 'onExit'),
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', onclick: () => { ctx.appTriggers.splice(ctx.appTriggers.indexOf(t), 1); save(); } }, '✕'));
    }));
    if (!ctx.appTriggers.length) list.append(h('div', { class: 'hint' }, 'Ingen automatik endnu.'));
    datalist.replaceChildren(...getGroups().map((g) => h('option', { value: g.exe })));
  };
  const datalist = h('datalist', { id: 'running-exes' });
  actionCatalog(ctx).then((c) => { catalog = c; render(); });
  return h('div', { class: 'card' }, h('h2', {}, 'Automatik når en app starter',
    h('button', { class: 'btn sm primary', onclick: () => { ctx.appTriggers.push({ exe: '', onStart: null, onExit: null }); save(); } }, '+ Ny')),
    list, datalist,
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Fx: når Call of Duty starter → scenen "Gaming" eller profilen "Headset"; når det lukker → tilbage igen. Apps opdages, når de begynder at bruge lyd (tjekkes hvert 5. sekund).'));
}
