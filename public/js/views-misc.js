import { h, slider, selectBox, toggle, toast, segmented, confirmDialog, promptDialog, logActivity, infoDialog } from './ui.js';
import { CHANNELS } from './demo.js';
import { CHANNEL_LABEL, shortName } from './views-mixer.js';
import { listAudioDevices, setDefaultDevice, storeSet, isNative, historySnapshot, historyList, historyRestore, setAutostart } from './native.js';
import { prettyAccel } from './views-hotkeys.js';
import { resolveDevice } from './extras.js';
import { systemSettings } from './views-system.js';

const STYLE_LABELS = {
  reverb: ['Library', 'DarkBloom', 'MusicClub', 'RealPlate', 'Chapel', 'HockeyArena'],
  echo: ['Quarter', 'Eighth', 'Triplet', 'PingPong', 'ClassicSlap', 'MultiTap'],
  pitch: ['Narrow', 'Wide'],
  gender: ['Narrow', 'Medium', 'Wide'],
  megaphone: ['Megaphone', 'Radio', 'OnThePhone', 'Overdrive', 'BuzzCutt', 'Tweed'],
  robot: ['Robot1', 'Robot2', 'Robot3'],
  hard_tune: ['Natural', 'Medium', 'Hard'],
};
const STYLE_CMD = { reverb: 'SetReverbStyle', echo: 'SetEchoStyle', pitch: 'SetPitchStyle', gender: 'SetGenderStyle', megaphone: 'SetMegaphoneStyle', robot: 'SetRobotStyle', hard_tune: 'SetHardTuneStyle' };
const pretty = (s) => s.replace(/([a-z])([A-Z0-9])/g, '$1 $2');

export function effectsView(ctx) {
  const { conn, binder } = ctx;
  const m = () => conn.mixer;
  if (!m().effects) {
    return h('div', { class: 'card' }, 'Effekter findes kun på den store GoXLR – GoXLR Mini har ingen effektsektion.');
  }
  const fx = () => m().effects;
  const cur = () => fx().current;

  const presets = h('div', { class: 'preset-grid' });
  for (let i = 1; i <= 6; i++) {
    const key = `Preset${i}`;
    const b = h('button', { class: 'btn', onclick: () => conn.command('SetActiveEffectPreset', key) });
    binder.add(() => { b.textContent = fx().preset_names?.[key] || `Preset ${i}`; b.classList.toggle('on', fx().active_preset === key); });
    presets.append(b);
  }
  const toggles = h('div', { class: 'fx-toggle' });
  for (const [label, cmd, get] of [
    ['Effekter', 'SetFXEnabled', () => fx().is_enabled],
    ['Megafon', 'SetMegaphoneEnabled', () => cur().megaphone.is_enabled],
    ['Robot', 'SetRobotEnabled', () => cur().robot.is_enabled],
    ['Hard Tune', 'SetHardTuneEnabled', () => cur().hard_tune.is_enabled],
  ]) {
    const b = h('button', { class: 'btn', onclick: () => conn.command(cmd, !get()) }, label);
    binder.add(() => b.classList.toggle('on', !!get()));
    toggles.append(b);
  }

  // Every setting GoXLR Utility has; the less used ones under "Avanceret" (ranges as the engine checks them).
  const fxCard = (key, title, sliders, advanced = []) => h('div', { class: 'card' },
    h('h2', {}, title, selectBox(binder, { options: STYLE_LABELS[key].map((s) => [s, pretty(s)]), get: () => cur()[key].style, set: (v) => conn.command(STYLE_CMD[key], v) })),
    ...sliders,
    advanced.length ? h('details', { class: 'fx-advanced', 'data-testid': `fx-advanced-${key}` }, h('summary', {}, 'Avanceret'), ...advanced) : null);
  const sl = (label, min, max, get, cmd, fmt = (v) => `${v}`, step = 1) => slider(binder, { label, min, max, step, get, set: (v) => conn.command(...(Array.isArray(cmd) ? [...cmd, v] : [cmd, v])), fmt });
  const db = (v) => `${v} dB`;
  const msF = (v) => `${v} ms`;
  const pctF = (v) => `${v} %`;
  const presetFiles = selectBox(binder, { options: [], get: () => '', set: () => {} });
  binder.add(() => {
    const names = conn.status.files?.presets || [];
    if (presetFiles.options.length !== names.length + 1) presetFiles.replaceChildren(h('option', { value: '' }, '— vælg fil —'), ...names.map((n) => h('option', { value: n }, n)));
  });

  return h('div', { class: 'grid' },
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Effekt-preset', h('button', { class: 'btn sm', onclick: () => conn.command('SaveActivePreset') }, 'Gem preset')), presets,
        h('div', { class: 'row' }, h('label', {}, 'Omdøb'), (() => {
          const inp = h('input', { type: 'text', maxlength: 24, placeholder: 'Nyt navn' });
          inp.addEventListener('change', () => { if (inp.value) conn.command('RenameActivePreset', inp.value); inp.value = ''; });
          return inp;
        })()),
        h('div', { class: 'row' }, h('label', {}, 'Fra fil'), presetFiles,
          h('button', { class: 'btn sm', 'data-testid': 'fx-load-preset', onclick: () => { if (presetFiles.value) { conn.command('LoadEffectPreset', presetFiles.value); toast(`Effekt-preset "${presetFiles.value}" indlæst i den aktive plads`, 'info'); } } }, 'Indlæs')),
        h('div', { class: 'hint' }, 'Effekt-presets (.preset) fra GoXLR’ens preset-mappe indlæses i den valgte plads.')),
      h('div', { class: 'card' }, h('h2', {}, 'Til/fra'), toggles,
        toggle(binder, { label: 'Hør effekter i hovedtelefoner', get: () => m().settings.enable_monitor_with_fx, set: (v) => conn.command('SetMonitorWithFx', v) }))),
    h('div', { class: 'grid cols-3' },
      fxCard('reverb', 'Reverb', [
        slider(binder, { label: 'Mængde', min: 0, max: 100, get: () => cur().reverb.amount, set: (v) => conn.command('SetReverbAmount', v), fmt: (v) => `${v} %` }),
        slider(binder, { label: 'Decay', min: 10, max: 10000, step: 10, get: () => cur().reverb.decay, set: (v) => conn.command('SetReverbDecay', v), fmt: (v) => `${v} ms` }),
      ], [
        sl('Pre-delay', 0, 100, () => cur().reverb.pre_delay, 'SetReverbPreDelay', msF),
        sl('Tidlige refleksioner', -25, 0, () => cur().reverb.early_level, 'SetReverbEarlyLevel', db),
        sl('Hale', -25, 0, () => cur().reverb.tail_level, 'SetReverbTailLevel', db),
        sl('Bas-farve', -50, 50, () => cur().reverb.lo_colour, 'SetReverbLowColour'),
        sl('Diskant-farve', -50, 50, () => cur().reverb.hi_colour, 'SetReverbHighColour'),
        sl('Diskant-dæmpning', -25, 25, () => cur().reverb.hi_factor, 'SetReverbHighFactor'),
        sl('Diffusion', -50, 50, () => cur().reverb.diffuse, 'SetReverbDiffuse'),
        sl('Modulation (hastighed)', -25, 25, () => cur().reverb.mod_speed, 'SetReverbModSpeed'),
        sl('Modulation (dybde)', -25, 25, () => cur().reverb.mod_depth, 'SetReverbModDepth'),
      ]),
      fxCard('echo', 'Echo', [
        slider(binder, { label: 'Mængde', min: 0, max: 100, get: () => cur().echo.amount, set: (v) => conn.command('SetEchoAmount', v), fmt: (v) => `${v} %` }),
        slider(binder, { label: 'Feedback', min: 0, max: 100, get: () => cur().echo.feedback, set: (v) => conn.command('SetEchoFeedback', v), fmt: (v) => `${v} %` }),
        slider(binder, { label: 'Tempo', min: 45, max: 300, get: () => cur().echo.tempo, set: (v) => conn.command('SetEchoTempo', v), fmt: (v) => `${v} BPM` }),
      ], [
        sl('Forsinkelse venstre', 0, 2500, () => cur().echo.delay_left, 'SetEchoDelayLeft', msF, 10),
        sl('Forsinkelse højre', 0, 2500, () => cur().echo.delay_right, 'SetEchoDelayRight', msF, 10),
        sl('Feedback venstre', 0, 100, () => cur().echo.feedback_left, 'SetEchoFeedbackLeft', pctF),
        sl('Feedback højre', 0, 100, () => cur().echo.feedback_right, 'SetEchoFeedbackRight', pctF),
        sl('Venstre → højre', 0, 100, () => cur().echo.feedback_xfb_l_to_r, 'SetEchoFeedbackXFBLtoR', pctF),
        sl('Højre → venstre', 0, 100, () => cur().echo.feedback_xfb_r_to_l, 'SetEchoFeedbackXFBRtoL', pctF),
      ]),
      fxCard('pitch', 'Pitch', [
        slider(binder, { label: 'Mængde', min: -24, max: 24, get: () => cur().pitch.amount, set: (v) => conn.command('SetPitchAmount', v), fmt: (v) => `${v}` }),
        slider(binder, { label: 'Karakter', min: 0, max: 100, get: () => cur().pitch.character, set: (v) => conn.command('SetPitchCharacter', v), fmt: (v) => `${v} %` }),
      ]),
      fxCard('gender', 'Gender', [
        slider(binder, { label: 'Mængde', min: -24, max: 24, get: () => cur().gender.amount, set: (v) => conn.command('SetGenderAmount', v), fmt: (v) => `${v}` }),
      ]),
      fxCard('megaphone', 'Megafon', [
        slider(binder, { label: 'Mængde', min: 0, max: 100, get: () => cur().megaphone.amount, set: (v) => conn.command('SetMegaphoneAmount', v), fmt: (v) => `${v} %` }),
      ], [
        sl('Gain efter', -20, 20, () => cur().megaphone.post_gain, 'SetMegaphonePostGain', db),
      ]),
      fxCard('robot', 'Robot', [
        sl('Tørt signal', -36, 0, () => cur().robot.dry_mix, 'SetRobotDryMix', db),
        sl('Tærskel', -36, 0, () => cur().robot.threshold, 'SetRobotThreshold', db),
      ], [
        sl('Bølgeform', 0, 2, () => cur().robot.waveform, 'SetRobotWaveform'),
        sl('Pulsbredde', 0, 100, () => cur().robot.pulse_width, 'SetRobotPulseWidth', pctF),
        ...[['Low', 'low', 'Lav', 0, 88], ['Medium', 'mid', 'Mellem', 86, 184], ['High', 'high', 'Høj', 182, 240]].flatMap(([range, k, label, f0, f1]) => [
          sl(`${label}: gain`, -12, 12, () => cur().robot[`${k}_gain`], ['SetRobotGain', range], db),
          sl(`${label}: frekvens`, f0, f1, () => cur().robot[`${k}_freq`], ['SetRobotFreq', range]),
          sl(`${label}: bredde`, 0, 32, () => cur().robot[`${k}_width`], ['SetRobotWidth', range]),
        ]),
      ]),
      fxCard('hard_tune', 'Hard Tune', [
        slider(binder, { label: 'Mængde', min: 0, max: 100, get: () => cur().hard_tune.amount, set: (v) => conn.command('SetHardTuneAmount', v), fmt: (v) => `${v} %` }),
        slider(binder, { label: 'Rate', min: 0, max: 100, get: () => cur().hard_tune.rate, set: (v) => conn.command('SetHardTuneRate', v), fmt: (v) => `${v} %` }),
      ], [
        sl('Vindue', 0, 600, () => cur().hard_tune.window, 'SetHardTuneWindow', msF),
        h('div', { class: 'row' }, h('label', {}, 'Stemmer efter'), selectBox(binder, { options: [['All', 'Alt'], ['Music', 'Musik'], ['Game', 'Spil'], ['LineIn', 'Line in'], ['System', 'System']], get: () => cur().hard_tune.source, set: (v) => conn.command('SetHardTuneSource', v) })),
      ]),
    ));
}

// ---------- Scenes ----------
export async function captureScene(ctx, name, opts) {
  const m = ctx.conn.mixer;
  const scene = { id: crypto.randomUUID(), name, color: opts.color || '#22d3ee', parts: opts.parts };
  if (opts.parts.profile) { scene.profile_name = m.profile_name; scene.mic_profile_name = m.mic_profile_name; }
  if (opts.parts.volumes) scene.volumes = { ...m.levels.volumes };
  if (opts.parts.mutes) scene.mutes = Object.fromEntries(['A', 'B', 'C', 'D'].map((f) => [f, m.fader_status[f].mute_state]));
  if (opts.parts.routing) scene.router = structuredClone(m.router);
  if (opts.parts.monitor) scene.monitor = m.levels.output_monitor;
  if (opts.parts.devices) {
    const devs = await listAudioDevices().catch(() => []);
    const out = devs.find((d) => d.flow === 'render' && d.default);
    const inp = devs.find((d) => d.flow === 'capture' && d.default);
    scene.output = out?.id || null;
    scene.input = inp?.id || null;
    // Names let the scene find the devices again after a driver update changes their ids.
    scene.output_name = out?.name || null;
    scene.input_name = inp?.name || null;
  }
  if (opts.parts.eq) scene.eqSlot = structuredClone(ctx.outputEq.slots[ctx.outputEq.active]);
  if (opts.parts.lighting) scene.lighting = structuredClone(m.lighting);
  return scene;
}

// Resolves true once pred(mixer) holds, false after the timeout.
function waitFor(conn, pred, ms = 3000) {
  return new Promise((resolve) => {
    if (conn.mixer && pred(conn.mixer)) { resolve(true); return; }
    const done = (ok) => { clearTimeout(timer); conn.removeEventListener('change', on); resolve(ok); };
    const on = () => { if (conn.mixer && pred(conn.mixer)) done(true); };
    const timer = setTimeout(() => done(false), ms);
    conn.addEventListener('change', on);
  });
}

export async function applyScene(ctx, scene) {
  const { conn } = ctx;
  if (!conn.mixer) return;
  // Profiles replace most of the mixer state, so load them first and then layer the rest on top.
  let unsure = false;
  if (scene.profile_name && conn.mixer.profile_name !== scene.profile_name) {
    await conn.command('LoadProfile', scene.profile_name, true);
    unsure = !(await waitFor(conn, (mx) => mx.profile_name === scene.profile_name));
  }
  if (scene.mic_profile_name && conn.mixer.mic_profile_name !== scene.mic_profile_name) {
    await conn.command('LoadMicProfile', scene.mic_profile_name, true);
    unsure = !(await waitFor(conn, (mx) => mx.mic_profile_name === scene.mic_profile_name)) || unsure;
  }
  // Give the daemon a moment to stream the rest of the new profile's state.
  if (scene.profile_name || scene.mic_profile_name) await new Promise((r) => setTimeout(r, 150));
  const m = conn.mixer;
  // If the daemon never confirmed the load, the local state may be stale: send everything.
  const differs = (a, b) => unsure || a !== b;
  const jobs = [];
  if (scene.volumes) for (const [c, v] of Object.entries(scene.volumes)) if (differs(m.levels.volumes[c], v)) jobs.push(conn.command('SetVolume', c, v));
  if (scene.mutes) for (const [f, s] of Object.entries(scene.mutes)) if (differs(m.fader_status[f].mute_state, s)) jobs.push(conn.command('SetFaderMuteState', f, s));
  if (scene.router) for (const [i, outs] of Object.entries(scene.router)) for (const [o, on] of Object.entries(outs)) if (differs(m.router[i]?.[o], on)) jobs.push(conn.command('SetRouter', i, o, on));
  if (scene.monitor && differs(m.levels.output_monitor, scene.monitor)) jobs.push(conn.command('SetMonitorMix', scene.monitor));
  if (scene.output || scene.input) {
    const devs = await listAudioDevices().catch(() => []);
    for (const [key, flow, label] of [['output', 'render', 'Udgang'], ['input', 'capture', 'Mikrofon']]) {
      if (!scene[key]) continue;
      const id = resolveDevice(devs, scene[key], scene[`${key}_name`], flow);
      if (!id) { toast(`${label} i scenen "${scene.name}" findes ikke længere`); continue; }
      if (id !== scene[key]) { scene[key] = id; ctx.saveScenes?.(); }
      jobs.push(setDefaultDevice(id, 'all').catch((e) => toast(`${label}: ${e}`)));
    }
  }
  if (scene.lighting) jobs.push(...applyLighting(conn, scene.lighting));
  if (scene.eqSlot) {
    logActivity(`EQ ændret af scenen "${scene.name}"`);
    ctx.outputEq.slots[ctx.outputEq.active] = structuredClone(scene.eqSlot);
    storeSet('output-eq', ctx.outputEq);
    ctx.applyOutputEq?.();
    ctx.onStateChanged?.('eq');
  }
  await Promise.all(jobs);
  ctx.refreshDevices?.();
  if (ctx.notify) ctx.notify(`Scene: ${scene.name}`); else toast(`Scene: ${scene.name}`, 'info');
}

export function scenesView(ctx) {
  const list = h('div', { class: 'grid cols-3' });
  const render = () => {
    list.replaceChildren(...ctx.scenes.map((s, idx) => h('div', { class: 'card', style: { borderTop: `3px solid ${s.color}` } },
      h('h2', {}, h('span', { style: { color: 'var(--text)', textTransform: 'none', letterSpacing: 0, fontSize: '16px' } }, s.name), sceneKey(ctx, s)),
      h('div', { class: 'hint' }, Object.entries(s.parts).filter(([, v]) => v).map(([k]) => (k === 'profile' && s.profile_name ? `Profil: ${s.profile_name}${s.mic_profile_name ? ` / ${s.mic_profile_name}` : ''}` : PART_LABEL[k])).join(' · ')),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => applyScene(ctx, s) }, 'Aktivér'),
        h('button', { class: 'btn sm', onclick: async () => { const n = await captureScene(ctx, s.name, { color: s.color, parts: s.parts }); ctx.scenes[idx] = { ...n, id: s.id }; ctx.saveScenes(); render(); toast('Scene opdateret', 'info'); } }, 'Overskriv med nu'),
        h('button', { class: 'btn sm', 'data-testid': 'scene-delete', onclick: async () => {
          if (!(await confirmDialog(`Slet "${s.name}"?`, { ok: 'Slet', danger: true }))) return;
          ctx.scenes.splice(idx, 1);
          const before = ctx.hotkeys.length;
          ctx.hotkeys = ctx.hotkeys.filter((b) => b.action !== `scene:${s.id}`);
          if (ctx.hotkeys.length !== before) ctx.saveHotkeys();
          ctx.saveScenes(); render();
        } }, 'Slet')))));
    if (!ctx.scenes.length) list.append(h('div', { class: 'card hint' }, 'Ingen scener endnu. Indstil lyden som du vil have den – fx "Gaming", "Stream" eller "Film" – og gem den som scene.'));
  };
  const name = h('input', { type: 'text', placeholder: 'Navn, fx Gaming' });
  const color = h('input', { type: 'color', value: '#22d3ee' });
  const parts = { profile: false, volumes: true, mutes: true, routing: false, monitor: true, devices: true, eq: false, lighting: false };
  const partBtns = h('div', { class: 'fx-toggle' }, Object.keys(parts).map((k) => {
    const b = h('button', { class: `btn sm ${parts[k] ? 'on' : ''}`, onclick: () => { parts[k] = !parts[k]; b.classList.toggle('on', parts[k]); } }, PART_LABEL[k]);
    return b;
  }));
  const create = h('div', { class: 'card' }, h('h2', {}, 'Ny scene fra nuværende indstillinger'),
    h('div', { class: 'row color-row' }, name, color, h('button', { class: 'btn primary', onclick: async () => {
      if (!name.value.trim()) { name.focus(); return; }
      const scene = await captureScene(ctx, name.value.trim(), { color: color.value, parts: { ...parts } });
      ctx.scenes.push(scene);
      // Give new scenes the next free Ctrl+Alt+digit, like before shortcuts became configurable.
      const free = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Ctrl+Alt+${n}`).find((a) => !ctx.hotkeys.some((b) => b.accel === a));
      if (free) { ctx.hotkeys.push({ id: crypto.randomUUID(), accel: free, action: `scene:${scene.id}` }); ctx.saveHotkeys(); }
      ctx.saveScenes(); name.value = ''; render();
    } }, 'Gem scene')),
    h('div', { class: 'row' }, h('label', {}, 'Medtag'), partBtns),
    h('div', { class: 'hint' }, 'Nye scener får automatisk en ledig Ctrl+Alt+1…9. ',
      isNative() ? 'Genvejene virker overalt i Windows (også i spil), og scenerne ligger også i bakke-menuen. ' : '',
      h('a', { href: '#', onclick: (e) => { e.preventDefault(); ctx.navigate('hotkeys'); } }, 'Ret genveje')));
  render();
  return h('div', { class: 'grid' }, create, list);
}
function sceneKey(ctx, s) {
  const k = ctx.hotkeyFor?.(`scene:${s.id}`);
  return h('span', { class: 'badge' }, k ? prettyAccel(k) : 'Ingen genvej');
}
const PART_LABEL = { profile: 'GoXLR-profil', volumes: 'Volumer', mutes: 'Mute', routing: 'Routing', monitor: 'Monitor-mix', devices: 'Windows-enheder', eq: 'Afspilnings-EQ', lighting: 'Lys' };

function applyLighting(conn, L) {
  const cur = conn.mixer.lighting;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const jobs = [];
  const cmd = (...a) => jobs.push(conn.command(...a));
  if (L.animation?.supported && !same(L.animation, cur.animation)) {
    cmd('SetAnimationMode', L.animation.mode); cmd('SetAnimationMod1', L.animation.mod1); cmd('SetAnimationMod2', L.animation.mod2); cmd('SetAnimationWaterfall', L.animation.waterfall_direction);
  }
  for (const [t, v] of Object.entries(L.simple || {})) if (!same(v, cur.simple?.[t])) cmd(t === 'Global' ? 'SetGlobalColour' : 'SetSimpleColour', ...(t === 'Global' ? [v.colour_one] : [t, v.colour_one]));
  for (const [f, v] of Object.entries(L.faders || {})) {
    if (!same(v.colours, cur.faders?.[f]?.colours)) cmd('SetFaderColours', f, v.colours.colour_one, v.colours.colour_two);
    if (v.style !== cur.faders?.[f]?.style) cmd('SetFaderDisplayStyle', f, v.style);
  }
  for (const [b, v] of Object.entries(L.buttons || {})) {
    if (!same(v.colours, cur.buttons?.[b]?.colours)) cmd('SetButtonColours', b, v.colours.colour_one, v.colours.colour_two);
    if (v.off_style !== cur.buttons?.[b]?.off_style) cmd('SetButtonOffStyle', b, v.off_style);
  }
  for (const [e, v] of Object.entries(L.encoders || {})) if (!same(v, cur.encoders?.[e])) cmd('SetEncoderColour', e, v.colour_one, v.colour_two, v.colour_three);
  for (const [t, v] of Object.entries(L.sampler || {})) {
    if (!same(v.colours, cur.sampler?.[t]?.colours)) cmd('SetSampleColour', t, v.colours.colour_one, v.colours.colour_two, v.colours.colour_three);
    if (v.off_style !== cur.sampler?.[t]?.off_style) cmd('SetSampleOffStyle', t, v.off_style);
  }
  return jobs;
}

// ---------- Lighting ----------
const BUTTON_ROWS = [
  ['Fader1Mute', 'Fader2Mute', 'Fader3Mute', 'Fader4Mute', 'Bleep', 'Cough'],
  ['EffectSelect1', 'EffectSelect2', 'EffectSelect3', 'EffectSelect4', 'EffectSelect5', 'EffectSelect6'],
  ['EffectFx', 'EffectMegaphone', 'EffectRobot', 'EffectHardTune'],
  ['SamplerSelectA', 'SamplerSelectB', 'SamplerSelectC', 'SamplerClear'],
  ['SamplerTopLeft', 'SamplerTopRight', 'SamplerBottomLeft', 'SamplerBottomRight'],
];
const BUTTON_LABEL = {
  Fader1Mute: 'Mute 1', Fader2Mute: 'Mute 2', Fader3Mute: 'Mute 3', Fader4Mute: 'Mute 4', Bleep: 'Bleep', Cough: 'Cough',
  EffectSelect1: 'FX 1', EffectSelect2: 'FX 2', EffectSelect3: 'FX 3', EffectSelect4: 'FX 4', EffectSelect5: 'FX 5', EffectSelect6: 'FX 6',
  EffectFx: 'FX', EffectMegaphone: 'Megafon', EffectRobot: 'Robot', EffectHardTune: 'Hard Tune',
  SamplerSelectA: 'Bank A', SamplerSelectB: 'Bank B', SamplerSelectC: 'Bank C', SamplerClear: 'Clear',
  SamplerTopLeft: 'Sample 1', SamplerTopRight: 'Sample 2', SamplerBottomLeft: 'Sample 3', SamplerBottomRight: 'Sample 4',
};
const OFF_STYLES = [['Dimmed', 'Dæmpet'], ['Colour2', 'Farve 2'], ['DimmedColour2', 'Dæmpet farve 2']];
const THEMES = {
  'Cyan / lilla': ['00E5FF', '8B00FF'], 'Solnedgang': ['FF6A00', 'FF0080'], 'Skov': ['00FF6A', '007A33'],
  'Is': ['FFFFFF', '00A2FF'], 'Rød': ['FF0000', '400000'], 'Guld': ['FFB000', '402800'],
};
const MINI_HIDDEN = /^(Effect|Sampler)/;

export function lightingView(ctx) {
  const { conn, binder } = ctx;
  const m = () => conn.mixer;
  const L = () => m().lighting;
  const isMini = () => m().hardware.device_type === 'Mini';
  const send = (...a) => conn.command(...a);
  const colorInput = (get, set) => {
    const inp = h('input', { type: 'color' });
    let t;
    inp.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => set(inp.value.slice(1).toUpperCase()), 60); });
    binder.add(() => { const v = get(); if (v && document.activeElement !== inp) inp.value = `#${v.slice(0, 6)}`; });
    return inp;
  };

  const animSupported = () => L().animation?.supported;
  const animation = h('div', { class: 'card' }, h('h2', {}, 'Animation'),
    h('div', { class: 'row' }, h('label', {}, 'Tilstand'), segmented(binder, {
      options: [['None', 'Ingen'], ['Simple', 'Simpel'], ['RetroRainbow', 'Retro-regnbue'], ['RainbowBright', 'Regnbue lys'], ['RainbowDark', 'Regnbue mørk'], ['Ripple', 'Ripple']],
      get: () => L().animation?.mode, set: (v) => send('SetAnimationMode', v),
    })),
    slider(binder, { label: 'Hastighed / farve', min: 0, max: 255, get: () => L().animation?.mod1, set: (v) => send('SetAnimationMod1', v) }),
    slider(binder, { label: 'Variation', min: 0, max: 255, get: () => L().animation?.mod2, set: (v) => send('SetAnimationMod2', v) }),
    h('div', { class: 'row' }, h('label', {}, 'Vandfald'), segmented(binder, {
      options: [['Down', 'Ned'], ['Up', 'Op'], ['Off', 'Fra']], get: () => L().animation?.waterfall_direction, set: (v) => send('SetAnimationWaterfall', v),
    })));
  binder.add(() => { animation.style.display = animSupported() ? '' : 'none'; });

  const themes = h('div', { class: 'card' }, h('h2', {}, 'Farvetema – hele mixeren'),
    h('div', { class: 'fx-toggle' }, Object.entries(THEMES).map(([name, [c1, c2]]) => h('button', {
      class: 'btn', style: { background: `linear-gradient(90deg, #${c1}55, #${c2}55)` },
      onclick: () => {
        send('SetGlobalColour', c1);
        send('SetAllFaderColours', c1, c2);
        for (const g of ['FaderMute', 'EffectSelector', 'EffectTypes']) send('SetButtonGroupColours', g, c1, c2);
        for (const e of ['Reverb', 'Pitch', 'Echo', 'Gender']) send('SetEncoderColour', e, c2, c1, c1);
        for (const t of ['SamplerSelectA', 'SamplerSelectB', 'SamplerSelectC']) send('SetSampleColour', t, c1, c2, c2);
        for (const t of ['Accent', 'Scribble1', 'Scribble2', 'Scribble3', 'Scribble4']) send('SetSimpleColour', t, c1);
      },
    }, name))),
    h('div', { class: 'row color-row' }, h('label', {}, 'Global farve'), colorInput(() => L().simple?.Global?.colour_one, (v) => send('SetGlobalColour', v)),
      h('label', { style: { minWidth: 0 } }, 'Accent'), colorInput(() => L().simple?.Accent?.colour_one, (v) => send('SetSimpleColour', 'Accent', v))),
    h('div', { class: 'row' }, h('label', {}, 'Fra profil'), (() => {
      const sel = h('select', {}, h('option', { value: '' }, 'Kopiér farver fra profil…'));
      binder.add(() => { const n = conn.status.files?.profiles || []; if (sel.options.length !== n.length + 1) sel.replaceChildren(h('option', { value: '' }, 'Kopiér farver fra profil…'), ...n.map((p) => h('option', { value: p }, p))); });
      sel.addEventListener('change', () => { if (sel.value) send('LoadProfileColours', sel.value); sel.value = ''; });
      return sel;
    })()));

  const faders = h('div', { class: 'grid', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))' } }, ['A', 'B', 'C', 'D'].map((f, i) => {
    const fl = () => L().faders[f];
    return h('div', { class: 'card' }, h('h2', {}, `Fader ${f}`),
      h('div', { class: 'row color-row' }, h('label', {}, 'Top / bund'),
        colorInput(() => fl()?.colours.colour_one, (v) => send('SetFaderColours', f, v, fl().colours.colour_two)),
        colorInput(() => fl()?.colours.colour_two, (v) => send('SetFaderColours', f, fl().colours.colour_one, v)),
        h('label', { style: { minWidth: 0 } }, 'Scribble'),
        colorInput(() => L().simple?.[`Scribble${i + 1}`]?.colour_one, (v) => send('SetSimpleColour', `Scribble${i + 1}`, v))),
      h('div', { class: 'row' }, h('label', {}, 'Stil'), segmented(binder, {
        options: [['Gradient', 'Gradient'], ['Meter', 'Meter'], ['GradientMeter', 'Gradient-meter'], ['TwoColour', 'To farver']],
        get: () => fl()?.style, set: (v) => send('SetFaderDisplayStyle', f, v),
      })));
  }));

  let sel = 'Fader1Mute';
  const board = h('div', { class: 'button-board' });
  const editor = h('div');
  const isSampler = (b) => /^SamplerSelect[ABC]$/.test(b);
  const renderEditor = () => {
    const bl = () => (isSampler(sel) ? L().sampler?.[sel] : L().buttons?.[sel]);
    const c = () => bl()?.colours || {};
    const setC = (one, two) => (isSampler(sel) ? send('SetSampleColour', sel, one, two, c().colour_three || two) : send('SetButtonColours', sel, one, two));
    const group = /^Fader\dMute$/.test(sel) ? 'FaderMute' : /^EffectSelect/.test(sel) ? 'EffectSelector' : /^Effect(Megaphone|Robot|HardTune|Fx)$/.test(sel) ? 'EffectTypes' : null;
    editor.replaceChildren(
      h('div', { class: 'row' }, h('b', {}, BUTTON_LABEL[sel])),
      h('div', { class: 'row color-row' }, h('label', {}, 'Tændt / slukket'),
        colorInput(() => c().colour_one, (v) => setC(v, c().colour_two)),
        colorInput(() => c().colour_two, (v) => setC(c().colour_one, v))),
      h('div', { class: 'row' }, h('label', {}, 'Når slukket'), segmented(binder, {
        options: OFF_STYLES, get: () => bl()?.off_style,
        set: (v) => (isSampler(sel) ? send('SetSampleOffStyle', sel, v) : send('SetButtonOffStyle', sel, v)),
      })),
      group ? h('div', { class: 'row' }, h('label', {}, 'Hele gruppen'),
        h('button', { class: 'btn sm', onclick: () => { send('SetButtonGroupColours', group, c().colour_one, c().colour_two); send('SetButtonGroupOffStyle', group, bl().off_style); } }, 'Brug på alle i gruppen')) : null);
  };
  const tiles = [];
  binder.add(() => {
    if (!tiles.length) {
      for (const row of BUTTON_ROWS) {
        const r = h('div', { class: 'board-row' });
        for (const b of row) {
          const t = h('button', { class: 'tile', 'data-b': b, onclick: () => { sel = b; renderEditor(); binder.run(); } }, BUTTON_LABEL[b]);
          tiles.push(t); r.append(t);
        }
        board.append(r);
      }
      renderEditor();
    }
    for (const t of tiles) {
      const b = t.dataset.b;
      const c = (isSampler(b) ? L().sampler?.[b] : L().buttons?.[b])?.colours;
      t.style.setProperty('--tc', c ? `#${c.colour_one.slice(0, 6)}` : '#334');
      t.classList.toggle('sel', b === sel);
      t.style.display = isMini() && MINI_HIDDEN.test(b) ? 'none' : '';
    }
  });

  const encoders = h('div', { class: 'card' }, h('h2', {}, 'Effekt-knapper (encodere)'),
    ...['Reverb', 'Echo', 'Pitch', 'Gender'].map((e) => {
      const c = () => L().encoders?.[e] || {};
      return h('div', { class: 'row color-row' }, h('label', {}, e),
        colorInput(() => c().colour_one, (v) => send('SetEncoderColour', e, v, c().colour_two, c().colour_three)),
        colorInput(() => c().colour_two, (v) => send('SetEncoderColour', e, c().colour_one, v, c().colour_three)),
        colorInput(() => c().colour_three, (v) => send('SetEncoderColour', e, c().colour_one, c().colour_two, v)),
        h('span', { class: 'hint' }, 'ring · knap · pil'));
    }));
  binder.add(() => { encoders.style.display = isMini() ? 'none' : ''; });

  return h('div', { class: 'grid' },
    h('div', { class: 'grid cols-2' }, themes, animation),
    faders,
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Knapper'), board, h('div', { style: { marginTop: '14px' } }, editor)),
      encoders));
}

// ---------- Profiles ----------
export function profilesView(ctx) {
  const { conn, binder } = ctx;
  const m = () => conn.mixer;
  const list = h('div', { class: 'list' });
  let key = '';
  binder.add(() => {
    const names = conn.status.files?.profiles || [];
    const k = names.join('|') + '#' + m().profile_name;
    if (k === key) return;
    key = k;
    list.replaceChildren(...names.map((n) => h('div', { class: `item ${n === m().profile_name ? 'active' : ''}` },
      h('div', {}, n), h('div', { class: 'spacer' }),
      n === m().profile_name ? h('span', { class: 'badge ok' }, 'Aktiv') : h('button', { class: 'btn sm', onclick: () => conn.command('LoadProfile', n, true) }, 'Indlæs'),
      h('button', { class: 'btn sm', 'data-testid': 'profile-history', title: 'Tidligere versioner af profilen', onclick: () => showHistory(ctx, 'profile', n) }, 'Historik'),
      n !== m().profile_name && h('button', { class: 'btn sm', 'data-testid': 'profile-delete', onclick: async () => { if (await confirmDialog(`Slet profilen "${n}"?`, { ok: 'Slet', danger: true })) conn.command('DeleteProfile', n); } }, 'Slet'))));
  });
  const micList = h('div', { class: 'list' });
  let micKey = '';
  binder.add(() => {
    const names = conn.status.files?.mic_profiles || [];
    const k = names.join('|') + '#' + m().mic_profile_name;
    if (k === micKey) return;
    micKey = k;
    micList.replaceChildren(...names.map((n) => h('div', { class: `item ${n === m().mic_profile_name ? 'active' : ''}` },
      h('div', {}, n), h('div', { class: 'spacer' }),
      n === m().mic_profile_name ? h('span', { class: 'badge ok' }, 'Aktiv') : h('button', { class: 'btn sm', 'data-testid': 'mic-profile-load', onclick: () => conn.command('LoadMicProfile', n, true) }, 'Indlæs'),
      h('button', { class: 'btn sm', 'data-testid': 'mic-profile-history', onclick: () => showHistory(ctx, 'mic', n) }, 'Historik'),
      n !== m().mic_profile_name && h('button', { class: 'btn sm', 'data-testid': 'mic-profile-delete', onclick: async () => { if (await confirmDialog(`Slet mikrofonprofilen "${n}"?`, { ok: 'Slet', danger: true })) conn.command('DeleteMicProfile', n); } }, 'Slet'))));
    if (!names.length) micList.append(h('div', { class: 'hint' }, 'Ingen mikrofonprofiler.'));
  });
  return h('div', { class: 'grid cols-2' },
    h('div', { class: 'card' }, h('h2', {}, 'GoXLR-profiler',
      h('span', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => { conn.command('SaveProfile'); setTimeout(() => snapshotProfiles(ctx), 1500); } }, 'Gem aktiv'),
        h('button', { class: 'btn sm', 'data-testid': 'profile-save-as', onclick: async () => { const n = await promptDialog('Navn på profil'); if (n) { conn.command('SaveProfileAs', n); setTimeout(() => snapshotProfiles(ctx), 1500); } } }, 'Gem som…'),
        h('button', { class: 'btn sm', 'data-testid': 'profile-new', title: 'En ny profil med GoXLR’ens standardindstillinger', onclick: async () => { const n = await promptDialog('Navn på den nye profil (starter fra standard)'); if (n) conn.command('NewProfile', n); } }, 'Ny'))),
    list),
    h('div', { class: 'card' }, h('h2', {}, 'Mikrofonprofiler',
      h('span', { class: 'row' },
        h('button', { class: 'btn sm', onclick: () => conn.command('SaveMicProfile') }, 'Gem aktiv'),
        h('button', { class: 'btn sm', 'data-testid': 'mic-profile-save-as2', onclick: async () => { const n = await promptDialog('Navn på mikrofonprofil'); if (n) conn.command('SaveMicProfileAs', n); } }, 'Gem som…'),
        h('button', { class: 'btn sm', 'data-testid': 'mic-profile-new', title: 'En ny mikrofonprofil med standardindstillinger', onclick: async () => { const n = await promptDialog('Navn på den nye mikrofonprofil (starter fra standard)'); if (n) conn.command('NewMicProfile', n); } }, 'Ny'))),
      micList,
      h('div', { class: 'hint', style: { marginTop: '8px' } }, 'Historik: GoXLR Studio gemmer automatisk de 30 seneste versioner af hver profil, hver gang den er ændret. "Gendan" lægger en gammel version tilbage – den nuværende gemmes først, så det kan fortrydes.')),
    h('div', { class: 'card' }, h('h2', {}, 'Om profiler'),
      h('div', { class: 'hint' }, 'GoXLR-profiler indeholder routing, faders, farver, effekter og sampler. Mikrofonprofiler (gain, EQ, gate, kompressor) ligger under Mikrofon. Scener i GoXLR Studio er hurtigere og kan også skifte Windows-enheder og afspilnings-EQ.')));
}

// Profilhistorik: earlier versions of a profile, with "Gendan".
async function showHistory(ctx, kind, name) {
  const { conn } = ctx;
  const folder = kind === 'mic' ? conn.status.paths?.mic_profile_directory : conn.status.paths?.profile_directory;
  await snapshotProfiles(ctx);
  const versions = await historyList(kind, name).catch(() => []);
  const kb = (n) => `${String(Math.round(n / 102.4) / 10).replace('.', ',')} KB`;
  const rows = versions.length ? versions.map((v, i) => h('div', { class: 'item', 'data-testid': 'history-version' },
    h('div', {}, v.at, i === 0 ? h('span', { class: 'badge', style: { marginLeft: '8px' } }, 'nyeste') : null), h('div', { class: 'spacer' }), h('span', { class: 'hint' }, kb(v.size)),
    h('button', { class: 'btn sm', 'data-testid': 'history-restore', onclick: async () => {
      if (!(await confirmDialog(`Gendan "${name}" som den var ${v.at}?\n\nDen nuværende version gemmes først, så du kan fortryde.`, { ok: 'Gendan' }))) return;
      try {
        await historyRestore(kind, name, v.file, String(folder || ''));
        if (kind === 'mic' ? conn.mixer?.mic_profile_name === name : conn.mixer?.profile_name === name) conn.command(kind === 'mic' ? 'LoadMicProfile' : 'LoadProfile', name, true);
        logActivity(`Profilhistorik: "${name}" gendannet fra ${v.at}`);
        toast(`"${name}" er gendannet fra ${v.at}`, 'info');
        document.querySelector('[data-testid=profile-history-dialog] [data-testid=dialog-ok]')?.click();
      } catch (e) { toast(String(e.message || e)); }
    } }, 'Gendan')))
    : [h('div', { class: 'hint' }, 'Ingen gemte versioner endnu – de kommer, når profilen bliver ændret.')];
  infoDialog(`Historik for "${name}"`, h('div', { class: 'list' }, rows), { ok: 'Luk', testid: 'profile-history-dialog' });
}

/** Saves a version of every profile that changed (every 5 minutes and after "Gem"). */
export async function snapshotProfiles(ctx) {
  const p = ctx.conn.status?.paths;
  if (!p?.profile_directory) return 0;
  return historySnapshot(String(p.profile_directory), String(p.mic_profile_directory || '')).catch(() => 0);
}

// ---------- Settings ----------
export function settingsView(ctx) {
  const { conn, binder } = ctx;
  const m = () => conn.mixer;
  const info = h('div', { class: 'list' });
  binder.add(() => {
    const hw = m().hardware;
    const fw = hw.versions?.firmware;
    info.replaceChildren(
      h('div', { class: 'item' }, 'Model', h('div', { class: 'spacer' }), hw.device_type === 'Mini' ? 'GoXLR Mini' : 'GoXLR'),
      h('div', { class: 'item' }, 'Serienummer', h('div', { class: 'spacer' }), hw.serial_number),
      h('div', { class: 'item' }, 'Firmware', h('div', { class: 'spacer' }), Array.isArray(fw) ? fw.join('.') : (fw ? Object.values(fw).join('.') : '–')),
      h('div', { class: 'item' }, 'GoXLR-motor', h('div', { class: 'spacer' }), conn.status.config?.daemon_version ? `${conn.status.config.daemon_version} (i appen)` : '–'),
      h('div', { class: 'item' }, 'Forbindelse', h('div', { class: 'spacer' }), conn.mode === 'live' ? 'Live' : 'Demo (ingen GoXLR-motor)'));
  });
  const behaviour = h('div', { class: 'card' }, h('h2', {}, 'GoXLR-adfærd'),
    slider(binder, { label: 'Mute-hold', min: 100, max: 2000, step: 50, get: () => m().settings.mute_hold_duration, set: (v) => conn.command('SetMuteHoldDuration', v), fmt: (v) => `${v} ms` }),
    toggle(binder, { label: 'Chat-mute muter også mic', get: () => m().settings.vc_mute_also_mute_cm, set: (v) => conn.command('SetVCMuteAlsoMuteCM', v) }),
    toggle(binder, { label: 'Lås faders', get: () => m().settings.lock_faders, set: (v) => conn.command('SetLockFaders', v) }),
  );
  // Sprog / language – in both languages, so it can be found whichever is shown.
  const langSel = h('select', { 'data-testid': 'language', 'data-no-i18n': '', onchange: () => ctx.setLanguage?.(langSel.value) },
    [['auto', 'Automatisk (som Windows) / Automatic'], ['da', 'Dansk'], ['en', 'English']].map(([v, label]) => h('option', { value: v, selected: (ctx.prefs.lang || 'auto') === v }, label)));
  // Windows can switch the app off under its own Startup apps – then the toggle is off and says why.
  const autostartHint = () => (ctx.autostart?.registered && !ctx.autostart.approved
    ? [h('div', { class: 'hint warn-text', 'data-testid': 'autostart-disabled' }, 'Windows har slået GoXLR Studio fra under Indstillinger → Apps → Start. Slå “Start med Windows” til her igen for at tænde den.')]
    : []);
  const autostartNote = h('div', {}, ...autostartHint());
  if (isNative()) ctx.checkAutostart?.().then(() => autostartNote.replaceChildren(...autostartHint()));
  const app = h('div', { class: 'card' }, h('h2', {}, 'App'),
    h('div', { class: 'row' }, h('label', { 'data-no-i18n': '' }, 'Sprog / Language'), langSel),
    toggle(binder, { label: 'Auto-ducking', get: () => ctx.ducker.settings.enabled, set: (v) => { ctx.ducker.settings.enabled = v; ctx.ducker.save(); } }),
    isNative() ? toggle(binder, { label: 'Start med Windows', get: () => ctx.autostart?.enabled ?? ctx.prefs.autostart, set: async (v) => {
      try {
        ctx.autostart = await setAutostart(v);
        ctx.prefs.autostart = ctx.autostart.registered; ctx.savePrefs();
        if (v && !ctx.autostart.enabled) toast('Windows starter stadig ikke GoXLR Studio – se Indstillinger → Apps → Start i Windows');
      } catch (e) { toast(String(e)); }
      autostartNote.replaceChildren(...autostartHint());
    } }) : null,
    autostartNote,
    toggle(binder, { label: 'Niveaumåler i bakke-ikonet (mikrofon)', get: () => !!ctx.prefs.trayMeter, set: (v) => { ctx.prefs.trayMeter = v; ctx.savePrefs(); } }),
    isNative() ? toggle(binder, { label: 'Luk til bakke-ikon', get: () => ctx.prefs.closeToTray, set: (v) => { ctx.prefs.closeToTray = v; ctx.savePrefs(); window.__TAURI__.core.invoke('set_close_to_tray', { enabled: v }).catch(() => {}); } }) : null,
    h('div', { class: 'hint' }, 'Auto-ducking skruer ned for Music og Game, mens du taler. GoXLR Studio styrer GoXLR’en med sin egen indbyggede motor – GoXLR Utility og TC-Helicons app skal ikke køre.'));
  return h('div', { class: 'grid' }, h('div', { class: 'grid cols-2' }, h('div', { class: 'card' }, h('h2', {}, 'Enhed'), info), behaviour, app), systemSettings(ctx));
}

export { CHANNELS, CHANNEL_LABEL, shortName };
