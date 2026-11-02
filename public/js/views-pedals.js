// Fodpedal page: learn a pedal (a key, a Stream Deck Pedal or MIDI), and give it what to do –
// press, hold (push-to-talk), tap-and-hold, or a MIDI fader to a channel's volume.
import { h, toast, confirmDialog } from './ui.js';
import { midiStart, midiPorts, isNative } from './native.js';
import { actionCatalog } from './actions.js';
import { accelFromEvent, prettyAccel } from './views-hotkeys.js';
import { CHANNEL_LABEL } from './views-mixer.js';
import { HOLD_ACTIONS, PEDAL_MODES, CHATMIX, describeInput, stealsTyping } from './pedals.js';

const LEARN_SECONDS = 15;
const VOLUME_CHANNELS = ['Mic', 'LineIn', 'Console', 'System', 'Game', 'Chat', 'Sample', 'Music', 'Headphones', 'MicMonitor', 'LineOut'];

export function pedalsView(ctx) {
  ctx.pedals ??= [];
  const list = h('div', { class: 'list', 'data-testid': 'pedal-list' });
  const learnBox = h('div', { class: 'learn-box', 'data-testid': 'pedal-learn', style: { display: 'none' } });
  const portsBox = h('div', { class: 'hint', 'data-testid': 'midi-ports' });
  const save = () => { ctx.savePedals(); render(); };
  let catalog = [];
  const lights = new Map();

  // ---- learning: the next key or MIDI message is the pedal ----
  let stopLearn = null;
  const learn = (pedal) => {
    stopLearn?.();
    midiStart().catch(() => {});
    ctx.capturingHotkey = true;
    ctx.pauseHotkeys?.();
    let left = LEARN_SECONDS, downAt = 0, keyAccel = null, midi = null, ccValues = new Set(), settle = null;
    const status = h('span', {}, '');
    const tick = () => { status.textContent = `Træd på pedalen, og hold den nede et øjeblik … (${left} s)`; };
    tick();
    learnBox.replaceChildren(h('b', {}, pedal.name || 'Ny pedal'), status, h('button', { class: 'btn sm', onclick: () => done(null) }, 'Annullér'));
    learnBox.style.display = '';
    const timer = setInterval(() => { left -= 1; tick(); if (left <= 0) done(null); }, 1000);
    const finish = (input) => {
      Object.assign(pedal, { input });
      if (input.kind === 'midi' && input.type === 'cc' && input.fader) { pedal.mode = 'fader'; pedal.channel ??= 'Music'; }
      else if (pedal.mode === 'fader') pedal.mode = 'press';
      delete pedal.input.fader;
      if (!ctx.pedals.includes(pedal)) ctx.pedals.push(pedal);
      toast(`${pedal.name}: ${describeInput(input)}`, 'info');
      if (input.canHold === false) toast('Pedalen sendte kun et kort tryk – "Hold" virker ikke med den. Brug "Tryk".', 'info');
      save();
    };
    const onDown = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { done(null); return; } // Esc cancels – it is not a pedal
      const a = accelFromEvent(e);
      if (!a) return;
      if (!keyAccel) { keyAccel = a; downAt = performance.now(); setTimeout(() => { if (keyAccel && downAt) done({ kind: 'key', accel: keyAccel, canHold: true }); }, 1500); }
    };
    const onUp = (e) => {
      if (!keyAccel || !downAt) return;
      e.preventDefault();
      const held = performance.now() - downAt;
      downAt = 0;
      done({ kind: 'key', accel: keyAccel, canHold: held > 250 });
    };
    ctx.pedalLearn = (ev) => {
      // A fader or knob sends many values; a pedal or key sends on/off.
      if (!midi) midi = ev;
      if (ev.type !== midi.type || ev.number !== midi.number) return;
      if (ev.type === 'cc') ccValues.add(ev.value);
      if (ev.type === 'note' && !ev.down) { done({ kind: 'midi', type: 'note', channel: midi.channel, number: midi.number, port: midi.port, canHold: true }); return; }
      clearTimeout(settle);
      settle = setTimeout(() => done({ kind: 'midi', type: midi.type, channel: midi.channel, number: midi.number, port: midi.port, canHold: true, fader: midi.type === 'cc' && ccValues.size > 3 }), 1200);
    };
    function done(input) {
      clearInterval(timer); clearTimeout(settle);
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      ctx.pedalLearn = null;
      ctx.capturingHotkey = false;
      stopLearn = null;
      learnBox.style.display = 'none';
      if (input) finish(input); else ctx.resumeHotkeys?.();
    }
    stopLearn = () => done(null);
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
  };
  ctx.cleanup.push(() => stopLearn?.());

  // ---- one row per pedal ----
  const actionSel = (value, onChange, testid) => h('select', { 'data-testid': testid, onchange: (e) => onChange(e.target.value || null) },
    h('option', { value: '' }, '— intet —'),
    catalog.map((g) => h('optgroup', { label: g.title }, g.items.map((i) => h('option', { value: i.id, selected: i.id === value }, i.label)))));
  const render = () => {
    list.replaceChildren(...ctx.pedals.map((p, i) => {
      const light = h('span', { class: `pedal-light ${ctx.pedalRunner?.isDown(p.id) ? 'on' : ''}`, title: 'Lyser, når pedalen er trådt ned' });
      lights.set(p.id, light);
      const name = h('input', { type: 'text', value: p.name || '', style: { width: '120px' }, 'data-testid': 'pedal-name', onchange: () => { p.name = name.value.trim() || `Pedal ${i + 1}`; save(); } });
      const isCc = p.input?.kind === 'midi' && p.input.type === 'cc';
      const modes = Object.entries(PEDAL_MODES).filter(([k]) => k !== 'fader' || isCc);
      const mode = h('select', { 'data-testid': 'pedal-mode', onchange: () => { p.mode = mode.value; if (p.mode === 'hold' || p.mode === 'taphold') p.holdAction ??= 'hold:ptt'; save(); } },
        modes.map(([k, v]) => h('option', { value: k, selected: (p.mode || 'press') === k }, v)));
      const parts = [];
      const m = p.mode || 'press';
      if (m === 'press' || m === 'taphold') parts.push(h('span', { class: 'lbl app-lbl' }, m === 'taphold' ? 'Kort tryk →' : '→'), actionSel(p.action, (v) => { p.action = v; save(); }, 'pedal-action'));
      if (m === 'hold' || m === 'taphold') parts.push(h('span', { class: 'lbl app-lbl' }, m === 'taphold' ? 'Hold →' : '→'),
        h('select', { 'data-testid': 'pedal-hold', onchange: (e) => { p.holdAction = e.target.value; save(); } }, HOLD_ACTIONS.map(([k, v]) => h('option', { value: k, selected: p.holdAction === k }, v))));
      if (m === 'fader') parts.push(h('span', { class: 'lbl app-lbl' }, '→'),
        h('select', { 'data-testid': 'pedal-channel', onchange: (e) => { p.channel = e.target.value; save(); } }, [...VOLUME_CHANNELS, CHATMIX].map((c) => h('option', { value: c, selected: p.channel === c }, c === CHATMIX ? 'ChatMix (chat ↔ spil)' : CHANNEL_LABEL[c] || c))));
      // What could go wrong, said in the row.
      const warns = [];
      const accel = p.input?.kind === 'key' ? p.input.accel : null;
      if (accel && stealsTyping(accel)) warns.push(`${prettyAccel(accel)} er en almindelig tast – den virker ikke til at skrive med, mens GoXLR Studio kører. Sæt pedalen til F13–F24 eller en kombination med Ctrl/Alt.`);
      if (accel && ctx.hotkeys?.some((b) => b.accel === accel && b.action)) warns.push(`${prettyAccel(accel)} bruges også under Genveje – genvejen vinder. Fjern den der, eller giv pedalen en anden tast.`);
      const reg = ctx.hotkeyStatus?.[`pedal:${p.id}`];
      if (accel && reg && !reg.ok) warns.push(`Tasten kunne ikke registreres: ${reg.error}`);
      if (p.input?.canHold === false && (m === 'hold' || m === 'taphold')) warns.push('Pedalen sendte kun et kort tryk, da den blev lært – "Hold" kræver, at tasten holdes nede så længe pedalen er trådt ned (for Stream Deck: brug "Tryk").');
      return h('div', { class: 'item pedal-row', style: { flexWrap: 'wrap' } },
        light, name,
        h('span', { class: 'hint pedal-input', 'data-testid': 'pedal-input' }, describeInput(p.input)),
        h('button', { class: 'btn sm', 'data-testid': 'pedal-relearn', onclick: () => learn(p) }, 'Lær igen'),
        mode, ...parts,
        h('div', { class: 'spacer' }),
        h('button', { class: 'btn sm', title: 'Fjern pedalen', onclick: async () => { if (await confirmDialog(`Fjern "${p.name}"?`, { ok: 'Fjern', danger: true })) { ctx.pedals.splice(i, 1); save(); } } }, '✕'),
        warns.length ? h('div', { class: 'pedal-warn', 'data-testid': 'pedal-warn' }, warns.map((w) => h('div', {}, `⚠ ${w}`))) : null);
    }));
    if (!ctx.pedals.length) list.append(h('div', { class: 'hint' }, 'Ingen pedaler endnu. Tryk "+ Tilføj pedal", og træd på pedalen.'));
  };
  ctx.onPedal = (id, down, value) => {
    const l = lights.get(id);
    if (!l) return;
    l.classList.toggle('on', down);
    if (value != null) { l.textContent = ''; l.title = `${Math.round((value / 127) * 100)} %`; }
  };
  ctx.cleanup.push(() => { ctx.onPedal = null; });
  actionCatalog(ctx).then((c) => { catalog = c; render(); });
  const refreshPorts = () => midiPorts().then((ports) => {
    portsBox.textContent = ports.length ? `MIDI fundet: ${ports.join(', ')}` : 'Ingen MIDI-enheder fundet. Sæt dem i – de findes automatisk inden for få sekunder.';
  }).catch(() => {});
  midiStart().catch(() => {}).finally(() => setTimeout(refreshPorts, 600));
  const portTimer = setInterval(refreshPorts, 4000);
  ctx.cleanup.push(() => clearInterval(portTimer));
  render();

  const add = () => learn({ id: crypto.randomUUID(), name: `Pedal ${ctx.pedals.length + 1}`, mode: 'press', action: null, holdAction: 'hold:ptt' });
  const guide = (title, ...lines) => h('div', { class: 'pedal-guide' }, h('b', {}, title), h('ul', {}, lines.map((l) => h('li', {}, l))));
  return h('div', { class: 'grid' },
    h('div', { class: 'card', 'data-testid': 'pedals-card' }, h('h2', {}, 'Dine pedaler', h('button', { class: 'btn sm primary', 'data-testid': 'pedal-add', onclick: add }, '+ Tilføj pedal')),
      learnBox, list,
      h('div', { class: 'hint', style: { marginTop: '8px' } }, '"Tryk" kører en handling. "Hold" virker, mens pedalen er nede – fx push-to-talk. "Tryk og hold" gør én ting ved et kort tryk og en anden, mens du holder. En MIDI-fader eller -knap kan styre en kanals lydstyrke. Pedalerne virker overalt, også i spil og når appen ligger i bakken.')),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Sådan sætter du pedalen op'),
        guide('USB-pedal, der skriver en tast (1–3 pedaler)',
          'Sæt hver pedal til en tast, du ikke bruger til andet – helst F13–F24 eller fx Ctrl+Alt+F5 – i det program, der fulgte med pedalen.',
          'Tryk "+ Tilføj pedal", og træd på pedalen. Hold den nede et øjeblik, så appen kan se, at den kan holdes.'),
        guide('Elgato Stream Deck Pedal',
          'Træk handlingen "Hotkey" (System) ind på en pedal i Stream Deck-programmet, og giv den en tast, fx Ctrl+Alt+Shift+F5.',
          'Tryk "+ Tilføj pedal", og træd på den. Kan den ikke holdes (Stream Deck sender kun et kort tryk), bruger du "Tryk" – eller linkene fra Stream Deck-siden.'),
        guide('MIDI-pedal eller -controller',
          'Sæt den i – GoXLR Studio finder den selv, også hvis den sættes i senere.',
          'En sustain-pedal eller en knap bliver en pedal; en fader eller drejeknap kan styre en kanals lydstyrke.'),
        portsBox),
      h('div', { class: 'card' }, h('h2', {}, 'Har du ikke en pedal?'),
        h('div', { class: 'hint' }, 'Den billigste løsning er en USB-fodpedal med 1–3 pedaler, der kan programmeres til at sende en tast (søg fx på "USB fodpedal programmerbar"). Tjek, at den kan sende F13–F24 eller tastkombinationer, og at tasten holdes nede, så længe pedalen er trådt ned – så virker push-to-talk.'),
        h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Har du allerede en Stream Deck, passer Elgato Stream Deck Pedal ind i den. Spiller du musik, kan en MIDI-pedal eller en lille MIDI-controller med faders også styre GoXLR’ens lydstyrker.'),
        h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Gode første funktioner: push-to-talk eller hold for at mute (host), mute af Discord, en lyd fra lydbanken, næste OBS-scene og "Stream-sikker musik".'),
        isNative() ? null : h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Demo: window.studioDemo.midi([0x90, 60, 100]) træder på en MIDI-pedal.'))));
}
