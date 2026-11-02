import { h, toggle, toast, confirmDialog } from './ui.js';
import { takeoverMessage } from './extras.js';
import { isNative, startDaemon, showOsd, daemonInfo, daemonTakeover, updateSigned } from './native.js';
import { DEFAULT_DISCORD_KEY, DEFAULT_DISCORD_DEAF_KEY } from './discord.js';
import { accelFromEvent, prettyAccel } from './views-hotkeys.js';
import { mqttCard } from './mqtt.js';
import { hearingCard } from './hearing.js';
import { obsCard } from './obs.js';
import { appearanceCard } from './theme.js';
import { mediaCard } from './media.js';
import { scheduleCard } from './schedule.js';
import { moveCard } from './movepc.js';
import { gameModeCard } from './gamemode.js';

export { BACKUP_KEYS } from './movepc.js';

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

  // ---- built-in GoXLR engine ----
  const daemonState = h('div', { class: 'hint' }, '…');
  const takeoverBtn = h('button', { class: 'btn sm primary', style: { display: 'none' }, onclick: async () => {
    takeoverBtn.disabled = true;
    try {
      const t = await daemonTakeover();
      const m = takeoverMessage(t); toast(m.text, m.ok ? 'info' : undefined);
    } catch (e) { toast(String(e)); }
    takeoverBtn.disabled = false;
    refreshDaemon();
  } }, 'Brug den indbyggede motor nu');
  const refreshDaemon = () => daemonInfo().then((d) => {
    daemonState.textContent = !d.bundled ? 'Denne version har ikke GoXLR-motoren indbygget – den bruger en installeret GoXLR Utility.'
      : d.foreign?.length ? 'GoXLR Utility kører stadig og styrer GoXLR’en. Tryk nedenfor for at lade GoXLR Studio overtage.'
        : d.started_by_us ? `GoXLR-motoren kører inde i GoXLR Studio – der er intet separat program (bygget på GoXLR Utility ${d.version}, MIT-licens).`
          : `GoXLR-motoren kører ikke.${d.last_error ? ` ${d.last_error}` : ''}`;
    takeoverBtn.style.display = d.bundled && d.foreign?.length ? '' : 'none';
  }).catch(() => {});
  refreshDaemon();
  const daemonCard = h('div', { class: 'card' }, h('h2', {}, 'GoXLR-motor'),
    daemonState,
    toggle(binder, { label: 'Start automatisk med GoXLR Studio', get: () => p.autoStartDaemon !== false, set: (v) => { p.autoStartDaemon = v; ctx.savePrefs(); } }),
    toggle(binder, { label: 'Brug altid GoXLR Studios egen motor', get: () => p.builtinEngine !== false, set: (v) => { p.builtinEngine = v; ctx.savePrefs(); } }),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, takeoverBtn,
      h('button', { class: 'btn sm', disabled: !isNative(), onclick: () => startDaemon().then((t) => toast(t, 'info')).catch((e) => toast(String(e))) }, 'Start nu')),
    h('div', { class: 'hint' }, 'Motoren er en del af GoXLR Studio: den taler med GoXLR’en over USB, starter og stopper med appen og bruger samme profiler og indstillinger som GoXLR Utility.'));

  // ---- updates ----
  const updInfo = h('div', { class: 'list' });
  const signedBadge = h('span', { class: 'badge', 'data-testid': 'update-signed' }, '…');
  updateSigned().then((on) => {
    signedBadge.className = `badge ${on ? 'ok' : ''}`;
    signedBadge.textContent = on ? 'Kun signerede opdateringer' : 'Ikke slået til';
    signedBadge.title = on ? 'Appen installerer kun en udgivelse, hvis dens liste over filer er signeret med GoXLR Studios nøgle.' : 'Denne udgave tjekker kun GitHubs checksum.';
  }).catch(() => { signedBadge.textContent = '–'; });
  const installBtn = h('button', { class: 'btn sm primary', onclick: () => ctx.installUpdate() }, 'Installér nu');
  const renderUpd = () => {
    const u = ctx.updateState || {};
    updInfo.replaceChildren(...[
      h('div', { class: 'item' }, 'Denne version', h('div', { class: 'spacer' }), u.current || '…'),
      h('div', { class: 'item' }, 'Nyeste udgivelse', h('div', { class: 'spacer' }),
        u.error ? h('span', { class: 'badge warn', title: u.error }, 'Kunne ikke tjekke') : (u.latest || '–'),
        u.available ? h('span', { class: 'badge ok' }, 'Ny version') : null),
      u.checkedAt ? h('div', { class: 'item' }, 'Sidst tjekket', h('div', { class: 'spacer' }), new Date(u.checkedAt).toLocaleString('da-DK')) : null,
      h('div', { class: 'item' }, 'Signatur', h('div', { class: 'spacer' }), signedBadge),
      u.error ? h('div', { class: 'item hint', 'data-testid': 'update-error' }, u.error) : null,
      u.failed ? h('div', { class: 'item hint', 'data-testid': 'update-failed' }, u.failed) : null].filter(Boolean));
    installBtn.style.display = u.available && isNative() ? '' : 'none';
  };
  ctx.onUpdateState = renderUpd;
  ctx.cleanup.push(() => { ctx.onUpdateState = null; });
  renderUpd();
  const updCard = h('div', { class: 'card' }, h('h2', {}, 'Opdateringer'), updInfo,
    toggle(binder, { label: 'Installér automatisk (når appen ligger i bakken)', get: () => p.autoUpdate !== false, set: (v) => { p.autoUpdate = v; ctx.savePrefs(); } }),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('button', { class: 'btn sm', onclick: () => ctx.checkUpdate(true) }, 'Søg efter opdatering'), installBtn,
      h('button', { class: 'btn sm', 'data-testid': 'whats-new-btn', onclick: () => ctx.showWhatsNew?.(true) }, 'Hvad er nyt'),
      h('a', { href: 'https://github.com/MRDonnii/goxlr-studio/releases', target: '_blank', rel: 'noopener' }, 'Udgivelser')),
    h('div', { class: 'hint' }, 'Appen tjekker GitHub hver 6. time. Filen kontrolleres mod GitHubs checksum, før den installeres; dine indstillinger bevares. Under installationen lukker GoXLR Studio, installeren vises kort, og appen starter igen af sig selv – hvert trin skrives i Diagnose.'));

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
    renderRemote();
  };
  const port = h('input', { type: 'number', min: 1024, max: 65535, value: api.port, style: { width: '100px' }, onchange: () => { api.port = Number(port.value) || 14610; saveApi(); } });
  // Mobil-fjernbetjening: the API's phone page (GET /remote) – mute, profiles, scenes, EQ and volume.
  const remoteBox = h('div', { class: 'remote-box', 'data-testid': 'remote-box' });
  const renderRemote = async () => {
    const ip = api.lan ? (isNative() ? await window.__TAURI__.core.invoke('lan_ip').catch(() => null) : '192.168.1.20') : null;
    const url = ip ? `http://${ip}:${api.port}/remote?token=${encodeURIComponent(api.token)}` : null;
    remoteBox.replaceChildren(h('div', { class: 'hint', style: { marginTop: '10px' } }, 'Fjernbetjening på mobilen:'),
      api.enabled && url
        ? h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('code', { 'data-no-i18n': '', 'data-testid': 'remote-url' }, url),
          h('button', { class: 'btn sm', onclick: () => navigator.clipboard?.writeText(url).then(() => toast('Linket er kopieret – send det til din telefon', 'info')).catch((e) => toast(`Kunne ikke kopiere: ${e.message || e}`)) }, 'Kopiér link'))
        : h('div', { class: 'hint' }, 'Slå API til og "Tillad fra andre enheder på netværket", så får du et link, du kan åbne på telefonen (samme wifi). Gem det på hjemmeskærmen.'));
  };
  const apiCard = h('div', { class: 'card' }, h('h2', {}, 'Lokalt API (Stream Deck / Home Assistant)', apiStatus),
    toggle(binder, { label: 'Slå API til', get: () => api.enabled, set: (v) => { api.enabled = v; saveApi(); } }),
    toggle(binder, { label: 'Tillad fra andre enheder på netværket', get: () => api.lan, set: (v) => { api.lan = v; saveApi(); } }),
    h('div', { class: 'row' }, h('label', {}, 'Port'), port,
      h('button', { class: 'btn sm', 'data-testid': 'api-new-token', onclick: async () => { if (await confirmDialog('Lav en ny token? Gamle links holder op med at virke.', { ok: 'Ny token' })) { api.token = newToken(); saveApi(); } } }, 'Ny token'),
      h('button', { class: 'btn sm', onclick: () => navigator.clipboard?.writeText(api.token).then(() => toast('Token kopieret', 'info')).catch((e) => toast(`Kunne ikke kopiere: ${e.message || e}`)) }, 'Kopiér token')),
    examples,
    remoteBox,
    h('div', { class: 'hint' }, isNative() ? 'Alle handlinger fra Genveje kan kaldes – se listen på /actions. Windows Firewall spørger første gang, hvis netværksadgang er slået til.' : 'API’et findes kun i Windows-appen.'));
  renderApi();
  renderRemote();

  // ---- Discord ----
  p.discord ??= { enabled: false, accel: DEFAULT_DISCORD_KEY, cough: true, fader: true };
  const dc = p.discord;
  dc.deafAccel ??= DEFAULT_DISCORD_DEAF_KEY;
  // A button that records a key combination (Esc cancels) for one of Discord's keybinds.
  const keyButton = (key, testid) => {
    const btn = h('button', { class: 'btn keycap', style: { minWidth: '0' }, 'data-testid': testid }, prettyAccel(dc[key]));
    btn.addEventListener('click', () => {
      btn.textContent = 'Tryk tasterne… (Esc = annullér)';
      ctx.capturingHotkey = true;
      ctx.pauseHotkeys?.();
      const onKey = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') return done();
        const a = accelFromEvent(e);
        if (!a) return;
        if (ctx.hotkeys.some((b) => b.accel === a)) { toast(`${prettyAccel(a)} bruges af en af dine genveje – vælg en anden`); return; }
        const other = key === 'accel' ? 'deafAccel' : 'accel';
        if (dc[other] === a) { toast('Mikrofon og døv skal have hver sin genvej'); return; }
        dc[key] = a; ctx.savePrefs(); done();
      };
      const done = () => { window.removeEventListener('keydown', onKey, true); ctx.capturingHotkey = false; ctx.resumeHotkeys?.(); btn.textContent = prettyAccel(dc[key]); renderSteps(); };
      window.addEventListener('keydown', onKey, true);
    });
    return btn;
  };
  const steps = h('ol', { class: 'hint steps' });
  const renderSteps = () => {
    const both = dc.mode === 'both';
    steps.replaceChildren(
      h('li', {}, 'Åbn Discord → Brugerindstillinger → Tastaturgenveje → "Tilføj en tastaturgenvej".'),
      both
        ? h('li', {}, `Vælg handlingen for døv ("Toggle Deafen" på engelsk), klik i genvejsfeltet og tryk ${prettyAccel(dc.deafAccel)}.`)
        : h('li', {}, `Vælg handlingen "Slå mikrofonen fra/til" ("Toggle Mute"), klik i genvejsfeltet og tryk ${prettyAccel(dc.accel)}.`),
      h('li', {}, 'Slå "Vis GoXLR-mute i Discord" til.'),
      h('li', {}, both
        ? 'Når du muter på GoXLR’en, bliver du stum og døv i Discord – både mikrofonen og hovedtelefonerne er streget over, så de andre kan se det. Slår du mute fra igen, kommer lyd og mikrofon tilbage.'
        : 'Når du muter på GoXLR’en, muter Discord også – med det røde ikon.'));
  };
  renderSteps();
  const modeSel = h('select', { 'data-testid': 'discord-mode', onchange: async () => {
    const from = dc.mode === 'both' ? 'both' : 'mute';
    dc.mode = modeSel.value; ctx.savePrefs(); renderSteps();
    await ctx.discordModeChanged?.(from, dc.mode);
  } },
  h('option', { value: 'mute' }, 'Stum (mikrofonen fra)'),
  h('option', { value: 'both' }, 'Stum og døv (mikrofon og lyd fra)'));
  modeSel.value = dc.mode === 'both' ? 'both' : 'mute';
  const discordCard = h('div', { class: 'card' }, h('h2', {}, 'Discord'),
    toggle(binder, { label: 'Vis GoXLR-mute i Discord', get: () => dc.enabled, set: (v) => { dc.enabled = v; ctx.savePrefs(); if (v) ctx.discordAlign?.(); } }),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('label', {}, 'Når GoXLR’en muter, bliver du i Discord'), modeSel),
    toggle(binder, { label: 'Cough-/mute-knappen', get: () => dc.cough !== false, set: (v) => { dc.cough = v; ctx.savePrefs(); } }),
    toggle(binder, { label: 'Mute-knappen under Mic-faderen', get: () => dc.fader !== false, set: (v) => { dc.fader = v; ctx.savePrefs(); } }),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('label', {}, 'Discord-genvej: mikrofon fra/til'), keyButton('accel', 'discord-key-mute'),
      h('button', { class: 'btn sm', 'data-testid': 'discord-test-mute', onclick: () => ctx.discordToggle?.() }, 'Test / ret')),
    h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('label', {}, 'Discord-genvej: døv (lyd fra/til)'), keyButton('deafAccel', 'discord-key-deaf'),
      h('button', { class: 'btn sm', 'data-testid': 'discord-test-deaf', onclick: () => ctx.discordDeafen?.() }, 'Test / ret')),
    steps,
    h('div', { class: 'hint' }, 'Mutes kun "til stream" påvirker ikke Discord. Muter du direkte i Discord, kommer de ud af trit – tryk så "Test / ret" én gang. Genvejene kan også ligge på en Stream Deck.'));

  // ---- mic safety ----
  const micSafetyCard = h('div', { class: 'card' }, h('h2', {}, 'Mikrofon-sikkerhed'),
    toggle(binder, { label: 'Sig til, når jeg taler, mens mikrofonen er muted', get: () => p.mutedReminder !== false, set: (v) => { p.mutedReminder = v; ctx.savePrefs(); } }),
    toggle(binder, { label: 'Mute mikrofonen, når pc’en låses (Win+L)', get: () => p.lockMute !== false, set: (v) => { p.lockMute = v; ctx.savePrefs(); } }),
    h('div', { class: 'hint' }, 'Påmindelsen vises ovenpå spil. Når du låser pc’en op, åbnes mikrofonen igen – men kun hvis det var GoXLR Studio, der mutede den. Med Discord "stum og døv" følger Discord med.'));

  // ---- about ----
  const repo = 'https://github.com/MRDonnii/goxlr-studio';
  const aboutCard = h('div', { class: 'card' }, h('h2', {}, 'Om GoXLR Studio'),
    h('div', { class: 'list compact' },
      h('div', { class: 'item' }, 'GoXLR Studio', h('div', { class: 'spacer' }), ctx.updateState?.current || '', h('span', { class: 'badge' }, 'MIT')),
      h('div', { class: 'item' }, 'GoXLR-motor: GoXLR Utility 1.2.4', h('div', { class: 'spacer' }), h('span', { class: 'badge' }, 'MIT')),
      h('div', { class: 'item' }, 'EQ-motor: Equalizer APO 1.4.2', h('div', { class: 'spacer' }), h('span', { class: 'badge' }, 'GPL v2')),
      h('div', { class: 'item hint' }, 'FFTW (GPL), libsndfile (LGPL), Microsoft VC++ runtime')),
    h('div', { class: 'row', style: { marginTop: '8px', flexWrap: 'wrap' } },
      h('a', { href: `${repo}/blob/main/THIRD-PARTY-NOTICES.md`, target: '_blank', rel: 'noopener' }, 'Licenser og kildekode'),
      h('a', { href: `${repo}/releases`, target: '_blank', rel: 'noopener' }, 'Udgivelser')),
    h('div', { class: 'hint' }, 'Motorerne er open source og indgår uændrede. Kildekoden til EQ-motoren ligger ved hver udgivelse.'));

  return h('div', { class: 'grid cols-2' }, appearanceCard(ctx), mediaCard(ctx, binder), scheduleCard(ctx, binder), gameModeCard(ctx, binder), discordCard, micSafetyCard, hearingCard(ctx), mqttCard(ctx), obsCard(ctx), osdCard, daemonCard, updCard, moveCard(ctx), apiCard, aboutCard);
}
