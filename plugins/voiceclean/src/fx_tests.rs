//! Stemmeskifter measured: pitch, formants (does it still sound like a person?), how clean the
//! voice stays (harmonicity – warble and doubled pulses lower it), level, and on real speech when
//! DF_TEST_ASSETS is set (as for tests_df.rs). FX_RENDER_DIR = also write each voice as a WAV.
use super::*;

const SR: f32 = RATE as f32;

fn sine(f: f32, n: usize, amp: f32) -> Vec<f32> {
    (0..n).map(|i| amp * (2.0 * std::f32::consts::PI * f * i as f32 / SR).sin()).collect()
}

fn rms(v: &[f32]) -> f32 {
    (v.iter().map(|s| s * s).sum::<f32>() / v.len().max(1) as f32).sqrt()
}

/// A vowel ("a"): glottal pulses with vibrato through three formant resonators.
fn vowel(f0: f32, secs: f32, formants: [f32; 3]) -> Vec<f32> {
    let n = (secs * SR) as usize;
    let mut phase = 0.0f32;
    let mut src = vec![0f32; n];
    let mut tilt = 0.0;
    for (i, v) in src.iter_mut().enumerate() {
        let f = f0 * (1.0 + 0.015 * (2.0 * std::f32::consts::PI * 5.0 * i as f32 / SR).sin());
        phase += f / SR;
        let pulse = if phase >= 1.0 {
            phase -= 1.0;
            1.0
        } else {
            0.0
        };
        tilt = 0.92 * tilt + pulse;
        *v = tilt;
    }
    let mut y = src;
    for (fc, bw) in formants.iter().zip([80.0, 100.0, 140.0]) {
        let r = (-std::f32::consts::PI * bw / SR).exp();
        let c = 2.0 * r * (2.0 * std::f32::consts::PI * fc / SR).cos();
        let (mut y1, mut y2) = (0.0, 0.0);
        for v in y.iter_mut() {
            let o = *v + c * y1 - r * r * y2;
            y2 = y1;
            y1 = o;
            *v = o;
        }
    }
    // DC out, then −26 dBFS RMS like a talking voice.
    let mean = y.iter().sum::<f32>() / n as f32;
    y.iter_mut().for_each(|v| *v -= mean);
    let g = 0.05 / rms(&y);
    y.iter().map(|v| v * g).collect()
}

const VOWEL_A: [f32; 3] = [730.0, 1090.0, 2440.0];

fn run(cmd: u32, x: &[f32]) -> Vec<f32> {
    let mut fx = VoiceFx::new();
    fx.set_command(cmd);
    let mut y = x.to_vec();
    for ch in y.chunks_mut(480) {
        fx.process(ch);
    }
    y
}

/// YIN at 48 kHz over one frame: (f0, aperiodicity = the dip's depth, 0 = perfectly periodic).
fn yin(frame: &[f32]) -> (f32, f32) {
    let max_lag = (SR / 60.0) as usize;
    let min_lag = (SR / 600.0) as usize;
    let w = frame.len() - max_lag - 1;
    let mut d = vec![0f32; max_lag + 2];
    for (tau, dv) in d.iter_mut().enumerate().skip(1) {
        *dv = (0..w).map(|j| (frame[j] - frame[j + tau]).powi(2)).sum();
    }
    let mut cm = vec![1f32; d.len()];
    let mut run = 0.0;
    for tau in 1..d.len() {
        run += d[tau];
        cm[tau] = if run > 0.0 { d[tau] * tau as f32 / run } else { 1.0 };
    }
    let mut tau = (min_lag..=max_lag).find(|&t| cm[t] < 0.15).unwrap_or(0);
    if tau == 0 {
        tau = (min_lag..=max_lag).min_by(|a, b| cm[*a].total_cmp(&cm[*b])).unwrap();
    } else {
        while tau < max_lag && cm[tau + 1] < cm[tau] {
            tau += 1;
        }
    }
    let (a, b, c) = (cm[tau - 1], cm[tau], cm[tau + 1]);
    let den = a - 2.0 * b + c;
    let frac = if den.abs() > 1e-9 { (0.5 * (a - c) / den).clamp(-0.5, 0.5) } else { 0.0 };
    (SR / (tau as f32 + frac), cm[tau])
}

/// Per 40 ms frame from `from` on, the frames loud enough to be voice: (f0, aperiodicity).
fn track(x: &[f32], from: usize) -> Vec<(f32, f32)> {
    track_with(x, from, 2400)
}

/// Frame by frame (`len` samples, 40 % hop – short frames follow a gliding voice): (f0,
/// aperiodicity), or None where it is too quiet. Frames stay in place, so two signals line up.
fn frames(x: &[f32], from: usize, len: usize) -> Vec<Option<(f32, f32)>> {
    (from..x.len().saturating_sub(len)).step_by(len * 2 / 5).map(|i| {
        let f = &x[i..i + len];
        (rms(f) > 0.01).then(|| yin(f))
    }).collect()
}

fn track_with(x: &[f32], from: usize, len: usize) -> Vec<(f32, f32)> {
    frames(x, from, len).into_iter().flatten().collect()
}

/// Output/input pitch ratios over the frames voiced in both.
fn ratios(x: &[f32], y: &[f32]) -> Vec<f32> {
    ratios_vs(x, y)
}

/// The old shifter has no fixed delay: its output is compared directly.
fn ratios_vs(x: &[f32], y: &[f32]) -> Vec<f32> {
    frames(x, 0, 1200).iter().zip(frames(y, 0, 1200)).filter_map(|(a, b)| match (a, b) {
        (Some(a), Some(b)) if a.1 < 0.15 && b.1 < 0.3 && (70.0..450.0).contains(&a.0) => Some(b.0 / a.0),
        _ => None,
    }).collect()
}

fn median(mut v: Vec<f32>) -> f32 {
    v.sort_by(f32::total_cmp);
    v[v.len() / 2]
}

/// Spectral envelope on a log-frequency grid (dB, 1/48 octave from 150 Hz to 5 kHz): LPC of
/// order 12 at 12 kHz (which follows the vocal tract, not the harmonics), averaged over the
/// voiced frames.
fn envelope(x: &[f32], from: usize) -> Vec<f32> {
    // Down to 12 kHz through a windowed-sinc low-pass at 5 kHz.
    let taps: Vec<f32> = (-32i32..=32).map(|k| {
        let t = k as f32;
        let fc = 5000.0 / SR;
        let sinc = if k == 0 { 2.0 * fc } else { (2.0 * std::f32::consts::PI * fc * t).sin() / (std::f32::consts::PI * t) };
        sinc * (0.54 + 0.46 * (std::f32::consts::PI * t / 33.0).cos())
    }).collect();
    let d: Vec<f32> = (from + 32..x.len() - 32).step_by(4).map(|i| taps.iter().enumerate().map(|(k, t)| t * x[i + k - 32]).sum()).collect();
    let grid: Vec<f32> = (0..243).map(|k| 150.0 * 2f32.powf(k as f32 / 48.0)).collect();
    let len = 360;
    let order = 12;
    let mut sum = vec![0f32; grid.len()];
    let mut frames = 0;
    for i in (0..d.len().saturating_sub(len)).step_by(180) {
        let f: Vec<f32> = d[i..i + len].iter().enumerate().map(|(j, v)| v * (0.54 - 0.46 * (2.0 * std::f32::consts::PI * j as f32 / len as f32).cos())).collect();
        if rms(&d[i..i + len]) < 0.01 {
            continue;
        }
        let r: Vec<f64> = (0..=order).map(|l| (0..len - l).map(|j| f[j] as f64 * f[j + l] as f64).sum()).collect();
        // Levinson–Durbin.
        let mut a = vec![0f64; order + 1];
        a[0] = 1.0;
        let mut e = r[0] * (1.0 + 1e-6);
        for m in 1..=order {
            let k = -(0..m).map(|j| a[j] * r[m - j]).sum::<f64>() / e;
            let prev = a.clone();
            for j in 1..m {
                a[j] = prev[j] + k * prev[m - j];
            }
            a[m] = k;
            e *= 1.0 - k * k;
        }
        for (g, fr) in grid.iter().enumerate() {
            let w = 2.0 * std::f64::consts::PI * *fr as f64 / 12000.0;
            let (mut re, mut im) = (0.0, 0.0);
            for (j, c) in a.iter().enumerate() {
                re += c * (w * j as f64).cos();
                im -= c * (w * j as f64).sin();
            }
            sum[g] += (-10.0 * (re * re + im * im).log10()) as f32;
        }
        frames += 1;
    }
    sum.iter().map(|v| v / frames.max(1) as f32).collect()
}

/// How far the formants moved: the frequency ratio that lines the output's envelope up best with
/// the input's (300 Hz – 3.5 kHz).
fn formant_shift(input: &[f32], output: &[f32], from: usize) -> f32 {
    let (a, b) = (envelope(input, from), envelope(output, from));
    let mut best = (f32::MIN, 1.0);
    for step in -24i32..=24 {
        // Output bin k + step ↔ input bin k (1/48 octave per step).
        let pairs: Vec<(f32, f32)> = (0..a.len()).filter_map(|k| {
            let f = 150.0 * 2f32.powf(k as f32 / 48.0);
            let j = k as i32 + step;
            ((300.0..3500.0).contains(&f) && j >= 0 && (j as usize) < b.len()).then(|| (a[k], b[j as usize]))
        }).collect();
        let n = pairs.len() as f32;
        let (ma, mb) = (pairs.iter().map(|p| p.0).sum::<f32>() / n, pairs.iter().map(|p| p.1).sum::<f32>() / n);
        let cov: f32 = pairs.iter().map(|p| (p.0 - ma) * (p.1 - mb)).sum();
        let va: f32 = pairs.iter().map(|p| (p.0 - ma).powi(2)).sum();
        let vb: f32 = pairs.iter().map(|p| (p.1 - mb).powi(2)).sum();
        let r = cov / (va * vb).sqrt().max(1e-9);
        if r > best.0 {
            best = (r, 2f32.powf(step as f32 / 48.0));
        }
    }
    best.1
}

/// The voice changer as it was in 0.16.0 (two crossfaded read heads), to compare against.
fn old_pitch(x: &[f32], ratio: f32) -> Vec<f32> {
    let w = (SR / 25.0) as usize;
    let n = w * 2 + 4;
    let mut buf = vec![0f32; n];
    let (mut pos, mut phase) = (0usize, 0f32);
    let read = |buf: &[f32], pos: usize, delay: f32| {
        let d = delay.clamp(1.0, (n - 3) as f32);
        let i = d.floor() as usize;
        let f = d - i as f32;
        let a = buf[(pos + n - i) % n];
        let b = buf[(pos + n - i - 1) % n];
        a + (b - a) * f
    };
    x.iter().map(|&v| {
        pos = (pos + 1) % n;
        buf[pos] = v;
        phase = (phase + (1.0 - ratio) / w as f32).rem_euclid(1.0);
        let p2 = (phase + 0.5).rem_euclid(1.0);
        let g1 = (std::f32::consts::PI * phase).sin().powi(2);
        let g2 = (std::f32::consts::PI * p2).sin().powi(2);
        read(&buf, pos, phase * w as f32 + 1.0) * g1 + read(&buf, pos, p2 * w as f32 + 1.0) * g2
    }).collect()
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

/// The voices move the pitch exactly and the formants by their own amount – and the voice stays
/// as clean (periodic) as it came in. The old crossfading shifter is measured too: it moved the
/// formants with the pitch and made the voice rough.
#[test]
fn voices_shift_pitch_and_formants_cleanly() {
    let from = RATE as usize / 2;
    for f0 in [110.0, 210.0] {
        let x = vowel(f0, 2.5, VOWEL_A);
        let ap_in = median(track(&x, from).iter().map(|t| t.1).collect());
        for (id, pitch, formant) in [(1u32, -4.0, -2.0), (2, 4.0, 2.0), (3, 8.0, 6.0), (4, -8.0, -4.0)] {
            let y = run(id, &x);
            let t = track(&y, from);
            let f = median(t.iter().map(|t| t.0).collect());
            let ap = median(t.iter().map(|t| t.1).collect());
            let want = f0 * semis(pitch);
            let fs = formant_shift(&x, &y, from);
            let want_fs = semis(formant);
            let r = rms(&y[from..]) / rms(&x[from..]);
            eprintln!("effect {id} at {f0} Hz: pitch {f:.1} (want {want:.1}), formants ×{fs:.3} (want ×{want_fs:.3}), aperiodicity {ap:.3} (input {ap_in:.3}), level ×{r:.2}");
            if std::env::var_os("FX_SOFT").is_some() { continue; }
            assert!((f / want - 1.0).abs() < 0.025, "effect {id} at {f0} Hz: pitch {f:.1}, want {want:.1}");
            // Monster drives and adds a room on top, so only its pitch and formants are checked.
            if id != 4 {
                assert!(ap < ap_in + 0.08, "effect {id} at {f0} Hz: aperiodicity {ap:.3} (input {ap_in:.3})");
            }
            assert!((fs / want_fs - 1.0).abs() < 0.05, "effect {id} at {f0} Hz: formants ×{fs:.3}, want ×{want_fs:.3}");
            assert!((0.6..1.7).contains(&r), "effect {id} at {f0} Hz: level ×{r:.2}");
        }
        // The old one, for the record: formants followed the pitch.
        let old = old_pitch(&x, semis(-4.0));
        let ap_old = median(track(&old, from).iter().map(|t| t.1).collect());
        eprintln!("old shifter at {f0} Hz, −4: formants ×{:.3}, aperiodicity {ap_old:.3}", formant_shift(&x, &old, from));
    }
}

#[test]
fn robot_speaks_on_one_pitch() {
    let from = RATE as usize / 2;
    for f0 in [120.0, 180.0] {
        let y = run(5, &vowel(f0, 2.0, VOWEL_A));
        let t = track(&y, from);
        let f = median(t.iter().map(|t| t.0).collect());
        assert!((f / ROBOT_HZ - 1.0).abs() < 0.03, "robot at {f0} Hz input: {f:.1} Hz");
        // Monotone: hardly any vibrato left (the input swings ±1,5 %).
        let spread = t.iter().map(|t| (t.0 / f - 1.0).abs()).fold(0.0, f32::max);
        assert!(spread < 0.02, "robot pitch varies {spread:.3}");
    }
}

#[test]
fn breath_and_s_sounds_come_through() {
    // White noise (like an "s"): neither gated away nor blown up.
    let mut seed = 1u32;
    let x: Vec<f32> = (0..RATE as usize * 2).map(|_| {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (seed as f32 / u32::MAX as f32 - 0.5) * 0.1
    }).collect();
    for id in 1..=4 {
        let y = run(id, &x);
        let r = rms(&y[RATE as usize..]) / rms(&x[RATE as usize..]);
        assert!((0.4..2.0).contains(&r), "effect {id}: noise level ×{r:.2}");
    }
}

#[test]
fn voices_start_without_a_gap() {
    // The pitch effects need 43 ms of sound: until then the mic stays dry, then fades over.
    let x = vowel(150.0, 1.0, VOWEL_A);
    let y = run(1, &x);
    // Chunk by chunk against the input (the vowel itself starts with its first pulse).
    let gap = y[960..LATENCY + 1920].chunks(960).zip(x[960..].chunks(960)).map(|(a, b)| rms(a) / rms(b)).fold(f32::MAX, f32::min);
    assert!(gap > 0.5, "a hole at the start: ×{gap:.2}");
}

#[test]
fn nothing_clips_and_nothing_breaks() {
    let loud = sine(150.0, RATE as usize, 1.5);
    let speech = vowel(130.0, 1.0, VOWEL_A).iter().map(|v| v * 15.0).collect::<Vec<_>>();
    // (Off leaves the mic exactly as it is – that is tested above.)
    for id in 1..=9 {
        for x in [&loud, &speech] {
            let y = run(id, x);
            assert!(y.iter().all(|v| v.is_finite() && v.abs() <= 1.0), "effect {id}");
        }
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
    let x = vowel(140.0, 1.5, VOWEL_A);
    let from = RATE as usize / 2;
    for id in 1..=9 {
        let y = run(id, &x);
        let diff = y[from..].iter().zip(&x[from..]).map(|(a, b)| (a - b).abs()).sum::<f32>() / (y.len() - from) as f32;
        assert!(diff > 0.005, "effect {id} changes the sound");
        let r = rms(&y[from..]) / rms(&x[from..]);
        assert!((0.5..2.0).contains(&r), "effect {id}: level ratio {r:.2}");
    }
}

#[test]
fn switching_fades_without_jumps() {
    let x = vowel(160.0, 1.0, VOWEL_A);
    let mut fx = VoiceFx::new();
    let mut y = x.clone();
    for (k, ch) in y.chunks_mut(480).enumerate() {
        match k {
            10 => fx.set_command(encode(5, 100)),
            40 => fx.set_command(encode(8, 100)),
            60 => fx.set_command(encode(1, 100)),
            80 => fx.set_command(0),
            _ => {}
        }
        fx.process(ch);
    }
    // Sample-to-sample steps stay those of a voice (no clicks at the switches).
    let natural = x.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
    let max_step = y.windows(2).map(|w| (w[1] - w[0]).abs()).fold(0.0, f32::max);
    assert!(max_step < 2.5 * natural, "{max_step} vs {natural}");
    assert_eq!(fx.active(), Effect::Off);
    // Off again: untouched from there on.
    assert_eq!(&y[90 * 480..], &x[90 * 480..]);
}

#[test]
fn mix_blends_with_the_dry_voice() {
    let x = vowel(150.0, 0.5, VOWEL_A);
    let full = run(encode(6, 100), &x);
    let half = run(encode(6, 50), &x);
    let d = |a: &[f32]| a[12000..].iter().zip(&x[12000..]).map(|(p, q)| (p - q).abs()).sum::<f32>();
    assert!(d(&half) < d(&full) * 0.75);
}

#[test]
fn half_a_voice_has_no_echo() {
    // Styrke 50 % on Dyb: the mic and the voice line up (no copy of the mic 43 ms later).
    let x = vowel(150.0, 1.5, VOWEL_A);
    let y = run(encode(1, 50), &x);
    let from = RATE as usize / 2;
    let corr = |lag: usize| {
        let a = &y[from..y.len()];
        let b = &x[from - lag..x.len() - lag];
        a.iter().zip(b).map(|(p, q)| p * q).sum::<f32>() / (rms(a) * rms(b) * a.len() as f32)
    };
    assert!(corr(LATENCY) > 0.3, "the dry half is delayed with the voice: {:.2}", corr(LATENCY));
    assert!(corr(0).abs() < 0.2, "no undelayed copy: {:.2}", corr(0));
}

/// 16-bit PCM WAV, first channel, 48 kHz.
fn read_wav(path: &std::path::Path) -> Vec<f32> {
    let b = std::fs::read(path).unwrap();
    let mut i = 12;
    let (mut channels, mut data) = (1usize, None);
    while i + 8 <= b.len() {
        let len = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        if &b[i..i + 4] == b"fmt " {
            channels = u16::from_le_bytes([b[i + 10], b[i + 11]]) as usize;
            assert_eq!(u32::from_le_bytes([b[i + 12], b[i + 13], b[i + 14], b[i + 15]]), RATE);
        }
        if &b[i..i + 4] == b"data" {
            data = Some(&b[i + 8..(i + 8 + len).min(b.len())]);
        }
        i += 8 + len + (len & 1);
    }
    data.unwrap().chunks_exact(2 * channels).map(|f| i16::from_le_bytes([f[0], f[1]]) as f32 / 32768.0).collect()
}

fn write_wav(path: &std::path::Path, x: &[f32]) {
    let mut b = Vec::with_capacity(44 + 2 * x.len());
    let data = (2 * x.len()) as u32;
    b.extend_from_slice(b"RIFF");
    b.extend_from_slice(&(36 + data).to_le_bytes());
    b.extend_from_slice(b"WAVEfmt ");
    b.extend_from_slice(&16u32.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&1u16.to_le_bytes());
    b.extend_from_slice(&RATE.to_le_bytes());
    b.extend_from_slice(&(RATE * 2).to_le_bytes());
    b.extend_from_slice(&2u16.to_le_bytes());
    b.extend_from_slice(&16u16.to_le_bytes());
    b.extend_from_slice(b"data");
    b.extend_from_slice(&data.to_le_bytes());
    for v in x {
        b.extend_from_slice(&((v.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    std::fs::write(path, b).unwrap();
}

/// Real speech (DeepFilterNet's freesound recording): each voice lands on the right pitch for
/// the voiced part, keeps its level, and runs far faster than real time.
#[test]
fn real_speech() {
    let Some(dir) = std::env::var_os("DF_TEST_ASSETS").map(std::path::PathBuf::from).filter(|p| p.join("clean_freesound_33711.wav").is_file()) else {
        assert!(std::env::var_os("DF_REQUIRE_ASSETS").is_none(), "DF_TEST_ASSETS is missing");
        eprintln!("skipped: DF_TEST_ASSETS not set");
        return;
    };
    let x = read_wav(&dir.join("clean_freesound_33711.wav"));
    let render = std::env::var_os("FX_RENDER_DIR").map(std::path::PathBuf::from);
    if let Some(r) = &render {
        write_wav(&r.join("00-original.wav"), &x);
    }
    let names = ["", "dyb", "lysere", "jordegern", "monster", "robot", "megafon", "radio", "hule", "ekko"];
    for id in 1..=9u32 {
        let t0 = std::time::Instant::now();
        let y = run(id, &x);
        let secs = t0.elapsed().as_secs_f32();
        if let Some(r) = &render {
            write_wav(&r.join(format!("{id:02}-{}.wav", names[id as usize])), &y);
            if let Some(v) = Effect::from_id(id).voice().filter(|v| v.monotone.is_none()) {
                write_wav(&r.join(format!("{id:02}-{}-0.16.0.wav", names[id as usize])), &old_pitch(&x, v.beta));
            }
        }
        let r = rms(&y) / rms(&x);
        assert!((0.5..2.0).contains(&r), "effect {id}: level ×{r:.2}");
        if !cfg!(debug_assertions) {
            assert!(secs < 0.1 * x.len() as f32 / SR, "effect {id}: {secs:.2} s for {:.1} s", x.len() as f32 / SR);
        }
        let Some(shift) = Effect::from_id(id).voice() else { continue };
        // Frame by frame (the output is LATENCY later): voiced frames in both, pitch ratio.
        let ratios = ratios(&x, &y[LATENCY..]);
        let pitches: Vec<f32> = track_with(&y[LATENCY..], 0, 1200).iter().filter(|b| b.1 < 0.3).map(|b| b.0).collect();
        match shift.monotone {
            Some(hz) => {
                let f = median(pitches);
                assert!((f / hz - 1.0).abs() < 0.04, "robot: {f:.1} Hz");
            }
            None => {
                let m = median(ratios.clone());
                let near = ratios.iter().filter(|r| (*r / shift.beta - 1.0).abs() < 0.06).count() as f32 / ratios.len() as f32;
                if std::env::var_os("FX_SOFT").is_some() {
                    let mut h = std::collections::BTreeMap::new();
                    for r in &ratios { *h.entry(((r / shift.beta).log2() * 24.0).round() as i32).or_insert(0) += 1; }
                    eprintln!("effect {id} quarter-tone histogram: {h:?}");
                }
                eprintln!("effect {id}: pitch ×{m:.3} (want ×{:.3}), {:.0} % of voiced frames within 6 %, {secs:.2} s", shift.beta, near * 100.0);
                assert!((m / shift.beta - 1.0).abs() < 0.03, "effect {id}: pitch ×{m:.3}, want ×{:.3}", shift.beta);
                assert!(near > 0.8, "effect {id}: only {:.0} % of voiced frames on pitch", near * 100.0);
                // Against 0.16.0's shifter on the same speech: frames within a quarter tone.
                let close = |r: &[f32]| r.iter().filter(|r| (*r / shift.beta - 1.0).abs() < 0.03).count() as f32 / r.len() as f32;
                let old = close(&ratios_vs(&x, &old_pitch(&x, shift.beta)));
                eprintln!("effect {id}: {:.0} % within 3 % (0.16.0: {:.0} %)", close(&ratios) * 100.0, old * 100.0);
                assert!(close(&ratios) > old + 0.1, "effect {id}: not steadier than 0.16.0");
            }
        }
    }
}




