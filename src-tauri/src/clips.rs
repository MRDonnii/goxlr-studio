//! Lydklip: while switched on, the last N seconds of one audio device are kept in memory (nothing
//! is written), and "Gem klip" saves them as a WAV in Music\GoXLR Studio – like a replay buffer for
//! sound. The device is normally the GoXLR's "Broadcast Stream Mix" (what the stream hears: you, the
//! game, the chat …); an output can be used too (a loopback copy of what Windows plays on it).
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Serialize, Clone, Debug, Default)]
pub struct ClipStatus {
    pub running: bool,
    pub device: String,
    pub seconds: u32,
    pub rate: u32,
    /// Seconds of sound in memory (up to `seconds`).
    pub buffered: f32,
    pub error: Option<String>,
}

/// Interleaved stereo samples, the newest `cap` frames.
pub struct StereoRing {
    buf: Vec<f32>,
    pos: usize,
    filled: usize,
}

impl StereoRing {
    pub fn new(frames: usize) -> Self {
        StereoRing { buf: vec![0.0; frames.max(1) * 2], pos: 0, filled: 0 }
    }
    pub fn push(&mut self, l: f32, r: f32) {
        self.buf[self.pos] = l;
        self.buf[self.pos + 1] = r;
        self.pos = (self.pos + 2) % self.buf.len();
        self.filled = (self.filled + 1).min(self.buf.len() / 2);
    }
    pub fn frames(&self) -> usize {
        self.filled
    }
    /// The last `frames` frames, oldest first.
    pub fn last(&self, frames: usize) -> Vec<f32> {
        let n = frames.min(self.filled) * 2;
        let len = self.buf.len();
        let start = (self.pos + len - n) % len;
        (0..n).map(|i| self.buf[(start + i) % len]).collect()
    }
}

/// A 16-bit stereo WAV (plays everywhere, half the size of float).
pub fn wav16(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 4).to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0).round() as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

pub fn clips_dir() -> PathBuf {
    let base = std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Music").join("GoXLR Studio")
}

struct Shared {
    ring: Mutex<StereoRing>,
    rate: AtomicU32,
    stop: AtomicBool,
    running: AtomicBool,
    error: Mutex<Option<String>>,
}

struct Recorder {
    device: String,
    seconds: u32,
    shared: Arc<Shared>,
}

static REC: Mutex<Option<Recorder>> = Mutex::new(None);

pub fn start(device: String, seconds: u32) {
    let seconds = seconds.clamp(5, 300);
    stop();
    let shared = Arc::new(Shared {
        // Room for 192 kHz; the real rate is set when the device is opened.
        ring: Mutex::new(StereoRing::new(1)),
        rate: AtomicU32::new(0),
        stop: AtomicBool::new(false),
        running: AtomicBool::new(true),
        error: Mutex::new(None),
    });
    let (s, d) = (shared.clone(), device.clone());
    std::thread::Builder::new().name("clips".into()).spawn(move || run(d, seconds, s)).ok();
    *REC.lock().unwrap() = Some(Recorder { device, seconds, shared });
}

pub fn stop() {
    if let Some(r) = REC.lock().unwrap().take() {
        r.shared.stop.store(true, Ordering::SeqCst);
    }
}

pub fn status() -> ClipStatus {
    let Some((device, seconds, shared)) = REC.lock().unwrap().as_ref().map(|r| (r.device.clone(), r.seconds, r.shared.clone())) else {
        return ClipStatus::default();
    };
    let rate = shared.rate.load(Ordering::SeqCst);
    let frames = shared.ring.lock().unwrap().frames();
    let error = shared.error.lock().unwrap().clone();
    ClipStatus {
        running: shared.running.load(Ordering::SeqCst),
        device,
        seconds,
        rate,
        buffered: if rate > 0 { frames as f32 / rate as f32 } else { 0.0 },
        error,
    }
}

/// Saves the last `seconds` (0 = all there is) and returns the file's path.
pub fn save(seconds: u32) -> Result<String, String> {
    let (samples, rate) = {
        let rec = REC.lock().unwrap();
        let r = rec.as_ref().ok_or("Lydklip er ikke slået til")?;
        let rate = r.shared.rate.load(Ordering::SeqCst);
        if rate == 0 {
            return Err("Der er ikke optaget noget endnu".into());
        }
        let ring = r.shared.ring.lock().unwrap();
        let want = if seconds == 0 { ring.frames() } else { seconds as usize * rate as usize };
        (ring.last(want), rate)
    };
    if samples.is_empty() {
        return Err("Der er ikke optaget noget endnu".into());
    }
    let dir = clips_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("Klip {}.wav", chrono::Local::now().format("%Y-%m-%d %H.%M.%S"));
    let path = dir.join(name);
    std::fs::write(&path, wav16(&samples, rate)).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[cfg(windows)]
fn run(device: String, seconds: u32, shared: Arc<Shared>) {
    if let Err(e) = capture(&device, seconds, &shared) {
        *shared.error.lock().unwrap() = Some(e);
    }
    shared.running.store(false, Ordering::SeqCst);
}

#[cfg(not(windows))]
fn run(_device: String, _seconds: u32, shared: Arc<Shared>) {
    *shared.error.lock().unwrap() = Some("Kun på Windows".into());
    shared.running.store(false, Ordering::SeqCst);
}

/// Shared-mode capture of a recording device, or a loopback copy of an output.
#[cfg(windows)]
fn capture(device: &str, seconds: u32, shared: &Shared) -> Result<(), String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.message())?;
        let dev = if device.is_empty() {
            en.GetDefaultAudioEndpoint(eCapture, eConsole).map_err(|e| e.message())?
        } else {
            let id: Vec<u16> = device.encode_utf16().chain(std::iter::once(0)).collect();
            en.GetDevice(PCWSTR(id.as_ptr())).map_err(|e| e.message())?
        };
        let render = dev.cast::<IMMEndpoint>().ok().and_then(|e| e.GetDataFlow().ok()) == Some(eRender);
        let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(|e| e.message())?;
        let fmt = client.GetMixFormat().map_err(|e| e.message())?;
        let wf: WAVEFORMATEX = std::ptr::read_unaligned(fmt);
        let (tag, channels, bits, rate) = (wf.wFormatTag, wf.nChannels as usize, wf.wBitsPerSample, wf.nSamplesPerSec);
        let kind = if tag == 0xFFFE { std::ptr::read_unaligned(fmt as *const WAVEFORMATEXTENSIBLE).SubFormat.data1 as u16 } else { tag };
        let float = kind == 3 && bits == 32;
        let pcm = kind == 1 && (bits == 16 || bits == 24 || bits == 32);
        if !(float || pcm) || channels == 0 {
            CoTaskMemFree(Some(fmt as *const _));
            return Err(format!("ukendt lydformat ({kind}, {bits} bit)"));
        }
        let flags = if render { AUDCLNT_STREAMFLAGS_LOOPBACK } else { 0 };
        let r = client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, fmt, None);
        CoTaskMemFree(Some(fmt as *const _));
        r.map_err(|e| e.message())?;
        let cap: IAudioCaptureClient = client.GetService().map_err(|e| e.message())?;
        *shared.ring.lock().unwrap() = StereoRing::new(seconds as usize * rate as usize);
        shared.rate.store(rate, Ordering::SeqCst);
        client.Start().map_err(|e| e.message())?;
        let bytes = (bits / 8) as usize;
        let read = |p: *const u8| -> f32 {
            match (float, bits) {
                (true, _) => std::ptr::read_unaligned(p as *const f32),
                (false, 16) => std::ptr::read_unaligned(p as *const i16) as f32 / 32768.0,
                (false, 24) => (i32::from_le_bytes([0, *p, *p.add(1), *p.add(2)]) as f32) / 2147483648.0,
                _ => std::ptr::read_unaligned(p as *const i32) as f32 / 2147483648.0,
            }
        };
        let result = loop {
            if shared.stop.load(Ordering::SeqCst) {
                break Ok(());
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
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
                let (mut frames, mut fl) = (0u32, 0u32);
                if let Err(e) = cap.GetBuffer(&mut data, &mut frames, &mut fl, None, None) {
                    failed = Some(e.message());
                    break;
                }
                let silent = fl & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null();
                {
                    let mut ring = shared.ring.lock().unwrap();
                    for f in 0..frames as usize {
                        if silent {
                            ring.push(0.0, 0.0);
                            continue;
                        }
                        let base = data.add(f * channels * bytes);
                        let l = read(base);
                        let r = if channels > 1 { read(base.add(bytes)) } else { l };
                        ring.push(l, r);
                    }
                }
                let _ = cap.ReleaseBuffer(frames);
            }
            if let Some(e) = failed {
                break Err(e);
            }
        };
        let _ = client.Stop();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_keeps_the_newest() {
        let mut r = StereoRing::new(3);
        for i in 0..5 {
            r.push(i as f32, -(i as f32));
        }
        assert_eq!(r.frames(), 3);
        assert_eq!(r.last(2), vec![3.0, -3.0, 4.0, -4.0]);
        assert_eq!(r.last(10), vec![2.0, -2.0, 3.0, -3.0, 4.0, -4.0]);
        assert!(StereoRing::new(4).last(4).is_empty());
    }

    #[test]
    fn wav16_header_and_clipping() {
        let w = wav16(&[0.5, -2.0], 48000);
        assert_eq!(&w[0..4], b"RIFF");
        assert_eq!(u16::from_le_bytes([w[22], w[23]]), 2);
        assert_eq!(u32::from_le_bytes([w[24], w[25], w[26], w[27]]), 48000);
        assert_eq!(i16::from_le_bytes([w[44], w[45]]), 16384);
        assert_eq!(i16::from_le_bytes([w[46], w[47]]), -32767);
    }
}
