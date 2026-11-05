//! "Ren mikrofon": the microphone cleaned before Discord, games and everything else get it.
//!
//! Runs in GoXLR Studio's EQ engine (Equalizer APO) on the GoXLR's "Chat Mic" as a VST2 plugin:
//! - echo cancellation – WebRTC's AEC3: what the speakers play (sent by GoXLR Studio through
//!   shared memory, see `ring`) is removed from the mic, so others do not hear themselves or the
//!   game when you play on speakers;
//! - noise suppression – WebRTC's noise suppression, and in "strong" mode also RNNoise (a small
//!   neural network), which removes keyboard, fan and game sound between and under the words;
//! - a high-pass filter against rumble;
//! - Stemmeisolering (feature "deepfilter", see `deepfilter`): DeepFilterNet 3 keeps only speech,
//!   30 ms more delay.
//!
//! Everything runs on 10 ms frames (480 samples at 48 kHz) in mono, with a constant latency of one
//! frame. Other sample rates pass through untouched. Nothing here may stop the sound: on any
//! problem the plugin passes the mic through unchanged.
use nnnoiseless::DenoiseState;
use sonora::config::{EchoCanceller, HighPassFilter, NoiseSuppression, NoiseSuppressionLevel};
use sonora::{AudioProcessing, Config, StreamConfig};

#[cfg(feature = "deepfilter")]
pub mod deepfilter;
pub mod ring;
#[cfg(windows)]
mod shm;
pub mod vst;

pub const RATE: u32 = 48000;
pub const FRAME: usize = 480;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Noise {
    Off,
    /// WebRTC noise suppression (steady noise: fan, hum, hiss).
    Normal,
    /// WebRTC (high) + RNNoise (also keyboard, clicks, game sound).
    Strong,
    /// Stemmeisolering: DeepFilterNet 3 keeps only speech (RNNoise while it loads, or if this
    /// build has no network).
    Isolate,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Settings {
    pub echo: bool,
    pub noise: Noise,
    pub high_pass: bool,
}

/// Parameter names as Equalizer APO sets them (`VSTPlugin: Library "…" Echo 1 Noise 1 HighPass 1 Isolate 0`).
pub const PARAMS: [&str; 4] = ["Echo", "Noise", "HighPass", "Isolate"];
pub const DEFAULTS: [f32; 4] = [1.0, 0.5, 1.0, 0.0];

impl Settings {
    /// From the normalized (0…1) VST parameters. Noise: < 0.25 off, < 0.75 normal, else strong;
    /// Isolate ≥ 0.5 = Stemmeisolering whatever Noise says.
    pub fn from_normalized(p: &[f32; 4]) -> Settings {
        Settings {
            echo: p[0] >= 0.5,
            noise: if p[3] >= 0.5 {
                Noise::Isolate
            } else if p[1] < 0.25 {
                Noise::Off
            } else if p[1] < 0.75 {
                Noise::Normal
            } else {
                Noise::Strong
            },
            high_pass: p[2] >= 0.5,
        }
    }

    fn active(&self) -> bool {
        self.echo || self.noise != Noise::Off || self.high_pass
    }
}

/// What the cleaner reports (shown in GoXLR Studio).
#[derive(Clone, Copy, Default, Debug)]
pub struct Stats {
    /// How much echo is removed, in dB (WebRTC's ERLE), when known.
    pub erle_db: Option<f32>,
    /// The echo's delay found by the echo canceller.
    pub delay_ms: Option<i32>,
    /// Reference (speaker sound) arrived recently.
    pub reference: bool,
    pub isolate: Isolation,
}

/// Where Stemmeisolering is.
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub enum Isolation {
    #[default]
    Off,
    /// The network is being built (a second or two); RNNoise meanwhile.
    Loading,
    Running,
    /// Not in this build, or the network failed: RNNoise instead.
    Unavailable,
}

/// The delay Stemmeisolering adds (the network's STFT and look-ahead), whole 10 ms frames.
#[cfg(feature = "deepfilter")]
pub const ISOLATE_FRAMES: usize = deepfilter::LATENCY / FRAME;
#[cfg(not(feature = "deepfilter"))]
pub const ISOLATE_FRAMES: usize = 0;

#[cfg(feature = "deepfilter")]
type Network = Box<deepfilter::DeepFilter>;
#[cfg(not(feature = "deepfilter"))]
type Network = ();

/// The network's plans, built once per process and shared by every instance: the audio engine
/// makes a new plugin instance for each recording and whenever config.txt changes, and building
/// takes about a second (0.14.2).
#[cfg(feature = "deepfilter")]
static PLANS: std::sync::OnceLock<Result<deepfilter::Plans, String>> = std::sync::OnceLock::new();
#[cfg(feature = "deepfilter")]
static LOADING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg_attr(not(feature = "deepfilter"), allow(dead_code))]
enum Iso {
    Idle,
    Loading,
    Ready(Network),
    Failed,
}

pub struct Cleaner {
    settings: Settings,
    apm: Option<AudioProcessing>,
    rnn: Box<DenoiseState<'static>>,
    // Capture framing: `inp` collects input; `out` holds processed audio (one frame of latency).
    inp: [f32; FRAME],
    inp_len: usize,
    out: [f32; FRAME],
    out_pos: usize,
    // Render (reference) framing.
    rnd: [f32; FRAME],
    rnd_len: usize,
    rnd_scratch: [f32; FRAME],
    work: [f32; FRAME],
    work2: [f32; FRAME],
    frames: u64,
    last_render_frame: u64,
    iso: Iso,
    /// Stemmeisolering's fallback is delayed like the network, so switching makes no jump; the
    /// raw frames are kept to start the network where the fallback is.
    iso_delay: std::collections::VecDeque<[f32; FRAME]>,
    iso_raw: std::collections::VecDeque<[f32; FRAME]>,
    pub stats: Stats,
}

/// Builds the network on its own thread (it takes too long for the audio thread), once.
fn start_network() -> Iso {
    #[cfg(feature = "deepfilter")]
    {
        use std::sync::atomic::Ordering;
        if PLANS.get().is_none() && !LOADING.swap(true, Ordering::SeqCst) {
            let spawned = std::thread::Builder::new().name("goxlr-studio-voice-isolate".into()).spawn(|| {
                let r = std::panic::catch_unwind(deepfilter::load_plans).unwrap_or_else(|_| Err("panic".into()));
                let _ = PLANS.set(r);
            });
            if spawned.is_err() {
                LOADING.store(false, Ordering::SeqCst);
                return Iso::Failed;
            }
        }
        return Iso::Loading;
    }
    #[allow(unreachable_code)]
    Iso::Failed
}

fn build_apm(s: &Settings) -> Option<AudioProcessing> {
    if !(s.echo || s.noise != Noise::Off || s.high_pass) {
        return None;
    }
    let config = Config {
        high_pass_filter: s.high_pass.then(HighPassFilter::default),
        echo_canceller: s.echo.then(EchoCanceller::default),
        noise_suppression: match s.noise {
            Noise::Off => None,
            Noise::Normal => Some(NoiseSuppression { level: NoiseSuppressionLevel::Moderate, ..Default::default() }),
            Noise::Strong => Some(NoiseSuppression { level: NoiseSuppressionLevel::High, ..Default::default() }),
            // The network does it all; WebRTC's suppressor in front would only blur what it hears.
            Noise::Isolate => None,
        },
        ..Default::default()
    };
    Some(
        AudioProcessing::builder()
            .config(config)
            .capture_config(StreamConfig::new(RATE, 1))
            .render_config(StreamConfig::new(RATE, 1))
            .build(),
    )
}

impl Cleaner {
    pub fn new(settings: Settings) -> Cleaner {
        Cleaner {
            settings,
            apm: build_apm(&settings),
            rnn: DenoiseState::new(),
            inp: [0.0; FRAME],
            inp_len: 0,
            out: [0.0; FRAME],
            out_pos: 0,
            rnd: [0.0; FRAME],
            rnd_len: 0,
            rnd_scratch: [0.0; FRAME],
            work: [0.0; FRAME],
            work2: [0.0; FRAME],
            frames: 0,
            last_render_frame: 0,
            iso: if settings.noise == Noise::Isolate { start_network() } else { Iso::Idle },
            iso_delay: std::collections::VecDeque::new(),
            iso_raw: std::collections::VecDeque::new(),
            stats: Stats::default(),
        }
    }

    /// Stemmeisolering's network is running.
    pub fn isolating(&mut self) -> bool {
        self.poll_network();
        matches!(self.iso, Iso::Ready(_)) && self.settings.noise == Noise::Isolate
    }

    fn poll_network(&mut self) {
        if let Iso::Loading = &self.iso {
            #[cfg(feature = "deepfilter")]
            {
                self.iso = match PLANS.get() {
                    None => return,
                    Some(Ok(plans)) => match deepfilter::DeepFilter::from_plans(plans.clone()) {
                        Ok(net) => Iso::Ready(Box::new(net)),
                        Err(_) => Iso::Failed,
                    },
                    Some(Err(_)) => Iso::Failed,
                };
            }
            #[cfg(not(feature = "deepfilter"))]
            {
                self.iso = Iso::Failed;
            }
            #[cfg(feature = "deepfilter")]
            if let Iso::Ready(net) = &mut self.iso {
                // Start where the fallback is: feed it the raw frames still in the delay.
                let mut sink = [0f32; FRAME];
                for f in &self.iso_raw {
                    if net.process(f, &mut sink).is_err() {
                        self.iso = Iso::Failed;
                        break;
                    }
                }
            }
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings
    }

    /// New settings; the processing starts over when they change.
    pub fn set(&mut self, settings: Settings) {
        if settings != self.settings {
            if settings.noise == Noise::Isolate && matches!(self.iso, Iso::Idle) {
                self.iso = start_network();
            }
            self.settings = settings;
            self.apm = build_apm(&settings);
            self.rnn = DenoiseState::new();
            self.rnd_len = 0;
        }
    }

    pub fn reset(&mut self) {
        self.apm = build_apm(&self.settings);
        self.rnn = DenoiseState::new();
        self.inp_len = 0;
        self.out = [0.0; FRAME];
        self.out_pos = 0;
        self.rnd_len = 0;
        self.stats = Stats::default();
        self.reset_isolation();
    }

    fn reset_isolation(&mut self) {
        self.iso_delay.clear();
        self.iso_raw.clear();
        #[cfg(feature = "deepfilter")]
        if let Iso::Ready(net) = &mut self.iso {
            if net.reset().is_err() {
                self.iso = Iso::Failed;
            }
        }
    }

    /// The constant delay through the cleaner, in samples (Stemmeisolering adds 30 ms).
    pub fn latency(&self) -> usize {
        if self.settings.noise == Noise::Isolate {
            FRAME * (1 + ISOLATE_FRAMES)
        } else {
            FRAME
        }
    }

    /// What the speakers play (mono, 48 kHz, −1…1), in any amounts; fed to the echo canceller in
    /// 10 ms frames. Call it before `process` with the reference that has arrived since.
    pub fn push_render(&mut self, x: &[f32]) {
        if !self.settings.echo {
            return;
        }
        for &s in x {
            self.rnd[self.rnd_len] = if s.is_finite() { s } else { 0.0 };
            self.rnd_len += 1;
            if self.rnd_len == FRAME {
                self.rnd_len = 0;
                if let Some(apm) = self.apm.as_mut() {
                    let _ = apm.process_render_f32(&[&self.rnd[..]], &mut [&mut self.rnd_scratch[..]]);
                }
                self.last_render_frame = self.frames;
            }
        }
    }

    /// Cleans a block of mono mic samples in place (any length; one frame of latency).
    pub fn process(&mut self, block: &mut [f32]) {
        for s in block.iter_mut() {
            let x = if s.is_finite() { *s } else { 0.0 };
            self.inp[self.inp_len] = x;
            self.inp_len += 1;
            *s = self.out[self.out_pos];
            self.out_pos += 1;
            if self.inp_len == FRAME {
                self.process_frame();
                self.inp_len = 0;
                self.out_pos = 0;
            }
        }
    }

    fn process_frame(&mut self) {
        self.frames += 1;
        if !self.settings.active() || self.apm.is_none() {
            self.out = self.inp;
            return;
        }
        self.work = self.inp;
        if let Some(apm) = self.apm.as_mut() {
            if apm.process_capture_f32(&[&self.inp[..]], &mut [&mut self.work[..]]).is_err() {
                self.work = self.inp;
            }
        }
        match self.settings.noise {
            Noise::Strong => self.rnnoise(),
            Noise::Isolate => self.isolate(),
            _ => {}
        }
        // Never pass on anything broken: on a bad value the frame goes through as it came in.
        if self.work.iter().all(|v| v.is_finite()) {
            self.out = self.work;
        } else {
            self.out = self.inp;
            self.reset_keep_framing();
        }
        if self.frames % 50 == 0 {
            if let Some(apm) = self.apm.as_ref() {
                let st = apm.statistics();
                self.stats.erle_db = st.echo_return_loss_enhancement.map(|v| v as f32).filter(|v| v.is_finite());
                self.stats.delay_ms = st.delay_ms;
            }
        }
        self.stats.reference = self.settings.echo && self.frames.saturating_sub(self.last_render_frame) < 50;
        if self.settings.noise != Noise::Isolate {
            self.stats.isolate = Isolation::Off;
        }
    }

    fn rnnoise(&mut self) {
        for (o, &x) in self.work2.iter_mut().zip(self.work.iter()) {
            *o = x * 32768.0;
        }
        let mut den = [0f32; FRAME];
        self.rnn.process_frame(&mut den, &self.work2);
        for (o, &x) in self.work.iter_mut().zip(den.iter()) {
            *o = x / 32768.0;
        }
    }

    /// Stemmeisolering on `work` (in place, ISOLATE_FRAMES frames later).
    fn isolate(&mut self) {
        self.poll_network();
        #[cfg(feature = "deepfilter")]
        if let Iso::Ready(net) = &mut self.iso {
            let mut out = [0f32; FRAME];
            if net.process(&self.work, &mut out).is_ok() {
                self.work = out;
                self.stats.isolate = Isolation::Running;
                return;
            }
            self.iso = Iso::Failed;
        }
        // Meanwhile (or without the network): RNNoise, delayed as much as the network.
        self.stats.isolate = if matches!(self.iso, Iso::Loading) { Isolation::Loading } else { Isolation::Unavailable };
        self.iso_raw.push_back(self.work);
        while self.iso_raw.len() > ISOLATE_FRAMES {
            self.iso_raw.pop_front();
        }
        self.rnnoise();
        self.iso_delay.push_back(self.work);
        if self.iso_delay.len() > ISOLATE_FRAMES {
            self.work = self.iso_delay.pop_front().unwrap_or([0.0; FRAME]);
        } else {
            self.work = [0.0; FRAME];
        }
    }

    fn reset_keep_framing(&mut self) {
        self.apm = build_apm(&self.settings);
        self.rnn = DenoiseState::new();
    }
}

#[cfg(test)]
mod tests;
#[cfg(all(test, feature = "deepfilter"))]
mod tests_df;
