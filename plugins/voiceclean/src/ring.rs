//! The echo reference: what the speakers play, from GoXLR Studio (the writer) to the plugin in the
//! audio engine (the reader), as a ring of mono 48 kHz samples in shared memory. One writer, any
//! number of readers (each keeps its own position). The same file is used by the app
//! (src-tauri/src/voiceref.rs includes it), so both sides always agree on the layout.
//!
//! Layout (little endian, `SIZE` bytes):
//!   0  magic u32 · 4 version u32 · 8 rate u32 · 12 reserved u32
//!   16 write u64 (samples written so far, the ring position is `write % CAPACITY`)
//!   24 writer_beat u64 (writer's clock in ms, 0 = never)
//!   32 plugin_beat u64 (reader's clock in ms) · 40 erle u32 (f32 bits, dB) · 44 flags u32
//!   48 delay_ms i32 · 52.. reserved · 64 samples f32[CAPACITY]
use std::sync::atomic::{AtomicI32, AtomicU32, AtomicU64, Ordering};

pub const MAGIC: u32 = u32::from_le_bytes(*b"GXVR");
pub const VERSION: u32 = 1;
pub const RATE: u32 = 48000;
/// 65536 samples ≈ 1.4 s at 48 kHz.
pub const CAPACITY: usize = 1 << 16;
pub const HEADER: usize = 64;
pub const SIZE: usize = HEADER + CAPACITY * 4;
/// The shared memory's name (Global: the audio engine runs in session 0 as LOCAL SERVICE).
pub const NAME_GLOBAL: &str = "Global\\GoXLRStudioVoiceRef";
pub const NAME_LOCAL: &str = "Local\\GoXLRStudioVoiceRef";

/// Flags the plugin reports back.
pub const FLAG_RUNNING: u32 = 1;
pub const FLAG_AEC_ON: u32 = 2;
pub const FLAG_REFERENCE: u32 = 4;
pub const FLAG_NS_ON: u32 = 8;
pub const FLAG_BYPASSED: u32 = 16;
/// Stemmeisolering: the network runs / is loading / is not available (RNNoise instead).
pub const FLAG_ISOLATE: u32 = 32;
pub const FLAG_ISOLATE_LOADING: u32 = 64;
pub const FLAG_ISOLATE_UNAVAILABLE: u32 = 128;

/// A ring placed over shared memory (or any 8-byte aligned buffer of `SIZE` bytes).
pub struct Ring {
    base: *mut u8,
}

unsafe impl Send for Ring {}
unsafe impl Sync for Ring {}

impl Ring {
    /// # Safety
    /// `base` must point to at least `SIZE` writable bytes, 8-byte aligned, valid for the Ring's life.
    pub unsafe fn from_ptr(base: *mut u8) -> Ring {
        Ring { base }
    }

    fn u32_at(&self, off: usize) -> &AtomicU32 {
        unsafe { &*(self.base.add(off) as *const AtomicU32) }
    }
    fn u64_at(&self, off: usize) -> &AtomicU64 {
        unsafe { &*(self.base.add(off) as *const AtomicU64) }
    }
    fn i32_at(&self, off: usize) -> &AtomicI32 {
        unsafe { &*(self.base.add(off) as *const AtomicI32) }
    }
    fn sample(&self, i: usize) -> *mut f32 {
        unsafe { (self.base.add(HEADER) as *mut f32).add(i % CAPACITY) }
    }

    /// Sets up the header if the memory is new (or from another layout version).
    pub fn init(&self) {
        if self.u32_at(0).load(Ordering::Acquire) != MAGIC || self.u32_at(4).load(Ordering::Acquire) != VERSION {
            self.u32_at(8).store(RATE, Ordering::Relaxed);
            self.u64_at(16).store(0, Ordering::Relaxed);
            self.u64_at(24).store(0, Ordering::Relaxed);
            self.u32_at(4).store(VERSION, Ordering::Relaxed);
            self.u32_at(0).store(MAGIC, Ordering::Release);
        }
    }

    pub fn valid(&self) -> bool {
        self.u32_at(0).load(Ordering::Acquire) == MAGIC && self.u32_at(4).load(Ordering::Acquire) == VERSION
    }

    // ---- writer (GoXLR Studio) ----
    pub fn write(&self, samples: &[f32], now_ms: u64) {
        let w = self.u64_at(16).load(Ordering::Relaxed);
        for (i, &s) in samples.iter().enumerate() {
            unsafe { self.sample(w as usize + i).write_volatile(if s.is_finite() { s.clamp(-4.0, 4.0) } else { 0.0 }) };
        }
        self.u64_at(16).store(w + samples.len() as u64, Ordering::Release);
        self.u64_at(24).store(now_ms.max(1), Ordering::Release);
    }

    pub fn writer_beat(&self) -> u64 {
        self.u64_at(24).load(Ordering::Acquire)
    }

    pub fn written(&self) -> u64 {
        self.u64_at(16).load(Ordering::Acquire)
    }

    // ---- what the plugin reports ----
    pub fn report(&self, now_ms: u64, flags: u32, erle_db: f32, delay_ms: i32) {
        self.u32_at(40).store(erle_db.to_bits(), Ordering::Relaxed);
        self.u32_at(44).store(flags, Ordering::Relaxed);
        self.i32_at(48).store(delay_ms, Ordering::Relaxed);
        self.u64_at(32).store(now_ms.max(1), Ordering::Release);
    }

    /// (plugin's clock in ms, flags, echo reduction in dB, echo delay in ms)
    pub fn plugin_report(&self) -> (u64, u32, f32, i32) {
        let beat = self.u64_at(32).load(Ordering::Acquire);
        (beat, self.u32_at(44).load(Ordering::Relaxed), f32::from_bits(self.u32_at(40).load(Ordering::Relaxed)), self.i32_at(48).load(Ordering::Relaxed))
    }
}

/// One reader's position.
pub struct Reader {
    pos: Option<u64>,
}

/// Kept when the reader falls behind or starts: 20 ms of the newest samples.
const RESYNC_KEEP: u64 = 960;
/// More than this behind (the writer laps the reader soon): start again near the newest samples.
const MAX_BEHIND: u64 = (CAPACITY as u64) / 2;

impl Default for Reader {
    fn default() -> Self {
        Self::new()
    }
}

impl Reader {
    pub fn new() -> Reader {
        Reader { pos: None }
    }

    /// How many samples are waiting.
    pub fn available(&mut self, ring: &Ring) -> usize {
        let w = ring.written();
        let p = self.sync(w);
        (w - p) as usize
    }

    fn sync(&mut self, w: u64) -> u64 {
        let p = match self.pos {
            // A new writer (the app restarted) or far behind: start near the newest samples.
            Some(p) if p <= w && w - p <= MAX_BEHIND => p,
            _ => w.saturating_sub(RESYNC_KEEP),
        };
        self.pos = Some(p);
        p
    }

    /// Reads up to `out.len()` samples; returns how many.
    pub fn read(&mut self, ring: &Ring, out: &mut [f32]) -> usize {
        let w = ring.written();
        let p = self.sync(w);
        let n = ((w - p) as usize).min(out.len());
        for (i, o) in out[..n].iter_mut().enumerate() {
            *o = unsafe { ring.sample(p as usize + i).read_volatile() };
        }
        self.pos = Some(p + n as u64);
        n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Vec<u64> {
        vec![0u64; SIZE / 8]
    }

    #[test]
    fn writes_and_reads_across_the_end() {
        let mut m = mem();
        let ring = unsafe { Ring::from_ptr(m.as_mut_ptr() as *mut u8) };
        ring.init();
        assert!(ring.valid());
        let mut r = Reader::new();
        assert_eq!(r.available(&ring), 0);
        // Fill close to the end of the buffer, then across it.
        let chunk: Vec<f32> = (0..480).map(|i| i as f32 / 1000.0).collect();
        let mut seen = 0usize;
        let mut out = vec![0f32; 480];
        for k in 0..300 {
            ring.write(&chunk, k + 1);
            let n = r.read(&ring, &mut out);
            assert_eq!(n, 480);
            assert_eq!(out, chunk);
            seen += n;
        }
        assert!(seen > CAPACITY, "wrapped around");
    }

    #[test]
    fn a_slow_reader_skips_ahead_and_a_restarted_writer_is_followed() {
        let mut m = mem();
        let ring = unsafe { Ring::from_ptr(m.as_mut_ptr() as *mut u8) };
        ring.init();
        let mut r = Reader::new();
        let _ = r.available(&ring);
        let big = vec![0.5f32; CAPACITY / 2 + 2000];
        ring.write(&big, 1);
        // Far behind: only the newest 20 ms are kept.
        assert_eq!(r.available(&ring), RESYNC_KEEP as usize);
        // The app restarts: the memory is new (write counter back at 0).
        let mut m2 = mem();
        let ring2 = unsafe { Ring::from_ptr(m2.as_mut_ptr() as *mut u8) };
        ring2.init();
        ring2.write(&[0.25; 100], 1);
        assert_eq!(r.available(&ring2), 100);
    }

    #[test]
    fn bad_samples_are_written_as_silence_and_reports_round_trip() {
        let mut m = mem();
        let ring = unsafe { Ring::from_ptr(m.as_mut_ptr() as *mut u8) };
        ring.init();
        let mut r = Reader::new();
        let _ = r.available(&ring);
        ring.write(&[f32::NAN, f32::INFINITY, 9.0, -0.5], 7);
        let mut out = [1f32; 4];
        assert_eq!(r.read(&ring, &mut out), 4);
        assert_eq!(out, [0.0, 0.0, 4.0, -0.5]);
        assert_eq!(ring.writer_beat(), 7);
        ring.report(9, FLAG_RUNNING | FLAG_AEC_ON, 18.5, 42);
        assert_eq!(ring.plugin_report(), (9, FLAG_RUNNING | FLAG_AEC_ON, 18.5, 42));
    }
}
