//! Spiltilstand: is a full-screen game (or other full-screen app) in front, and Windows' system
//! sounds (notification "ding"s) muted or not. Read-only except for the mute of the system sounds
//! session on each output, which the UI switches back when the game ends.
use serde::Serialize;

#[derive(Serialize, Clone, Debug, Default)]
pub struct Foreground {
    /// Windows' QUERY_USER_NOTIFICATION_STATE: 2 = full-screen app (busy), 3 = Direct3D full screen,
    /// 4 = presentation mode, 5 = accepts notifications, 1 = not present, 6/7 = quiet time/app.
    pub notification: i32,
    /// is_fullscreen(notification)
    pub fullscreen: bool,
    /// File name of the process that owns the window in front ("game.exe"), or "".
    pub exe: String,
    /// The system sounds session is muted on every output that has one.
    pub system_muted: bool,
}

/// Full screen, as Windows sees it (a game in exclusive or borderless full screen, a video, slides).
pub fn is_fullscreen(notification: i32) -> bool {
    matches!(notification, 2 | 3 | 4)
}

#[cfg(windows)]
mod imp {
    use super::Foreground;
    use windows::core::Interface;
    use windows::Win32::Foundation::{CloseHandle, S_OK};
    use windows::Win32::Media::Audio::{eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::Shell::SHQueryUserNotificationState;
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    use windows::core::PWSTR;

    unsafe fn foreground_exe() -> String {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return String::new();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return String::new();
        }
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return String::new() };
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        path.rsplit('\\').next().unwrap_or(&path).to_string()
    }

    /// Calls `f` with the system sounds session's volume on every active output.
    unsafe fn each_system_session(mut f: impl FnMut(&ISimpleAudioVolume)) -> Result<usize, String> {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
        let col = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(|e| e.to_string())?;
        let mut n = 0;
        for i in 0..col.GetCount().unwrap_or(0) {
            let Ok(dev) = col.Item(i) else { continue };
            let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
            let Ok(sessions) = mgr.GetSessionEnumerator() else { continue };
            for k in 0..sessions.GetCount().unwrap_or(0) {
                let Ok(ctl) = sessions.GetSession(k) else { continue };
                let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                if ctl2.IsSystemSoundsSession() != S_OK {
                    continue;
                }
                if let Ok(vol) = ctl.cast::<ISimpleAudioVolume>() {
                    f(&vol);
                    n += 1;
                }
            }
        }
        Ok(n)
    }

    pub fn foreground() -> Foreground {
        unsafe {
            let notification = SHQueryUserNotificationState().map(|s| s.0).unwrap_or(0);
            let mut all = true;
            let n = each_system_session(|v| {
                if !v.GetMute().map(|b| b.as_bool()).unwrap_or(false) {
                    all = false;
                }
            })
            .unwrap_or(0);
            Foreground { notification, fullscreen: super::is_fullscreen(notification), exe: foreground_exe(), system_muted: n > 0 && all }
        }
    }

    pub fn mute_system_sounds(mute: bool) -> Result<usize, String> {
        unsafe { each_system_session(|v| { let _ = v.SetMute(mute, std::ptr::null()); }) }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Foreground;
    pub fn foreground() -> Foreground {
        Foreground { notification: 5, ..Default::default() }
    }
    pub fn mute_system_sounds(_mute: bool) -> Result<usize, String> {
        Err("Kun på Windows".into())
    }
}

pub use imp::{foreground, mute_system_sounds};

#[cfg(test)]
mod tests {
    #[test]
    fn full_screen_states() {
        assert!(super::is_fullscreen(3));
        assert!(super::is_fullscreen(2));
        assert!(!super::is_fullscreen(5));
        assert!(!super::is_fullscreen(0));
    }
}
