//! Stemmeskifter: voice effects on the mic after it is cleaned. The GoXLR Mini has no voice
//! effects of its own, so they run here, on Chat Mic – what Discord and games hear.
//!
//! GoXLR Studio picks the effect through the shared memory (`ring::Ring::fx_command`), so a key
//! switches it at once without reloading the engine's config. Changing effect fades the old one
//! out and the new one in over 10 ms; everything ends in a soft limiter, so nothing can clip.
//! Mono, 48 kHz.
//!
//! The voices (Dyb, Lysere, Jordegern, Monster, Robot) use pitch-synchronous overlap-add (PSOLA,
//! `Psola`): the voice's pitch is tracked (YIN), the sound is cut into grains of two pitch periods
//! around each glottal pulse and laid down again at the new pitch's spacing. That keeps the voice
//! whole – no warble – and the formants (what makes it sound like a person) are moved on their own:
//! a grain read faster or slower moves them up or down. Unvoiced sounds (s, f, t) keep their
//! timing. Robot lays the pulses at one fixed pitch. Latency: `LATENCY` (43 ms).

use crate::RATE;

/// The effects, by the number GoXLR Studio sends (0 = off). Also in public/js/voicefx.js – the
/// numbers must never change.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    Off,
    /// Lower and bigger: pitch −4 semitones, formants −2.
    Deep,
    /// Higher and lighter: pitch +4, formants +2.
    High,
    /// Pitch +8, formants +6.
    Chipmunk,
    /// Pitch −8, formants −4, growl and a small room.
    Monster,
    /// One fixed pitch (monotone) and a metallic comb.
    Robot,
    /// Horn: narrow band with a honk, driven hard.
    Megaphone,
    /// Walkie-talkie: telephone band, a little drive and hiss.
    Radio,
    /// Big stone room (Freeverb).
    Cave,
    /// Echo, 280 ms, each repeat a little darker.
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

    /// The PSOLA voice: pitch and formant shift in semitones, and Robot's monotone.
    fn voice(self) -> Option<Shift> {
        let s = |pitch: f32, formant: f32| Some(Shift { beta: semis(pitch), gamma: semis(formant), monotone: None });
        match self {
            Effect::Deep => s(-4.0, -2.0),
            Effect::High => s(4.0, 2.0),
            Effect::Chipmunk => s(8.0, 6.0),
            Effect::Monster => s(-8.0, -4.0),
            Effect::Robot => Some(Shift { beta: 1.0, gamma: 1.0, monotone: Some(ROBOT_HZ) }),
            _ => None,
        }
    }
}

fn semis(st: f32) -> f32 {
    2f32.powf(st / 12.0)
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

#[derive(Clone, Copy, Debug, PartialEq)]
struct Shift {
    /// Pitch ratio.
    beta: f32,
    /// Formant ratio (how much faster a grain is read).
    gamma: f32,
    /// Robot: every voiced pulse at this pitch (Hz).
    monotone: Option<f32>,
}

const ROBOT_HZ: f32 = 105.0;

// ---- PSOLA -------------------------------------------------------------------------------------

/// Ring buffers of the pitch shifter (power of two).
const BUF: usize = 8192;
const MASK: usize = BUF - 1;
/// The pitch effects' delay: grains reach up to two periods (and a lower formant reads them
/// slower) ahead of the pulse they belong to. 2048 samples = 42.7 ms.
pub const LATENCY: usize = 2048;
/// Lowest and highest voice pitch tracked.
const MIN_F0: f32 = 75.0;
const MAX_F0: f32 = 500.0;
/// Longest period, and the longest half grain (a lowered formant reads a grain slower).
const P_MAX: usize = (RATE as f32 / MIN_F0) as usize + 1; // 641
const H_MAX: usize = 800;
/// Grain spacing in unvoiced sound (s, f, breath): 5 ms.
const UNVOICED_P: f32 = 240.0;
/// Pitch tracking runs at 12 kHz, every 5.3 ms, over 16 ms (+ the longest lag).
const DEC: usize = 4;
const DET_HOP: usize = 256;
const YIN_W: usize = 192;
const LAG_MIN: usize = ((RATE as usize / DEC) as f32 / MAX_F0) as usize; // 24
const LAG_MAX: usize = ((RATE as usize / DEC) as f32 / MIN_F0) as usize + 1; // 161
const YIN_LEN: usize = YIN_W + LAG_MAX + 2;
const DEC_BUF: usize = 1024;
/// Quieter than this (RMS, about −56 dBFS) counts as silence, not voice.
const SILENCE: f32 = 0.0016;

#[derive(Clone, Copy, Debug)]
struct Mark {
    pos: u64,
    period: f32,
    voiced: bool,
}

#[derive(Clone, Copy, Debug)]
struct Estimate {
    at: u64,
    period: f32,
    voiced: bool,
}

/// Pitch-synchronous overlap-add pitch and formant shifter.
struct Psola {
    shift: Shift,
    /// Input (low-passed for a raised formant, so grains read faster do not alias).
    inp: Vec<f32>,
    /// Input low-passed at 900 Hz: the glottal pulses stand out for placing the marks.
    lp: Vec<f32>,
    /// Output being built up by the grains.
    acc: Vec<f32>,
    /// Input samples so far (absolute time).
    n: u64,
    start: u64,
    pre: [Biquad; 2],
    mark_lp: [Biquad; 2],
    // Pitch tracking.
    aa: [Biquad; 2],
    dec: Vec<f32>,
    dn: u64,
    track: [Estimate; 32],
    tn: usize,
    raw: [f32; 3],
    raw_voiced: [bool; 3],
    // Marks on the input, grains on the output.
    marks: std::collections::VecDeque<Mark>,
    last_mark: u64,
    last_voiced: bool,
    next_grain: f64,
}

impl Psola {
    fn new() -> Psola {
        let mut p = Psola {
            shift: Shift { beta: 1.0, gamma: 1.0, monotone: None },
            inp: vec![0.0; BUF],
            lp: vec![0.0; BUF],
            acc: vec![0.0; BUF],
            n: 0,
            start: 0,
            pre: [Biquad::lowpass(20000.0, 0.707); 2],
            mark_lp: [Biquad::lowpass(900.0, 0.707); 2],
            aa: [Biquad::lowpass(2800.0, 0.707); 2],
            dec: vec![0.0; DEC_BUF],
            dn: 0,
            track: [Estimate { at: 0, period: UNVOICED_P, voiced: false }; 32],
            tn: 0,
            raw: [0.0; 3],
            raw_voiced: [false; 3],
            marks: std::collections::VecDeque::with_capacity(256),
            last_mark: 0,
            last_voiced: false,
            next_grain: 0.0,
        };
        p.reset(Shift { beta: 1.0, gamma: 1.0, monotone: None });
        p
    }

    /// Starts over with a new voice (no allocation – this runs on the audio thread).
    fn reset(&mut self, shift: Shift) {
        self.shift = shift;
        self.inp.fill(0.0);
        self.lp.fill(0.0);
        self.acc.fill(0.0);
        self.dec.fill(0.0);
        // Content above 20 kHz / γ would fold down when a grain is read γ times faster.
        let cut = (19000.0 / shift.gamma.max(1.0)).min(20000.0);
        self.pre = [Biquad::lowpass(cut, 0.54), Biquad::lowpass(cut, 1.31)];
        self.mark_lp = [Biquad::lowpass(900.0, 0.707); 2];
        self.aa = [Biquad::lowpass(2800.0, 0.54), Biquad::lowpass(2800.0, 1.31)];
        self.n = BUF as u64; // so times never go below 0
        self.start = self.n;
        self.dn = 0;
        self.tn = 0;
        self.raw = [0.0; 3];
        self.raw_voiced = [false; 3];
        self.marks.clear();
        self.last_mark = self.n;
        self.last_voiced = false;
        self.next_grain = self.n as f64;
    }

    /// The output is the shifted voice (until then the caller keeps the dry mic).
    fn ready(&self) -> bool {
        self.n >= self.start + LATENCY as u64
    }

    fn process(&mut self, x: f32) -> f32 {
        let n = self.n;
        let i = (n as usize) & MASK;
        self.inp[i] = self.pre.iter_mut().fold(x, |v, f| f.process(v));
        self.lp[i] = self.mark_lp.iter_mut().fold(x, |v, f| f.process(v));
        let d = self.aa.iter_mut().fold(x, |v, f| f.process(v));
        if n % DEC as u64 == 0 {
            self.dec[(self.dn as usize) % DEC_BUF] = d;
            self.dn += 1;
        }
        if n % DET_HOP as u64 == 0 && self.dn >= YIN_LEN as u64 {
            self.detect();
        }
        self.n += 1;
        self.place_marks();
        let o = self.n - 1 - LATENCY as u64;
        self.place_grains(o);
        let k = (o as usize) & MASK;
        let y = self.acc[k];
        self.acc[k] = 0.0;
        y
    }

    /// YIN on the latest 31 ms at 12 kHz.
    fn detect(&mut self) {
        let mut w = [0f32; YIN_LEN];
        let first = self.dn - YIN_LEN as u64;
        for (j, v) in w.iter_mut().enumerate() {
            *v = self.dec[((first + j as u64) as usize) % DEC_BUF];
        }
        // Anchored at the newest samples: lag τ compares the latest 16 ms with the τ before.
        let last = YIN_LEN - 1;
        let rms = (w[YIN_LEN - YIN_W..].iter().map(|v| v * v).sum::<f32>() / YIN_W as f32).sqrt();
        let mut d = [0f32; LAG_MAX + 2];
        for (tau, dv) in d.iter_mut().enumerate().skip(1) {
            let mut s = 0.0;
            for j in 0..YIN_W {
                let e = w[last - j] - w[last - j - tau];
                s += e * e;
            }
            *dv = s;
        }
        // Cumulative mean normalised difference.
        let mut cm = [1f32; LAG_MAX + 2];
        let mut run = 0.0;
        for tau in 1..d.len() {
            run += d[tau];
            cm[tau] = if run > 0.0 { d[tau] * tau as f32 / run } else { 1.0 };
        }
        let mut tau = 0;
        for t in LAG_MIN..=LAG_MAX {
            if cm[t] < 0.2 {
                let mut b = t;
                while b < LAG_MAX && cm[b + 1] < cm[b] {
                    b += 1;
                }
                tau = b;
                break;
            }
        }
        if tau == 0 {
            tau = (LAG_MIN..=LAG_MAX).min_by(|a, b| cm[*a].total_cmp(&cm[*b])).unwrap_or(LAG_MIN);
        }
        let voiced = cm[tau] < 0.35 && rms > SILENCE && tau > LAG_MIN && tau < LAG_MAX;
        // Parabolic interpolation for a period finer than the 12 kHz grid.
        let (a, b, c) = (cm[tau - 1], cm[tau], cm[tau + 1]);
        let den = a - 2.0 * b + c;
        let frac = if den.abs() > 1e-9 { (0.5 * (a - c) / den).clamp(-0.5, 0.5) } else { 0.0 };
        let period = (tau as f32 + frac) * DEC as f32;
        self.raw = [self.raw[1], self.raw[2], period];
        self.raw_voiced = [self.raw_voiced[1], self.raw_voiced[2], voiced];
        // Median of the last three while they are all voiced: one odd octave error is ignored.
        let period = if self.raw_voiced.iter().all(|v| *v) {
            let mut r = self.raw;
            r.sort_by(f32::total_cmp);
            r[1]
        } else {
            period
        };
        // The estimate holds for the middle of what it looked at.
        let at = self.n.saturating_sub(((YIN_W as f32 + period / DEC as f32) * DEC as f32 / 2.0) as u64);
        self.track[self.tn % self.track.len()] = Estimate { at, period, voiced };
        self.tn += 1;
    }

    /// The pitch around input time `t` (the latest estimate for times past it).
    fn period_at(&self, t: u64) -> (f32, bool) {
        let len = self.tn.min(self.track.len());
        if len == 0 {
            return (UNVOICED_P, false);
        }
        let mut best = self.track[(self.tn - 1) % self.track.len()];
        let mut dist = best.at.abs_diff(t);
        for k in 1..len {
            let e = self.track[(self.tn - 1 - k) % self.track.len()];
            let dd = e.at.abs_diff(t);
            if dd < dist {
                best = e;
                dist = dd;
            }
        }
        (best.period, best.voiced)
    }

    /// The pitch period at `t` interpolated between the two estimates around it (smooth, finer
    /// than the pulse marks, which jitter by a few samples). None unless both are voiced.
    fn smooth_period(&self, t: u64) -> Option<f32> {
        let len = self.tn.min(self.track.len());
        let (mut before, mut after): (Option<Estimate>, Option<Estimate>) = (None, None);
        for k in 0..len {
            let e = self.track[(self.tn - 1 - k) % self.track.len()];
            if e.at <= t {
                if before.is_none_or(|b| e.at > b.at) {
                    before = Some(e);
                }
            } else if after.is_none_or(|a| e.at < a.at) {
                after = Some(e);
            }
        }
        match (before, after) {
            (Some(b), Some(a)) if b.voiced && a.voiced => {
                let f = (t - b.at) as f32 / (a.at - b.at).max(1) as f32;
                Some(b.period + (a.period - b.period) * f)
            }
            (Some(b), None) if b.voiced => Some(b.period),
            _ => None,
        }
    }

    /// Analysis marks: one per pitch period on the strongest part of the pulse while voiced,
    /// every 5 ms otherwise.
    fn place_marks(&mut self) {
        let frontier = self.n - 200;
        loop {
            let t = self.last_mark;
            let (p, voiced) = self.period_at(t);
            let (pos, period) = if voiced {
                let (lo, hi) = if self.last_voiced {
                    (t as f32 + 0.75 * p, t as f32 + 1.25 * p)
                } else {
                    (t as f32 + 0.5 * p, t as f32 + 1.5 * p)
                };
                if hi as u64 >= frontier {
                    break;
                }
                let mut best = lo as u64;
                let mut val = f32::MIN;
                for s in lo as u64..=hi as u64 {
                    let v = self.lp[(s as usize) & MASK];
                    if v > val {
                        val = v;
                        best = s;
                    }
                }
                (best, p)
            } else {
                let pos = t + UNVOICED_P as u64;
                if pos >= frontier {
                    break;
                }
                (pos, UNVOICED_P)
            };
            if self.marks.len() == self.marks.capacity() {
                self.marks.pop_front();
            }
            self.marks.push_back(Mark { pos, period, voiced });
            self.last_mark = pos;
            self.last_voiced = voiced;
        }
    }

    /// Lays grains on the output up to where output time `o` is complete.
    fn place_grains(&mut self, o: u64) {
        while self.next_grain <= (o + H_MAX as u64 + 1) as f64 {
            let s = self.next_grain;
            let Some(m) = self.nearest(s) else {
                self.next_grain += UNVOICED_P as f64;
                continue;
            };
            let Shift { beta, gamma, monotone } = self.shift;
            let (step, scale) = if m.voiced {
                let step = match monotone {
                    Some(hz) => RATE as f32 / hz,
                    None => m.period / beta,
                };
                // More pulses per second → each a little quieter (same power).
                (step, (step / m.period).sqrt().min(1.5))
            } else {
                // Hann grains of 2h at spacing 240 sum to h/240.
                (UNVOICED_P, gamma.min(2.0))
            };
            let h = ((m.period / gamma) as usize).clamp(8, H_MAX);
            let centre = s.round() as i64;
            // Read no further than the input written so far.
            let latest = self.n as i64 - 3;
            let src0 = (m.pos as f64).min(latest as f64 - h as f64 * gamma as f64);
            for k in -(h as i64)..=(h as i64) {
                let at = centre + k;
                if at < o as i64 {
                    continue; // already played
                }
                let w = 0.5 + 0.5 * (std::f32::consts::PI * k as f32 / h as f32).cos();
                let x = self.read(src0 + k as f64 * gamma as f64);
                self.acc[(at as usize) & MASK] += scale * w * x;
            }
            self.next_grain += step as f64;
            while self.marks.len() > 2 && (self.marks[1].pos as f64) < s - 2.0 * P_MAX as f64 {
                self.marks.pop_front();
            }
        }
    }

    /// The mark nearest output time `s`, with the pitch period there: the spacing of the two
    /// pulses `s` lies between (so with the pitch unchanged the grains land exactly on the
    /// pulses they came from), or the newest estimate where that spacing is implausible.
    fn nearest(&self, s: f64) -> Option<Mark> {
        let mut best: Option<usize> = None;
        for (k, m) in self.marks.iter().enumerate() {
            if best.is_none_or(|b| (m.pos as f64 - s).abs() < (self.marks[b].pos as f64 - s).abs()) {
                best = Some(k);
            }
            if m.pos as f64 > s + P_MAX as f64 {
                break;
            }
        }
        let k = best?;
        let m = self.marks[k];
        if !m.voiced {
            return Some(m);
        }
        let (est, _) = self.period_at(m.pos);
        let j = if (m.pos as f64) <= s { k } else { k.saturating_sub(1) };
        let spacing = (j + 1 < self.marks.len() && self.marks[j].voiced && self.marks[j + 1].voiced)
            .then(|| (self.marks[j + 1].pos - self.marks[j].pos) as f32)
            .filter(|d| *d > 0.6 * est && *d < 1.6 * est && *d < P_MAX as f32);
        let period = spacing.unwrap_or(m.period);
        // With the pitch changed, the steps follow the smooth estimate (the grains are skipped or
        // repeated anyway) – unless it disagrees with the pulses (an octave slip).
        let period = if self.shift.beta != 1.0 || self.shift.monotone.is_some() {
            match self.smooth_period(s as u64) {
                Some(p) if (p / period - 1.0).abs() < 0.25 => p,
                _ => period,
            }
        } else {
            period
        };
        Some(Mark { pos: m.pos, period, voiced: true })
    }

    /// The input at a fractional time (4-point Hermite).
    fn read(&self, t: f64) -> f32 {
        let i = t.floor();
        let f = (t - i) as f32;
        let i = i as i64;
        let at = |k: i64| self.inp[((i + k) as usize) & MASK];
        let (xm1, x0, x1, x2) = (at(-1), at(0), at(1), at(2));
        let c1 = 0.5 * (x1 - xm1);
        let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
        let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        ((c3 * f + c2) * f + c1) * f + x0
    }
}

// ---- Filters and rooms -------------------------------------------------------------------------

/// RBJ biquad (direct form I).
#[derive(Clone, Copy, Debug)]
struct Biquad {
    b: [f32; 3],
    a: [f32; 2],
    x: [f32; 2],
    y: [f32; 2],
}

impl Biquad {
    fn coeffs(b: [f32; 3], a: [f32; 3]) -> Biquad {
        Biquad { b: [b[0] / a[0], b[1] / a[0], b[2] / a[0]], a: [a[1] / a[0], a[2] / a[0]], x: [0.0; 2], y: [0.0; 2] }
    }

    fn w(fc: f32) -> (f32, f32) {
        let w = 2.0 * std::f32::consts::PI * fc.min(0.49 * RATE as f32) / RATE as f32;
        w.sin_cos()
    }

    fn lowpass(fc: f32, q: f32) -> Biquad {
        let (s, c) = Self::w(fc);
        let al = s / (2.0 * q);
        Self::coeffs([(1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0], [1.0 + al, -2.0 * c, 1.0 - al])
    }

    fn highpass(fc: f32, q: f32) -> Biquad {
        let (s, c) = Self::w(fc);
        let al = s / (2.0 * q);
        Self::coeffs([(1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0], [1.0 + al, -2.0 * c, 1.0 - al])
    }

    fn peak(fc: f32, q: f32, db: f32) -> Biquad {
        let (s, c) = Self::w(fc);
        let al = s / (2.0 * q);
        let a = 10f32.powf(db / 40.0);
        Self::coeffs([1.0 + al * a, -2.0 * c, 1.0 - al * a], [1.0 + al / a, -2.0 * c, 1.0 - al / a])
    }

    fn low_shelf(fc: f32, db: f32) -> Biquad {
        let (s, c) = Self::w(fc);
        let a = 10f32.powf(db / 40.0);
        let al = s / 2.0 * 2f32.sqrt();
        let sa = 2.0 * a.sqrt() * al;
        Self::coeffs(
            [a * ((a + 1.0) - (a - 1.0) * c + sa), 2.0 * a * ((a - 1.0) - (a + 1.0) * c), a * ((a + 1.0) - (a - 1.0) * c - sa)],
            [(a + 1.0) + (a - 1.0) * c + sa, -2.0 * ((a - 1.0) + (a + 1.0) * c), (a + 1.0) + (a - 1.0) * c - sa],
        )
    }

    fn process(&mut self, x: f32) -> f32 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1] - self.a[0] * self.y[0] - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

/// A chain of biquads.
#[derive(Clone, Copy)]
struct Chain<const N: usize>([Biquad; N]);

impl<const N: usize> Chain<N> {
    fn process(&mut self, x: f32) -> f32 {
        self.0.iter_mut().fold(x, |v, f| f.process(v))
    }
}

/// Freeverb: eight damped combs into four all-passes, with a pre-delay.
struct Reverb {
    combs: [(Vec<f32>, usize, f32); 8],
    alls: [(Vec<f32>, usize); 4],
    pre: Delay,
    feedback: f32,
    damp: f32,
}

impl Reverb {
    fn new(feedback: f32, damp: f32, pre_ms: f32) -> Reverb {
        let scale = RATE as f32 / 44100.0;
        let len = |n: usize| ((n as f32 * scale) as usize).max(1);
        let combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map(|n| (vec![0.0; len(n)], 0, 0.0));
        let alls = [556, 441, 341, 225].map(|n| (vec![0.0; len(n)], 0));
        Reverb { combs, alls, pre: Delay::new((RATE as f32 * pre_ms / 1000.0) as usize), feedback, damp }
    }

    fn clear(&mut self) {
        for (b, i, lp) in self.combs.iter_mut() {
            b.fill(0.0);
            *i = 0;
            *lp = 0.0;
        }
        for (b, i) in self.alls.iter_mut() {
            b.fill(0.0);
            *i = 0;
        }
        self.pre.clear();
    }

    fn process(&mut self, x: f32) -> f32 {
        let x = self.pre.tap(x) * 0.015;
        let mut out = 0.0;
        for (buf, i, lp) in self.combs.iter_mut() {
            let y = buf[*i];
            *lp = y * (1.0 - self.damp) + *lp * self.damp;
            buf[*i] = x + *lp * self.feedback;
            *i = (*i + 1) % buf.len();
            out += y;
        }
        for (buf, i) in self.alls.iter_mut() {
            let b = buf[*i];
            buf[*i] = out + b * 0.5;
            out = b - out;
            *i = (*i + 1) % buf.len();
        }
        out
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

    fn clear(&mut self) {
        self.buf.fill(0.0);
        self.pos = 0;
    }

    /// The sample from `len` ago, and writes `x` in its place.
    fn tap(&mut self, x: f32) -> f32 {
        let y = self.buf[self.pos];
        self.buf[self.pos] = x;
        self.pos = (self.pos + 1) % self.buf.len();
        y
    }

    fn peek(&self) -> f32 {
        self.buf[self.pos]
    }
}

/// Keeps a voice effect as loud as the mic: follows both levels over ~0.3 s while you talk.
struct Level {
    dry: f32,
    wet: f32,
    gain: f32,
}

impl Level {
    const fn new() -> Level {
        Level { dry: 0.0, wet: 0.0, gain: 1.0 }
    }

    fn process(&mut self, dry: f32, wet: f32) -> f32 {
        const A: f32 = 1.0 / (0.3 * RATE as f32);
        const G: f32 = 1.0 / (0.2 * RATE as f32);
        self.dry += A * (dry * dry - self.dry);
        self.wet += A * (wet * wet - self.wet);
        if self.dry > SILENCE * SILENCE && self.wet > 1e-9 {
            let want = (self.dry / self.wet).sqrt().clamp(0.1, 6.0);
            self.gain += G * (want - self.gain);
        }
        wet * self.gain
    }

    /// Brings `wet` to `target` RMS while there is sound (so a drive bites the same on a quiet
    /// mic as on a loud one).
    fn to(&mut self, target: f32, wet: f32) -> f32 {
        const A: f32 = 1.0 / (0.3 * RATE as f32);
        const G: f32 = 1.0 / (0.2 * RATE as f32);
        self.wet += A * (wet * wet - self.wet);
        if self.wet > 0.25 * SILENCE * SILENCE {
            let want = (target * target / self.wet).sqrt().clamp(0.1, 30.0);
            self.gain += G * (want - self.gain);
        }
        wet * self.gain
    }
}

// ---- The effects -------------------------------------------------------------------------------

pub struct VoiceFx {
    effect: Effect,
    /// The effect asked for (switched to when the old one has faded out).
    wanted: Effect,
    mix: f32,
    /// Fade of the effect in/out (0…1) when switching.
    fade: f32,
    psola: Psola,
    level: Level,
    /// Brings the mic to one level before a drive.
    drive: Level,
    /// Band and colour filters of the effect.
    pre: Chain<5>,
    post: Chain<2>,
    reverb: Reverb,
    echo: Delay,
    echo_tone: Chain<2>,
    comb: Delay,
    /// The mic delayed like the voices.
    dry: Delay,
    /// Radio's hiss and its envelope.
    noise: u32,
    env: f32,
}

/// 10 ms fade when switching.
const FADE_STEP: f32 = 1.0 / (RATE as f32 / 100.0);

fn thru() -> Biquad {
    Biquad::coeffs([1.0, 0.0, 0.0], [1.0, 0.0, 0.0])
}

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
            psola: Psola::new(),
            level: Level::new(),
            drive: Level::new(),
            pre: Chain([thru(); 5]),
            post: Chain([thru(); 2]),
            reverb: Reverb::new(0.86, 0.35, 30.0),
            echo: Delay::new(RATE as usize * 28 / 100),
            echo_tone: Chain([Biquad::lowpass(3200.0, 0.707), Biquad::highpass(180.0, 0.707)]),
            comb: Delay::new(RATE as usize / 400),
            dry: Delay::new(LATENCY),
            noise: 0x1234_5678,
            env: 0.0,
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
        if let Some(shift) = e.voice() {
            self.psola.reset(shift);
        }
        self.level = Level::new();
        self.drive = Level::new();
        self.pre = Chain(match e {
            // Megaphone: a horn – narrow, with a honk around 1.6 kHz.
            Effect::Megaphone => [Biquad::highpass(550.0, 0.707), Biquad::highpass(550.0, 0.707), Biquad::peak(1600.0, 1.2, 9.0), Biquad::lowpass(3800.0, 0.707), Biquad::lowpass(3800.0, 0.707)],
            // Radio: the telephone band.
            Effect::Radio => [Biquad::highpass(380.0, 0.707), Biquad::highpass(380.0, 0.707), Biquad::peak(2200.0, 1.0, 4.0), Biquad::lowpass(2900.0, 0.707), Biquad::lowpass(2900.0, 0.707)],
            // Monster: weight in the chest.
            Effect::Monster => [Biquad::low_shelf(180.0, 5.0), thru(), thru(), thru(), thru()],
            // Robot: a little brighter and boxy.
            Effect::Robot => [Biquad::highpass(120.0, 0.707), Biquad::peak(1100.0, 1.5, 3.0), thru(), thru(), thru()],
            _ => [thru(); 5],
        });
        // After the drive: smooth off the harsh top it makes.
        self.post = Chain(match e {
            Effect::Megaphone => [Biquad::lowpass(5000.0, 0.707), thru()],
            Effect::Radio => [Biquad::lowpass(3400.0, 0.707), Biquad::highpass(300.0, 0.707)],
            Effect::Monster => [Biquad::lowpass(7000.0, 0.707), thru()],
            _ => [thru(); 2],
        });
        self.reverb = match e {
            Effect::Monster => Reverb::new(0.7, 0.5, 10.0),
            _ => Reverb::new(0.86, 0.35, 30.0),
        };
        self.reverb.clear();
        self.echo.clear();
        self.echo_tone = Chain([Biquad::lowpass(3200.0, 0.707), Biquad::highpass(180.0, 0.707)]);
        self.comb.clear();
        self.dry.clear();
        self.env = 0.0;
    }

    /// Radio's hiss: white noise (xorshift).
    fn hiss(&mut self) -> f32 {
        self.noise ^= self.noise << 13;
        self.noise ^= self.noise >> 17;
        self.noise ^= self.noise << 5;
        (self.noise as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    fn wet(&mut self, x: f32) -> f32 {
        match self.effect {
            Effect::Off => x,
            Effect::Deep | Effect::High | Effect::Chipmunk => {
                let y = self.psola.process(x);
                self.level.process(x, y)
            }
            Effect::Monster => {
                let v = self.psola.process(x);
                let v = self.pre.process(v);
                let v = self.level.process(x, v);
                // Growl: soft drive, then a small dark room.
                let g = (v * 2.5).tanh() / 2.5f32.tanh();
                let v = self.post.process(0.6 * v + 0.4 * g);
                0.7 * (v + 0.35 * self.reverb.process(v))
            }
            Effect::Robot => {
                let v = self.psola.process(x);
                let v = self.pre.process(v);
                // Metallic: a 2.5 ms comb with feedback.
                let c = self.comb.peek();
                let v = v + 0.55 * c;
                self.comb.tap(v);
                self.level.process(x, v)
            }
            Effect::Megaphone => {
                let v = self.pre.process(x);
                let v = self.drive.to(0.12, v);
                let v = (v * 4.0).tanh() * 0.25;
                let v = self.post.process(v);
                self.level.process(x, v)
            }
            Effect::Radio => {
                let v = self.pre.process(x);
                let v = self.drive.to(0.12, v);
                let v = (v * 2.5).tanh() * 0.3;
                // Hiss only while you talk (the radio's squelch is open).
                self.env += (v.abs() - self.env) * if v.abs() > self.env { 0.01 } else { 0.0002 };
                let open = (self.env * 12.0).min(1.0);
                let h = self.hiss() * 0.006 * open;
                let v = self.post.process(v + h);
                self.level.process(x, v)
            }
            Effect::Cave => x * 0.8 + 0.9 * self.reverb.process(x),
            Effect::Echo => {
                let d = self.echo.peek();
                let fb = self.echo_tone.process(d);
                self.echo.tap(x + 0.42 * fb);
                x + 0.55 * d
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
            // Switching: fade the running effect out, then start the new one and fade it in (a
            // voice once its first grains are out).
            if self.wanted != self.effect {
                if self.fade > 0.0 {
                    self.fade = (self.fade - FADE_STEP).max(0.0);
                } else {
                    self.start(self.wanted);
                }
            } else if self.effect != Effect::Off && (self.effect.voice().is_none() || self.psola.ready()) {
                self.fade = (self.fade + FADE_STEP).min(1.0);
            }
            let y = if self.effect == Effect::Off { x } else { self.wet(x) };
            // The voices come LATENCY late: blend them with the mic from as long ago (else Styrke
            // under 100 % sounds like an echo), and fade over from the live mic.
            let dry = self.dry.tap(x);
            let blend = if self.effect.voice().is_some() { dry * (1.0 - self.mix) + y * self.mix } else { x * (1.0 - self.mix) + y * self.mix };
            let out = x * (1.0 - self.fade) + blend * self.fade;
            // Soft limiter: never above full scale, transparent below about −6 dBFS.
            let out = if out.abs() > 0.5 { out.signum() * (0.5 + 0.5 * ((out.abs() - 0.5) / 0.5).tanh()) } else { out };
            *s = if out.is_finite() { out } else { 0.0 };
        }
        // A broken state (NaN inside a filter) starts the effect over.
        if !self.level.gain.is_finite() || !self.reverb.combs[0].2.is_finite() || self.psola.acc.iter().take(64).any(|v| !v.is_finite()) || self.echo.buf.iter().take(64).any(|v| !v.is_finite()) {
            let e = self.effect;
            self.start(e);
        }
    }
}

#[cfg(test)]
#[path = "fx_tests.rs"]
mod tests;
