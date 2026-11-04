//! Stemmeisolering measured on real recordings: clean speech and real noise from DeepFilterNet's
//! test assets (freesound.org, downloaded by CI next to the model – not part of the repository).
//! DF_TEST_ASSETS = the folder with clean_freesound_33711.wav, noise_freesound_2530.wav and
//! noise_freesound_573577.wav. Without it these tests only say they were skipped – unless
//! DF_REQUIRE_ASSETS is set (CI), then they fail.
use crate::deepfilter::{DeepFilter, HOP, LATENCY};
use crate::{Cleaner, Noise, Settings, FRAME};

fn assets() -> Option<std::path::PathBuf> {
    match std::env::var_os("DF_TEST_ASSETS").map(std::path::PathBuf::from) {
        Some(p) if p.join("clean_freesound_33711.wav").is_file() => Some(p),
        _ => {
            assert!(std::env::var_os("DF_REQUIRE_ASSETS").is_none(), "DF_TEST_ASSETS is missing");
            eprintln!("skipped: DF_TEST_ASSETS not set");
            None
        }
    }
}

/// 16-bit PCM WAV, first channel, as −1…1.
fn wav(path: &std::path::Path) -> Vec<f32> {
    let b = std::fs::read(path).unwrap();
    assert_eq!(&b[0..4], b"RIFF");
    let mut i = 12;
    let (mut channels, mut data) = (1usize, None);
    while i + 8 <= b.len() {
        let id = &b[i..i + 4];
        let len = u32::from_le_bytes([b[i + 4], b[i + 5], b[i + 6], b[i + 7]]) as usize;
        if id == b"fmt " {
            channels = u16::from_le_bytes([b[i + 10], b[i + 11]]) as usize;
            assert_eq!(u16::from_le_bytes([b[i + 22], b[i + 23]]), 16, "16-bit");
            assert_eq!(u32::from_le_bytes([b[i + 12], b[i + 13], b[i + 14], b[i + 15]]), 48000);
        }
        if id == b"data" {
            data = Some(&b[i + 8..(i + 8 + len).min(b.len())]);
        }
        i += 8 + len + (len & 1);
    }
    data.unwrap().chunks_exact(2 * channels).map(|f| i16::from_le_bytes([f[0], f[1]]) as f32 / 32768.0).collect()
}

fn energy(x: &[f32]) -> f64 {
    x.iter().map(|v| (*v as f64) * (*v as f64)).sum()
}

fn db(x: f64) -> f64 {
    10.0 * x.max(1e-30).log10()
}

/// Scale-invariant signal-to-distortion ratio of `est` against `reference` (dB).
fn si_sdr(est: &[f32], reference: &[f32]) -> f64 {
    let dot: f64 = est.iter().zip(reference).map(|(a, b)| *a as f64 * *b as f64).sum();
    let a = dot / energy(reference).max(1e-30);
    let noise: f64 = est.iter().zip(reference).map(|(e, r)| { let d = *e as f64 - a * *r as f64; d * d }).sum();
    db(a * a * energy(reference) / noise.max(1e-30))
}

/// `noise` looped and scaled so speech/noise = `snr` dB.
fn mix(clean: &[f32], noise: &[f32], snr: f64) -> (Vec<f32>, Vec<f32>) {
    let n: Vec<f32> = (0..clean.len()).map(|i| noise[i % noise.len()]).collect();
    let g = (energy(clean) / energy(&n) / 10f64.powf(snr / 10.0)).sqrt() as f32;
    let n: Vec<f32> = n.iter().map(|v| v * g).collect();
    (clean.iter().zip(&n).map(|(a, b)| a + b).collect(), n)
}

fn run_df(df: &mut DeepFilter, x: &[f32]) -> Vec<f32> {
    let mut out = vec![0.0; x.len()];
    let mut pad = x.to_vec();
    pad.resize(x.len().div_ceil(HOP) * HOP, 0.0);
    let mut o = vec![0.0; HOP];
    for (k, hop) in pad.chunks(HOP).enumerate() {
        df.process(hop, &mut o).unwrap();
        for (j, v) in o.iter().enumerate() {
            if let Some(slot) = out.get_mut(k * HOP + j) {
                *slot = *v;
            }
        }
    }
    out
}

/// The output moved back by the filter's delay, against the input range it belongs to.
fn aligned<'a>(out: &'a [f32], reference: &'a [f32]) -> (&'a [f32], &'a [f32]) {
    let n = out.len() - LATENCY;
    (&out[LATENCY..], &reference[..n])
}

struct Assets {
    clean: Vec<f32>,
    noise_a: Vec<f32>,
    noise_b: Vec<f32>,
}

fn load() -> Option<Assets> {
    let dir = assets()?;
    Some(Assets { clean: wav(&dir.join("clean_freesound_33711.wav")), noise_a: wav(&dir.join("noise_freesound_2530.wav")), noise_b: wav(&dir.join("noise_freesound_573577.wav")) })
}

/// Keyboard: short, sharp clicks (decaying noise bursts) a few times a second.
fn keyboard(len: usize, seed: u32) -> Vec<f32> {
    let mut x = seed;
    let mut rnd = move || {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        x as f32 / u32::MAX as f32
    };
    let mut out = vec![0.0f32; len];
    let mut t = 2000usize;
    while t < len {
        let amp = 0.3 + 0.7 * rnd();
        for i in 0..900.min(len - t) {
            out[t + i] += amp * (rnd() * 2.0 - 1.0) * (-(i as f32) / 120.0).exp();
        }
        t += 4000 + (rnd() * 9000.0) as usize;
    }
    out
}

/// Log-spectral distance (dB) between `est` and `reference`, over 20 ms frames where the
/// reference has speech (within 40 dB of its loudest frame), 100 Hz–8 kHz.
fn lsd(est: &[f32], reference: &[f32]) -> f64 {
    let n = 960;
    let frames = est.len().min(reference.len()) / n;
    let level = |x: &[f32]| energy(x) / x.len() as f64;
    let loud = (0..frames).map(|k| level(&reference[k * n..(k + 1) * n])).fold(0.0, f64::max);
    let spec = |x: &[f32]| -> Vec<f64> {
        // Hann + plain DFT on the bins 2..160 (100 Hz–8 kHz at 50 Hz per bin): slow but simple.
        (2..160)
            .map(|b| {
                let (mut re, mut im) = (0.0f64, 0.0f64);
                for (i, v) in x.iter().enumerate() {
                    let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos();
                    let ph = 2.0 * std::f64::consts::PI * (b * i) as f64 / n as f64;
                    re += *v as f64 * w * ph.cos();
                    im -= *v as f64 * w * ph.sin();
                }
                10.0 * (re * re + im * im + 1e-12).log10()
            })
            .collect()
    };
    let (mut sum, mut count) = (0.0, 0);
    for k in (0..frames).step_by(3) {
        let r = &reference[k * n..(k + 1) * n];
        if level(r) < loud * 1e-4 {
            continue;
        }
        let (a, b) = (spec(&est[k * n..(k + 1) * n]), spec(r));
        let d: f64 = a.iter().zip(&b).map(|(x, y)| (x - y).powi(2)).sum::<f64>() / a.len() as f64;
        sum += d.sqrt();
        count += 1;
    }
    sum / count.max(1) as f64
}

#[test]
fn df_delay_is_the_latency() {
    let Some(a) = load() else { return };
    let out = run_df(&mut DeepFilter::new().unwrap(), &a.clean);
    // The lag with the best match is the filter's delay.
    let corr = |lag: usize| -> f64 { a.clean[..a.clean.len() - 2000].iter().zip(&out[lag..]).map(|(x, y)| *x as f64 * *y as f64).sum() };
    let best = (LATENCY - 480..LATENCY + 480).max_by(|p, q| corr(*p).partial_cmp(&corr(*q)).unwrap()).unwrap();
    assert_eq!(best, LATENCY);
}

/// Clear speech comes through (almost) untouched – measured 33,6 dB SI-SDR, 0,7 dB spectral distance.
#[test]
fn df_keeps_clean_speech() {
    let Some(a) = load() else { return };
    let out = run_df(&mut DeepFilter::new().unwrap(), &a.clean);
    let (o, c) = aligned(&out, &a.clean);
    let (sdr, dist) = (si_sdr(o, c), lsd(o, c));
    eprintln!("clean speech through the filter: SI-SDR {sdr:.1} dB, spectral distance {dist:.1} dB");
    assert!(sdr > 25.0, "{sdr}");
    assert!(dist < 1.5, "{dist}");
}

/// Real noise and keyboard under speech (measured +9…+18 dB SI-SDR).
#[test]
fn df_removes_real_noise_under_speech() {
    let Some(a) = load() else { return };
    for (name, noise, snr) in [("noise 2530", &a.noise_a, 0.0), ("noise 2530", &a.noise_a, 5.0), ("noise 573577", &a.noise_b, 0.0), ("keyboard", &keyboard(a.clean.len(), 7), 0.0)] {
        let (noisy, _) = mix(&a.clean, noise, snr);
        let out = run_df(&mut DeepFilter::new().unwrap(), &noisy);
        let (o, c) = aligned(&out, &a.clean);
        let (before, after) = (si_sdr(&noisy, &a.clean), si_sdr(o, c));
        eprintln!("{name} at {snr} dB SNR: SI-SDR {before:.1} → {after:.1} dB");
        assert!(after - before > 8.0, "{name}: {before} → {after}");
    }
    // The voice's spectrum gets closer to the clean one with noise at 10 dB.
    let (noisy, _) = mix(&a.clean, &a.noise_a, 10.0);
    let out = run_df(&mut DeepFilter::new().unwrap(), &noisy);
    let (o, c) = aligned(&out, &a.clean);
    let (before, after) = (lsd(&noisy, &a.clean), lsd(o, c));
    eprintln!("noise 2530 at 10 dB: spectral distance {before:.1} → {after:.1} dB");
    assert!(after < before - 1.0);
}

/// Without speech it goes (nearly) silent: the level between the words.
#[test]
fn df_silences_noise_without_speech() {
    let Some(a) = load() else { return };
    for (name, noise, cut_min) in [("noise 2530", a.noise_a[..48000 * 8].to_vec(), 18.0), ("noise 573577", a.noise_b.clone(), 17.0), ("keyboard", keyboard(48000 * 6, 3), 50.0)] {
        let noise: Vec<f32> = noise.iter().map(|v| v * 0.3).collect();
        let out = run_df(&mut DeepFilter::new().unwrap(), &noise);
        // After the first second (the filter learning the room).
        let cut = db(energy(&noise[48000..]) / energy(&out[48000..]));
        let mut lvl: Vec<f64> = out[48000..].chunks(480).map(|o| db(energy(o) / 480.0)).collect();
        lvl.sort_by(|x, y| x.partial_cmp(y).unwrap());
        let median = lvl[lvl.len() / 2];
        eprintln!("{name} alone: {cut:.1} dB quieter, median level {median:.0} dBFS");
        assert!(cut > cut_min, "{name}: {cut}");
        assert!(median < -60.0, "{name}: {median}");
    }
}

/// The end of a word is not cut off when the GoXLR's gate closes to digital silence.
#[test]
fn df_lets_the_last_word_out_before_silence() {
    let Some(a) = load() else { return };
    let mut x = a.clean[48000 * 2..48000 * 4].to_vec();
    x.extend(std::iter::repeat(0.0).take(48000));
    let out = run_df(&mut DeepFilter::new().unwrap(), &x);
    let tail = &out[48000 * 2..48000 * 2 + LATENCY];
    let src = &x[48000 * 2 - LATENCY..48000 * 2];
    assert!(energy(tail) > energy(src) * 0.1, "the last 30 ms came out");
    assert!(out[48000 * 2 + LATENCY + 2000..].iter().all(|v| *v == 0.0), "then silence");
}

#[test]
fn df_is_fast_enough() {
    let Some(a) = load() else { return };
    let mut df = DeepFilter::new().unwrap();
    let (noisy, _) = mix(&a.clean, &a.noise_a, 0.0);
    let t = std::time::Instant::now();
    let _ = run_df(&mut df, &noisy);
    let rtf = t.elapsed().as_secs_f64() / (noisy.len() as f64 / 48000.0);
    eprintln!("real-time factor {rtf:.3} (debug builds are much slower)");
    if !cfg!(debug_assertions) {
        assert!(rtf < 0.3, "{rtf}");
    }
}

/// Through the whole cleaner with Stemmeisolering: the network loads in the background, the mic
/// keeps flowing meanwhile (RNNoise, same delay), and then the noise is removed.
#[test]
fn cleaner_isolates_after_loading_in_the_background() {
    let Some(a) = load() else { return };
    let settings = Settings { echo: false, noise: Noise::Isolate, high_pass: false };
    let mut c = Cleaner::new(settings);
    let (noisy, _) = mix(&a.clean, &a.noise_a, 0.0);
    let start = std::time::Instant::now();
    let mut waited = 0;
    while !c.isolating() {
        let mut block = noisy[waited % 48000..waited % 48000 + FRAME].to_vec();
        c.process(&mut block);
        assert!(block.iter().all(|v| v.is_finite()));
        waited += FRAME;
        assert!(start.elapsed().as_secs() < 60, "the network never loaded");
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    eprintln!("network ready after {:?}", start.elapsed());
    c.reset();
    let mut out = noisy.clone();
    for chunk in out.chunks_mut(256) {
        c.process(chunk);
    }
    let delay = c.latency();
    assert_eq!(delay, FRAME + LATENCY);
    let after = si_sdr(&out[delay..], &a.clean[..a.clean.len() - delay]);
    let before = si_sdr(&noisy, &a.clean);
    eprintln!("cleaner, isolate: SI-SDR {before:.1} → {after:.1} dB");
    assert!(after - before > 8.0);
}

