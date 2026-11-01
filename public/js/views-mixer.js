import { FADER_LEDS, faderLeds, peakToMeter, dbToMeter, channelEndpoint, vuStep } from './extras.js';
import { h, slider, segmented, selectBox, toggle, throttle, toast } from './ui.js';
import { CHANNELS, INPUTS, OUTPUTS } from './demo.js';
import { listAudioDevices, setDefaultDevice } from './native.js';
import { startLevelsCard } from './startlevels.js';
import { deviceTriggersCard } from './devicetriggers.js';

export const CHANNEL_LABEL = {
  Mic: 'Mikrofon', LineIn: 'Line In', Console: 'Konsol', System: 'System', Game: 'Spil', Chat: 'Chat',
  Sample: 'Samples', Music: 'Musik', Headphones: 'Hovedtelefoner', MicMonitor: 'Mic-monitor', LineOut: 'Line Out',
};
export const INPUT_LABEL = { Microphone: 'Mikrofon', Chat: 'Chat', Music: 'Musik', Game: 'Spil', Console: 'Konsol', LineIn: 'Line In', System: 'System', Samples: 'Samples' };
export const OUTPUT_LABEL = { Headphones: 'Hovedtelefoner', BroadcastMix: 'Stream-mix', ChatMic: 'Chat-mic', Sampler: 'Sampler', LineOut: 'Line Out', StreamMix2: 'Stream-mix 2' };
const MUTE_FN_LABEL = { All: 'Alt', ToStream: 'Stream', ToVoiceChat: 'Voice chat', ToPhones: 'Hovedtelefoner', ToLineOut: 'Line Out' };

export const pct = (v) => `${Math.round((v / 255) * 100)} %`;

function vuMeter(list, fader) {
  const fill = h('div', { class: 'vu-fill' });
  const peak = h('div', { class: 'vu-peak' });
  const el = h('div', { class: 'vu', title: 'Lydniveau' }, fill, peak);
  list.push({ fader, el, fill, peak, state: { level: 0, peak: 0, peakAt: 0 } });
  return el;
}

function verticalFader(binder, { get, set, colours, style }) {
  // 15 LEDs on each side of the slot, coloured exactly like the hardware (see faderLeds).
  const leds = Array.from({ length: FADER_LEDS }, () => [h('span', { class: 'led' }), h('span', { class: 'led' })]);
  const ledBox = h('div', { class: 'leds' }, leds.map((pair) => h('div', { class: 'led-row' }, pair[0], h('span', { class: 'slot' }), pair[1])));
  const knob = h('div', { class: 'knob' });
  const el = h('div', { class: 'vfader', tabindex: 0, role: 'slider', 'aria-valuemin': 0, 'aria-valuemax': 255 }, ledBox, knob);
  let active = false;
  const send = throttle(set, 40);
  const paint = (v) => {
    const p = (v / 255) * 100;
    knob.style.bottom = `calc(${p}% - ${(p / 100) * 18}px)`;
    el.setAttribute('aria-valuenow', v);
    const c = colours();
    if (!c) return;
    faderLeds(style?.() || 'TwoColour', c.colour_one, c.colour_two, v).forEach((col, i) => {
      for (const led of leds[i]) {
        led.style.background = col ? `#${col}` : '';
        led.style.boxShadow = col ? `0 0 6px #${col}99` : '';
        led.classList.toggle('off', !col);
      }
    });
  };
  const fromY = (y) => {
    const r = el.getBoundingClientRect();
    return Math.round(Math.min(Math.max(1 - (y - r.top - 9) / (r.height - 18), 0), 1) * 255);
  };
  el.addEventListener('pointerdown', (e) => {
    active = true;
    el.setPointerCapture(e.pointerId);
    const v = fromY(e.clientY); paint(v); send(v);
  });
  el.addEventListener('pointermove', (e) => {
    if (!active) return;
    const v = fromY(e.clientY); paint(v); send(v);
  });
  el.addEventListener('pointerup', () => { active = false; send.flush(); });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const v = Math.min(Math.max(get() + (e.deltaY < 0 ? 5 : -5), 0), 255);
    paint(v); send(v);
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const step = { ArrowUp: 5, ArrowDown: -5, PageUp: 25, PageDown: -25 }[e.key];
    if (!step) return;
    e.preventDefault();
    const v = Math.min(Math.max(get() + step, 0), 255);
    paint(v); send(v);
  });
  binder.add(() => {
    const c = colours();
    if (c) { el.style.setProperty('--c1', `#${c.colour_one.slice(0, 6)}`); el.style.setProperty('--c2', `#${c.colour_two.slice(0, 6)}`); }
    if (!active) paint(get());
  });
  return el;
}

export function mixerView(ctx) {
  const { conn, binder } = ctx;
  const m = () => conn.mixer;
  const root = h('div', { class: 'grid' });

  root.append(quickSwitchCard(ctx));

  const strips = h('div', { class: 'strips' });
  // VU meters: the mic level comes from the GoXLR, the other channels from Windows' meter on the
  // GoXLR output that feeds them (System, Game, Chat, Music, Sample).
  let devices = [];
  listAudioDevices().then((d) => { devices = d; }).catch(() => {});
  const vus = [];
  let micDb = null;
  ctx.onLevels = (levels) => {
    const now = performance.now();
    for (const v of vus) {
      const ch = m()?.fader_status[v.fader].channel;
      let target = null;
      if (ch === 'Mic') target = dbToMeter(micDb);
      else {
        const id = channelEndpoint(ch, devices);
        if (id && levels && id in levels) target = peakToMeter(levels[id]);
      }
      v.el.classList.toggle('none', target == null);
      v.state = vuStep(v.state, target ?? 0, now);
      v.fill.style.height = `${(v.state.level * 100).toFixed(1)}%`;
      v.peak.style.bottom = `${(v.state.peak * 100).toFixed(1)}%`;
      v.peak.style.opacity = v.state.peak > 0.02 ? 1 : 0;
    }
  };
  for (const f of ['A', 'B', 'C', 'D']) {
    const fs = () => m().fader_status[f];
    const pctEl = h('div', { class: 'pct' });
    const scribble = h('input', { type: 'text', class: 'scribble', maxlength: 14, title: 'Tekst på faderens display' });
    scribble.addEventListener('change', () => conn.command('SetScribbleText', f, scribble.value));
    const muteBtn = h('button', { class: 'btn mute', title: 'Klik: mute efter mute-funktion · Skift+klik: mute alt' });
    muteBtn.addEventListener('click', (e) => {
      const st = fs().mute_state;
      conn.command('SetFaderMuteState', f, st === 'Unmuted' ? (e.shiftKey ? 'MutedToAll' : 'MutedToX') : 'Unmuted');
    });
    const strip = h('div', { class: 'strip' },
      scribble,
      selectBox(binder, { options: CHANNELS.map((c) => [c, CHANNEL_LABEL[c]]), get: () => fs().channel, set: (v) => conn.command('SetFader', f, v) }),
      h('div', { class: 'fader-row' },
        verticalFader(binder, {
          get: () => m().levels.volumes[fs().channel],
          set: (v) => conn.command('SetVolume', fs().channel, v),
          colours: () => m().lighting?.faders?.[f]?.colours,
          style: () => m().lighting?.faders?.[f]?.style,
        }),
        vuMeter(vus, f)),
      pctEl,
      muteBtn,
      selectBox(binder, { options: Object.entries(MUTE_FN_LABEL), get: () => fs().mute_type, set: (v) => conn.command('SetFaderMuteFunction', f, v) }),
    );
    binder.add(() => {
      const st = fs();
      const c = m().lighting?.faders?.[f]?.colours;
      if (c) { strip.style.setProperty('--c1', `#${c.colour_one.slice(0, 6)}`); strip.style.setProperty('--c2', `#${c.colour_two.slice(0, 6)}`); }
      pctEl.textContent = pct(m().levels.volumes[st.channel]);
      const muted = st.mute_state !== 'Unmuted';
      strip.classList.toggle('muted', muted);
      muteBtn.classList.toggle('on', muted);
      muteBtn.textContent = st.mute_state === 'MutedToAll' ? 'Mutet (alt)' : muted ? `Mutet → ${MUTE_FN_LABEL[st.mute_type] || st.mute_type}` : 'Mute';
      if (document.activeElement !== scribble) scribble.value = st.scribble?.bottom_text || CHANNEL_LABEL[st.channel];
    });
    strips.append(strip);
  }
  root.append(strips);

  const chans = h('div', { class: 'card chan-list' }, h('h2', {}, 'Alle kanaler'));
  for (const c of CHANNELS) {
    chans.append(slider(binder, { label: CHANNEL_LABEL[c], min: 0, max: 255, get: () => m().levels.volumes[c], set: (v) => conn.command('SetVolume', c, v), fmt: pct }));
  }

  const meterBar = h('div');
  const meterVal = h('span', { class: 'val' }, '—');
  ctx.onMicLevel = (db) => {
    micDb = db;
    const p = db == null ? 0 : Math.max(0, (db + 72.2) / 72.2) * 100;
    meterBar.style.width = `${p}%`;
    meterVal.textContent = db == null ? '—' : `${db.toFixed(0)} dB`;
  };
  const cough = h('button', { class: 'btn danger' });
  cough.addEventListener('click', () => conn.command('SetCoughMuteState', m().cough_button.state === 'Unmuted' ? 'MutedToX' : 'Unmuted'));
  binder.add(() => {
    const st = m().cough_button.state;
    cough.classList.toggle('on', st !== 'Unmuted');
    cough.textContent = st === 'Unmuted' ? 'Mikrofon tændt' : 'Mikrofon mutet';
  });

  const micCard = h('div', { class: 'card' },
    h('h2', {}, 'Mikrofon'),
    h('div', { class: 'row' }, h('label', {}, 'Niveau'), h('div', { class: 'meter' }, meterBar), meterVal),
    h('div', { class: 'row' }, h('label', {}, 'Cough / mute'), cough),
    slider(binder, { label: 'Bleep-niveau', min: -34, max: 0, get: () => m().levels.bleep, set: (v) => conn.command('SetSwearButtonVolume', v), fmt: (v) => `${v} dB` }),
    h('div', { class: 'row' }, h('label', {}, 'Jeg hører'),
      segmented(binder, {
        options: ['Headphones', 'BroadcastMix', 'ChatMic', 'LineOut'].map((o) => [o, OUTPUT_LABEL[o]]),
        get: () => m().levels.output_monitor,
        set: (v) => conn.command('SetMonitorMix', v),
      })),
    h('div', { class: 'hint' }, 'Vælg hvilket mix du lytter til i hovedtelefonerne – fx præcis det, streamen hører.'),
  );

  root.append(h('div', { class: 'grid cols-2' }, h('div', { class: 'grid' }, chans, startLevelsCard(ctx)), h('div', { class: 'grid' }, micCard, duckingCard(ctx), submixCard(ctx))));
  return root;
}

function submixCard(ctx) {
  const { conn, binder } = ctx;
  const m = () => conn.mixer;
  const card = h('div', { class: 'card' }, h('h2', {}, 'Submix (Mix B)'));
  const body = h('div');
  card.append(body);
  let built = false;
  binder.add(() => {
    const lv = m().levels;
    card.style.display = lv.submix_supported ? '' : 'none';
    if (!lv.submix_supported || built) return;
    built = true;
    body.append(
      toggle(binder, { label: 'Submix aktiv', get: () => !!m().levels.submix, set: (v) => conn.command('SetSubMixEnabled', v) }),
      h('div', { class: 'hint' }, 'Separate niveauer til stream-mixet, så du kan have musik højt i ørerne og lavt på streamen.'),
      ...['Mic', 'Game', 'Chat', 'Music', 'System', 'Console', 'LineIn', 'Sample'].map((c) =>
        slider(binder, { label: CHANNEL_LABEL[c], min: 0, max: 255, get: () => m().levels.submix?.inputs?.[c]?.volume, set: (v) => conn.command('SetSubMixVolume', c, v), fmt: pct })),
    );
  });
  return card;
}

function duckingCard(ctx) {
  const { binder, ducker } = ctx;
  const s = ducker.settings;
  const save = () => ducker.save();
  const targets = h('div', { class: 'fx-toggle' });
  for (const c of ['Music', 'Game', 'System', 'Console', 'Sample']) {
    const b = h('button', { class: 'btn sm', onclick: () => { s.targets = s.targets.includes(c) ? s.targets.filter((x) => x !== c) : [...s.targets, c]; save(); binder.run(); } }, CHANNEL_LABEL[c]);
    binder.add(() => b.classList.toggle('on', s.targets.includes(c)));
    targets.append(b);
  }
  const state = h('span', { class: 'badge' });
  binder.add(() => {
    state.textContent = !s.enabled ? 'Slået fra' : ducker.active ? 'Ducker nu' : 'Lytter';
    state.className = `badge ${s.enabled ? (ducker.active ? 'warn' : 'ok') : ''}`;
  });
  return h('div', { class: 'card' },
    h('h2', {}, 'Auto-ducking', state),
    toggle(binder, { label: 'Sænk lyd når jeg taler', get: () => s.enabled, set: (v) => { s.enabled = v; save(); binder.run(); } }),
    h('div', { class: 'row' }, h('label', {}, 'Kanaler'), targets),
    slider(binder, { label: 'Sænk med', min: 10, max: 90, get: () => s.amount, set: (v) => { s.amount = v; save(); }, fmt: (v) => `${v} %` }),
    slider(binder, { label: 'Tærskel', min: -60, max: -10, get: () => s.threshold, set: (v) => { s.threshold = v; save(); }, fmt: (v) => `${v} dB` }),
    slider(binder, { label: 'Hold', min: 200, max: 3000, step: 100, get: () => s.hold, set: (v) => { s.hold = v; save(); }, fmt: (v) => `${(v / 1000).toFixed(1)} s` }),
  );
}

export function quickSwitchCard(ctx) {
  const card = h('div', { class: 'card' });
  const outRow = h('div', { class: 'fx-toggle' });
  const inRow = h('div', { class: 'fx-toggle' });
  const render = async () => {
    let devices;
    try { devices = await listAudioDevices(); } catch (e) { toast(`Lydenheder: ${e}`); return; }
    const pins = ctx.prefs.pinnedDevices;
    const pick = (flow) => {
      const all = devices.filter((d) => d.flow === flow);
      const pinned = all.filter((d) => pins.includes(d.id));
      return pinned.length ? pinned : all;
    };
    const btn = (d) => h('button', {
      class: `btn ${d.default ? 'on' : ''}`,
      title: d.name,
      onclick: async () => {
        try { await setDefaultDevice(d.id, 'all'); render(); } catch (e) { toast(`Kunne ikke skifte: ${e}`); }
      },
    }, shortName(d.name));
    outRow.replaceChildren(...pick('render').map(btn));
    inRow.replaceChildren(...pick('capture').map(btn));
  };
  ctx.refreshDevices = render;
  card.append(
    h('h2', {}, 'Hurtigskift af Windows-lyd', h('button', { class: 'btn sm', onclick: () => ctx.navigate('devices') }, 'Tilpas')),
    h('div', { class: 'row' }, h('label', {}, 'Udgang'), outRow),
    h('div', { class: 'row' }, h('label', {}, 'Mikrofon'), inRow),
  );
  render();
  return card;
}

export function shortName(name) {
  const m = name.match(/^(.*?)\s*\((.*)\)$/);
  if (!m) return name;
  return /goxlr/i.test(m[2]) ? `${m[1]} · GoXLR` : m[1];
}

export function routingView(ctx) {
  const { conn, binder } = ctx;
  const m = () => conn.mixer;
  const table = h('table', { class: 'matrix' });
  const outs = () => OUTPUTS.concat(m().router?.Microphone?.StreamMix2 != null ? ['StreamMix2'] : []);
  const head = h('tr', {}, h('th'), ...outs().map((o) => h('th', {}, OUTPUT_LABEL[o])));
  table.append(head);
  for (const i of INPUTS) {
    const tr = h('tr', {}, h('th', { class: 'in' }, INPUT_LABEL[i]));
    for (const o of outs()) {
      const cell = h('button', { class: 'cell', title: `${INPUT_LABEL[i]} → ${OUTPUT_LABEL[o]}` });
      cell.addEventListener('click', () => conn.command('SetRouter', i, o, !m().router[i][o]));
      binder.add(() => cell.classList.toggle('on', !!m().router?.[i]?.[o]));
      tr.append(h('td', {}, cell));
    }
    table.append(tr);
  }
  return h('div', { class: 'grid' },
    h('div', { class: 'card' }, h('h2', {}, 'Routing-matrix'), h('div', { style: { overflowX: 'auto' } }, table),
      h('div', { class: 'hint' }, 'Klik for at sende en kilde til et mix. Ændringer gemmes i den aktive GoXLR-profil, når du gemmer den.')),
  );
}

export function devicesView(ctx) {
  const list = h('div', { class: 'grid cols-2' });
  const render = async () => {
    let devices;
    try { devices = await listAudioDevices(); } catch (e) { list.replaceChildren(h('div', { class: 'card' }, `Kunne ikke hente lydenheder: ${e}`)); return; }
    const section = (flow, title) => {
      const card = h('div', { class: 'card' }, h('h2', {}, title));
      const l = h('div', { class: 'list' });
      for (const d of devices.filter((x) => x.flow === flow)) {
        const pinned = ctx.prefs.pinnedDevices.includes(d.id);
        l.append(h('div', { class: `item ${d.default ? 'active' : ''}` },
          h('div', {}, h('div', {}, d.name),
            h('div', { class: 'hint' }, [d.default && 'Standard', d.default_comm && 'Kommunikation'].filter(Boolean).join(' · ') || ' ')),
          h('div', { class: 'spacer' }),
          // Mindre fejl 7: clear feedback – the button shows a pin and a message says where it shows up.
          h('button', { class: `btn sm ${pinned ? 'on' : ''}`, 'data-testid': 'device-pin', title: pinned ? 'Fjern fra hurtigskift på Mixer-siden' : 'Vis som hurtigknap øverst på Mixer-siden', onclick: () => {
            ctx.prefs.pinnedDevices = pinned ? ctx.prefs.pinnedDevices.filter((x) => x !== d.id) : [...ctx.prefs.pinnedDevices, d.id];
            ctx.savePrefs(); render();
            toast(pinned ? `${shortName(d.name)} er fjernet fra hurtigskift` : `${shortName(d.name)} vises nu som hurtigknap øverst på Mixer-siden`, 'info');
          } }, pinned ? '📌 Fastgjort' : 'Fastgør'),
          h('button', { class: 'btn sm', 'data-testid': 'device-default', onclick: async () => { await setDefaultDevice(d.id, 'console'); render(); toast(`${shortName(d.name)} er nu Windows-standard`, 'info'); } }, 'Standard'),
          h('button', { class: 'btn sm', 'data-testid': 'device-comm', onclick: async () => { await setDefaultDevice(d.id, 'comm'); render(); toast(`${shortName(d.name)} bruges nu til kommunikation`, 'info'); } }, 'Kommunikation'),
        ));
      }
      card.append(l);
      return card;
    };
    list.replaceChildren(section('render', 'Udgange'), section('capture', 'Indgange / mikrofoner'));
  };
  render();
  return h('div', { class: 'grid' },
    h('div', { class: 'hint' }, 'Fastgjorte enheder vises som hurtigknapper på Mixer-siden og kan bruges i scener. "Standard" bruges af spil og musik, "Kommunikation" af Discord/Teams.'),
    list,
    deviceTriggersCard(ctx));
}
