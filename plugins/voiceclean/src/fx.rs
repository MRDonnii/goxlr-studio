//! Stemmeskifter: voice effects on the mic after it is cleaned (0.16.0). The GoXLR Mini has no
//! voice effects of its own, so they run here, on Chat Mic – what Discord and games hear.
//!
//! GoXLR Studio picks the effect through the shared memory (`ring::Ring::fx_command`), so a key
//! switches it at once without reloading the engine's config. Changing effect fades the old one
//! out and the new one in over 10 ms; everything ends in a soft limiter, so nothing can clip.
//! Mono, 48 kHz.

use crate::RATE;

/// The effects, by the number GoXLR Studio sends (0 = off). Also in public/js/voicefx.js.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    Off,
    /// Pitch down 5 semitones.
    Deep,
    /// Pitch up 4 semitones.
    High,
    /// Pitch up 9 semitones.
    Chipmunk,
    /// Pitch down 9 semitones, driven.
    Monster,
    /// Ring modulation + a short metallic comb.
    Robot,
    /// Narrow band, driven hard.
    Megaphone,
    /// Telephone band, a little drive.
    Radio,
    /// Big room (Schroeder reverb).
    Cave,
    /// Echo, 320 ms.
    Echo,
}

impl Effect {
    pub fn from_id(id: u32) -> Effect {
        match id {
            1 => Effect::Deep,
            2 => Effect::High,
            3 => Effect::Chipmunk,
            4 => Effect::Monster,
            5 => Effect::Robot,
            6 => Effect::Megaphone,
            7 => Effect::Radio,
            8 => Effect::Cave,
            9 => Effect::Echo,
            _ => Effect::Off,
        }
    }

    fn semitones(self) -> Option<f32> {
        match self {
            Effect::Deep => Some(-5.0),
            Effect::High => Some(4.0),
            Effect::Chipmunk => Some(9.0),
            Effect::Monster => Some(-9.0),
            _ => None,
        }
    }
}

/// The command as GoXLR Studio writes it: effect in the low byte, how much of it (0–100 %, 0 =
/// 100) in the next.
pub fn decode(cmd: u32) -> (Effect, f32) {
    let effect = Effect::from_id(cmd & 0xff);
    let mix = ((cmd >> 8) & 0xff) as f32;
    let mix = if mix == 0.0 { 1.0 } else { (mix / 100.0).clamp(0.0, 1.0) };
    (effect, mix)
}

pub fn encode(effect_id: u32, mix_pct: u32) -> u32 {
    (effect_id & 0xff) | ((mix_pct.min(100) & 0xff) << 8)
}

/// Pitch shifter: two read heads sweep a delay line, crossfaded with sin² windows (the classic
/// rotating-head design). 40 ms window – fine for a voice, little delay.
struct Pitch {
    buf: Vec<f32>,
    pos: usize,
    phase: f32,
}

const PITCH_WINDOW: usize = (RATE as usize) / 25; // 40 ms

impl Pitch {
    fn new() -> Pitch {
        Pitch { buf: vec![0.0; PITCH_WINDOW * 2 + 4], pos: 0, phase: 0.0 }
    }

    fn read(&self, delay: f32) -> f32 {
        let n = self.buf.len();
        let d = delay.clamp(1.0, (n - 3) as f32);
        let i = d.floor() as usize;
        let f = d - i as f32;
        let a = self.buf[(self.pos + n - i) % n];
        let b = self.buf[(self.pos + n - i - 1) % n];
        a + (b - a) * f
    }

    fn process(&mut self, x: f32, ratio: f32) -> f32 {
        let n = self.buf.len();
        self.pos = (self.pos + 1) % n;
        self.buf[self.pos] = x;
        let w = PITCH_WINDOW as f32;
        // The delay changes by (1 - ratio) per sample: a falling delay reads faster (higher pitch).
        self.phase = (self.phase + (1.0 - ratio) / w).rem_euclid(1.0);
        let p2 = (self.phase + 0.5).rem_euclid(1.0);
        let g1 = (std::f32::consts::PI * self.phase).sin().powi(2);
        let g2 = (std::f32::consts::PI * p2).sin().powi(2);
        self.read(self.phase * w + 1.0) * g1 + self.read(p2 * w + 1.0) * g2
    }
}

/// RBJ biquad (direct form I).
#[derive(Clone, Copy)]
struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
    x: [f32; 2],
    y: [f32; 2],
}

impl Biquad {
    fn new(kind: char, fc: f32, q: f32) -> Biquad {
        let w = 2.0 * std::f32::consts::PI * fc / RATE as f32;
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q);
        let a0 = 1.0 + alpha;
        let (b, a) = match kind {
            'h' => ([(1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0], [-2.0 * c, 1.0 - alpha]),
            _ => ([(1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0], [-2.0 * c, 1.0 - alpha]),
        };
        Biquad { b: [b[0] / a0, b[1] / a0, b[2] / a0], a: [a[0] / a0, a[1] / a0], x: [0.0; 2], y: [0.0; 2] }
    }

    fn process(&mut self, x: f32) -> f32 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1] - self.a[0] * self.y[0] - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

/// A band: high-pass at `lo` and low-pass at `hi`, two biquads each (24 dB/oct).
struct Band {
    f: [Biquad; 4],
}

impl Band {
    fn new(lo: f32, hi: f32) -> Band {
        Band { f: [Biquad::new('h', lo, 0.707), Biquad::new('h', lo, 0.707), Biquad::new('l', hi, 0.707), Biquad::new('l', hi, 0.707)] }
    }

    fn process(&mut self, x: f32) -> f32 {
        self.f.iter_mut().fold(x, |v, f| f.process(v))
    }
}

/// Schroeder/Freeverb-style reverb: four combs into two all-passes.
struct Reverb {
    combs: Vec<(Vec<f32>, usize, f32)>,
    alls: Vec<(Vec<f32>, usize)>,
}

impl Reverb {
    fn new() -> Reverb {
        let scale = RATE as f32 / 44100.0;
        let combs = [1116, 1188, 1277, 1356].iter().map(|&n| (vec![0.0; (n as f32 * scale) as usize], 0, 0.0)).collect();
        let alls = [556, 441].iter().map(|&n| (vec![0.0; (n as f32 * scale) as usize], 0)).collect();
        Reverb { combs, alls }
    }

    fn process(&mut self, x: f32) -> f32 {
        let mut out = 0.0;
        for (buf, i, lp) in self.combs.iter_mut() {
            let y = buf[*i];
            *lp = y * 0.75 + *lp * 0.25; // damping
            buf[*i] = x * 0.3 + *lp * 0.84;
            *i = (*i + 1) % buf.len();
            out += y;
        }
        for (buf, i) in self.alls.iter_mut() {
            let b = buf[*i];
            buf[*i] = out + b * 0.5;
            out = b - out;
            *i = (*i + 1) % buf.len();
        }
        out * 0.5
    }
}

struct Delay {
    buf: Vec<f32>,
    pos: usize,
}

impl Delay {
    fn new(samples: usize) -> Delay {
        Delay { buf: vec![0.0; samples.max(1)], pos: 0 }
    }

    /// The sample from `len` ago, and writes `x` in its place.
    fn tap(&mut self, x: f32) -> f32 {
        let y = self.buf[self.pos];
        self.buf[self.pos] = x;
        self.pos = (self.pos + 1) % self.buf.len();
        y
    }
}

pub struct VoiceFx {
    effect: Effect,
    /// The effect asked for (switched to when the old one has faded out).
    wanted: Effect,
    mix: f32,
    /// Fade of the effect in/out (0…1) when switching.
    fade: f32,
    pitch: Pitch,
    band: Band,
    reverb: Reverb,
    echo: Delay,
    comb: Delay,
    osc: f32,
}

/// 10 ms fade when switching.
const FADE_STEP: f32 = 1.0 / (RATE as f32 / 100.0);

impl Default for VoiceFx {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceFx {
    pub fn new() -> VoiceFx {
        VoiceFx {
            effect: Effect::Off,
            wanted: Effect::Off,
            mix: 1.0,
            fade: 0.0,
            pitch: Pitch::new(),
            band: Band::new(300.0, 3400.0),
            reverb: Reverb::new(),
            echo: Delay::new(RATE as usize * 32 / 100),
            comb: Delay::new(RATE as usize / 200),
            osc: 0.0,
        }
    }

    /// The effect GoXLR Studio asks for (a command from `encode`).
    pub fn set_command(&mut self, cmd: u32) {
        let (effect, mix) = decode(cmd);
        self.wanted = effect;
        self.mix = mix;
    }

    /// The effect running now (Off once a switch to off has faded out).
    pub fn active(&self) -> Effect {
        if self.fade > 0.0 { self.effect } else { Effect::Off }
    }

    fn start(&mut self, e: Effect) {
        self.effect = e;
        self.pitch = Pitch::new();
        self.band = match e {
            Effect::Megaphone => Band::new(600.0, 3000.0),
            _ => Band::new(300.0, 3400.0),
        };
        self.reverb = Reverb::new();
        self.echo = Delay::new(RATE as usize * 32 / 100);
        self.comb = Delay::new(RATE as usize / 200);
        self.osc = 0.0;
    }

    fn wet(&mut self, x: f32) -> f32 {
        let tau = 2.0 * std::f32::consts::PI;
        match self.effect {
            Effect::Off => x,
            e @ (Effect::Deep | Effect::High | Effect::Chipmunk | Effect::Monster) => {
                let st = e.semitones().unwrap_or(0.0);
                let y = self.pitch.process(x, 2f32.powf(st / 12.0));
                if e == Effect::Monster { (y * 3.0).tanh() * 0.7 } else { y }
            }
            Effect::Robot => {
                self.osc = (self.osc + 55.0 / RATE as f32) % 1.0;
                let ring = x * (tau * self.osc).sin();
                let c = self.comb.tap(ring);
                (ring + 0.6 * c) * 1.6
            }
            Effect::Megaphone => (self.band.process(x) * 8.0).tanh() * 0.6,
            Effect::Radio => (self.band.process(x) * 2.5).tanh() * 0.8,
            Effect::Cave => x * 0.6 + self.reverb.process(x) * 0.9,
            Effect::Echo => {
                let d = self.echo.buf[self.echo.pos];
                let y = x + 0.45 * d;
                self.echo.tap(y);
                y
            }
        }
    }

    /// Processes mono samples in place.
    pub fn process(&mut self, block: &mut [f32]) {
        if self.wanted == Effect::Off && self.fade <= 0.0 {
            self.effect = Effect::Off;
            return;
        }
        for s in block.iter_mut() {
            let x = if s.is_finite() { *s } else { 0.0 };
            // Switching: fade the running effect out, then start the new one and fade it in.
            if self.wanted != self.effect {
                if self.fade > 0.0 {
                    self.fade = (self.fade - FADE_STEP).max(0.0);
                } else {
                    self.start(self.wanted);
                }
            } else if self.effect != Effect::Off {
                self.fade = (self.fade + FADE_STEP).min(1.0);
            }
            let y = if self.effect == Effect::Off { x } else { self.wet(x) };
            let m = self.mix * self.fade;
            let out = x * (1.0 - m) + y * m;
            // Soft limiter: never above full scale, transparent below about −6 dBFS.
            let out = if out.abs() > 0.5 { out.signum() * (0.5 + 0.5 * ((out.abs() - 0.5) / 0.5).tanh()) } else { out };
            *s = if out.is_finite() { out } else { 0.0 };
        }
        // A broken state (NaN inside a filter) starts the effect over.
        if !self.osc.is_finite() || self.pitch.buf.iter().any(|v| !v.is_finite()) {
            let e = self.effect;
            self.start(e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(f: f32, n: usize, amp: f32) -> Vec<f32> {
        (0..n).map(|i| amp * (2.0 * std::f32::consts::PI * f * i as f32 / RATE as f32).sin()).collect()
    }

    /// Frequency from positive-going zero crossings (good enough for a clean tone).
    fn freq(x: &[f32]) -> f32 {
        let c: Vec<usize> = (1..x.len()).filter(|&i| x[i - 1] <= 0.0 && x[i] > 0.0).collect();
        if c.len() < 3 {
            return 0.0;
        }
        (c.len() - 1) as f32 * RATE as f32 / (c[c.len() - 1] - c[0]) as f32
    }

    fn run(cmd: u32, x: &[f32]) -> Vec<f32> {
        let mut fx = VoiceFx::new();
        fx.set_command(cmd);
        let mut y = x.to_vec();
        for ch in y.chunks_mut(480) {
            fx.process(ch);
        }
        y
    }

    #[test]
    fn commands_round_trip() {
        assert_eq!(decode(encode(5, 70)), (Effect::Robot, 0.7));
        assert_eq!(decode(encode(1, 0)), (Effect::Deep, 1.0));
        assert_eq!(decode(0).0, Effect::Off);
        assert_eq!(decode(200).0, Effect::Off, "unknown = off");
    }

    #[test]
    fn off_passes_the_mic_untouched() {
        let x = sine(300.0, 4800, 0.3);
        assert_eq!(run(0, &x), x);
    }

    #[test]
    fn pitch_effects_move_the_pitch() {
        let x = sine(200.0, RATE as usize, 0.3);
        for (id, st) in [(1u32, -5.0f32), (2, 4.0), (3, 9.0)] {
            let y = run(id, &x);
            // The heads cross-fade, so look at the level-weighted average over the second half.
            let f = freq(&y[RATE as usize / 2..]);
            let want = 200.0 * 2f32.powf(st / 12.0);
            assert!((f - want).abs() / want < 0.06, "effect {id}: {f} Hz, want {want}");
        }
    }

    #[test]
    fn nothing_clips_and_nothing_breaks() {
        let loud = sine(150.0, RATE as usize, 1.5);
        // (Off leaves the mic exactly as it is – that is tested above.)
        for id in 1..=9 {
            let y = run(id, &loud);
            assert!(y.iter().all(|v| v.is_finite() && v.abs() <= 1.0), "effect {id}");
        }
        let mut bad = sine(300.0, 4800, 0.3);
        bad[100] = f32::NAN;
        bad[200] = f32::INFINITY;
        // (Off touches nothing; the cleaner in front already turns bad samples into silence.)
        for id in 1..=9 {
            assert!(run(id, &bad).iter().all(|v| v.is_finite()), "effect {id}");
        }
    }

    #[test]
    fn effects_change_the_sound_and_keep_a_level() {
        // Voice-like: a low tone with overtones up to a few kHz.
        let x: Vec<f32> = sine(250.0, RATE as usize, 0.1).iter().zip(sine(1000.0, RATE as usize, 0.06)).zip(sine(2500.0, RATE as usize, 0.04)).map(|((a, b), c)| a + b + c).collect();
        let rms = |v: &[f32]| (v.iter().map(|s| s * s).sum::<f32>() / v.len() as f32).sqrt();
        for id in 1..=9 {
            let y = run(id, &x);
            let tail = &y[RATE as usize / 2..];
            let diff: f32 = tail.iter().zip(&x[RATE as usize / 2..]).map(|(a, b)| (a - b).abs()).sum::<f32>() / tail.len() as f32;
            assert!(diff > 0.01, "effect {id} changes the sound");
            let r = rms(tail) / rms(&x);
            assert!((0.25..4.0).contains(&r), "effect {id}: level ratio {r}");
        }
    }

    #[test]
    fn switching_fades_without_jumps() {
        let x = sine(220.0, RATE as usize, 0.3);
        let mut fx = VoiceFx::new();
        let mut y = x.clone();
        for (k, ch) in y.chunks_mut(480).enumerate() {
            match k {
                10 => fx.set_command(encode(5, 100)),
                40 => fx.set_command(encode(8, 100)),
                70 => fx.set_command(0),
                _ => {}
            }
            fx.process(ch);
        }
        // Sample-to-sample steps stay those of the signals (no clicks at the switches).
        let max_step = y.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
        assert!(max_step < 0.2, "{max_step}");
        assert_eq!(fx.active(), Effect::Off);
        // Off again: untouched from there on.
        assert_eq!(&y[80 * 480..], &x[80 * 480..]);
    }

    #[test]
    fn mix_blends_with_the_dry_voice() {
        let x = sine(250.0, RATE as usize / 2, 0.2);
        let full = run(encode(6, 100), &x);
        let half = run(encode(6, 50), &x);
        let d = |a: &[f32]| a[12000..].iter().zip(&x[12000..]).map(|(p, q)| (p - q).abs()).sum::<f32>();
        assert!(d(&half) < d(&full) * 0.75);
    }
}
