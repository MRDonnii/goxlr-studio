// GoXLR-indstillinger: what GoXLR Utility could set and GoXLR Studio couldn't yet – the cough
// button's behaviour, what the GoXLR does when the pc sleeps, wakes or shuts down, the screens above
// the faders (big GoXLR), VOD mode and read-aloud (TTS) of button changes.
import { h, toggle, selectBox, segmented } from './ui.js';
import { commandJson } from './api.js';

export const MUTE_TARGETS = [['All', 'Alt (stream, chat og hovedtelefoner)'], ['ToStream', 'Kun streamen'], ['ToVoiceChat', 'Kun voice chat'], ['ToPhones', 'Kun hovedtelefonerne'], ['ToLineOut', 'Kun Line Out']];
export const FADERS = ['A', 'B', 'C', 'D'];

/** The commands the GoXLR runs at sleep/wake/shutdown, from simple choices:
 *  { mute: bool, unmute: bool, profile: '' | name }. Each command as serde's JSON (commandJson). */
export function powerCommands({ mute = false, unmute = false, profile = '' } = {}) {
  const out = [];
  if (profile) out.push(commandJson('LoadProfile', [profile, false]));
  if (mute) out.push(commandJson('SetCoughMuteState', ['MutedToAll']));
  if (unmute) out.push(commandJson('SetCoughMuteState', ['Unmuted']));
  return out;
}

/** The simple choices back from the engine's list (anything else is kept as "other"). */
export function readPowerCommands(cmds = []) {
  const r = { mute: false, unmute: false, profile: '', other: 0 };
  for (const c of cmds || []) {
    const [name] = Object.keys(c || {});
    const v = c?.[name];
    if (name === 'LoadProfile') r.profile = Array.isArray(v) ? v[0] : v;
    else if (name === 'SetCoughMuteState' && v === 'MutedToAll') r.mute = true;
    else if (name === 'SetCoughMuteState' && v === 'Unmuted') r.unmute = true;
    else r.other += 1;
  }
  return r;
}

export function goxlrView(ctx) {
  const { conn, binder } = ctx;
  const m = () => conn.mixer;
  const full = () => m()?.hardware?.device_type !== 'Mini';

  const cough = h('div', { class: 'card', 'data-testid': 'cough-card' }, h('h2', {}, 'Cough-knappen'),
    h('div', { class: 'row' }, h('label', {}, 'Knappen'), segmented(binder, { options: [['toggle', 'Tryk = til/fra'], ['hold', 'Hold = mute']], get: () => (m().cough_button.is_toggle ? 'toggle' : 'hold'), set: (v) => conn.command('SetCoughIsHold', v === 'hold') })),
    h('div', { class: 'row' }, h('label', {}, 'Muter til'), selectBox(binder, { options: MUTE_TARGETS, get: () => m().cough_button.mute_type, set: (v) => conn.command('SetCoughMuteFunction', v) })),
    h('div', { class: 'hint' }, '"Hold = mute": mikrofonen er kun muted, mens du holder knappen nede – fx når du hoster. "Kun streamen": vennerne i Discord hører dig stadig.'));

  // Sleep / wake / shutdown.
  const powerRow = (key, title, cmd, opts) => {
    const box = h('div', { class: 'power-row', 'data-testid': `power-${key}` });
    let sig = '';
    binder.add(() => {
      const cur = readPowerCommands(m()[`${key}_commands`]);
      const s = JSON.stringify(cur) + (conn.status.files?.profiles || []).join('|');
      if (s === sig) return;
      sig = s;
      const send = (patch) => conn.command(cmd, powerCommands({ ...cur, ...patch }));
      const prof = h('select', { onchange: () => send({ profile: prof.value }) },
        h('option', { value: '' }, '— ingen —'),
        (conn.status.files?.profiles || []).map((p) => h('option', { value: p, selected: p === cur.profile }, p)));
      const check = (field, label) => {
        const i = h('input', { type: 'checkbox', checked: cur[field], onchange: () => send({ [field]: i.checked }) });
        return h('label', { class: 'check-inline' }, i, h('span', {}, label));
      };
      box.replaceChildren(h('b', {}, title),
        h('div', { class: 'row', style: { flexWrap: 'wrap' } },
          opts.mute ? check('mute', 'Mute mikrofonen') : null,
          opts.unmute ? check('unmute', 'Åbn mikrofonen igen') : null),
        h('div', { class: 'row' }, h('label', {}, 'Indlæs profil'), prof),
        cur.other ? h('div', { class: 'hint' }, `+ ${cur.other} andre kommandoer fra GoXLR Utility (bevares ikke, hvis du ændrer her)`) : '');
    });
    return box;
  };
  const power = h('div', { class: 'card', 'data-testid': 'power-card' }, h('h2', {}, 'Når pc’en sover, vågner eller lukker'),
    powerRow('sleep', 'Når pc’en går i dvale', 'SetSleepCommands', { mute: true }),
    powerRow('wake', 'Når pc’en vågner', 'SetWakeCommands', { unmute: true }),
    powerRow('shutdown', 'Når pc’en lukker ned', 'SetShutdownCommands', { mute: true }),
    h('div', { class: 'hint' }, 'GoXLR’en gør det selv – også selvom GoXLR Studio ikke når at reagere. Fx en mørk profil ved dvale, så lyset slukker, og din normale profil igen ved opvågning.'));

  // Scribbles (the screens above the faders, big GoXLR).
  const scribbles = h('div', { class: 'card', 'data-testid': 'scribble-card' }, h('h2', {}, 'Skærmene over faderne'));
  let scribSig = '';
  binder.add(() => {
    if (!full()) { scribbles.style.display = 'none'; return; }
    const icons = conn.status.files?.icons || [];
    const sig = icons.join('|');
    if (sig === scribSig) return;
    scribSig = sig;
    scribbles.replaceChildren(h('h2', {}, 'Skærmene over faderne'),
      ...FADERS.map((f) => {
        const sc = () => m().fader_status[f].scribble || {};
        const num = h('input', { type: 'text', maxlength: 3, class: 'num', 'aria-label': `Tal på skærm ${f}`, placeholder: 'tal', onchange: () => conn.command('SetScribbleNumber', f, num.value) });
        binder.add(() => { if (document.activeElement !== num) num.value = sc().left_text || ''; });
        return h('div', { class: 'row', style: { flexWrap: 'wrap' } }, h('label', {}, `Fader ${f}`),
          selectBox(binder, { options: [['', '— intet ikon —'], ...icons.map((i) => [i, i.replace(/\.[^.]+$/, '')])], get: () => sc().file_name || '', set: (v) => conn.command('SetScribbleIcon', f, v || null) }),
          num,
          h('label', { class: 'check-inline' }, (() => { const i = h('input', { type: 'checkbox', onchange: () => conn.command('SetScribbleInvert', f, i.checked) }); binder.add(() => { i.checked = !!sc().inverted; }); return i; })(), h('span', {}, 'Omvendt')));
      }),
      h('div', { class: 'hint' }, 'Teksten nederst sættes på Mixer-siden. Ikoner er billeder i GoXLR’ens ikon-mappe.'));
  });

  const vod = h('div', { class: 'card', 'data-testid': 'vod-card' }, h('h2', {}, 'VOD-tilstand'),
    h('div', { class: 'row' }, h('label', {}, 'Stream-mix 2'), segmented(binder, { options: [['Routable', 'Kan routes'], ['StreamNoMusic', 'Stream uden musik']], get: () => m().settings?.vod_mode, set: (v) => conn.command('SetVodMode', v) })),
    h('div', { class: 'hint' }, '"Stream uden musik" giver et ekstra stream-mix uden Music-kanalen – fx til Twitchs VOD-spor, så musik ikke giver ophavsrets-problemer i optagelsen.'));
  binder.add(() => { vod.style.display = full() ? '' : 'none'; });

  const tts = h('div', { class: 'card', 'data-testid': 'tts-card' }, h('h2', {}, 'Oplæsning'),
    toggle(binder, { label: 'Læs ændringer højt (fx "mikrofon muted")', get: () => !!conn.status.config?.tts_enabled, set: (v) => conn.daemon('SetTTSEnabled', v) }),
    h('div', { class: 'hint' }, 'Windows’ stemme siger, hvad der skete, når du trykker på GoXLR’en – smart, når du ikke kan se skærmen, eller hvis du har nedsat syn.'));

  return h('div', { class: 'grid cols-2' }, cough, power, scribbles, vod, tts);
}
