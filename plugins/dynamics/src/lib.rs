//! GoXLR Studio Dynamik: a compressor followed by a look-ahead brick-wall limiter, stereo-linked.
//! Built as a tiny VST2 plugin (vst.rs, no SDK – only the plain C ABI) so Equalizer APO's engine can
//! run it last in the chain ("VSTPlugin:" line written by the app). The DSP is plain Rust and tested here.

pub mod vst;

/// The parameters as the host sees them: name (≤ 8 characters) and the normalised value 0–1.
pub const PARAMS: [&str; 8] = ["Thresh", "Ratio", "Attack", "Release", "Makeup", "LimOn", "Ceiling", "LimRel"];

/// Real values ↔ normalised 0–1 (the app writes normalised values into the config).
pub mod map {
    pub fn threshold_db(n: f32) -> f32 { -40.0 + 40.0 * n }
    pub fn ratio(n: f32) -> f32 { 1.0 + 19.0 * n }
    pub fn attack_ms(n: f32) -> f32 { 0.1 * 1000f32.powf(n) }
    pub fn release_ms(n: f32) -> f32 { 10.0 * 200f32.powf(n) }
    pub fn makeup_db(n: f32) -> f32 { 24.0 * n }
    pub fn ceiling_db(n: f32) -> f32 { -12.0 + 12.0 * n }
    pub fn lim_release_ms(n: f32) -> f32 { 1000f32.powf(n) }
}

#[derive(Clone, Copy, Debug)]
pub struct Settings {
    pub threshold_db: f32,
    pub ratio: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
    pub limiter: bool,
    pub ceiling_db: f32,
    pub lim_release_ms: f32,
}

impl Settings {
    pub fn from_normalized(p: &[f32; 8]) -> Self {
        Settings {
            threshold_db: map::threshold_db(p[0]),
            ratio: map::ratio(p[1]),
            attack_ms: map::attack_ms(p[2]),
            release_ms: map::release_ms(p[3]),
            makeup_db: map::makeup_db(p[4]),
            limiter: p[5] >= 0.5,
            ceiling_db: map::ceiling_db(p[6]),
            lim_release_ms: map::lim_release_ms(p[7]),
        }
    }
}

/// Defaults: no compression (ratio 1), limiter on at −1 dB.
pub const DEFAULTS: [f32; 8] = [0.75, 0.0, 0.5, 0.5, 0.0, 1.0, 11.0 / 12.0, 0.5];

const LOOKAHEAD_S: f32 = 0.002;
const KNEE_DB: f32 = 6.0;

pub struct Dynamics {
    rate: f32,
    s: Settings,
    // compressor
    gr_db: f32,
    // limiter
    look: usize,
    delay: Vec<[f32; 2]>,
    target: Vec<f32>,
    boxbuf: Vec<f32>,
    box_sum: f64,
    pos: usize,
    g_rel: f32,
}

fn coef(ms: f32, rate: f32) -> f32 {
    if ms <= 0.0 { 0.0 } else { (-1.0 / (ms * 0.001 * rate)).exp() }
}

pub fn db_to_lin(db: f32) -> f32 { 10f32.powf(db / 20.0) }

/// The compressor's static curve (soft knee): output level in dB for an input level in dB.
pub fn gain_computer(x: f32, t: f32, r: f32) -> f32 {
    let d = x - t;
    if 2.0 * d < -KNEE_DB {
        x
    } else if 2.0 * d.abs() <= KNEE_DB {
        x + (1.0 / r - 1.0) * (d + KNEE_DB / 2.0).powi(2) / (2.0 * KNEE_DB)
    } else {
        t + d / r
    }
}

impl Dynamics {
    pub fn new(rate: f32) -> Self {
        let mut d = Dynamics { rate, s: Settings::from_normalized(&DEFAULTS), gr_db: 0.0, look: 1, delay: vec![], target: vec![], boxbuf: vec![], box_sum: 0.0, pos: 0, g_rel: 1.0 };
        d.set_rate(rate);
        d
    }

    pub fn set_rate(&mut self, rate: f32) {
        self.rate = rate.max(8000.0);
        self.look = ((self.rate * LOOKAHEAD_S).round() as usize).max(1);
        self.reset();
    }

    pub fn latency(&self) -> usize { self.look }

    pub fn reset(&mut self) {
        let n = self.look + 1;
        self.delay = vec![[0.0; 2]; n];
        self.target = vec![1.0; n];
        self.boxbuf = vec![1.0; self.look];
        self.box_sum = self.look as f64;
        self.pos = 0;
        self.g_rel = 1.0;
        self.gr_db = 0.0;
    }

    pub fn set(&mut self, s: Settings) { self.s = s; }

    /// One stereo frame in, one out (delayed by the look-ahead).
    #[inline]
    pub fn process_frame(&mut self, l: f32, r: f32) -> (f32, f32) {
        let s = self.s;
        // Compressor (feed-forward, peak detector, smoothed gain reduction).
        let (mut l, mut r) = (l, r);
        if s.ratio > 1.01 || s.makeup_db.abs() > 0.001 {
            let peak = l.abs().max(r.abs()).max(1e-9);
            let x = 20.0 * peak.log10();
            let want = gain_computer(x, s.threshold_db, s.ratio) - x; // ≤ 0
            let c = if want < self.gr_db { coef(s.attack_ms, self.rate) } else { coef(s.release_ms, self.rate) };
            self.gr_db = want + c * (self.gr_db - want);
            let g = db_to_lin(self.gr_db + s.makeup_db);
            l *= g;
            r *= g;
        }
        if !s.limiter {
            return (l, r);
        }
        // Limiter: the gain each sample needs, the minimum over the look-ahead, instant down and slow
        // up, then averaged over the look-ahead – the audio is delayed by as much, so the gain is
        // down before the peak arrives (no overshoot, no hard edges).
        let n = self.delay.len();
        let ceil = db_to_lin(s.ceiling_db) * 0.9995;
        let peak = l.abs().max(r.abs());
        self.target[self.pos] = if peak > ceil { ceil / peak } else { 1.0 };
        self.delay[self.pos] = [l, r];
        let m = self.target.iter().copied().fold(1.0f32, f32::min);
        let rel = coef(s.lim_release_ms, self.rate);
        self.g_rel = if m < self.g_rel { m } else { m + rel * (self.g_rel - m) };
        let bi = self.pos % self.look;
        self.box_sum += (self.g_rel - self.boxbuf[bi]) as f64;
        self.boxbuf[bi] = self.g_rel;
        let g = (self.box_sum / self.look as f64) as f32;
        self.pos = (self.pos + 1) % n;
        let [dl, dr] = self.delay[self.pos]; // the oldest frame (look samples ago)
        (dl * g, dr * g)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(limiter: bool, ratio: f32) -> Settings {
        Settings { threshold_db: -20.0, ratio, attack_ms: 1.0, release_ms: 100.0, makeup_db: 0.0, limiter, ceiling_db: -1.0, lim_release_ms: 50.0 }
    }

    #[test]
    fn limiter_never_goes_over_the_ceiling() {
        let mut d = Dynamics::new(48000.0);
        d.set(settings(true, 1.0));
        let ceil = db_to_lin(-1.0);
        let mut seed = 12345u32;
        let mut max = 0f32;
        for i in 0..96000 {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (seed >> 8) as f32 / (1u32 << 24) as f32 * 2.0 - 1.0;
            // Loud bursts and single-sample spikes up to +12 dB over full scale.
            let amp = if (i / 4000) % 2 == 0 { 0.3 } else { 4.0 };
            let x = if i % 9973 == 0 { 4.0 } else { noise * amp };
            let (l, r) = d.process_frame(x, -x * 0.5);
            max = max.max(l.abs()).max(r.abs());
        }
        assert!(max <= ceil * 1.0001, "max {max} > ceiling {ceil}");
    }

    #[test]
    fn quiet_audio_passes_unchanged_after_the_delay() {
        let mut d = Dynamics::new(48000.0);
        d.set(settings(true, 1.0));
        let look = d.latency();
        let input: Vec<f32> = (0..2000).map(|i| 0.5 * (i as f32 * 0.05).sin()).collect();
        let out: Vec<f32> = input.iter().map(|&x| d.process_frame(x, x).0).collect();
        for i in look..2000 {
            assert!((out[i] - input[i - look]).abs() < 1e-5, "sample {i}");
        }
    }

    #[test]
    fn compressor_curve() {
        assert_eq!(gain_computer(-40.0, -20.0, 4.0), -40.0);
        assert!((gain_computer(0.0, -20.0, 4.0) - -15.0).abs() < 1e-4);
        // Soft knee: continuous at its edges.
        let a = gain_computer(-23.0, -20.0, 4.0);
        assert!((a - -23.0).abs() < 1e-4);
        let b = gain_computer(-17.0, -20.0, 4.0);
        assert!((b - (-20.0 + 3.0 / 4.0)).abs() < 1e-4);
    }

    #[test]
    fn compressor_lowers_loud_parts() {
        let mut d = Dynamics::new(48000.0);
        d.set(settings(false, 4.0));
        let mut last = 0f32;
        for i in 0..48000 {
            let (l, _) = d.process_frame((i as f32 * 0.06).sin(), 0.0);
            if i > 40000 { last = last.max(l.abs()); }
        }
        // 0 dBFS sine, threshold −20, ratio 4 → about −15 dB.
        let db = 20.0 * last.log10();
        assert!(db < -13.0 && db > -17.0, "{db}");
    }

    #[test]
    fn app_values_mean_what_the_app_thinks() {
        // public/js/dynamicsmodel.js turns "Natmode" (−32 dB, 4:1, 5 ms, 300 ms, +10 dB, −1 dB, 80 ms)
        // into these numbers (tests/dynamics.test.mjs checks the same vector).
        let s = Settings::from_normalized(&[0.2, 0.1579, 0.5663, 0.6419, 0.4167, 1.0, 0.9167, 0.6344]);
        let near = |a: f32, b: f32, tol: f32| (a - b).abs() <= tol;
        assert!(near(s.threshold_db, -32.0, 0.01) && near(s.ratio, 4.0, 0.01) && near(s.attack_ms, 5.0, 0.05));
        assert!(near(s.release_ms, 300.0, 1.0) && near(s.makeup_db, 10.0, 0.01) && near(s.ceiling_db, -1.0, 0.01) && near(s.lim_release_ms, 80.0, 0.5));
        assert!(s.limiter);
    }

    #[test]
    fn mapping_endpoints() {
        assert_eq!(map::threshold_db(0.0), -40.0);
        assert_eq!(map::ratio(1.0), 20.0);
        assert!((map::attack_ms(1.0) - 100.0).abs() < 1e-3);
        assert!((map::release_ms(0.0) - 10.0).abs() < 1e-6);
        assert_eq!(map::ceiling_db(1.0), 0.0);
        let s = Settings::from_normalized(&DEFAULTS);
        assert!(s.limiter && (s.ceiling_db + 1.0).abs() < 1e-5 && s.ratio == 1.0);
    }
}
