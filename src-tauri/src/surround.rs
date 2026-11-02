//! Virtuelle højttalere: stereo in headphones sounds like two speakers in front of you (and with
//! "rum", in a room) instead of inside your head. Made with Equalizer APO's convolution filter and
//! impulse responses GoXLR Studio makes itself from a physical head model (Brown & Duda 1998:
//! head shadow + time difference between the ears, plus early reflections and a short room tail) –
//! no measured HRIR files, so no licence questions. The files are written next to config.txt, one
//! per sample rate, and config.txt picks the right one with `If: sampleRate == …`.
use serde::Deserialize;
use std::f64::consts::PI;
use std::path::Path;

pub const RATES: [u32; 4] = [44100, 48000, 96000, 192000];
const HEAD_RADIUS: f64 = 0.0875; // m
const SPEED: f64 = 343.0; // m/s

#[derive(Deserialize, Debug, Clone, Copy, PartialEq)]
pub struct Surround {
    /// Each speaker's angle from straight ahead, degrees (10–60; studio speakers are at 30).
    pub angle: f64,
    /// 0 = no room, 1 = small, 2 = living room, 3 = big room.
    pub room: u8,
}

impl Surround {
    fn clamped(self) -> (f64, u8) {
        let a = if self.angle.is_finite() { self.angle.clamp(10.0, 60.0).round() } else { 30.0 };
        (a, self.room.min(3))
    }
    pub fn file_name(self, rate: u32) -> String {
        let (a, r) = self.clamped();
        format!("surround-a{a}-r{r}-{rate}.wav")
    }
}

/// Head shadow for one ear, as a first-order filter (bilinear transform of Brown & Duda's model).
/// theta = angle between the ear's axis and the source, radians (0 = straight at the ear).
fn head_shadow(x: &[f64], theta: f64, rate: f64) -> Vec<f64> {
    let w0 = SPEED / HEAD_RADIUS;
    let alpha_min = 0.1;
    let theta_min = 150f64.to_radians();
    let alpha = (1.0 + alpha_min / 2.0) + (1.0 - alpha_min / 2.0) * (theta / theta_min * PI).cos();
    let k = rate / w0;
    let (b0, b1, a1) = ((1.0 + alpha * k) / (1.0 + k), (1.0 - alpha * k) / (1.0 + k), (1.0 - k) / (1.0 + k));
    let mut y = vec![0.0; x.len()];
    let (mut x1, mut y1) = (0.0, 0.0);
    for (i, &v) in x.iter().enumerate() {
        let out = b0 * v + b1 * x1 - a1 * y1;
        y[i] = out;
        x1 = v;
        y1 = out;
    }
    y
}

/// Extra time for the sound to reach an ear (seconds), from the ear-axis angle (Brown & Duda).
fn ear_delay(theta: f64) -> f64 {
    let base = HEAD_RADIUS / SPEED;
    if theta < PI / 2.0 { base - base * theta.cos() } else { base + base * (theta - PI / 2.0) }
}

/// Adds a fractional-delay impulse (windowed sinc, 32 taps) of `gain` at `delay` samples.
fn add_impulse(buf: &mut [f64], delay: f64, gain: f64) {
    let center = delay.floor() as i64;
    let frac = delay - delay.floor();
    for k in -15..=16i64 {
        let n = center + k;
        if n < 0 || n as usize >= buf.len() {
            continue;
        }
        let t = k as f64 - frac;
        let sinc = if t.abs() < 1e-9 { 1.0 } else { (PI * t).sin() / (PI * t) };
        let w = 0.5 + 0.5 * (PI * t / 16.5).cos();
        buf[n as usize] += gain * sinc * w;
    }
}

/// One path (direct sound or a reflection) from a source at `azimuth` (radians, + = left) to both ears.
fn path(len: usize, rate: f64, azimuth: f64, delay_s: f64, gain: f64, dull: f64) -> (Vec<f64>, Vec<f64>) {
    let mut out = (vec![0.0; len], vec![0.0; len]);
    for (ear_side, buf) in [(1.0, &mut out.0), (-1.0, &mut out.1)] {
        // Ear axis: left ear points to +90°, right ear to −90°.
        let theta = (ear_side * PI / 2.0 - azimuth).abs().min(2.0 * PI - (ear_side * PI / 2.0 - azimuth).abs());
        let mut imp = vec![0.0; len];
        add_impulse(&mut imp, (delay_s + ear_delay(theta)) * rate + 16.0, gain);
        let mut shaded = head_shadow(&imp, theta, rate);
        if dull > 0.0 {
            // Walls absorb treble: a gentle one-pole low-pass for reflections.
            let a = (-2.0 * PI * (8000.0 - dull * 5000.0) / rate).exp();
            let mut y = 0.0;
            for v in shaded.iter_mut() {
                y = (1.0 - a) * *v + a * y;
                *v = y;
            }
        }
        for (b, s) in buf.iter_mut().zip(shaded) {
            *b += s;
        }
    }
    out
}

/// A tiny deterministic noise source (xorshift), so the files are the same every time.
struct Noise(u64);
impl Noise {
    fn next(&mut self) -> f64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0
    }
}

/// The four impulse responses: [left speaker → left ear, left → right ear, right → left, right → right].
pub fn impulse_responses(s: Surround, rate: u32) -> [Vec<f32>; 4] {
    let (angle, room) = s.clamped();
    let rate_f = rate as f64;
    let tail_s = [0.0, 0.0, 0.15, 0.3][room as usize];
    let len = ((0.012 + tail_s) * rate_f).ceil() as usize + 64;
    let az = angle.to_radians();
    // Early reflections (image sources of a room around you): (extra delay s, gain, azimuth offset).
    let refl: &[(f64, f64, f64)] = match room {
        0 => &[],
        1 => &[(0.0021, 0.22, 0.0), (0.0037, 0.18, 0.9), (0.0052, 0.12, PI - 0.4)],
        _ => &[(0.0021, 0.3, 0.0), (0.0037, 0.26, 0.9), (0.0044, 0.2, -0.7), (0.0068, 0.18, PI - 0.4), (0.0091, 0.14, 1.6)],
    };
    let mut irs: [Vec<f64>; 4] = Default::default();
    for (spk, sign) in [(0usize, 1.0), (1usize, -1.0)] {
        let source = sign * az;
        let (mut l, mut r) = path(len, rate_f, source, 0.0, 1.0, 0.0);
        for &(d, g, off) in refl {
            let (rl, rr) = path(len, rate_f, source + sign * off, d, g, 0.5);
            for i in 0..len {
                l[i] += rl[i];
                r[i] += rr[i];
            }
        }
        if tail_s > 0.0 {
            // A short, decorrelated room tail that dies away (T60 = tail length), from 12 ms.
            let start = (0.012 * rate_f) as usize;
            let level = if room == 2 { 0.06 } else { 0.08 };
            for (k, buf) in [&mut l, &mut r].into_iter().enumerate() {
                // Same tail for the near ear of either speaker (symmetry), another for the far ear.
                let near = (k == spk) as u64;
                let mut n = Noise(0x9E37_79B9_7F4A_7C15 ^ ((near + 1) * 0x1234_5678_9ABC));
                let mut lp = 0.0;
                let a = (-2.0 * PI * 6000.0 / rate_f).exp();
                for i in start..len {
                    let t = (i - start) as f64 / rate_f;
                    lp = (1.0 - a) * n.next() + a * lp;
                    buf[i] += level * lp * (-6.9 * t / tail_s).exp();
                }
            }
        }
        irs[spk * 2] = l;
        irs[spk * 2 + 1] = r;
    }
    // Never louder than the original: scale so the strongest response (one speaker, or a centred
    // mono sound) at any frequency is at most 0 dB.
    let peak = peak_gain(&irs, rate_f);
    let scale = if peak > 0.0 { 1.0 / peak } else { 1.0 };
    irs.map(|v| v.into_iter().map(|x| (x * scale) as f32).collect())
}

fn magnitude(h: &[f64], f: f64, rate: f64) -> (f64, f64) {
    let w = 2.0 * PI * f / rate;
    h.iter().enumerate().fold((0.0, 0.0), |(re, im), (n, &v)| (re + v * (w * n as f64).cos(), im - v * (w * n as f64).sin()))
}

/// The largest gain (linear) of the left speaker alone or a centred sound, 20 Hz–20 kHz.
pub fn peak_gain(irs: &[Vec<f64>; 4], rate: f64) -> f64 {
    let mut peak: f64 = 0.0;
    for i in 0..120 {
        let f = 20.0 * (1000f64).powf(i as f64 / 119.0);
        if f >= rate / 2.0 {
            break;
        }
        let ll = magnitude(&irs[0], f, rate);
        let rl = magnitude(&irs[2], f, rate);
        let one = (ll.0 * ll.0 + ll.1 * ll.1).sqrt();
        let mono = ((ll.0 + rl.0).powi(2) + (ll.1 + rl.1).powi(2)).sqrt();
        peak = peak.max(one).max(mono);
    }
    peak
}

/// A 32-bit float WAV (what libsndfile in Equalizer APO reads).
pub fn wav_bytes(channels: &[Vec<f32>], rate: u32) -> Vec<u8> {
    let ch = channels.len() as u16;
    let frames = channels.iter().map(|c| c.len()).max().unwrap_or(0);
    let data_len = frames * ch as usize * 4;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
    out.extend_from_slice(&ch.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * ch as u32 * 4).to_le_bytes());
    out.extend_from_slice(&(ch * 4).to_le_bytes());
    out.extend_from_slice(&32u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for i in 0..frames {
        for c in channels {
            out.extend_from_slice(&c.get(i).copied().unwrap_or(0.0).to_le_bytes());
        }
    }
    out
}

/// The config.txt lines: each stereo channel is copied to two virtual channels, convolved with the
/// path to each ear, and mixed back. V* are new channel names (APO adds them); RL/RR would clash
/// with the rear speakers.
pub fn lines(s: Surround) -> Vec<String> {
    let mut v = vec!["Copy: VLL=L VLR=L VRL=R VRR=R".to_string(), "Channel: VLL VLR VRL VRR".to_string()];
    for (i, rate) in RATES.iter().enumerate() {
        v.push(format!("{}: sampleRate == {rate}", if i == 0 { "If" } else { "ElseIf" }));
        v.push(format!("Convolution: {}", s.file_name(*rate)));
    }
    v.push("EndIf:".to_string());
    v.push("Channel: all".to_string());
    v.push("Copy: L=VLL+VRL R=VLR+VRR".to_string());
    v
}

/// Writes the impulse files the config needs (only missing ones) and removes old ones it doesn't.
pub fn ensure_files(dir: &Path, wanted: &[Surround]) -> Result<(), String> {
    let mut keep = Vec::new();
    for s in wanted {
        for rate in RATES {
            let name = s.file_name(rate);
            let path = dir.join(&name);
            if !path.exists() {
                let irs = impulse_responses(*s, rate);
                let tmp = dir.join(format!("{name}.tmp"));
                std::fs::write(&tmp, wav_bytes(&irs, rate)).map_err(|e| e.to_string())?;
                std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
            }
            keep.push(name);
        }
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_string();
            if n.starts_with("surround-") && n.ends_with(".wav") && !keep.contains(&n) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symmetric_and_never_louder() {
        for room in 0..=3 {
            let s = Surround { angle: 30.0, room };
            let irs = impulse_responses(s, 48000);
            // Left speaker → left ear equals right speaker → right ear (and the cross paths).
            let diff: f32 = irs[0].iter().zip(&irs[3]).map(|(a, b)| (a - b).abs()).fold(0.0, f32::max);
            assert!(diff < 1e-6, "room {room}: {diff}");
            let back: [Vec<f64>; 4] = irs.clone().map(|v| v.into_iter().map(f64::from).collect());
            let peak = peak_gain(&back, 48000.0);
            assert!(peak <= 1.0001 && peak > 0.5, "room {room}: peak {peak}");
        }
    }

    #[test]
    fn the_far_ear_hears_later_and_duller() {
        let irs = impulse_responses(Surround { angle: 45.0, room: 0 }, 48000);
        let arg_max = |v: &Vec<f32>| v.iter().enumerate().max_by(|a, b| a.1.abs().total_cmp(&b.1.abs())).unwrap().0;
        assert!(arg_max(&irs[1]) > arg_max(&irs[0]), "contralateral arrives later");
        let back: Vec<Vec<f64>> = irs.iter().map(|v| v.iter().map(|&x| x as f64).collect()).collect();
        let m = |h: &Vec<f64>, f| { let (r, i) = magnitude(h, f, 48000.0); (r * r + i * i).sqrt() };
        assert!(m(&back[1], 8000.0) < m(&back[0], 8000.0) * 0.7, "head shadow on treble");
    }

    #[test]
    fn wav_and_lines() {
        let w = wav_bytes(&[vec![0.5, -0.5], vec![0.25, 0.0]], 48000);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(u16::from_le_bytes([w[20], w[21]]), 3);
        assert_eq!(u16::from_le_bytes([w[22], w[23]]), 2);
        assert_eq!(w.len(), 44 + 2 * 2 * 4);
        let s = Surround { angle: 99.0, room: 7 };
        assert_eq!(s.file_name(48000), "surround-a60-r3-48000.wav");
        let l = lines(Surround { angle: 30.0, room: 1 });
        assert_eq!(l[0], "Copy: VLL=L VLR=L VRL=R VRR=R");
        assert!(l.contains(&"If: sampleRate == 44100".to_string()));
        assert!(l.contains(&"Convolution: surround-a30-r1-96000.wav".to_string()));
        assert_eq!(l.last().unwrap(), "Copy: L=VLL+VRL R=VLR+VRR");
    }
}
