export const CHANNELS = ['Mic', 'LineIn', 'Console', 'System', 'Game', 'Chat', 'Sample', 'Music', 'Headphones', 'MicMonitor', 'LineOut'];
export const INPUTS = ['Microphone', 'Chat', 'Music', 'Game', 'Console', 'LineIn', 'System', 'Samples'];
export const OUTPUTS = ['Headphones', 'BroadcastMix', 'ChatMic', 'Sampler', 'LineOut'];
export const EQ_BANDS = ['Equalizer31Hz', 'Equalizer63Hz', 'Equalizer125Hz', 'Equalizer250Hz', 'Equalizer500Hz', 'Equalizer1KHz', 'Equalizer2KHz', 'Equalizer4KHz', 'Equalizer8KHz', 'Equalizer16KHz'];
export const EQ_DEFAULT_FREQ = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const MINI_EQ_BANDS = ['Equalizer90Hz', 'Equalizer250Hz', 'Equalizer500Hz', 'Equalizer1KHz', 'Equalizer3KHz', 'Equalizer8KHz'];
export const MINI_EQ_DEFAULT_FREQ = [90, 250, 500, 1000, 3000, 8000];

const ROUTING_DEFAULT = {
  Microphone: { Headphones: false, BroadcastMix: true, ChatMic: true, Sampler: true, LineOut: false },
  Chat: { Headphones: true, BroadcastMix: true, ChatMic: false, Sampler: true, LineOut: false },
  Music: { Headphones: true, BroadcastMix: true, ChatMic: true, Sampler: true, LineOut: false },
  Game: { Headphones: true, BroadcastMix: true, ChatMic: true, Sampler: true, LineOut: false },
  Console: { Headphones: true, BroadcastMix: true, ChatMic: true, Sampler: true, LineOut: false },
  LineIn: { Headphones: true, BroadcastMix: true, ChatMic: true, Sampler: true, LineOut: false },
  System: { Headphones: true, BroadcastMix: true, ChatMic: false, Sampler: true, LineOut: false },
  Samples: { Headphones: true, BroadcastMix: true, ChatMic: true, Sampler: false, LineOut: false },
};

export function createDemoStatus() {
  const gain = {}; const freq = {};
  EQ_BANDS.forEach((b, i) => { gain[b] = [2, 1, 0, -1, -2, 0, 1, 3, 2, 1][i]; freq[b] = EQ_DEFAULT_FREQ[i]; });
  const mgain = {}; const mfreq = {};
  MINI_EQ_BANDS.forEach((b, i) => { mgain[b] = 0; mfreq[b] = MINI_EQ_DEFAULT_FREQ[i]; });
  const volumes = { Mic: 255, LineIn: 140, Console: 160, System: 190, Game: 178, Chat: 204, Sample: 150, Music: 120, Headphones: 210, MicMonitor: 0, LineOut: 255 };
  const fader = (channel, text) => ({ channel, mute_type: 'All', mute_state: 'Unmuted', scribble: { file_name: null, bottom_text: text, left_text: null, inverted: false } });
  const presetNames = { Preset1: 'Studie', Preset2: 'Radio', Preset3: 'Robot', Preset4: 'Hal', Preset5: 'Telefon', Preset6: 'Dyb' };
  return {
    config: { daemon_version: 'demo', platform: 'demo', http_settings: { port: 14564 } },
    firmware: {},
    paths: {},
    files: { profiles: ['Headset', 'Speakers', 'Stream'], mic_profiles: ['SM7B', 'Standard'], presets: [], samples: {}, icons: [] },
    mixers: {
      DEMO0001: {
        hardware: { serial_number: 'DEMO0001', device_type: (typeof location !== 'undefined' && /[?&]mini\b/.test(location.search)) ? 'Mini' : 'Full', colour_way: 'Black', versions: { firmware: [1, 5, 0, 0] }, manufactured_date: '', usb_device: {} },
        fader_status: { A: fader('Mic', 'Mikrofon'), B: fader('Music', 'Musik'), C: fader('Chat', 'Discord'), D: fader('System', 'System') },
        mic_status: {
          mic_type: 'Dynamic',
          mic_gains: { Dynamic: 52, Condenser: 30, Jack: 20 },
          equaliser: { gain, frequency: freq },
          equaliser_mini: { gain: mgain, frequency: mfreq },
          noise_gate: { threshold: -42, attack: 'Gate10ms', release: 'Gate200ms', enabled: true, attenuation: 80 },
          compressor: { threshold: -18, ratio: 'Ratio3_2', attack: 'Comp5ms', release: 'Comp140ms', makeup_gain: 4 },
        },
        levels: { submix_supported: false, output_monitor: 'Headphones', volumes, submix: null, bleep: -20, deess: 25 },
        router: structuredClone(ROUTING_DEFAULT),
        cough_button: { is_toggle: false, mute_type: 'All', state: 'Unmuted' },
        lighting: {
          animation: { supported: true, mode: 'None', mod1: 0, mod2: 0, waterfall_direction: 'Down' },
          faders: {
            A: { style: 'Gradient', colours: { colour_one: '00FFFF', colour_two: '0040FF' } },
            B: { style: 'Gradient', colours: { colour_one: 'FF00C8', colour_two: '7A00FF' } },
            C: { style: 'Gradient', colours: { colour_one: '00FF7F', colour_two: '00A0FF' } },
            D: { style: 'Gradient', colours: { colour_one: 'FFB000', colour_two: 'FF3D00' } },
          },
          buttons: Object.fromEntries(['Fader1Mute', 'Fader2Mute', 'Fader3Mute', 'Fader4Mute', 'Bleep', 'Cough', 'EffectSelect1', 'EffectSelect2', 'EffectSelect3', 'EffectSelect4', 'EffectSelect5', 'EffectSelect6', 'EffectFx', 'EffectMegaphone', 'EffectRobot', 'EffectHardTune', 'SamplerTopLeft', 'SamplerTopRight', 'SamplerBottomLeft', 'SamplerBottomRight', 'SamplerClear'].map((b, i) => [b, { off_style: 'Dimmed', colours: { colour_one: ['00FFFF', 'A855F7', 'FF3D7F', 'FFB000'][i % 4], colour_two: '000000' } }])),
          simple: { Global: { colour_one: '00FFFF' }, Accent: { colour_one: 'A855F7' }, Scribble1: { colour_one: 'FFFFFF' }, Scribble2: { colour_one: 'FFFFFF' }, Scribble3: { colour_one: 'FFFFFF' }, Scribble4: { colour_one: 'FFFFFF' } },
          sampler: Object.fromEntries(['SamplerSelectA', 'SamplerSelectB', 'SamplerSelectC'].map((t) => [t, { off_style: 'Dimmed', colours: { colour_one: '00FF7F', colour_two: '000000', colour_three: '003300' } }])),
          encoders: Object.fromEntries(['Reverb', 'Pitch', 'Echo', 'Gender'].map((e) => [e, { colour_one: '00FFFF', colour_two: 'A855F7', colour_three: 'FFFFFF' }])),
        },
        effects: {
          is_enabled: true, active_preset: 'Preset1', preset_names: presetNames,
          current: {
            reverb: { style: 'Library', amount: 20, decay: 1000, raw_encoder: 0 },
            echo: { style: 'Quarter', amount: 10, feedback: 30, tempo: 120, raw_encoder: 0 },
            pitch: { style: 'Narrow', amount: 0, character: 50, raw_encoder: 0 },
            gender: { style: 'Medium', amount: 0, raw_encoder: 0 },
            megaphone: { is_enabled: false, style: 'Megaphone', amount: 50, post_gain: 0 },
            robot: { is_enabled: false, style: 'Robot1' },
            hard_tune: { is_enabled: false, style: 'Natural', amount: 50, rate: 50, window: 20, source: 'All' },
          },
        },
        sampler: null,
        settings: { mute_hold_duration: 500, vc_mute_also_mute_cm: true, enable_monitor_with_fx: false, reset_sampler_on_clear: true, lock_faders: false, fade_duration: 0, vod_mode: 'Routable' },
        button_down: {},
        profile_name: 'Headset',
        mic_profile_name: 'SM7B',
      },
    },
  };
}

export function applyDemoCommand(status, serial, cmd) {
  const m = status.mixers[serial];
  const [name] = Object.keys(cmd);
  const a = cmd[name];
  const mic = m.mic_status;
  const fx = m.effects;
  switch (name) {
    case 'SetVolume': m.levels.volumes[a[0]] = a[1]; break;
    case 'SetFader': m.fader_status[a[0]].channel = a[1]; break;
    case 'SetFaderMuteState': m.fader_status[a[0]].mute_state = a[1]; break;
    case 'SetFaderMuteFunction': m.fader_status[a[0]].mute_type = a[1]; break;
    case 'SetCoughMuteState': m.cough_button.state = a[0]; break;
    case 'SetRouter': m.router[a[0]][a[1]] = a[2]; break;
    case 'SetMicrophoneType': mic.mic_type = a[0]; break;
    case 'SetMicrophoneGain': mic.mic_gains[a[0]] = a[1]; break;
    case 'SetEqGain': mic.equaliser.gain[a[0]] = a[1]; break;
    case 'SetEqFreq': mic.equaliser.frequency[a[0]] = a[1]; break;
    case 'SetEqMiniGain': mic.equaliser_mini.gain[a[0]] = a[1]; break;
    case 'SetEqMiniFreq': mic.equaliser_mini.frequency[a[0]] = a[1]; break;
    case 'SetGateThreshold': mic.noise_gate.threshold = a[0]; break;
    case 'SetGateAttenuation': mic.noise_gate.attenuation = a[0]; break;
    case 'SetGateAttack': mic.noise_gate.attack = a[0]; break;
    case 'SetGateRelease': mic.noise_gate.release = a[0]; break;
    case 'SetGateActive': mic.noise_gate.enabled = a[0]; break;
    case 'SetCompressorThreshold': mic.compressor.threshold = a[0]; break;
    case 'SetCompressorRatio': mic.compressor.ratio = a[0]; break;
    case 'SetCompressorAttack': mic.compressor.attack = a[0]; break;
    case 'SetCompressorReleaseTime': mic.compressor.release = a[0]; break;
    case 'SetCompressorMakeupGain': mic.compressor.makeup_gain = a[0]; break;
    case 'SetDeeser': m.levels.deess = a[0]; break;
    case 'SetSwearButtonVolume': m.levels.bleep = a[0]; break;
    case 'SetMonitorMix': m.levels.output_monitor = a[0]; break;
    case 'SetFXEnabled': fx.is_enabled = a[0]; break;
    case 'SetActiveEffectPreset': fx.active_preset = a[0]; break;
    case 'SetMegaphoneEnabled': fx.current.megaphone.is_enabled = a[0]; break;
    case 'SetRobotEnabled': fx.current.robot.is_enabled = a[0]; break;
    case 'SetHardTuneEnabled': fx.current.hard_tune.is_enabled = a[0]; break;
    case 'SetReverbAmount': fx.current.reverb.amount = a[0]; break;
    case 'SetEchoAmount': fx.current.echo.amount = a[0]; break;
    case 'SetPitchAmount': fx.current.pitch.amount = a[0]; break;
    case 'SetGenderAmount': fx.current.gender.amount = a[0]; break;
    case 'SetMegaphoneAmount': fx.current.megaphone.amount = a[0]; break;
    case 'SetHardTuneAmount': fx.current.hard_tune.amount = a[0]; break;
    case 'SetFaderColours': Object.assign(m.lighting.faders[a[0]].colours, { colour_one: a[1], colour_two: a[2] }); break;
    case 'SetGlobalColour': m.lighting.simple.Global = { colour_one: a[0] }; break;
    case 'SetFaderDisplayStyle': m.lighting.faders[a[0]].style = a[1]; break;
    case 'SetAllFaderColours': for (const f of Object.values(m.lighting.faders)) Object.assign(f.colours, { colour_one: a[0], colour_two: a[1] }); break;
    case 'SetAllFaderDisplayStyle': for (const f of Object.values(m.lighting.faders)) f.style = a[0]; break;
    case 'SetSimpleColour': m.lighting.simple[a[0]] = { colour_one: a[1] }; break;
    case 'SetButtonColours': m.lighting.buttons[a[0]].colours = { colour_one: a[1], colour_two: a[2] ?? m.lighting.buttons[a[0]].colours.colour_two }; break;
    case 'SetButtonOffStyle': m.lighting.buttons[a[0]].off_style = a[1]; break;
    case 'SetButtonGroupColours': for (const [b, v] of Object.entries(m.lighting.buttons)) if (groupOf(b) === a[0]) v.colours = { colour_one: a[1], colour_two: a[2] ?? v.colours.colour_two }; break;
    case 'SetButtonGroupOffStyle': for (const [b, v] of Object.entries(m.lighting.buttons)) if (groupOf(b) === a[0]) v.off_style = a[1]; break;
    case 'SetEncoderColour': m.lighting.encoders[a[0]] = { colour_one: a[1], colour_two: a[2], colour_three: a[3] }; break;
    case 'SetSampleColour': m.lighting.sampler[a[0]].colours = { colour_one: a[1], colour_two: a[2], colour_three: a[3] }; break;
    case 'SetSampleOffStyle': m.lighting.sampler[a[0]].off_style = a[1]; break;
    case 'SetAnimationMode': m.lighting.animation.mode = a[0]; break;
    case 'SetAnimationMod1': m.lighting.animation.mod1 = a[0]; break;
    case 'SetAnimationMod2': m.lighting.animation.mod2 = a[0]; break;
    case 'SetAnimationWaterfall': m.lighting.animation.waterfall_direction = a[0]; break;
    case 'LoadProfile': m.profile_name = a[0]; break;
    case 'LoadMicProfile': m.mic_profile_name = a[0]; break;
    case 'SaveProfileAs': if (!status.files.profiles.includes(a[0])) status.files.profiles.push(a[0]); m.profile_name = a[0]; break;
    case 'SaveMicProfileAs': if (!status.files.mic_profiles.includes(a[0])) status.files.mic_profiles.push(a[0]); m.mic_profile_name = a[0]; break;
    case 'SetScribbleText': m.fader_status[a[0]].scribble = { ...(m.fader_status[a[0]].scribble || {}), bottom_text: a[1] }; break;
    default: break;
  }
}

function groupOf(b) {
  if (/^Fader\dMute$/.test(b)) return 'FaderMute';
  if (/^EffectSelect/.test(b)) return 'EffectSelector';
  if (/^Effect(Megaphone|Robot|HardTune)$/.test(b)) return 'EffectTypes';
  return null;
}
