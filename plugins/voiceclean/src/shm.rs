//! The echo reference's shared memory on Windows. The plugin runs in the audio engine (audiodg.exe,
//! LOCAL SERVICE, session 0), which may create "Global\" objects; it creates the memory with access
//! for the signed-in user and a medium integrity label, so GoXLR Studio (medium integrity) can write
//! and low-integrity (sandboxed) processes cannot.
use crate::ring::{Instances, Reader, Ring, INST_NAME_GLOBAL, INST_NAME_LOCAL, INST_SIZE, NAME_GLOBAL, NAME_LOCAL, SIZE};
use crate::vst::Reference;
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::System::Memory::{CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE};
use windows_sys::Win32::System::SystemInformation::GetTickCount64;

/// SYSTEM, administrators and LOCAL SERVICE: all; interactive users: read/write; a medium integrity
/// label, so GoXLR Studio (medium) may write but sandboxed low-integrity processes may not (0.15.0).
const SDDL: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;LS)(A;;GRGW;;;IU)S:(ML;;NW;;;ME)";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub struct Shared {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    ring: Ring,
    reader: Reader,
    /// This instance's slot (so GoXLR Studio can count the streams being cleaned).
    slot: Option<(Mapping, Instances, usize)>,
}

/// A mapped view of a named shared memory.
struct Mapping {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
}

impl Mapping {
    unsafe fn open(global: &str, local: &str, size: usize) -> Option<Mapping> {
        let mut h = create(global, size);
        if h.is_null() {
            h = create(local, size);
        }
        if h.is_null() {
            return None;
        }
        let view = MapViewOfFile(h, FILE_MAP_ALL_ACCESS, 0, 0, size);
        if view.Value.is_null() {
            CloseHandle(h);
            return None;
        }
        Some(Mapping { handle: h, view })
    }
}

impl Drop for Mapping {
    fn drop(&mut self) {
        unsafe {
            UnmapViewOfFile(self.view);
            CloseHandle(self.handle);
        }
    }
}

unsafe impl Send for Shared {}

impl Drop for Shared {
    fn drop(&mut self) {
        if let Some((_, inst, i)) = &self.slot {
            inst.release(*i);
        }
        unsafe {
            UnmapViewOfFile(self.view);
            CloseHandle(self.handle);
        }
    }
}

unsafe fn create(name: &str, size: usize) -> HANDLE {
    let n = wide(name);
    let existing = OpenFileMappingW(FILE_MAP_ALL_ACCESS, 0, n.as_ptr());
    if !existing.is_null() {
        return existing;
    }
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let sddl = wide(SDDL);
    let have_sd = ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) != 0;
    let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: 0 };
    let h = CreateFileMappingW(INVALID_HANDLE_VALUE, if have_sd { &sa } else { std::ptr::null() }, PAGE_READWRITE, 0, size as u32, n.as_ptr());
    if have_sd {
        LocalFree(sd as _);
    }
    h
}

/// Opens (or creates) the echo reference. None if Windows does not allow it – then the plugin
/// still removes noise, only without the speakers' sound.
pub fn open() -> Option<Shared> {
    unsafe {
        let mut h = create(NAME_GLOBAL, SIZE);
        if h.is_null() {
            h = create(NAME_LOCAL, SIZE);
        }
        if h.is_null() {
            return None;
        }
        let view = MapViewOfFile(h, FILE_MAP_ALL_ACCESS, 0, 0, SIZE);
        if view.Value.is_null() {
            CloseHandle(h);
            return None;
        }
        let ring = Ring::from_ptr(view.Value as *mut u8);
        ring.init();
        let slot = Mapping::open(INST_NAME_GLOBAL, INST_NAME_LOCAL, INST_SIZE).and_then(|m| {
            let inst = Instances::from_ptr(m.view.Value as *mut u8);
            let i = inst.claim(GetTickCount64())?;
            Some((m, inst, i))
        });
        Some(Shared { handle: h, view, ring, reader: Reader::new(), slot })
    }
}

/// The writer must have written within the last half second, otherwise nothing is read.
const STALE_MS: u64 = 500;

impl Reference for Shared {
    fn read(&mut self, out: &mut [f32]) -> usize {
        let now = unsafe { GetTickCount64() };
        let beat = self.ring.writer_beat();
        if beat == 0 || now.saturating_sub(beat) > STALE_MS {
            // Keep the position current, so old samples are not played later.
            let _ = self.reader.available(&self.ring);
            let mut sink = [0f32; 480];
            while self.reader.read(&self.ring, &mut sink) == sink.len() {}
            return 0;
        }
        self.reader.read(&self.ring, out)
    }

    fn report(&mut self, flags: u32, erle_db: f32, delay_ms: i32, in_db: f32, out_db: f32) {
        let now = unsafe { GetTickCount64() };
        self.ring.report_levels(now, flags, erle_db, delay_ms, in_db, out_db);
        if let Some((_, inst, i)) = &self.slot {
            inst.beat(*i, now);
        }
    }
}
