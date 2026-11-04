//! Simulated rooms: the speakers' sound reaches the mic as an echo (delayed, filtered, quieter),
//! with or without your own voice and noise on top. The cleaner must remove the echo and the
//! noise and keep the voice.
use super::*;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        ((self.0 >> 11) as f64 / (1u64 << 53) as f64) as f32 * 2.0 - 1.0
    }
}

const SR: f32 = RATE as f32;

/// A voice-like signal: a pitched, buzzy tone with two formants, in syllables (~4 per second).
fn voice(len: usize, pitch: f32, seed: u64) -> Vec<f32> {
    let mut rng = Rng(seed);
    let mut out = vec![0f32; len];
    let (mut ph, mut f1, mut f2) = (0f32, 0f32, 0f32);
    let mut lp = 0f32;
    for (i, o) in out.iter_mut().enumerate() {
        let t = i as f32 / SR;
        let p = pitch * (1.0 + 0.08 * (t * 1.3).sin());
        ph = (ph + p / SR).fract();
        let glottal = (1.0 - 2.0 * ph) + 0.05 * rng.next();
        // Two resonators (≈ 700 Hz and 1200 Hz) on the buzz.
        f1 += 0.12 * (glottal - f1) + 0.02 * (2.0 * std::f32::consts::PI * 700.0 * t).sin() * glottal;
        f2 += 0.25 * (glottal - f2) + 0.02 * (2.0 * std::f32::consts::PI * 1200.0 * t).sin() * glottal;
        lp += 0.3 * ((f1 + 0.6 * f2) - lp);
        let syll = (2.0 * std::f32::consts::PI * 4.0 * t).sin().max(0.0).powf(0.6);
        *o = 0.25 * lp * syll;
    }
    out
}

/// Game/music-like speaker sound: band-limited noise with a slow loudness swing plus a melody.
fn speaker(len: usize, seed: u64) -> Vec<f32> {
    let mut rng = Rng(seed);
    let mut lp = 0f32;
    (0..len)
        .map(|i| {
            let t = i as f32 / SR;
            lp += 0.2 * (rng.next() - lp);
            let env = 0.6 + 0.4 * (2.0 * std::f32::consts::PI * 0.7 * t).sin();
            let melody = 0.15 * (2.0 * std::f32::consts::PI * (330.0 + 110.0 * ((t * 2.0).floor() % 3.0)) * t).sin();
            0.3 * env * (lp + melody)
        })
        .collect()
}

/// The room: delayed, low-passed, quieter copy plus a reflection.
fn echo_of(x: &[f32], delay: usize, gain: f32) -> Vec<f32> {
    let mut out = vec![0f32; x.len()];
    let mut lp = 0f32;
    for i in 0..x.len() {
        let d = if i >= delay { x[i - delay] } else { 0.0 };
        let r = if i >= delay + 300 { x[i - delay - 300] } else { 0.0 };
        lp += 0.5 * (d - lp);
        out[i] = gain * (lp + 0.3 * r);
    }
    out
}

fn energy(x: &[f32]) -> f64 {
    x.iter().map(|&v| (v as f64) * (v as f64)).sum::<f64>() / x.len().max(1) as f64
}

fn db(ratio: f64) -> f64 {
    10.0 * ratio.max(1e-20).log10()
}

/// Runs the cleaner over `mic` with `refsig` as the speakers' sound, frame by frame (as the plugin
/// does: the reference that has arrived first, then the mic block).
fn run(settings: Settings, mic: &[f32], refsig: Option<&[f32]>, block: usize) -> Vec<f32> {
    let mut c = Cleaner::new(settings);
    let mut out = mic.to_vec();
    let mut i = 0;
    while i < mic.len() {
        let n = block.min(mic.len() - i);
        if let Some(r) = refsig {
            c.push_render(&r[i..i + n]);
        }
        c.process(&mut out[i..i + n]);
        i += n;
    }
    // Undo the cleaner's constant latency so the signals line up.
    let lat = FRAME;
    let mut aligned = out[lat..].to_vec();
    aligned.resize(mic.len(), 0.0);
    aligned
}

const ALL: Settings = Settings { echo: true, noise: Noise::Normal, high_pass: true };

#[test]
fn bypass_is_a_clean_one_frame_delay() {
    let off = Settings { echo: false, noise: Noise::Off, high_pass: false };
    let mut rng = Rng(1);
    let x: Vec<f32> = (0..48000).map(|_| rng.next() * 0.5).collect();
    let y = run(off, &x, None, 333);
    assert_eq!(&y[..48000 - FRAME], &x[..48000 - FRAME]);
}

#[test]
fn removes_the_speakers_from_the_mic() {
    // 12 s of game sound on the speakers, heard by the mic 40 ms later at −8 dB. You are quiet.
    let len = 12 * 48000;
    let spk = speaker(len, 7);
    let echo = echo_of(&spk, 1920, 0.4);
    let out = run(ALL, &echo, Some(&spk), 480);
    // After it has learned the room (the first 4 s), the echo must be far down.
    let tail = 4 * 48000..len;
    let reduction = db(energy(&echo[tail.clone()]) / energy(&out[tail]));
    assert!(reduction >= 25.0, "echo reduced only {reduction:.1} dB");
}

#[test]
fn without_a_reference_the_mic_is_not_harmed() {
    // GoXLR Studio is not running (no speaker sound arrives): the voice passes.
    let len = 6 * 48000;
    let near = voice(len, 180.0, 5);
    let out = run(ALL, &near, None, 441);
    let tail = 2 * 48000..len;
    let kept = db(energy(&out[tail.clone()]) / energy(&near[tail]));
    assert!(kept > -4.0, "voice lost {kept:.1} dB");
}

fn noise_test(noise: Noise, min_cut: f64) {
    // Fan-like noise at about −40 dBFS, with you talking in every other second.
    let len = 10 * 48000;
    let mut rng = Rng(9);
    let mut lp = 0f32;
    let fan: Vec<f32> = (0..len).map(|_| { lp += 0.3 * (rng.next() - lp); 0.02 * lp }).collect();
    let talk = voice(len, 150.0, 21);
    let speaking = |i: usize| (i / 48000) % 2 == 1;
    let mic: Vec<f32> = (0..len).map(|i| fan[i] + if speaking(i) { talk[i] } else { 0.0 }).collect();
    let out = run(Settings { echo: false, noise, high_pass: true }, &mic, None, 480);
    // Quiet seconds 4, 6, 8 (after learning) and talking seconds 5, 7, 9.
    let pick = |x: &[f32], odd: bool| -> Vec<f32> { (4..10).filter(|s| (s % 2 == 1) == odd).flat_map(|s| x[s * 48000 + 4800..(s + 1) * 48000 - 4800].to_vec()).collect() };
    let cut = db(energy(&pick(&mic, false)) / energy(&pick(&out, false)));
    assert!(cut >= min_cut, "{noise:?}: noise cut only {cut:.1} dB");
    let talk_in: Vec<f32> = pick(&mic, true);
    let kept = db(energy(&pick(&out, true)) / energy(&talk_in));
    assert!(kept > -6.0, "{noise:?}: voice lost {kept:.1} dB");
}

#[test]
fn normal_noise_suppression_cuts_steady_noise() {
    noise_test(Noise::Normal, 6.0);
}

#[test]
fn strong_noise_suppression_cuts_more() {
    noise_test(Noise::Strong, 12.0);
}

#[test]
fn broken_input_never_comes_out_broken() {
    let mut c = Cleaner::new(ALL);
    let mut x: Vec<f32> = (0..4800).map(|i| if i % 97 == 0 { f32::NAN } else if i % 89 == 0 { f32::INFINITY } else { 0.1 }).collect();
    c.push_render(&[f32::NAN; 960]);
    c.process(&mut x);
    assert!(x.iter().all(|v| v.is_finite()));
}

#[test]
fn settings_from_the_engine_parameters() {
    assert_eq!(Settings::from_normalized(&DEFAULTS), Settings { echo: true, noise: Noise::Normal, high_pass: true });
    assert_eq!(Settings::from_normalized(&[0.0, 0.0, 0.0, 0.0]), Settings { echo: false, noise: Noise::Off, high_pass: false });
    assert_eq!(Settings::from_normalized(&[1.0, 1.0, 0.0, 0.0]).noise, Noise::Strong);
    // Isolate wins over Noise (old configs without it keep their noise setting).
    assert_eq!(Settings::from_normalized(&[1.0, 0.0, 1.0, 1.0]).noise, Noise::Isolate);
    assert_eq!(Settings::from_normalized(&[1.0, 0.5, 1.0, 0.4]).noise, Noise::Normal);
}

/// The audio engine gives ~10 ms blocks: one second of audio must take far less than a second.
#[test]
#[cfg_attr(debug_assertions, ignore = "speed is measured in release builds")]
fn fast_enough_for_the_audio_engine() {
    let len = 10 * 48000;
    let spk = speaker(len, 2);
    let mic: Vec<f32> = echo_of(&spk, 1920, 0.4).iter().zip(voice(len, 140.0, 4)).map(|(a, b)| a + b).collect();
    let t = std::time::Instant::now();
    let _ = run(Settings { echo: true, noise: Noise::Strong, high_pass: true }, &mic, Some(&spk), 480);
    let per_second = t.elapsed().as_secs_f64() / 10.0;
    assert!(per_second < 0.15, "{:.0} ms per second of audio", per_second * 1000.0);
}



/// RBJ biquad (low-pass or high-pass), applied twice (4th order).
fn biquad(x: &[f32], f: f32, high: bool) -> Vec<f32> {
    let w = 2.0 * std::f32::consts::PI * f / SR;
    let (s, c) = (w.sin(), w.cos());
    let a = s / (2.0 * 0.7071);
    let (b0, b1, b2) = if high { ((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0) } else { ((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0) };
    let (a0, a1, a2) = (1.0 + a, -2.0 * c, 1.0 - a);
    let mut y = x.to_vec();
    for _ in 0..2 {
        let (mut x1, mut x2, mut y1, mut y2) = (0f32, 0f32, 0f32, 0f32);
        for v in y.iter_mut() {
            let x0 = *v;
            let out = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
            x2 = x1; x1 = x0; y2 = y1; y1 = out;
            *v = out;
        }
    }
    y
}
fn band(x: &[f32], lo: f32, hi: f32) -> Vec<f32> {
    biquad(&biquad(x, lo, true), hi, false)
}

/// Game sound only in 3–7 kHz, voice only below 2 kHz: then what the cleaner leaves of the game
/// while you talk can be measured exactly.
fn double_talk_case(settings: Settings) -> (f64, f64) {
    let len = 20 * 48000;
    let spk = band(&speaker(len, 11), 3000.0, 7000.0).iter().map(|v| v * 3.0).collect::<Vec<_>>();
    let echo = echo_of(&spk, 1920, 0.6);
    let v = biquad(&voice(len, 130.0, 3), 1800.0, false);
    let near: Vec<f32> = (0..len).map(|i| if i < 6 * 48000 { 0.0 } else { v[i] }).collect();
    let mic: Vec<f32> = (0..len).map(|i| near[i] + echo[i]).collect();
    let out = run(settings, &mic, Some(&spk), 480);
    let r = 8 * 48000..len;
    let game_left = db(energy(&band(&out, 3000.0, 7000.0)[r.clone()]) / energy(&band(&echo, 3000.0, 7000.0)[r.clone()]));
    let voice_kept = db(energy(&biquad(&out, 2000.0, false)[r.clone()]) / energy(&biquad(&near, 2000.0, false)[r.clone()]));
    (game_left, voice_kept)
}

#[test]
fn keeps_your_voice_and_removes_the_game_while_you_talk() {
    for s in [ALL, Settings { echo: true, noise: Noise::Strong, high_pass: true }, Settings { echo: true, noise: Noise::Off, high_pass: false }] {
        let (game, voice) = double_talk_case(s);
        assert!(game <= -20.0, "{s:?}: game only {game:.1} dB down while talking");
        assert!(voice > -3.0, "{s:?}: voice lost {voice:.1} dB");
    }
}

/// Echo-only reduction after learning, for an echo arriving `delay` samples after the reference,
/// with the reference arriving in uneven pieces (as the app sends it every few ms).
fn echo_reduction(delay: usize, gain: f32, jitter: bool) -> f64 {
    let len = 12 * 48000;
    let spk = speaker(len, 5);
    let echo = echo_of(&spk, delay, gain);
    let mut c = Cleaner::new(ALL);
    let mut out = echo.clone();
    let mut rng = Rng(77);
    let (mut fed, mut i) = (0usize, 0usize);
    while i < len {
        let n = 480.min(len - i);
        // Reference: on time, or in pieces of 0–2 frames (never behind by more than 2 frames).
        let want = i + n;
        if jitter {
            while fed < want {
                let piece = ((rng.next().abs() * 3.0) as usize * 240).min(len - fed);
                if piece == 0 && fed + 960 > want { break; }
                let piece = piece.max(240).min(len - fed);
                c.push_render(&spk[fed..fed + piece]);
                fed += piece;
                if fed + 960 < want { continue; }
                break;
            }
        } else {
            c.push_render(&spk[fed..want]);
            fed = want;
        }
        c.process(&mut out[i..i + n]);
        i += n;
    }
    let tail = 5 * 48000..len - FRAME;
    db(energy(&echo[tail.start..tail.end]) / energy(&out[tail.start + FRAME..tail.end + FRAME]))
}

#[test]
fn echo_delays_from_short_to_long() {
    // 10 ms (speakers close, fast pc) … 250 ms (slow Bluetooth-like path).
    for ms in [10usize, 40, 120, 250] {
        let r = echo_reduction(ms * 48, 0.4, false);
        assert!(r >= 25.0, "{ms} ms: echo reduced only {r:.1} dB");
    }
}

#[test]
fn loud_speakers_and_uneven_reference() {
    let r = echo_reduction(1920, 1.0, false);
    assert!(r >= 25.0, "loud speakers: {r:.1} dB");
    let r = echo_reduction(1920, 0.4, true);
    assert!(r >= 25.0, "uneven reference: {r:.1} dB");
}

#[test]
fn follows_when_the_echo_path_changes() {
    // You move (or the speakers do): the echo comes 25 ms later from 8 s on.
    let len = 16 * 48000;
    let spk = speaker(len, 13);
    let e1 = echo_of(&spk, 1920, 0.4);
    let e2 = echo_of(&spk, 3120, 0.5);
    let mic: Vec<f32> = (0..len).map(|i| if i < 8 * 48000 { e1[i] } else { e2[i] }).collect();
    let out = run(ALL, &mic, Some(&spk), 480);
    let r = 11 * 48000..len;
    let red = db(energy(&mic[r.clone()]) / energy(&out[r]));
    assert!(red >= 25.0, "after the change: {red:.1} dB");
}
