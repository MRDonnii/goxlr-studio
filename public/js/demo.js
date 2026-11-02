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
  const volumes = { Mic: 220, LineIn: 140, Console: 160, System: 170, Game: 178, Chat: 100, Sample: 150, Music: 85, Headphones: 210, MicMonitor: 0, LineOut: 255 };
  const fader = (channel, text) => ({ channel, mute_type: 'All', mute_state: 'Unmuted', scribble: { file_name: null, bottom_text: text, left_text: null, inverted: false } });
  const presetNames = { Preset1: 'Studie', Preset2: 'Radio', Preset3: 'Robot', Preset4: 'Hal', Preset5: 'Telefon', Preset6: 'Dyb' };
  return {
    config: { daemon_version: '1.2.4', platform: 'demo', http_settings: { port: 14564 }, tts_enabled: false },
    firmware: {},
    paths: {
      profile_directory: 'C:\\Users\\demo\\AppData\\Roaming\\GoXLR-on-Linux\\GoXLR-Utility\\profiles',
      mic_profile_directory: 'C:\\Users\\demo\\AppData\\Roaming\\GoXLR-on-Linux\\GoXLR-Utility\\mic-profiles',
      samples_directory: 'C:\\Users\\demo\\AppData\\Roaming\\GoXLR-on-Linux\\GoXLR-Utility\\samples',
      icons_directory: 'C:\\Users\\demo\\AppData\\Roaming\\GoXLR-on-Linux\\GoXLR-Utility\\icons',
    },
    files: {
      profiles: ['Headset', 'Speakers', 'Stream'], mic_profiles: ['SM7B', 'Standard'], presets: ['Studie', 'Hal'],
      samples: { 'Applaus.wav': { name: 'Applaus.wav', gain_pct: 100 }, 'Trommehvirvel.wav': { name: 'Trommehvirvel.wav', gain_pct: 100 }, 'Recorded/Optagelse 1.wav': { name: 'Recorded/Optagelse 1.wav', gain_pct: 100 } },
      icons: ['mic.png', 'game.png', 'music.png'],
    },
    mixers: {
      DEMO0001: {
        hardware: { serial_number: 'DEMO0001', device_type: (typeof location !== 'undefined' && /[?&]mini\b/.test(location.search)) ? 'Mini' : 'Full', colour_way: 'Black', versions: { firmware: [1, 5, 0, 0] }, manufactured_date: '', usb_device: {} },
        fader_status: { A: fader('Mic', 'Mic'), B: fader('Chat', 'Chat'), C: fader('Music', 'Music'), D: fader('System', 'System') },
        mic_status: {
          mic_type: 'Dynamic',
          mic_gains: { Dynamic: 52, Condenser: 30, Jack: 20 },
          equaliser: { gain, frequency: freq },
          equaliser_mini: { gain: mgain, frequency: mfreq },
          // Times and ratios are positions in the lists (micenums.js), as the real engine reports them.
          noise_gate: { threshold: -42, attack: 0, release: 19, enabled: true, attenuation: 80 },
          compressor: { threshold: -18, ratio: 8, attack: 4, release: 11, makeup_gain: 4 },
        },
        levels: { submix_supported: false, output_monitor: 'Headphones', volumes, submix: null, bleep: -20, deess: 25 },
        router: structuredClone(ROUTING_DEFAULT),
        cough_button: { is_toggle: false, mute_type: 'All', state: 'Unmuted' },
        lighting: {
          animation: { supported: true, mode: 'None', mod1: 0, mod2: 0, waterfall_direction: 'Down' },
          faders: {
            A: { style: 'TwoColour', colours: { colour_one: 'E8E8FF', colour_two: 'FF2A7A' } },
            B: { style: 'TwoColour', colours: { colour_one: 'E8E8FF', colour_two: 'E8E8FF' } },
            C: { style: 'TwoColour', colours: { colour_one: 'FF2A7A', colour_two: '1E3CFF' } },
            D: { style: 'TwoColour', colours: { colour_one: '3CFF8C', colour_two: 'FF2A7A' } },
          },
          buttons: Object.fromEntries(['Fader1Mute', 'Fader2Mute', 'Fader3Mute', 'Fader4Mute', 'Bleep', 'Cough', 'EffectSelect1', 'EffectSelect2', 'EffectSelect3', 'EffectSelect4', 'EffectSelect5', 'EffectSelect6', 'EffectFx', 'EffectMegaphone', 'EffectRobot', 'EffectHardTune', 'SamplerTopLeft', 'SamplerTopRight', 'SamplerBottomLeft', 'SamplerBottomRight', 'SamplerClear'].map((b, i) => [b, { off_style: 'Dimmed', colours: { colour_one: ['00FFFF', 'A855F7', 'FF3D7F', 'FFB000'][i % 4], colour_two: '000000' } }])),
          simple: { Global: { colour_one: '00FFFF' }, Accent: { colour_one: 'A855F7' }, Scribble1: { colour_one: 'FFFFFF' }, Scribble2: { colour_one: 'FFFFFF' }, Scribble3: { colour_one: 'FFFFFF' }, Scribble4: { colour_one: 'FFFFFF' } },
          sampler: Object.fromEntries(['SamplerSelectA', 'SamplerSelectB', 'SamplerSelectC'].map((t) => [t, { off_style: 'Dimmed', colours: { colour_one: '00FF7F', colour_two: '000000', colour_three: '003300' } }])),
          encoders: Object.fromEntries(['Reverb', 'Pitch', 'Echo', 'Gender'].map((e) => [e, { colour_one: '00FFFF', colour_two: 'A855F7', colour_three: 'FFFFFF' }])),
        },
        effects: {
          is_enabled: true, active_preset: 'Preset1', preset_names: presetNames,
          current: {
            reverb: { style: 'Library', amount: 20, decay: 1000, early_level: -5, tail_level: -3, pre_delay: 10, lo_colour: 0, hi_colour: 0, hi_factor: 0, diffuse: 0, mod_speed: 0, mod_depth: 0, raw_encoder: 0 },
            echo: { style: 'Quarter', amount: 10, feedback: 30, tempo: 120, delay_left: 500, delay_right: 500, feedback_left: 30, feedback_right: 30, feedback_xfb_l_to_r: 0, feedback_xfb_r_to_l: 0, raw_encoder: 0 },
            pitch: { style: 'Narrow', amount: 0, character: 50, raw_encoder: 0 },
            gender: { style: 'Medium', amount: 0, raw_encoder: 0 },
            megaphone: { is_enabled: false, style: 'Megaphone', amount: 50, post_gain: 0 },
            robot: { is_enabled: false, style: 'Robot1', low_gain: 0, low_freq: 40, low_width: 16, mid_gain: 0, mid_freq: 130, mid_width: 16, high_gain: 0, high_freq: 210, high_width: 16, waveform: 0, pulse_width: 50, threshold: -20, dry_mix: -36 },
            hard_tune: { is_enabled: false, style: 'Natural', amount: 50, rate: 50, window: 20, source: 'All' },
          },
        },
        sampler: (typeof location !== 'undefined' && /[?&]mini\b/.test(location.search)) ? null : {
          processing_state: { progress: null, last_error: null }, active_bank: 'A', clear_active: false, record_buffer: 0,
          banks: Object.fromEntries(['A', 'B', 'C'].map((b) => [b, Object.fromEntries(['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight'].map((k, i) => [k, {
            function: 'PlayNext', order: 'Sequential', is_playing: false, is_recording: false,
            samples: b === 'A' && i === 0 ? [{ name: 'Applaus.wav', start_pct: 0, stop_pct: 100 }] : b === 'A' && i === 1 ? [{ name: 'Trommehvirvel.wav', start_pct: 5, stop_pct: 90 }] : [],
          }]))])),
        },
        shutdown_commands: [], sleep_commands: [], wake_commands: [],
        settings: { mute_hold_duration: 500, vc_mute_also_mute_cm: true, enable_monitor_with_fx: false, reset_sampler_on_clear: true, lock_faders: false, fade_duration: 0, vod_mode: 'Routable', display: { gate: 'Simple', compressor: 'Simple', equaliser: 'Simple', equaliser_fine: 'Simple' } },
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
    case 'SetScribbleIcon': m.fader_status[a[0]].scribble = { ...(m.fader_status[a[0]].scribble || {}), file_name: a[1] }; break;
    case 'SetScribbleNumber': m.fader_status[a[0]].scribble = { ...(m.fader_status[a[0]].scribble || {}), left_text: a[1] }; break;
    case 'SetScribbleInvert': m.fader_status[a[0]].scribble = { ...(m.fader_status[a[0]].scribble || {}), inverted: a[1] }; break;
    case 'SetCoughIsHold': m.cough_button.is_toggle = !a[0]; break;
    case 'SetCoughMuteFunction': m.cough_button.mute_type = a[0]; break;
    case 'SetSleepCommands': m.sleep_commands = a[0]; break;
    case 'SetWakeCommands': m.wake_commands = a[0]; break;
    case 'SetShutdownCommands': m.shutdown_commands = a[0]; break;
    case 'SetVodMode': m.settings.vod_mode = a[0]; break;
    case 'SetSamplerResetOnClear': m.settings.reset_sampler_on_clear = a[0]; break;
    case 'SetSamplerFadeDuration': m.settings.fade_duration = a[0]; break;
    case 'SetSamplerPreBufferDuration': if (m.sampler) m.sampler.record_buffer = a[0]; break;
    case 'SetActiveSamplerBank': if (m.sampler) m.sampler.active_bank = a[0]; break;
    case 'SetSamplerFunction': m.sampler.banks[a[0]][a[1]].function = a[2]; break;
    case 'SetSamplerOrder': m.sampler.banks[a[0]][a[1]].order = a[2]; break;
    case 'AddSample': m.sampler.banks[a[0]][a[1]].samples.push({ name: a[2], start_pct: 0, stop_pct: 100 }); break;
    case 'RemoveSampleByIndex': m.sampler.banks[a[0]][a[1]].samples.splice(a[2], 1); break;
    case 'SetSampleStartPercent': m.sampler.banks[a[0]][a[1]].samples[a[2]].start_pct = a[3]; break;
    case 'SetSampleStopPercent': m.sampler.banks[a[0]][a[1]].samples[a[2]].stop_pct = a[3]; break;
    case 'PlaySampleByIndex': case 'PlayNextSample': m.sampler.banks[a[0]][a[1]].is_playing = true; setTimeout(() => { m.sampler.banks[a[0]][a[1]].is_playing = false; }, 1500); break;
    case 'StopSamplePlayback': m.sampler.banks[a[0]][a[1]].is_playing = false; break;
    case 'NewMicProfile': if (!status.files.mic_profiles.includes(a[0])) status.files.mic_profiles.push(a[0]); m.mic_profile_name = a[0]; break;
    case 'DeleteMicProfile': status.files.mic_profiles = status.files.mic_profiles.filter((x) => x !== a[0]); break;
    case 'NewProfile': if (!status.files.profiles.includes(a[0])) status.files.profiles.push(a[0]); m.profile_name = a[0]; break;
    case 'DeleteProfile': status.files.profiles = status.files.profiles.filter((x) => x !== a[0]); break;
    case 'LoadEffectPreset': if (fx) fx.preset_names[fx.active_preset] = a[0]; break;
    case 'SetSubMixLinked': if (m.levels.submix) m.levels.submix.inputs[a[0]].linked = a[1]; break;
    case 'SetSubMixOutputMix': if (m.levels.submix) m.levels.submix.outputs[a[0]] = a[1]; break;
    default: {
      const f = FX_FIELDS[name];
      if (f && fx) {
        const [part, field] = f;
        if (part === 'robot' && a.length === 2) fx.current.robot[`${{ Low: 'low', Medium: 'mid', High: 'high' }[a[0]]}_${field}`] = a[1];
        else fx.current[part][field] = a[0];
      }
    }
  }
}

// Effect settings in the demo: command → [effect, field].
const FX_FIELDS = {
  SetReverbPreDelay: ['reverb', 'pre_delay'], SetReverbEarlyLevel: ['reverb', 'early_level'], SetReverbTailLevel: ['reverb', 'tail_level'],
  SetReverbLowColour: ['reverb', 'lo_colour'], SetReverbHighColour: ['reverb', 'hi_colour'], SetReverbHighFactor: ['reverb', 'hi_factor'],
  SetReverbDiffuse: ['reverb', 'diffuse'], SetReverbModSpeed: ['reverb', 'mod_speed'], SetReverbModDepth: ['reverb', 'mod_depth'], SetReverbDecay: ['reverb', 'decay'],
  SetEchoDelayLeft: ['echo', 'delay_left'], SetEchoDelayRight: ['echo', 'delay_right'], SetEchoFeedbackLeft: ['echo', 'feedback_left'], SetEchoFeedbackRight: ['echo', 'feedback_right'],
  SetEchoFeedbackXFBLtoR: ['echo', 'feedback_xfb_l_to_r'], SetEchoFeedbackXFBRtoL: ['echo', 'feedback_xfb_r_to_l'], SetEchoFeedback: ['echo', 'feedback'], SetEchoTempo: ['echo', 'tempo'],
  SetPitchCharacter: ['pitch', 'character'], SetMegaphonePostGain: ['megaphone', 'post_gain'],
  SetRobotGain: ['robot', 'gain'], SetRobotFreq: ['robot', 'freq'], SetRobotWidth: ['robot', 'width'], SetRobotWaveform: ['robot', 'waveform'],
  SetRobotPulseWidth: ['robot', 'pulse_width'], SetRobotThreshold: ['robot', 'threshold'], SetRobotDryMix: ['robot', 'dry_mix'],
  SetHardTuneWindow: ['hard_tune', 'window'], SetHardTuneSource: ['hard_tune', 'source'], SetHardTuneRate: ['hard_tune', 'rate'],
  SetReverbStyle: ['reverb', 'style'], SetEchoStyle: ['echo', 'style'], SetPitchStyle: ['pitch', 'style'], SetGenderStyle: ['gender', 'style'],
  SetMegaphoneStyle: ['megaphone', 'style'], SetRobotStyle: ['robot', 'style'], SetHardTuneStyle: ['hard_tune', 'style'],
};

/** Engine (daemon) commands in the demo. */
export function applyDemoDaemon(status, cmd) {
  const [name] = Object.keys(cmd);
  const a = cmd[name];
  if (name === 'SetTTSEnabled') status.config.tts_enabled = a[0];
  if (name === 'SetSampleGainPct' && status.files.samples[a[0]]) status.files.samples[a[0]].gain_pct = a[1];
}

function groupOf(b) {
  if (/^Fader\dMute$/.test(b)) return 'FaderMute';
  if (/^EffectSelect/.test(b)) return 'EffectSelector';
  if (/^Effect(Megaphone|Robot|HardTune)$/.test(b)) return 'EffectTypes';
  return null;
}
