//! The echo reference's shared memory on Windows. The plugin runs in the audio engine (audiodg.exe,
//! LOCAL SERVICE, session 0), which may create "Global\" objects; it creates the memory with access
//! for the signed-in user and a low integrity label, so GoXLR Studio (medium integrity) can write.
use crate::ring::{Reader, Ring, NAME_GLOBAL, NAME_LOCAL, SIZE};
use crate::vst::Reference;
use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::System::Memory::{CreateFileMappingW, MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE};
use windows_sys::Win32::System::SystemInformation::GetTickCount64;

/// SYSTEM, administrators and LOCAL SERVICE: all; interactive users: read/write; low integrity label.
const SDDL: &str = "D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;LS)(A;;GRGW;;;IU)S:(ML;;NW;;;LW)";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub struct Shared {
    handle: HANDLE,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    ring: Ring,
    reader: Reader,
}

unsafe impl Send for Shared {}

impl Drop for Shared {
    fn drop(&mut self) {
        unsafe {
            UnmapViewOfFile(self.view);
            CloseHandle(self.handle);
        }
    }
}

unsafe fn create(name: &str) -> HANDLE {
    let n = wide(name);
    let existing = OpenFileMappingW(FILE_MAP_ALL_ACCESS, 0, n.as_ptr());
    if !existing.is_null() {
        return existing;
    }
    let mut sd: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let sddl = wide(SDDL);
    let have_sd = ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), SDDL_REVISION_1, &mut sd, std::ptr::null_mut()) != 0;
    let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd, bInheritHandle: 0 };
    let h = CreateFileMappingW(INVALID_HANDLE_VALUE, if have_sd { &sa } else { std::ptr::null() }, PAGE_READWRITE, 0, SIZE as u32, n.as_ptr());
    if have_sd {
        LocalFree(sd as _);
    }
    h
}

/// Opens (or creates) the echo reference. None if Windows does not allow it – then the plugin
/// still removes noise, only without the speakers' sound.
pub fn open() -> Option<Shared> {
    unsafe {
        let mut h = create(NAME_GLOBAL);
        if h.is_null() {
            h = create(NAME_LOCAL);
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
        Some(Shared { handle: h, view, ring, reader: Reader::new() })
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

    fn report(&mut self, flags: u32, erle_db: f32, delay_ms: i32) {
        let now = unsafe { GetTickCount64() };
        self.ring.report(now, flags, erle_db, delay_ms);
    }
}
