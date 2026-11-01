import { h, toggle, toast } from './ui.js';
import { isNative, storeGet, storeSet, startDaemon, showOsd } from './native.js';

export const BACKUP_KEYS = ['prefs', 'scenes', 'hotkeys', 'app-rules', 'app-triggers', 'output-eq', 'ducking'];

export function newToken() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' }[c]));
}

export function systemSettings(ctx) {
  const { binder } = ctx;
  const p = ctx.prefs;

  // ---- OSD ----
  const osdCard = h('div', { class: 'card' }, h('h2', {}, 'Visning ovenpå spil'),
    toggle(binder, { label: 'Vis kort besked ved genveje', get: () => p.osd !== false, set: (v) => { p.osd = v; ctx.savePrefs(); } }),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: !isNative(), onclick: () => {
      toast('Skift til et andet vindue – beskeden vises om 2 sekunder', 'info');
      setTimeout(() => showOsd('GoXLR Studio · test', 'ok'), 2000);
    } }, 'Test')),
    h('div', { class: 'hint' }, 'En lille boks øverst på skærmen i ét sekund, når en genvej skifter profil, EQ, scene eller mute. Vises ikke, mens GoXLR Studio selv er i fokus. Spil i "eksklusiv fuldskærm" kan skjule den – brug "kantløs vindue".'));

  // ---- daemon ----
  const daemonCard = h('div', { class: 'card' }, h('h2', {}, 'GoXLR Utility'),
    toggle(binder, { label: 'Start den automatisk, hvis den ikke kører', get: () => p.autoStartDaemon !== false, set: (v) => { p.autoStartDaemon = v; ctx.savePrefs(); } }),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: !isNative(), onclick: () => startDaemon().then((path) => toast(`Starter ${path.split('\\').pop()}`, 'info')).catch((e) => toast(String(e))) }, 'Start GoXLR Utility nu')),
    h('div', { class: 'hint' }, 'GoXLR Studio taler med GoXLR’en gennem GoXLR Utility-tjenesten.'));

  // ---- updates ----
  const updInfo = h('div', { class: 'list' });
  const installBtn = h('button', { class: 'btn sm primary', onclick: () => ctx.installUpdate() }, 'Installér nu');
  const renderUpd = () => {
    const u = ctx.updateState || {};
    updInfo.replaceChildren(
      h('div', { class: 'item' }, 'Denne version', h('div', { class: 'spacer' }), u.current || '…'),
      h('div', { class: 'item' }, 'Nyeste udgivelse', h('div', { class: 'spacer' }),
        u.error ? h('span', { class: 'badge warn', title: u.error }, 'Kunne ikke tjekke') : (u.latest || '–'),
        u.available ? h('span', { class: 'badge ok' }, 'Ny version') : null),
      u.checkedAt ? h('div', { class: 'item' }, 'Sidst tjekket', h('div', { class: 'spacer' }), new Date(u.checkedAt).toLocaleString('da-DK')) : null);
    installBtn.style.display = u.available && isNative() ? '' : 'none';
  };
  ctx.onUpdateState = renderUpd;
  ctx.cleanup.push(() => { ctx.onUpdateState = null; });
  renderUpd();
  const updCard = h('div', { class: 'card' }, h('h2', {}, 'Opdateringer'), updInfo,
    toggle(binder, { label: 'Installér automatisk (når appen ligger i bakken)', get: () => p.autoUpdate !== false, set: (v) => { p.autoUpdate = v; ctx.savePrefs(); } }),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => ctx.checkUpdate(true) }, 'Søg efter opdatering'), installBtn,
      h('a', { href: 'https://github.com/MRDonnii/goxlr-studio/releases', target: '_blank', rel: 'noopener' }, 'Udgivelser')),
    h('div', { class: 'hint' }, 'Appen tjekker GitHub hver 6. time. Filen kontrolleres mod GitHubs checksum, før den installeres; dine indstillinger bevares.'));

  // ---- API ----
  p.api ??= { enabled: false, port: 14610, lan: false, token: '' };
  const api = p.api;
  const examples = h('div', { class: 'api-examples' });
  const apiStatus = h('span', { class: 'badge' });
  const host = () => (api.lan ? '<pc-ip>' : '127.0.0.1');
  const renderApi = () => {
    const base = `http://${host()}:${api.port}`;
    apiStatus.textContent = api.enabled ? (ctx.apiError ? 'Fejl' : 'Kører') : 'Slået fra';
    apiStatus.className = `badge ${api.enabled ? (ctx.apiError ? 'warn' : 'ok') : ''}`;
    apiStatus.title = ctx.apiError || '';
    examples.replaceChildren(
      h('div', { class: 'hint' }, 'Eksempler (token i URL eller som "Authorization: Bearer …"):'),
      h('code', {}, `${base}/action/profile:Headset?token=${api.token}`),
      h('code', {}, `${base}/action/mute-mic?token=${api.token}`),
      h('code', {}, `${base}/state?token=${api.token}`),
      h('code', {}, `${base}/actions?token=${api.token}`),
      h('div', { class: 'hint', style: { marginTop: '6px' } }, 'Home Assistant (configuration.yaml):'),
      h('pre', {}, `rest_command:\n  goxlr_headset:\n    url: "${base}/action/profile:Headset"\n    method: post\n    headers:\n      Authorization: "Bearer ${api.token}"`));
  };
  const saveApi = async () => {
    if (!api.token) api.token = newToken();
    ctx.savePrefs();
    await ctx.applyApi();
    renderApi();
  };
  const port = h('input', { type: 'number', min: 1024, max: 65535, value: api.port, style: { width: '100px' }, onchange: () => { api.port = Number(port.value) || 14610; saveApi(); } });
  const apiCard = h('div', { class: 'card' }, h('h2', {}, 'Lokalt API (Stream Deck / Home Assistant)', apiStatus),
    toggle(binder, { label: 'Slå API til', get: () => api.enabled, set: (v) => { api.enabled = v; saveApi(); } }),
    toggle(binder, { label: 'Tillad fra andre enheder på netværket', get: () => api.lan, set: (v) => { api.lan = v; saveApi(); } }),
    h('div', { class: 'row' }, h('label', {}, 'Port'), port,
      h('button', { class: 'btn sm', onclick: () => { if (confirm('Lav en ny token? Gamle links holder op med at virke.')) { api.token = newToken(); saveApi(); } } }, 'Ny token'),
      h('button', { class: 'btn sm', onclick: () => navigator.clipboard?.writeText(api.token).then(() => toast('Token kopieret', 'info')) }, 'Kopiér token')),
    examples,
    h('div', { class: 'hint' }, isNative() ? 'Alle handlinger fra Genveje kan kaldes – se listen på /actions. Windows Firewall spørger første gang, hvis netværksadgang er slået til.' : 'API’et findes kun i Windows-appen.'));
  renderApi();

  // ---- backup ----
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (data.app !== 'goxlr-studio' || !data.data) throw new Error('Ikke en GoXLR Studio-backup');
      if (!confirm(`Gendan backup fra ${new Date(data.created).toLocaleString('da-DK')}? Dine nuværende indstillinger overskrives.`)) return;
      for (const k of BACKUP_KEYS) if (k in data.data) await storeSet(k, data.data[k]);
      toast('Backup gendannet – genindlæser', 'info');
      setTimeout(() => location.reload(), 600);
    } catch (e) { toast(`Backup: ${e.message || e}`); }
  });
  const backupCard = h('div', { class: 'card' }, h('h2', {}, 'Backup'),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } },
      h('button', { class: 'btn sm primary', onclick: async () => {
        const data = {};
        for (const k of BACKUP_KEYS) data[k] = await storeGet(k, null);
        const blob = new Blob([JSON.stringify({ app: 'goxlr-studio', version: ctx.updateState?.current || null, created: new Date().toISOString(), data }, null, 2)], { type: 'application/json' });
        const a = h('a', { href: URL.createObjectURL(blob), download: `GoXLR Studio backup ${new Date().toISOString().slice(0, 10)}.json` });
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } }, 'Eksportér alle indstillinger'),
      h('button', { class: 'btn sm', onclick: () => fileIn.click() }, 'Importér backup…'), fileIn),
    h('div', { class: 'hint' }, 'Genveje, scener, app-regler, EQ-presets og indstillinger i én fil – til en ny pc eller før du eksperimenterer. GoXLR-profiler ligger i GoXLR Utility og er ikke med.'));

  return h('div', { class: 'grid cols-2' }, osdCard, daemonCard, updCard, backupCard, apiCard);
}
