// Automatik når en lydenhed tilsluttes eller fjernes: e.g. a USB or Bluetooth headset → GoXLR
// profile "Headset" (and the Windows output to the headset); removed → "Speakers". Windows' active
// audio devices are looked at every 2,5 s; the rules live in the store key 'device-triggers'.
import { h, logActivity } from './ui.js';
import { storeSet, listAudioDevices } from './native.js';
import { deviceTriggerStep, triggerDevicePresent, suggestDeviceActions } from './extras.js';
import { actionCatalog, actionLabel, rememberDeviceNames } from './actions.js';
import { shortName } from './views-mixer.js';

const memo = new Map();
// Actions that don't need the GoXLR (Windows devices, the EQ, the sound bank, Discord).
const LOCAL = /^(output|input|output-next|eq-|crossfeed|loudness|restore-sound|sound|sounds-stop|discord)/;

export function startDeviceTriggers(ctx) {
  const started = Date.now();
  let busy = false;
  const tick = async () => {
    if (!busy && ctx.deviceTriggers?.length) {
      busy = true;
      try {
        const devs = await listAudioDevices();
        rememberDeviceNames(devs);
        // No outputs at all = Windows' audio service is restarting: wait for it.
        if (devs.some((d) => d.flow === 'render')) {
          const starting = Date.now() - started < 60000;
          for (const hit of deviceTriggerStep(ctx.deviceTriggers, devs, memo, { starting })) await runTrigger(ctx, hit);
        }
      } catch { /* backend unavailable */ }
      busy = false;
    }
    setTimeout(tick, 2500);
  };
  setTimeout(tick, 1500);
}

// A rule made or changed in the UI starts from how things are now – it doesn't fire at once.
function seed(t, devs) {
  const is = triggerDevicePresent(t, devs);
  memo.set(t.id, { stable: is, seen: is, count: 2 });
}

async function runTrigger(ctx, { trigger, connected, actions }) {
  const ids = actions.filter(Boolean);
  if (!ids.length) return;
  // Right after the app started the GoXLR may not be connected yet.
  if (ids.some((id) => !LOCAL.test(id))) {
    const t0 = Date.now();
    while (!ctx.conn.mixer && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 300));
  }
  const name = shortName(trigger.name || trigger.device);
  const what = connected ? 'tilsluttet' : 'fjernet';
  logActivity(`Automatik: ${name} ${what} → ${ids.map((id) => actionLabel(ctx, id)).join(', ')}`);
  for (const id of ids) {
    try { await ctx.runAction(id, `automatik: ${name} ${what}`); } catch { /* next action */ }
  }
}

export function deviceTriggersCard(ctx) {
  ctx.deviceTriggers ??= [];
  const list = h('div', { class: 'list' });
  const badges = new Map();
  let catalog = [];
  let devs = [];
  const save = () => { storeSet('device-triggers', ctx.deviceTriggers); render(); };

  const actionSel = (arr, i) => {
    const known = catalog.some((g) => g.items.some((it) => it.id === arr[i]));
    return h('select', { class: 'trigger-sel', onchange: (e) => { if (e.target.value) arr[i] = e.target.value; else arr.splice(i, 1); save(); } },
      h('option', { value: '' }, '— ingen —'),
      arr[i] && !known ? h('option', { value: arr[i], selected: true }, actionLabel(ctx, arr[i])) : null,
      catalog.map((g) => h('optgroup', { label: g.title }, g.items.map((it) => h('option', { value: it.id, selected: it.id === arr[i] }, it.label)))));
  };
  const actionsRow = (t, key, label) => {
    t[key] ??= [];
    const arr = t[key];
    return h('div', { class: 'row trigger-actions' }, h('span', { class: 'lbl app-lbl' }, label),
      ...arr.map((_, i) => actionSel(arr, i)),
      h('button', { class: 'btn sm', title: 'Tilføj en handling mere', 'data-testid': `device-trigger-add-${key}`, onclick: () => { arr.push(''); render(); } }, arr.length ? '+' : '+ Handling'));
  };
  const deviceSel = (t) => {
    const present = triggerDevicePresent(t, devs);
    const opt = (d) => h('option', { value: d.id, selected: present && (d.id === t.device || (d.name === t.name && !devs.some((x) => x.id === t.device))) }, shortName(d.name));
    return h('select', { class: 'trigger-device', 'data-testid': 'device-trigger-device', onchange: (e) => {
      const d = devs.find((x) => x.id === e.target.value);
      if (d) { t.device = d.id; t.name = d.name; seed(t, devs); save(); }
    } },
      !present ? h('option', { value: t.device || '', selected: true }, t.name ? `${shortName(t.name)} (ikke tilsluttet)` : '— vælg enhed —') : null,
      h('optgroup', { label: 'Udgange' }, devs.filter((d) => d.flow === 'render').map(opt)),
      h('optgroup', { label: 'Mikrofoner' }, devs.filter((d) => d.flow === 'capture').map(opt)));
  };
  const updateBadges = () => {
    for (const t of ctx.deviceTriggers) {
      const b = badges.get(t.id);
      if (!b) continue;
      const present = triggerDevicePresent(t, devs);
      b.textContent = present ? 'tilsluttet' : 'ikke tilsluttet';
      b.className = `badge ${present ? 'ok' : ''}`;
    }
  };
  const render = () => {
    badges.clear();
    list.replaceChildren(...ctx.deviceTriggers.map((t) => {
      const badge = h('span', { class: 'badge', 'data-testid': 'device-trigger-state' });
      badges.set(t.id, badge);
      const atStart = h('input', { type: 'checkbox', checked: t.atStart !== false, onchange: () => { t.atStart = atStart.checked; save(); } });
      return h('div', { class: 'item device-trigger', 'data-testid': 'device-trigger' },
        h('div', { class: 'row', style: { flexWrap: 'wrap' } },
          h('span', { class: 'lbl app-lbl' }, 'Enhed'), deviceSel(t), badge,
          h('div', { class: 'spacer' }),
          h('label', { class: 'check-inline', title: 'Når GoXLR Studio starter, køres reglen for det, der passer: er enheden der, køres "tilsluttes", ellers "fjernes".' }, atStart, h('span', {}, 'Også når appen starter')),
          h('button', { class: 'btn sm', title: 'Slet reglen', onclick: () => { ctx.deviceTriggers.splice(ctx.deviceTriggers.indexOf(t), 1); memo.delete(t.id); save(); } }, '✕')),
        actionsRow(t, 'onConnect', 'Når den tilsluttes →'),
        actionsRow(t, 'onDisconnect', 'Når den fjernes →'));
    }));
    if (!ctx.deviceTriggers.length) list.append(h('div', { class: 'hint' }, 'Ingen regler endnu.'));
    updateBadges();
  };
  const add = () => {
    // Most likely a headset: a known headset name first, then anything on USB or Bluetooth.
    const pool = devs.filter((d) => d.flow === 'render' && !/goxlr|tc-helicon/i.test(d.name));
    const d = pool.find((x) => /headset|headphone|hovedtelefon|arctis|hyperx|corsair|steelseries|razer|astro|buds|airpods|hands-free|wh-1000/i.test(x.name))
      || pool.find((x) => /usb|bluetooth/i.test(x.name)) || pool[0] || null;
    const t = { id: crypto.randomUUID(), device: d?.id || '', name: d?.name || '', atStart: true, ...suggestDeviceActions(ctx.conn.status?.files?.profiles || []) };
    seed(t, devs);
    ctx.deviceTriggers.push(t);
    save();
  };
  let shown = false;
  const refresh = async () => {
    if (document.body.contains(list)) shown = true;
    else { if (shown) clearInterval(timer); return; }
    const before = devs.map((d) => d.id).join('|');
    devs = await listAudioDevices().catch(() => devs);
    // A device came or went: the selects need it; otherwise only the badges change.
    if (devs.map((d) => d.id).join('|') !== before) render(); else updateBadges();
  };
  const timer = setInterval(refresh, 3000);
  Promise.all([actionCatalog(ctx), listAudioDevices().catch(() => [])]).then(([c, d]) => { catalog = c; devs = d; render(); });
  render();
  return h('div', { class: 'card' }, h('h2', {}, 'Automatik når en enhed tilsluttes',
    h('button', { class: 'btn sm primary', 'data-testid': 'device-trigger-new', onclick: add }, '+ Ny')),
    list,
    h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Fx: når dit USB- eller Bluetooth-headset tilsluttes → profilen "Headset" og udgangen til headsettet; når det fjernes → "Speakers". Et headset i GoXLR’ens jackstik kan Windows ikke se, og et trådløst headset med dongle kan blive ved med at være der, selvom det er slukket.'));
}
