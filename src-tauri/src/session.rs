//! Is the Windows session locked (Win+L)? For "mute the microphone while the pc is locked".
//! A background thread asks Windows every 1,5 s and emits `session-lock` (true/false) on change.
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
pub fn is_locked() -> Option<bool> {
    use windows::Win32::System::RemoteDesktop::{
        WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW, WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
        WTS_SESSIONSTATE_LOCK,
    };
    unsafe {
        let mut buf = windows::core::PWSTR::null();
        let mut bytes = 0u32;
        WTSQuerySessionInformationW(WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTSSessionInfoEx, &mut buf, &mut bytes).ok()?;
        if buf.is_null() {
            return None;
        }
        let info = &*(buf.0 as *const WTSINFOEXW);
        let flags = (info.Level == 1).then(|| info.Data.WTSInfoExLevel1.SessionFlags);
        WTSFreeMemory(buf.0 as *mut core::ffi::c_void);
        flags.map(|f| f == WTS_SESSIONSTATE_LOCK as i32)
    }
}

#[cfg(not(windows))]
pub fn is_locked() -> Option<bool> {
    None
}

pub fn watch(app: AppHandle) {
    std::thread::Builder::new()
        .name("session-lock".into())
        .spawn(move || {
            let mut last = None;
            loop {
                let now = is_locked();
                if now.is_some() && now != last {
                    if last.is_some() {
                        let _ = app.emit("session-lock", now.unwrap_or(false));
                    }
                    last = now;
                }
                std::thread::sleep(std::time::Duration::from_millis(1500));
            }
        })
        .ok();
}
