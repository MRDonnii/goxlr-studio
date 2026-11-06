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
pub mod fx;
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
/// Amount (0.15.0): how much Stemmeisolering removes, see `residual`.
pub const PARAMS: [&str; 5] = ["Echo", "Noise", "HighPass", "Isolate", "Amount"];
pub const DEFAULTS: [f32; 5] = [1.0, 0.5, 1.0, 0.0, 1.0];

/// How much of the uncleaned mic Stemmeisolering lets through, from the Amount parameter (0…1):
/// 1 = nothing (full isolation), below that the background is kept 10 dB (0) to 30 dB (≈1) down,
/// as libDF's attenuation limit – for those who find full isolation too hard.
pub fn residual(amount: f32) -> f32 {
    if !amount.is_finite() || amount >= 0.995 {
        return 0.0;
    }
    let limit_db = 10.0 + 20.0 * amount.clamp(0.0, 1.0);
    10f32.powf(-limit_db / 20.0)
}

impl Settings {
    /// From the normalized (0…1) VST parameters. Noise: < 0.25 off, < 0.75 normal, else strong;
    /// Isolate ≥ 0.5 = Stemmeisolering whatever Noise says.
    pub fn from_normalized(p: &[f32]) -> Settings {
        let p = |i: usize| p.get(i).copied().unwrap_or(DEFAULTS[i]);
        Settings {
            echo: p(0) >= 0.5,
            noise: if p(3) >= 0.5 {
                Noise::Isolate
            } else if p(1) < 0.25 {
                Noise::Off
            } else if p(1) < 0.75 {
                Noise::Normal
            } else {
                Noise::Strong
            },
            high_pass: p(2) >= 0.5,
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
    /// Our own rumble filter, when WebRTC's processing is not used (see `needs_apm`).
    hp: HighPass,
    iso: Iso,
    /// Stemmeisolering's fallback is delayed like the network, so switching makes no jump; the
    /// raw frames are kept to start the network where the fallback is.
    iso_delay: std::collections::VecDeque<[f32; FRAME]>,
    iso_raw: std::collections::VecDeque<[f32; FRAME]>,
    /// What goes into the network, delayed like its output, for `residual` (Styrke).
    iso_dry: std::collections::VecDeque<[f32; FRAME]>,
    residual: f32,
    lift: Lift,
    pub stats: Stats,
}

/// Level lift in front of Stemmeisolering. DeepFilterNet only knows speech at normal levels: below
/// about −50 dBFS it takes a voice for noise and removes it completely (measured on real speech:
/// −46 dBFS kept, −56 dBFS gone – a user's GoXLR Mini Chat Mic gave −55 dB while talking, 0.15.1).
/// So the mic is lifted so its loud frames sit near −20 dBFS before the network, and the network's
/// output is lowered by exactly the same gain (the one its frame had going in): what comes out has
/// the mic's own level, only cleaned.
#[cfg_attr(not(feature = "deepfilter"), allow(dead_code))]
pub(crate) struct Lift {
    /// Level of the loud frames (dBFS): rises at once, falls 5 dB/s.
    level_db: f32,
    gain_db: f32,
    /// Gains of the frames still inside the network (its delay), oldest first.
    pending: std::collections::VecDeque<f32>,
}

#[cfg_attr(not(feature = "deepfilter"), allow(dead_code))]
impl Lift {
    const TARGET_DB: f32 = -20.0;
    const MAX_GAIN_DB: f32 = 40.0;
    /// Frames below this are the GoXLR's gate or digital silence: they say nothing about the level.
    const FLOOR_DB: f32 = -90.0;
    const FALL_DB: f32 = 0.05;
    const STEP_DB: f32 = 6.0;

    pub(crate) fn new() -> Lift {
        Lift { level_db: -60.0, gain_db: 0.0, pending: std::collections::VecDeque::new() }
    }

    pub(crate) fn reset(&mut self) {
        *self = Lift::new();
    }

    /// The linear gain for this frame going into the network (and remembered for its output).
    pub(crate) fn gain_in(&mut self, frame: &[f32]) -> f32 {
        let ms = frame.iter().map(|v| v * v).sum::<f32>() / frame.len().max(1) as f32;
        let db = 10.0 * (ms + 1e-20).log10();
        if db > Self::FLOOR_DB {
            self.level_db = db.max(self.level_db - Self::FALL_DB);
        }
        let want = (Self::TARGET_DB - self.level_db).clamp(0.0, Self::MAX_GAIN_DB);
        // Down at most 6 dB a frame (a loud word after a quiet spell); up as the level falls (slowly).
        self.gain_db = if want < self.gain_db { want.max(self.gain_db - Self::STEP_DB) } else { want };
        let g = 10f32.powf(self.gain_db / 20.0);
        self.pending.push_back(g);
        g
    }

    /// The gain to undo on the network's output (the frame `delay` frames back).
    pub(crate) fn gain_out(&mut self, delay: usize) -> f32 {
        if self.pending.len() > delay {
            self.pending.pop_front().unwrap_or(1.0)
        } else {
            self.pending.front().copied().unwrap_or(1.0)
        }
    }

    /// Frames fed to the network without a lift (when it starts where the fallback is).
    pub(crate) fn seed(&mut self, frames: usize) {
        self.pending = std::iter::repeat(1.0).take(frames).collect();
    }
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

/// WebRTC's processing is only needed for the echo canceller and its noise suppression. It splits
/// 48 kHz into bands (at 32 kHz internally), which cuts everything above 16 kHz and turns the phase;
/// measured on clean speech: 2,0 dB spectral distance with only its high-pass on, 0,7 dB without.
/// So without those, the high-pass is our own (0.15.0).
fn needs_apm(s: &Settings) -> bool {
    s.echo || matches!(s.noise, Noise::Normal | Noise::Strong)
}

/// Rumble filter: 4th-order Butterworth high-pass at 80 Hz (two biquads, RBJ), full band.
#[derive(Clone)]
struct HighPass {
    coef: [[f32; 5]; 2],
    state: [[f32; 2]; 2],
}

impl HighPass {
    fn new(fc: f32) -> HighPass {
        let mut coef = [[0.0; 5]; 2];
        // Q of the two sections of a 4th-order Butterworth.
        for (c, q) in coef.iter_mut().zip([0.541_196_1_f32, 1.306_563]) {
            let w = 2.0 * std::f32::consts::PI * fc / RATE as f32;
            let (sn, cs) = w.sin_cos();
            let alpha = sn / (2.0 * q);
            let a0 = 1.0 + alpha;
            *c = [(1.0 + cs) / 2.0 / a0, -(1.0 + cs) / a0, (1.0 + cs) / 2.0 / a0, -2.0 * cs / a0, (1.0 - alpha) / a0];
        }
        HighPass { coef, state: [[0.0; 2]; 2] }
    }

    fn reset(&mut self) {
        self.state = [[0.0; 2]; 2];
    }

    /// Transposed direct form II.
    fn process(&mut self, x: &mut [f32]) {
        for v in x.iter_mut() {
            let mut y = *v;
            for (c, z) in self.coef.iter().zip(self.state.iter_mut()) {
                let out = c[0] * y + z[0];
                z[0] = c[1] * y - c[3] * out + z[1];
                z[1] = c[2] * y - c[4] * out;
                y = out;
            }
            *v = y;
        }
        if self.state.iter().flatten().any(|z| !z.is_finite()) {
            self.reset();
        }
    }
}

fn build_apm(s: &Settings) -> Option<AudioProcessing> {
    if !needs_apm(s) {
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
            hp: HighPass::new(80.0),
            iso: if settings.noise == Noise::Isolate { start_network() } else { Iso::Idle },
            iso_delay: std::collections::VecDeque::new(),
            iso_raw: std::collections::VecDeque::new(),
            iso_dry: std::collections::VecDeque::new(),
            residual: 0.0,
            lift: Lift::new(),
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
                self.iso_dry = self.iso_raw.clone();
                self.lift.seed(self.iso_raw.len());
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

    /// Styrke for Stemmeisolering (the Amount parameter); changes nothing else.
    pub fn set_amount(&mut self, amount: f32) {
        self.residual = residual(amount);
    }

    /// New settings; the processing starts over when they change.
    pub fn set(&mut self, settings: Settings) {
        if settings != self.settings {
            if settings.noise == Noise::Isolate && matches!(self.iso, Iso::Idle) {
                self.iso = start_network();
            }
            self.settings = settings;
            self.apm = build_apm(&settings);
            self.hp.reset();
            self.iso_dry.clear();
            self.rnn = DenoiseState::new();
            self.rnd_len = 0;
        }
    }

    pub fn reset(&mut self) {
        self.apm = build_apm(&self.settings);
        self.hp.reset();
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
        self.iso_dry.clear();
        self.lift.reset();
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
        if !self.settings.active() {
            self.out = self.inp;
            return;
        }
        self.work = self.inp;
        if let Some(apm) = self.apm.as_mut() {
            if apm.process_capture_f32(&[&self.inp[..]], &mut [&mut self.work[..]]).is_err() {
                self.work = self.inp;
            }
        } else if self.settings.high_pass {
            self.hp.process(&mut self.work);
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
            let g = self.lift.gain_in(&self.work);
            let mut lifted = self.work;
            lifted.iter_mut().for_each(|v| *v *= g);
            if net.process(&lifted, &mut out).is_ok() {
                let undo = 1.0 / self.lift.gain_out(ISOLATE_FRAMES);
                out.iter_mut().for_each(|v| *v *= undo);
                // Styrke: some of the mic as it came in, aligned with the network's output.
                self.iso_dry.push_back(self.work);
                if self.iso_dry.len() > ISOLATE_FRAMES {
                    if let Some(dry) = self.iso_dry.pop_front() {
                        let m = self.residual;
                        if m > 0.0 {
                            for (o, d) in out.iter_mut().zip(dry.iter()) {
                                *o = (1.0 - m) * *o + m * d;
                            }
                        }
                    }
                }
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
        self.hp.reset();
        self.rnn = DenoiseState::new();
    }
}

#[cfg(test)]
mod tests;
#[cfg(all(test, feature = "deepfilter"))]
mod tests_df;
