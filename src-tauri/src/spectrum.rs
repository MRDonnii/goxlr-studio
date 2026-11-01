//! Live-spektrum for the EQ page: Windows' loopback capture of one output (what plays on it right
//! now), as 1/12-octave levels from 20 Hz to 20 kHz. Like the VU meters it only runs while the UI
//! keeps asking, so it costs nothing when the EQ page is closed.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// 120 bands from 20 Hz to 20 kHz: about 12 per octave.
pub const BANDS: usize = 120;
const F_LO: f64 = 20.0;
const F_HI: f64 = 20000.0;
/// 8192 samples ≈ 170 ms at 48 kHz: 5,9 Hz between FFT bins, enough for the bass.
const FFT: usize = 8192;
/// What a band reads with no sound.
pub const FLOOR: f32 = -120.0;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Spectrum {
    /// Endpoint id ("" = Windows' default output).
    pub device: String,
    pub rate: u32,
    /// dB per band; a full-scale sine reads 0 dB.
    pub bands: Vec<f32>,
    /// Sound came in during the last half second.
    pub playing: bool,
    pub error: Option<String>,
}

/// Centre frequency of band `i`.
pub fn band_center(i: usize) -> f64 {
    F_LO * (F_HI / F_LO).powf(i as f64 / (BANDS - 1) as f64)
}

/// In-place radix-2 FFT (n must be a power of two).
pub fn fft(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -2.0 * std::f64::consts::PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0, 0.0);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
        len <<= 1;
    }
}

/// 1/12-octave levels of a block of mono samples (oldest first; the block length must be a power
/// of two). Each FFT bin's power is shared between the bands it overlaps, so pink noise reads flat
/// and the narrow bass bands still get their part.
pub fn band_levels(samples: &[f32], rate: u32) -> Vec<f32> {
    let n = samples.len();
    if n < 64 || !n.is_power_of_two() || rate == 0 {
        return vec![FLOOR; BANDS];
    }
    let win: Vec<f64> = (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos()).collect();
    let wsum2: f64 = win.iter().map(|w| w * w).sum();
    let mut re: Vec<f64> = samples.iter().zip(&win).map(|(s, w)| *s as f64 * w).collect();
    let mut im = vec![0.0; n];
    fft(&mut re, &mut im);
    // One-sided power per bin, scaled so the bins of a sine add up to its mean square (Parseval).
    let df = rate as f64 / n as f64;
    let half = n / 2;
    let power: Vec<f64> = (0..=half).map(|k| (re[k] * re[k] + im[k] * im[k]) * if k == 0 || k == half { 1.0 } else { 2.0 } / (n as f64 * wsum2)).collect();
    let ratio = (F_HI / F_LO).powf(0.5 / (BANDS - 1) as f64);
    (0..BANDS)
        .map(|i| {
            let c = band_center(i);
            let (lo, hi) = (c / ratio, c * ratio);
            let first = ((lo / df) - 0.5).floor().max(0.0) as usize;
            let last = (((hi / df) + 0.5).ceil() as usize).min(half);
            let mut p = 0.0;
            for (k, pk) in power.iter().enumerate().take(last + 1).skip(first) {
                let (b0, b1) = ((k as f64 - 0.5) * df, (k as f64 + 0.5) * df);
                let overlap = (hi.min(b1) - lo.max(b0)).max(0.0);
                p += pk * overlap / df;
            }
            // ×2: a full-scale sine (mean square ½) reads 0 dB.
            if p > 0.0 {
                ((10.0 * (2.0 * p).log10()) as f32).max(FLOOR)
            } else {
                FLOOR
            }
        })
        .collect()
}

/// The last FFT samples, mono.
struct Ring {
    buf: Vec<f32>,
    pos: usize,
}

impl Ring {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn push(&mut self, s: f32) {
        self.buf[self.pos] = s;
        self.pos = (self.pos + 1) % self.buf.len();
    }
    fn ordered(&self) -> Vec<f32> {
        let mut v = Vec::with_capacity(self.buf.len());
        v.extend_from_slice(&self.buf[self.pos..]);
        v.extend_from_slice(&self.buf[..self.pos]);
        v
    }
}

struct Shared {
    ring: Mutex<Ring>,
    rate: AtomicU32,
    last_ask: AtomicU64,
    last_audio: AtomicU64,
    stop: AtomicBool,
    running: AtomicBool,
    error: Mutex<Option<String>>,
}

struct Capture {
    device: String,
    started: u64,
    shared: Arc<Shared>,
}

static CAPTURE: Mutex<Option<Capture>> = Mutex::new(None);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// The spectrum of `device` (an endpoint id; None = Windows' default output) right now. Starts the
/// capture, or moves it to another output; it stops by itself 3 s after the last call.
pub fn read(device: Option<String>) -> Spectrum {
    let device = device.unwrap_or_default();
    let now = now_ms();
    let mut cap = CAPTURE.lock().unwrap();
    let restart = match cap.as_ref() {
        Some(c) if c.device == device => {
            // A capture that failed is tried again after 3 s (e.g. the output came back).
            !c.shared.running.load(Ordering::SeqCst) && now.saturating_sub(c.started) > 3000
        }
        _ => true,
    };
    if restart {
        if let Some(old) = cap.take() {
            old.shared.stop.store(true, Ordering::SeqCst);
        }
        let shared = Arc::new(Shared {
            ring: Mutex::new(Ring { buf: vec![0.0; FFT], pos: 0 }),
            rate: AtomicU32::new(0),
            last_ask: AtomicU64::new(now),
            last_audio: AtomicU64::new(0),
            stop: AtomicBool::new(false),
            running: AtomicBool::new(true),
            error: Mutex::new(None),
        });
        let (s, d) = (shared.clone(), device.clone());
        std::thread::Builder::new().name("spectrum".into()).spawn(move || run(d, s)).ok();
        *cap = Some(Capture { device: device.clone(), started: now, shared });
    }
    let shared = cap.as_ref().map(|c| c.shared.clone()).unwrap();
    drop(cap);
    shared.last_ask.store(now, Ordering::SeqCst);
    let rate = shared.rate.load(Ordering::SeqCst);
    let playing = rate > 0 && now.saturating_sub(shared.last_audio.load(Ordering::SeqCst)) < 500;
    let bands = if playing { band_levels(&shared.ring.lock().unwrap().ordered(), rate) } else { vec![FLOOR; BANDS] };
    let error = shared.error.lock().unwrap().clone();
    Spectrum { device, rate, bands, playing, error }
}

#[cfg(windows)]
fn run(device: String, shared: Arc<Shared>) {
    if let Err(e) = capture(&device, &shared) {
        *shared.error.lock().unwrap() = Some(e);
    }
    shared.running.store(false, Ordering::SeqCst);
}

/// Loopback capture: a shared-mode capture stream on the render endpoint gives a copy of what
/// Windows plays on it.
#[cfg(windows)]
fn capture(device: &str, shared: &Shared) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.message())?;
        let dev = if device.is_empty() {
            en.GetDefaultAudioEndpoint(eRender, eConsole).map_err(|e| e.message())?
        } else {
            let id: Vec<u16> = device.encode_utf16().chain(std::iter::once(0)).collect();
            en.GetDevice(PCWSTR(id.as_ptr())).map_err(|e| e.message())?
        };
        let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(|e| e.message())?;
        let fmt = client.GetMixFormat().map_err(|e| e.message())?;
        let wf: WAVEFORMATEX = std::ptr::read_unaligned(fmt);
        let (tag, channels, bits, rate) = (wf.wFormatTag, wf.nChannels as usize, wf.wBitsPerSample, wf.nSamplesPerSec);
        // WAVE_FORMAT_EXTENSIBLE: the real format is the first part of SubFormat's GUID.
        let kind = if tag == 0xFFFE { std::ptr::read_unaligned(fmt as *const WAVEFORMATEXTENSIBLE).SubFormat.data1 as u16 } else { tag };
        let float = kind == 3 && bits == 32;
        let pcm = kind == 1 && (bits == 16 || bits == 24 || bits == 32);
        if !(float || pcm) || channels == 0 {
            CoTaskMemFree(Some(fmt as *const _));
            return Err(format!("ukendt lydformat ({kind}, {bits} bit)"));
        }
        let r = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, fmt, None);
        CoTaskMemFree(Some(fmt as *const _));
        r.map_err(|e| e.message())?;
        let cap: IAudioCaptureClient = client.GetService().map_err(|e| e.message())?;
        client.Start().map_err(|e| e.message())?;
        shared.rate.store(rate, Ordering::SeqCst);
        let bytes = (bits / 8) as usize;
        let result = loop {
            if shared.stop.load(Ordering::SeqCst) || now_ms().saturating_sub(shared.last_ask.load(Ordering::SeqCst)) > 3000 {
                break Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(15));
            let mut failed = None;
            loop {
                let n = match cap.GetNextPacketSize() {
                    Ok(n) => n,
                    Err(e) => {
                        failed = Some(e.message());
                        break;
                    }
                };
                if n == 0 {
                    break;
                }
                let mut data: *mut u8 = std::ptr::null_mut();
                let (mut frames, mut flags) = (0u32, 0u32);
                if let Err(e) = cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None) {
                    failed = Some(e.message());
                    break;
                }
                let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null();
                {
                    let mut ring = shared.ring.lock().unwrap();
                    for f in 0..frames as usize {
                        let mut sum = 0.0f32;
                        if !silent {
                            for c in 0..channels {
                                let p = data.add((f * channels + c) * bytes);
                                sum += match (float, bits) {
                                    (true, _) => std::ptr::read_unaligned(p as *const f32),
                                    (false, 16) => std::ptr::read_unaligned(p as *const i16) as f32 / 32768.0,
                                    (false, 24) => (i32::from_le_bytes([0, *p, *p.add(1), *p.add(2)]) as f32) / 2147483648.0,
                                    _ => std::ptr::read_unaligned(p as *const i32) as f32 / 2147483648.0,
                                };
                            }
                        }
                        ring.push(sum / channels as f32);
                    }
                }
                let _ = cap.ReleaseBuffer(frames);
                if !silent && frames > 0 {
                    shared.last_audio.store(now_ms(), Ordering::SeqCst);
                }
            }
            if let Some(e) = failed {
                break Err(e);
            }
        };
        let _ = client.Stop();
        result
    }
}

#[cfg(not(windows))]
fn run(_device: String, shared: Arc<Shared>) {
    *shared.error.lock().unwrap() = Some("Kun på Windows".into());
    shared.running.store(false, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, amp: f64, rate: u32, n: usize) -> Vec<f32> {
        (0..n).map(|i| (amp * (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin()) as f32).collect()
    }

    #[test]
    fn fft_finds_a_sine() {
        let n = 1024;
        let mut re: Vec<f64> = (0..n).map(|i| (2.0 * std::f64::consts::PI * 8.0 * i as f64 / n as f64).cos()).collect();
        let mut im = vec![0.0; n];
        fft(&mut re, &mut im);
        let mag: Vec<f64> = re.iter().zip(&im).map(|(r, i)| (r * r + i * i).sqrt()).collect();
        assert!((mag[8] - n as f64 / 2.0).abs() < 1e-6);
        assert!(mag[3] < 1e-6 && mag[100] < 1e-6);
    }

    #[test]
    fn a_sine_shows_up_in_its_band_at_its_level() {
        for (i, amp) in [(30usize, 1.0f64), (67, 0.5), (100, 0.25)] {
            let f = band_center(i);
            let levels = band_levels(&sine(f, amp, 48000, FFT), 48000);
            // The sine's power spreads over the neighbouring bands; together they read its level.
            let total: f64 = levels.iter().map(|db| 10f64.powf(*db as f64 / 10.0)).sum();
            let want = 20.0 * amp.log10();
            assert!((10.0 * total.log10() - want).abs() < 0.5, "band {i}: {} vs {want}", 10.0 * total.log10());
            let loudest = levels.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).unwrap().0;
            assert!((loudest as i64 - i as i64).abs() <= 1, "band {i}: loudest {loudest}");
        }
    }

    #[test]
    fn silence_reads_the_floor() {
        assert!(band_levels(&vec![0.0; FFT], 48000).iter().all(|db| *db == FLOOR));
        assert_eq!(band_levels(&[0.1; 100], 48000).len(), BANDS);
    }

    #[test]
    fn white_noise_rises_three_db_per_octave() {
        // Deterministic white noise (xorshift): equal power per Hz → +3 dB per octave in 1/12-octave bands.
        let mut x: u32 = 0x1234_5678;
        let noise: Vec<f32> = (0..FFT)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x as f32 / u32::MAX as f32) * 2.0 - 1.0
            })
            .collect();
        let l = band_levels(&noise, 48000);
        let avg = |a: usize, b: usize| l[a..b].iter().map(|v| *v as f64).sum::<f64>() / (b - a) as f64;
        // 1 kHz region vs 4 kHz region (two octaves): ≈ +6 dB.
        let d = avg(96, 108) - avg(72, 84);
        assert!((d - 6.0).abs() < 1.5, "{d}");
    }

    #[test]
    fn band_centres_span_20_hz_to_20_khz() {
        assert!((band_center(0) - 20.0).abs() < 1e-9);
        assert!((band_center(BANDS - 1) - 20000.0).abs() < 1e-6);
        assert!((band_center(12) / band_center(0) - 2f64.powf(12.0 / (BANDS - 1) as f64 * (1000f64.log2()))).abs() < 1e-9);
    }
}
