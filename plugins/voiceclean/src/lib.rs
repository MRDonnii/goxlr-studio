//! "Ren mikrofon": the microphone cleaned before Discord, games and everything else get it.
//!
//! Runs in GoXLR Studio's EQ engine (Equalizer APO) on the GoXLR's "Chat Mic" as a VST2 plugin:
//! - echo cancellation – WebRTC's AEC3: what the speakers play (sent by GoXLR Studio through
//!   shared memory, see `ring`) is removed from the mic, so others do not hear themselves or the
//!   game when you play on speakers;
//! - noise suppression – WebRTC's noise suppression, and in "strong" mode also RNNoise (a small
//!   neural network), which removes keyboard, fan and game sound between and under the words;
//! - a high-pass filter against rumble.
//!
//! Everything runs on 10 ms frames (480 samples at 48 kHz) in mono, with a constant latency of one
//! frame. Other sample rates pass through untouched. Nothing here may stop the sound: on any
//! problem the plugin passes the mic through unchanged.
use nnnoiseless::DenoiseState;
use sonora::config::{EchoCanceller, HighPassFilter, NoiseSuppression, NoiseSuppressionLevel};
use sonora::{AudioProcessing, Config, StreamConfig};

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
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Settings {
    pub echo: bool,
    pub noise: Noise,
    pub high_pass: bool,
}

/// Parameter names as Equalizer APO sets them (`VSTPlugin: Library "…" Echo 1 Noise 1 HighPass 1`).
pub const PARAMS: [&str; 3] = ["Echo", "Noise", "HighPass"];
pub const DEFAULTS: [f32; 3] = [1.0, 0.5, 1.0];

impl Settings {
    /// From the normalized (0…1) VST parameters. Noise: < 0.25 off, < 0.75 normal, else strong.
    pub fn from_normalized(p: &[f32; 3]) -> Settings {
        Settings {
            echo: p[0] >= 0.5,
            noise: if p[1] < 0.25 { Noise::Off } else if p[1] < 0.75 { Noise::Normal } else { Noise::Strong },
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
    pub stats: Stats,
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
            stats: Stats::default(),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings
    }

    /// New settings; the processing starts over when they change.
    pub fn set(&mut self, settings: Settings) {
        if settings != self.settings {
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
    }

    /// The constant delay through the cleaner, in samples.
    pub fn latency(&self) -> usize {
        FRAME
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
        if self.settings.noise == Noise::Strong {
            for (o, &x) in self.work2.iter_mut().zip(self.work.iter()) {
                *o = x * 32768.0;
            }
            let mut den = [0f32; FRAME];
            self.rnn.process_frame(&mut den, &self.work2);
            for (o, &x) in self.work.iter_mut().zip(den.iter()) {
                *o = x / 32768.0;
            }
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
    }

    fn reset_keep_framing(&mut self) {
        self.apm = build_apm(&self.settings);
        self.rnn = DenoiseState::new();
    }
}

#[cfg(test)]
mod tests;
