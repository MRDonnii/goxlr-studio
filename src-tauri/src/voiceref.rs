//! Ren mikrofon's echo reference: what the speakers play, sent to the plugin on the microphone
//! (plugins/voiceclean) through shared memory, so its echo canceller can remove it from the mic.
//!
//! The speakers' sound is put together from Windows' loopback copy of the outputs that play on
//! them (the GoXLR channels routed to the speakers, each weighted by its fader – worked out in
//! public/js/voiceclean.js – or one other output). Every packet carries Windows' timestamp, so the
//! outputs are laid side by side on one timeline and mixed to mono 48 kHz; nothing is held back
//! longer than needed, because the reference must reach the plugin before the echo does.
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[path = "../../plugins/voiceclean/src/ring.rs"]
#[allow(dead_code)]
mod ring;

pub const RATE: u32 = ring::RATE;

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Source {
    /// Endpoint id of an output.
    pub device: String,
    /// Linear gain (the GoXLR fader, mute = 0).
    pub gain: f32,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq, Default)]
pub struct Config {
    pub enabled: bool,
    #[serde(default)]
    pub sources: Vec<Source>,
    /// Stemmeskifter: the effect for the plugin (fx::encode in plugins/voiceclean; 0 = off).
    #[serde(default)]
    pub fx: u32,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct SourceStatus {
    pub device: String,
    pub ok: bool,
    pub rate: u32,
    pub playing: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct Status {
    pub enabled: bool,
    /// The shared memory is open (the plugin has run on the microphone since Windows started).
    pub connected: bool,
    /// The plugin reported within the last 2 s (something records from the microphone).
    pub plugin: bool,
    pub echo: bool,
    pub noise: bool,
    /// The plugin receives the speakers' sound.
    pub reference: bool,
    /// The plugin passes the mic through untouched (a problem, or not 48 kHz).
    pub bypassed: bool,
    /// The plugin hit a problem and passes the mic through (plugins from 0.15.0).
    pub broken: bool,
    /// A Stemmeskifter effect runs in the plugin (plugins from 0.16.0).
    pub fx: bool,
    /// Stemmeisolering: "running", "loading", "unavailable" (RNNoise instead) or None (off).
    pub isolate: Option<String>,
    /// The mic's level before and after cleaning (dBFS, last half second; plugins from 0.14.1).
    pub in_db: Option<f32>,
    pub out_db: Option<f32>,
    /// Recordings of the mic being cleaned right now (one plugin instance each; None = a plugin
    /// before 0.14.2, which does not count them).
    pub instances: Option<usize>,
    /// How much echo is removed right now (WebRTC's ERLE).
    pub erle_db: Option<f32>,
    pub delay_ms: Option<i32>,
    /// The speakers played something in the last half second.
    pub playing: bool,
    pub sources: Vec<SourceStatus>,
    pub error: Option<String>,
}

/// Pure: the plugin's report turned into the status (beat/now in ms of the same clock).
pub fn plugin_status(st: &mut Status, report: (u64, u32, f32, i32), now_ms: u64) {
    let (beat, flags, erle, delay) = report;
    st.plugin = beat != 0 && now_ms.saturating_sub(beat) < 2000;
    let on = |f: u32| st.plugin && flags & f != 0;
    st.echo = on(ring::FLAG_AEC_ON);
    st.noise = on(ring::FLAG_NS_ON);
    st.reference = on(ring::FLAG_REFERENCE);
    st.bypassed = on(ring::FLAG_BYPASSED);
    st.broken = on(ring::FLAG_BROKEN);
    st.fx = on(ring::FLAG_FX);
    st.isolate = if on(ring::FLAG_ISOLATE) {
        Some("running".into())
    } else if on(ring::FLAG_ISOLATE_LOADING) {
        Some("loading".into())
    } else if on(ring::FLAG_ISOLATE_UNAVAILABLE) {
        Some("unavailable".into())
    } else {
        None
    };
    st.erle_db = (st.echo && erle.is_finite()).then_some(erle);
    st.delay_ms = (st.echo && delay >= 0).then_some(delay);
}

// ---------------------------------------------------------------------------------------------
// Pure parts: mono, resampling and the timeline mixer.
// ---------------------------------------------------------------------------------------------

/// Linear-interpolation resampler to 48 kHz (enough for an echo reference).
pub struct Resampler {
    step: f64,
    pos: f64,
    prev: f32,
}

impl Resampler {
    pub fn new(from: u32) -> Resampler {
        Resampler { step: from as f64 / RATE as f64, pos: 0.0, prev: 0.0 }
    }

    pub fn process(&mut self, x: &[f32], out: &mut Vec<f32>) {
        if (self.step - 1.0).abs() < 1e-9 {
            out.extend_from_slice(x);
            return;
        }
        for &s in x {
            while self.pos < 1.0 {
                out.push(self.prev + (s - self.prev) * self.pos as f32);
                self.pos += self.step;
            }
            self.pos -= 1.0;
            self.prev = s;
        }
    }
}

/// One second of timeline.
const CAP: usize = RATE as usize;
/// A packet starting within 10 ms of where the last one ended continues it (Windows' timestamps
/// jitter a little; the device's own clock keeps the samples contiguous).
const SNAP: u64 = 480;
/// An output that sent nothing for 40 ms is quiet (Windows sends no loopback packets in silence).
const ACTIVE_MS: u64 = 40;
/// With nothing playing, silence is written 20 ms behind the clock, so a sound that starts is not cut.
const IDLE_LAG: u64 = 960;
/// An output that falls further behind than 100 ms no longer holds the others back.
const MAX_LAG: u64 = 4800;

struct Track {
    next: Option<u64>,
    latest: u64,
    last_ms: u64,
}

/// Lays the outputs' packets on one timeline (sample index at 48 kHz from Windows' clock) and
/// hands out the mix in order, as soon as every playing output has delivered.
pub struct Mixer {
    buf: Vec<f32>,
    base: Option<u64>,
    tracks: Vec<Track>,
}

impl Mixer {
    pub fn new(sources: usize) -> Mixer {
        Mixer { buf: vec![0.0; CAP], base: None, tracks: (0..sources).map(|_| Track { next: None, latest: 0, last_ms: 0 }).collect() }
    }

    fn active(t: &Track, now_ms: u64) -> bool {
        t.next.is_some() && now_ms.saturating_sub(t.last_ms) <= ACTIVE_MS
    }

    /// Samples (48 kHz mono, gain applied) of output `src` starting at timeline index `start`
    /// (None = Windows gave no valid timestamp: they follow the last packet).
    pub fn add(&mut self, src: usize, start: Option<u64>, x: &[f32], now_ms: u64) {
        let Some(t) = self.tracks.get_mut(src) else { return };
        let was_active = Self::active(t, now_ms);
        let start = match (t.next, start) {
            (Some(n), Some(s)) if was_active && s.abs_diff(n) <= SNAP => n,
            (Some(n), None) if was_active => n,
            (_, Some(s)) => s,
            (_, None) => return,
        };
        let end = start + x.len() as u64;
        t.next = Some(end);
        t.latest = end;
        t.last_ms = now_ms;
        let base = *self.base.get_or_insert(start);
        for (i, &s) in x.iter().enumerate() {
            let idx = start + i as u64;
            if idx >= base && idx < base + CAP as u64 && s.is_finite() {
                self.buf[(idx % CAP as u64) as usize] += s;
            }
        }
    }

    /// Everything that is complete up to now, in order (silence where nothing played).
    pub fn drain(&mut self, now_idx: u64, now_ms: u64, out: &mut Vec<f32>) {
        let Some(base) = self.base else {
            self.base = Some(now_idx.saturating_sub(IDLE_LAG));
            return;
        };
        let playing: Vec<u64> = self.tracks.iter().filter(|t| Self::active(t, now_ms)).map(|t| t.latest).collect();
        let target = match playing.iter().min() {
            Some(&m) => m.max(now_idx.saturating_sub(MAX_LAG)),
            None => now_idx.saturating_sub(IDLE_LAG),
        };
        if target <= base {
            return;
        }
        if target - base > CAP as u64 {
            // After a pause (sleep, a stuck thread): start again at the clock.
            self.buf.iter_mut().for_each(|v| *v = 0.0);
            self.base = Some(target);
            return;
        }
        for idx in base..target {
            let slot = &mut self.buf[(idx % CAP as u64) as usize];
            out.push(*slot);
            *slot = 0.0;
        }
        self.base = Some(target);
    }
}

/// Interleaved samples (any channel count) to mono, as Windows gives them.
pub fn to_mono(frames: usize, channels: usize, sample: impl Fn(usize) -> f32, gain: f32, out: &mut Vec<f32>) {
    if channels == 0 {
        return;
    }
    let k = gain / channels as f32;
    for f in 0..frames {
        let mut sum = 0.0;
        for c in 0..channels {
            sum += sample(f * channels + c);
        }
        out.push(sum * k);
    }
}

/// Windows' 100 ns timestamps to the 48 kHz timeline.
pub fn index_of(t100ns: u64) -> u64 {
    (t100ns as u128 * RATE as u128 / 10_000_000) as u64
}

// ---------------------------------------------------------------------------------------------
// The writer thread.
// ---------------------------------------------------------------------------------------------

struct State {
    config: Mutex<Config>,
    status: Mutex<Status>,
    stop: AtomicBool,
}

static RUNNING: Mutex<Option<Arc<State>>> = Mutex::new(None);

/// New settings from the UI; starts or stops the writer.
pub fn configure(cfg: Config) {
    let mut running = RUNNING.lock().unwrap();
    if !cfg.enabled {
        if let Some(s) = running.take() {
            s.stop.store(true, Ordering::SeqCst);
        }
        return;
    }
    if let Some(s) = running.as_ref() {
        *s.config.lock().unwrap() = cfg;
        return;
    }
    let state = Arc::new(State { config: Mutex::new(cfg), status: Mutex::new(Status { enabled: true, ..Default::default() }), stop: AtomicBool::new(false) });
    let s = state.clone();
    if std::thread::Builder::new().name("voice-ref".into()).spawn(move || run(s)).is_ok() {
        *running = Some(state);
    }
}

pub fn status() -> Status {
    match RUNNING.lock().unwrap().as_ref() {
        Some(s) => s.status.lock().unwrap().clone(),
        None => Status::default(),
    }
}

#[cfg(not(windows))]
fn run(state: Arc<State>) {
    state.status.lock().unwrap().error = Some("Kun på Windows".into());
}

#[cfg(windows)]
fn run(state: Arc<State>) {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_HIGHEST};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
    }
    let mut shm: Option<win::Shared> = None;
    let mut shm_tried = 0u64;
    let mut cfg = Config::default();
    let mut loops: Vec<win::Loopback> = Vec::new();
    let mut mixer = Mixer::new(0);
    let mut out = Vec::with_capacity(4800);
    let mut scratch = Vec::with_capacity(4800);
    let mut last_status = 0u64;
    let mut last_sound = 0u64;
    let mut inst: Option<win::InstanceCount> = None;
    while !state.stop.load(Ordering::SeqCst) {
        let now_ms = win::tick_ms();
        let wanted = state.config.lock().unwrap().clone();
        if wanted.sources.iter().map(|s| &s.device).ne(cfg.sources.iter().map(|s| &s.device)) {
            loops = wanted.sources.iter().map(|s| win::Loopback::new(&s.device)).collect();
            mixer = Mixer::new(loops.len());
        }
        cfg = wanted;
        if (shm.is_none() || inst.is_none()) && now_ms.saturating_sub(shm_tried) >= 2000 {
            shm_tried = now_ms;
            if shm.is_none() {
                shm = win::Shared::open();
            }
            if inst.is_none() {
                inst = win::InstanceCount::open();
            }
        }
        for (i, lp) in loops.iter_mut().enumerate() {
            let gain = cfg.sources.get(i).map(|s| s.gain).filter(|g| g.is_finite()).unwrap_or(0.0).clamp(0.0, 4.0);
            lp.pump(now_ms, gain, &mut scratch, |start, x| mixer.add(i, start, x, now_ms));
        }
        out.clear();
        mixer.drain(index_of(win::now_100ns()), now_ms, &mut out);
        if out.iter().any(|v| v.abs() > 1e-4) {
            last_sound = now_ms;
        }
        if let Some(s) = shm.as_ref() {
            s.write(&out, now_ms);
            s.set_fx(cfg.fx);
        }
        if now_ms.saturating_sub(last_status) >= 100 {
            last_status = now_ms;
            let mut st = Status { enabled: true, connected: shm.is_some(), playing: now_ms.saturating_sub(last_sound) < 500, ..Default::default() };
            if let Some(s) = shm.as_ref() {
                plugin_status(&mut st, s.report(), now_ms);
                if st.plugin {
                    (st.in_db, st.out_db) = s.levels();
                }
            }
            st.instances = inst.as_ref().map(|c| c.count(now_ms));
            st.sources = loops.iter().map(|l| l.status(now_ms)).collect();
            *state.status.lock().unwrap() = st;
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    // Stopped (Ren mikrofon and Stemmeskifter off): the effect ends now, not when it goes stale.
    if let Some(s) = shm.as_ref() {
        s.set_fx(0);
    }
    *state.status.lock().unwrap() = Status::default();
}

#[cfg(windows)]
mod win {
    use super::ring::{Instances, Ring, INST_NAME_GLOBAL, INST_SIZE, NAME_GLOBAL, SIZE};
    use super::{index_of, to_mono, Resampler, SourceStatus};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL, INVALID_HANDLE_VALUE};
    use windows::Win32::Media::Audio::*;
    use windows::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
    use windows::Win32::System::Memory::*;

    pub fn tick_ms() -> u64 {
        unsafe { windows::Win32::System::SystemInformation::GetTickCount64() }
    }

    /// QueryPerformanceCounter in 100 ns – the clock of Windows' audio timestamps.
    pub fn now_100ns() -> u64 {
        use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
        let (mut c, mut f) = (0i64, 0i64);
        unsafe {
            let _ = QueryPerformanceCounter(&mut c);
            let _ = QueryPerformanceFrequency(&mut f);
        }
        if f <= 0 {
            return 0;
        }
        (c as u128 * 10_000_000 / f as u128) as u64
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The plugin's shared memory. The plugin creates it (the audio engine may create "Global\"
    /// objects, a normal user may not), so until it has run once there is nothing to open.
    pub struct Shared {
        handle: HANDLE,
        view: MEMORY_MAPPED_VIEW_ADDRESS,
        ring: Ring,
    }

    unsafe impl Send for Shared {}

    impl Drop for Shared {
        fn drop(&mut self) {
            unsafe {
                let _ = UnmapViewOfFile(self.view);
                let _ = CloseHandle(self.handle);
            }
        }
    }

    impl Shared {
        pub fn open() -> Option<Shared> {
            unsafe {
                let name = wide(NAME_GLOBAL);
                let access = FILE_MAP_READ.0 | FILE_MAP_WRITE.0;
                let handle = match OpenFileMappingW(access, false, PCWSTR(name.as_ptr())) {
                    Ok(h) => h,
                    // An administrator may create it (same rights as the plugin gives it).
                    Err(_) => create(&name)?,
                };
                let view = MapViewOfFile(handle, FILE_MAP(access), 0, 0, SIZE);
                if view.Value.is_null() {
                    let _ = CloseHandle(handle);
                    return None;
                }
                let ring = Ring::from_ptr(view.Value as *mut u8);
                ring.init();
                Some(Shared { handle, view, ring })
            }
        }

        pub fn write(&self, x: &[f32], now_ms: u64) {
            if self.ring.valid() {
                self.ring.write(x, now_ms);
            }
        }

        pub fn set_fx(&self, cmd: u32) {
            if self.ring.valid() && self.ring.fx_command() != cmd {
                self.ring.set_fx_command(cmd);
            }
        }

        pub fn report(&self) -> (u64, u32, f32, i32) {
            self.ring.plugin_report()
        }

        pub fn levels(&self) -> (Option<f32>, Option<f32>) {
            self.ring.plugin_levels()
        }

    }

    /// The plugin instances' memory (created by plugins from 0.14.2), read only.
    pub struct InstanceCount {
        handle: HANDLE,
        view: MEMORY_MAPPED_VIEW_ADDRESS,
        inst: Instances,
    }

    unsafe impl Send for InstanceCount {}

    impl Drop for InstanceCount {
        fn drop(&mut self) {
            unsafe {
                let _ = UnmapViewOfFile(self.view);
                let _ = CloseHandle(self.handle);
            }
        }
    }

    impl InstanceCount {
        pub fn open() -> Option<InstanceCount> {
            unsafe {
                let name = wide(INST_NAME_GLOBAL);
                let handle = OpenFileMappingW(FILE_MAP_READ.0, false, PCWSTR(name.as_ptr())).ok()?;
                let view = MapViewOfFile(handle, FILE_MAP_READ, 0, 0, INST_SIZE);
                if view.Value.is_null() {
                    let _ = CloseHandle(handle);
                    return None;
                }
                Some(InstanceCount { handle, view, inst: Instances::from_ptr(view.Value as *mut u8) })
            }
        }

        pub fn count(&self, now_ms: u64) -> usize {
            self.inst.count(now_ms)
        }
    }

    unsafe fn create(name: &[u16]) -> Option<HANDLE> {
        const SDDL: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;LS)(A;;GRGW;;;IU)S:(ML;;NW;;;ME)";
        let sddl = wide(SDDL);
        let mut sd = PSECURITY_DESCRIPTOR::default();
        ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()), SDDL_REVISION_1, &mut sd, None).ok()?;
        let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd.0, bInheritHandle: false.into() };
        let h = CreateFileMappingW(INVALID_HANDLE_VALUE, Some(&sa), PAGE_READWRITE, 0, SIZE as u32, PCWSTR(name.as_ptr()));
        let _ = LocalFree(HLOCAL(sd.0));
        h.ok()
    }

    struct Open {
        client: IAudioClient,
        cap: IAudioCaptureClient,
        channels: usize,
        bits: u16,
        float: bool,
        rate: u32,
        resampler: Resampler,
    }

    /// Loopback capture of one output, opened again after it disappears.
    pub struct Loopback {
        device: String,
        open: Option<Open>,
        tried: u64,
        error: Option<String>,
        last_packet: u64,
    }

    impl Drop for Open {
        fn drop(&mut self) {
            unsafe {
                let _ = self.client.Stop();
            }
        }
    }

    impl Loopback {
        pub fn new(device: &str) -> Loopback {
            Loopback { device: device.to_string(), open: None, tried: 0, error: None, last_packet: 0 }
        }

        pub fn status(&self, now_ms: u64) -> SourceStatus {
            SourceStatus {
                device: self.device.clone(),
                ok: self.open.is_some(),
                rate: self.open.as_ref().map(|o| o.rate).unwrap_or(0),
                playing: now_ms.saturating_sub(self.last_packet) < 500,
                error: self.error.clone(),
            }
        }

        fn start(&self) -> Result<Open, String> {
            unsafe {
                let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.message())?;
                let id = wide(&self.device);
                let dev = en.GetDevice(PCWSTR(id.as_ptr())).map_err(|e| e.message())?;
                let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(|e| e.message())?;
                let fmt = client.GetMixFormat().map_err(|e| e.message())?;
                let wf: WAVEFORMATEX = std::ptr::read_unaligned(fmt);
                let (tag, channels, bits, rate) = (wf.wFormatTag, wf.nChannels as usize, wf.wBitsPerSample, wf.nSamplesPerSec);
                let kind = if tag == 0xFFFE { std::ptr::read_unaligned(fmt as *const WAVEFORMATEXTENSIBLE).SubFormat.data1 as u16 } else { tag };
                let float = kind == 3 && bits == 32;
                let pcm = kind == 1 && (bits == 16 || bits == 24 || bits == 32);
                if !(float || pcm) || channels == 0 || rate == 0 {
                    CoTaskMemFree(Some(fmt as *const _));
                    return Err(format!("ukendt lydformat ({kind}, {bits} bit)"));
                }
                // 200 ms buffer; read every 2 ms.
                let r = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 2_000_000, 0, fmt, None);
                CoTaskMemFree(Some(fmt as *const _));
                r.map_err(|e| e.message())?;
                let cap: IAudioCaptureClient = client.GetService().map_err(|e| e.message())?;
                client.Start().map_err(|e| e.message())?;
                Ok(Open { client, cap, channels, bits, float, rate, resampler: Resampler::new(rate) })
            }
        }

        /// Reads what has arrived; `emit(start index, samples)` for each packet.
        pub fn pump(&mut self, now_ms: u64, gain: f32, scratch: &mut Vec<f32>, mut emit: impl FnMut(Option<u64>, &[f32])) {
            if self.open.is_none() {
                if now_ms.saturating_sub(self.tried) < 2000 {
                    return;
                }
                self.tried = now_ms;
                match self.start() {
                    Ok(o) => {
                        self.open = Some(o);
                        self.error = None;
                    }
                    Err(e) => {
                        self.error = Some(e);
                        return;
                    }
                }
            }
            let Some(o) = self.open.as_mut() else { return };
            let mut failed = None;
            unsafe {
                loop {
                    let n = match o.cap.GetNextPacketSize() {
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
                    let (mut frames, mut flags, mut qpc) = (0u32, 0u32, 0u64);
                    if let Err(e) = o.cap.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc)) {
                        failed = Some(e.message());
                        break;
                    }
                    let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null();
                    let bad_time = flags & (AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32) != 0 || qpc == 0;
                    let mut mono = Vec::with_capacity(frames as usize);
                    let (bytes, float, bits) = ((o.bits / 8) as usize, o.float, o.bits);
                    if silent {
                        mono.resize(frames as usize, 0.0);
                    } else {
                        to_mono(
                            frames as usize,
                            o.channels,
                            |i| {
                                let p = data.add(i * bytes);
                                match (float, bits) {
                                    (true, _) => std::ptr::read_unaligned(p as *const f32),
                                    (false, 16) => std::ptr::read_unaligned(p as *const i16) as f32 / 32768.0,
                                    (false, 24) => (i32::from_le_bytes([0, *p, *p.add(1), *p.add(2)]) as f32) / 2147483648.0,
                                    _ => std::ptr::read_unaligned(p as *const i32) as f32 / 2147483648.0,
                                }
                            },
                            gain,
                            &mut mono,
                        );
                    }
                    let _ = o.cap.ReleaseBuffer(frames);
                    scratch.clear();
                    o.resampler.process(&mono, scratch);
                    self.last_packet = now_ms;
                    emit(if bad_time { None } else { Some(index_of(qpc)) }, scratch);
                }
            }
            if let Some(e) = failed {
                // The output disappeared (unplugged, the audio service restarted): try again later.
                self.error = Some(e);
                self.open = None;
                self.tried = now_ms;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_keeps_the_length_and_the_shape() {
        let mut r = Resampler::new(44100);
        let x: Vec<f32> = (0..44100).map(|i| (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 44100.0).sin()).collect();
        let mut out = Vec::new();
        r.process(&x[..20000], &mut out);
        r.process(&x[20000..], &mut out);
        assert!((out.len() as i64 - 48000).abs() <= 2, "{}", out.len());
        // Compare with the sine at 48 kHz (one input sample later; linear interpolation: small error at 440 Hz).
        let at = |i: usize| (2.0 * std::f64::consts::PI * 440.0 * (i as f64 * 44100.0 / 48000.0 - 1.0) / 44100.0).sin() as f32;
        let err = out.iter().enumerate().skip(10).take(47000).map(|(i, v)| (v - at(i)).abs()).fold(0.0f32, f32::max);
        assert!(err < 0.02, "{err}");
        let mut same = Resampler::new(48000);
        let mut o2 = Vec::new();
        same.process(&[0.1, 0.2], &mut o2);
        assert_eq!(o2, vec![0.1, 0.2]);
    }

    #[test]
    fn mono_averages_the_channels_with_gain() {
        let data = [0.5f32, -0.5, 1.0, 0.0];
        let mut out = Vec::new();
        to_mono(2, 2, |i| data[i], 2.0, &mut out);
        assert_eq!(out, vec![0.0, 1.0]);
        assert_eq!(index_of(10_000_000), 48000);
    }

    #[test]
    fn mixer_lines_outputs_up_by_time_and_waits_for_the_slowest() {
        let mut m = Mixer::new(2);
        let mut out = Vec::new();
        let t0 = 1_000_000u64;
        m.drain(t0, 0, &mut out); // starts 20 ms behind the clock
        assert!(out.is_empty());
        // Nothing plays: silence follows the clock.
        m.drain(t0 + 480, 10, &mut out);
        assert_eq!(out.len(), 480);
        assert!(out.iter().all(|v| *v == 0.0));
        out.clear();
        // Two outputs play the same 10 ms (one packet each), the second arrives later: the mix
        // waits for it and adds them up.
        let start = t0 + 480 - IDLE_LAG + 480; // a bit after what was written
        m.add(0, Some(start), &[0.25; 480], 20);
        m.add(1, Some(start + 100), &[0.5; 100], 20);
        m.drain(t0 + 2000, 20, &mut out);
        // Up to the second output's end (start + 200), silence before `start`.
        assert_eq!(out.len() as u64, start + 200 - (t0 + 480 - IDLE_LAG));
        let first = out.len() - 200;
        assert!(out[..first].iter().all(|v| *v == 0.0));
        assert!(out[first..first + 100].iter().all(|v| (*v - 0.25).abs() < 1e-6));
        assert!(out[first + 100..].iter().all(|v| (*v - 0.75).abs() < 1e-6));
        out.clear();
        m.add(1, Some(start + 200), &[0.5; 280], 25);
        m.drain(t0 + 2000, 25, &mut out);
        assert_eq!(out.len(), 280);
        assert!(out.iter().all(|v| (*v - 0.75).abs() < 1e-6));
    }

    #[test]
    fn mixer_keeps_packets_contiguous_through_timestamp_jitter() {
        let mut m = Mixer::new(1);
        let mut out = Vec::new();
        let mut t = 5_000_000u64;
        m.drain(t, 0, &mut out);
        out.clear();
        let mut start = t - 400;
        let mut written = 0usize;
        for k in 0..200u64 {
            // ±1 ms of jitter on the timestamps, the device's samples are contiguous.
            let jitter = [0i64, 40, -30, 25, -45][k as usize % 5];
            m.add(0, Some((start as i64 + jitter) as u64), &vec![0.1; 480], k * 10);
            start += 480;
            t += 480;
            m.drain(t, k * 10, &mut out);
            written += 480;
        }
        let tail: Vec<f32> = out.iter().copied().skip_while(|v| *v == 0.0).collect();
        assert_eq!(tail.len(), written, "no gaps or overlaps");
        assert!(tail.iter().all(|v| (*v - 0.1).abs() < 1e-6));
    }

    #[test]
    fn a_stuck_output_does_not_hold_the_reference_back_and_a_pause_starts_over() {
        let mut m = Mixer::new(2);
        let mut out = Vec::new();
        let t0 = 10_000_000u64;
        m.drain(t0, 0, &mut out);
        out.clear();
        m.add(1, Some(t0 - 900), &[0.2; 100], 0); // then nothing more from output 1 …
        for k in 1..=20u64 {
            m.add(0, Some(t0 + (k - 1) * 480), &[0.1; 480], k);
            m.drain(t0 + k * 480, k, &mut out);
        }
        // … for 20 ms it is still "playing", and MAX_LAG lets the reference move on anyway.
        assert!(out.len() > 4800, "{}", out.len());
        out.clear();
        // 5 s later (sleep): no 5 s of old silence, just start at the clock.
        m.drain(t0 + 5 * 48000, 5000, &mut out);
        assert!(out.is_empty());
        m.drain(t0 + 5 * 48000 + 480, 5010, &mut out);
        assert_eq!(out.len(), 480);
    }

    #[test]
    fn plugin_report_becomes_status() {
        let mut st = Status::default();
        plugin_status(&mut st, (1000, ring::FLAG_RUNNING | ring::FLAG_AEC_ON | ring::FLAG_REFERENCE | ring::FLAG_NS_ON, 23.5, 41), 1500);
        assert!(st.plugin && st.echo && st.reference && st.noise && !st.bypassed);
        assert_eq!((st.erle_db, st.delay_ms), (Some(23.5), Some(41)));
        assert_eq!(st.isolate, None);
        plugin_status(&mut st, (1000, ring::FLAG_RUNNING | ring::FLAG_ISOLATE, 0.0, -1), 1500);
        assert_eq!(st.isolate.as_deref(), Some("running"));
        plugin_status(&mut st, (1000, ring::FLAG_RUNNING | ring::FLAG_ISOLATE_UNAVAILABLE, 0.0, -1), 1500);
        assert_eq!(st.isolate.as_deref(), Some("unavailable"));
        plugin_status(&mut st, (1000, ring::FLAG_AEC_ON, f32::NAN, -1), 1500);
        assert_eq!((st.erle_db, st.delay_ms), (None, None));
        // An old report: the plugin is not running (nothing records from the mic).
        plugin_status(&mut st, (1000, ring::FLAG_AEC_ON, 20.0, 40), 4000);
        assert!(!st.plugin && !st.echo && st.erle_db.is_none());
    }
}
