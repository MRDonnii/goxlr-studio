//! Per-app audio device routing (Windows' "App volume and device preferences").
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AppSession {
    pub pid: u32,
    pub exe: String,
    pub path: String,
    pub output: Option<String>,
    pub input: Option<String>,
    /// The app's own volume in Windows' volume mixer (0–1), if it plays sound.
    #[serde(default)]
    pub volume: Option<f32>,
    #[serde(default)]
    pub muted: Option<bool>,
}

#[cfg(windows)]
#[allow(non_snake_case)]
mod imp {
    use super::AppSession;
    use std::collections::BTreeMap;
    use std::ffi::c_void;
    #[allow(unused_imports)]
    use windows::core::{interface, IUnknown, IUnknown_Vtbl, Interface, HRESULT, HSTRING, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, S_OK};
    use windows::Win32::Media::Audio::{
        eCapture, eConsole, eMultimedia, eRender, EDataFlow, ERole, IAudioSessionControl2, IAudioSessionManager2,
        IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::System::WinRT::RoGetActivationFactory;

    // Internal WinRT factory behind Settings > Sound > App volume. Layout matches Windows 10 21H2+ / Windows 11.
    #[interface("ab3d4648-e242-459f-b02f-541c70306324")]
    unsafe trait IAudioPolicyConfigFactory: IUnknown {
        fn GetIids(&self) -> HRESULT;
        fn GetRuntimeClassName(&self) -> HRESULT;
        fn GetTrustLevel(&self) -> HRESULT;
        fn m01(&self) -> HRESULT;
        fn m02(&self) -> HRESULT;
        fn m03(&self) -> HRESULT;
        fn m04(&self) -> HRESULT;
        fn m05(&self) -> HRESULT;
        fn m06(&self) -> HRESULT;
        fn m07(&self) -> HRESULT;
        fn m08(&self) -> HRESULT;
        fn m09(&self) -> HRESULT;
        fn m10(&self) -> HRESULT;
        fn m11(&self) -> HRESULT;
        fn m12(&self) -> HRESULT;
        fn m13(&self) -> HRESULT;
        fn m14(&self) -> HRESULT;
        fn m15(&self) -> HRESULT;
        fn m16(&self) -> HRESULT;
        fn m17(&self) -> HRESULT;
        fn m18(&self) -> HRESULT;
        fn m19(&self) -> HRESULT;
        fn SetPersistedDefaultAudioEndpoint(&self, pid: u32, flow: EDataFlow, role: ERole, device: *mut c_void) -> HRESULT;
        fn GetPersistedDefaultAudioEndpoint(&self, pid: u32, flow: EDataFlow, role: ERole, device: *mut *mut c_void) -> HRESULT;
        fn ClearAllPersistedApplicationDefaultEndpoints(&self) -> HRESULT;
    }

    const RENDER_IF: &str = "{e6327cad-dcec-4949-ae8a-991e976a79d2}";
    const CAPTURE_IF: &str = "{2eef81be-33fa-4800-9670-1cd474972c3f}";
    const PREFIX: &str = r"\\?\SWD#MMDEVAPI#";

    fn init() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    fn factory() -> Result<IAudioPolicyConfigFactory, String> {
        unsafe {
            RoGetActivationFactory::<IAudioPolicyConfigFactory>(&HSTRING::from("Windows.Media.Internal.AudioPolicyConfig"))
                .map_err(|e| format!("Lyd pr. app understøttes ikke på denne Windows-version: {e}"))
        }
    }

    fn to_policy_id(endpoint: &str, flow: EDataFlow) -> String {
        format!("{PREFIX}{endpoint}#{}", if flow == eRender { RENDER_IF } else { CAPTURE_IF })
    }

    fn from_policy_id(raw: &str) -> Option<String> {
        let s = raw.strip_prefix(PREFIX)?;
        Some(s.split('#').next()?.to_string())
    }

    unsafe fn exe_path(pid: u32) -> Option<String> {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }

    unsafe fn persisted(f: &IAudioPolicyConfigFactory, pid: u32, flow: EDataFlow) -> Option<String> {
        let mut raw: *mut c_void = std::ptr::null_mut();
        if f.GetPersistedDefaultAudioEndpoint(pid, flow, eMultimedia, &mut raw).is_err() || raw.is_null() {
            return None;
        }
        let h: HSTRING = std::mem::transmute(raw);
        from_policy_id(&h.to_string_lossy())
    }

    pub fn sessions() -> Result<Vec<AppSession>, String> {
        init();
        let f = factory()?;
        let mut by_pid: BTreeMap<u32, AppSession> = BTreeMap::new();
        unsafe {
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
            for flow in [eRender, eCapture] {
                let col = en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE).map_err(|e| e.to_string())?;
                for i in 0..col.GetCount().unwrap_or(0) {
                    let Ok(dev) = col.Item(i) else { continue };
                    let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
                    let Ok(sessions) = mgr.GetSessionEnumerator() else { continue };
                    for k in 0..sessions.GetCount().unwrap_or(0) {
                        let Ok(ctl) = sessions.GetSession(k) else { continue };
                        let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                        if ctl2.IsSystemSoundsSession() == S_OK {
                            continue;
                        }
                        let Ok(pid) = ctl2.GetProcessId() else { continue };
                        if pid == 0 {
                            continue;
                        }
                        // The app's volume: from its (first) playback session.
                        let vol = if flow == eRender { ctl.cast::<ISimpleAudioVolume>().ok() } else { None };
                        let level = vol.as_ref().and_then(|v| v.GetMasterVolume().ok());
                        let mute = vol.as_ref().and_then(|v| v.GetMute().ok()).map(|b| b.as_bool());
                        if let Some(existing) = by_pid.get_mut(&pid) {
                            if existing.volume.is_none() {
                                existing.volume = level;
                                existing.muted = mute;
                            }
                            continue;
                        }
                        let Some(path) = exe_path(pid) else { continue };
                        let exe = path.rsplit('\\').next().unwrap_or(&path).to_string();
                        by_pid.insert(pid, AppSession { pid, exe, path, output: persisted(&f, pid, eRender), input: persisted(&f, pid, eCapture), volume: level, muted: mute });
                    }
                }
            }
        }
        Ok(by_pid.into_values().collect())
    }

    pub fn set(pid: u32, flow: &str, endpoint: Option<&str>) -> Result<(), String> {
        init();
        let f = factory()?;
        let flow = if flow == "capture" { eCapture } else { eRender };
        let id = endpoint.map(|e| to_policy_id(e, flow)).unwrap_or_default();
        let h = HSTRING::from(id);
        unsafe {
            let raw: *mut c_void = std::mem::transmute_copy(&h);
            for role in [eConsole, eMultimedia] {
                f.SetPersistedDefaultAudioEndpoint(pid, flow, role, raw).ok().map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    /// Sets an app's volume (0–1) and/or mute on all its playback sessions, on every output.
    pub fn set_volume(pid: u32, volume: Option<f32>, mute: Option<bool>) -> Result<usize, String> {
        init();
        let mut n = 0;
        unsafe {
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.to_string())?;
            let col = en.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE).map_err(|e| e.to_string())?;
            for i in 0..col.GetCount().unwrap_or(0) {
                let Ok(dev) = col.Item(i) else { continue };
                let Ok(mgr) = dev.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
                let Ok(sessions) = mgr.GetSessionEnumerator() else { continue };
                for k in 0..sessions.GetCount().unwrap_or(0) {
                    let Ok(ctl) = sessions.GetSession(k) else { continue };
                    let Ok(ctl2) = ctl.cast::<IAudioSessionControl2>() else { continue };
                    if ctl2.GetProcessId().ok() != Some(pid) {
                        continue;
                    }
                    let Ok(v) = ctl.cast::<ISimpleAudioVolume>() else { continue };
                    if let Some(x) = volume {
                        let _ = v.SetMasterVolume(super::clamp_volume(x), std::ptr::null());
                    }
                    if let Some(m) = mute {
                        let _ = v.SetMute(m, std::ptr::null());
                    }
                    n += 1;
                }
            }
        }
        if n == 0 {
            return Err("Appen spiller ikke lyd lige nu".into());
        }
        Ok(n)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::AppSession;
    pub fn sessions() -> Result<Vec<AppSession>, String> {
        Ok(Vec::new())
    }
    pub fn set(_pid: u32, _flow: &str, _endpoint: Option<&str>) -> Result<(), String> {
        Err("Kun på Windows".into())
    }
    pub fn set_volume(_pid: u32, _volume: Option<f32>, _mute: Option<bool>) -> Result<usize, String> {
        Err("Kun på Windows".into())
    }
}

pub use imp::{sessions, set, set_volume};

/// 0–1, anything else is clamped (NaN → 0).
pub fn clamp_volume(v: f32) -> f32 {
    if v.is_nan() {
        0.0
    } else {
        v.clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod volume_tests {
    #[test]
    fn volume_is_clamped() {
        assert_eq!(super::clamp_volume(1.5), 1.0);
        assert_eq!(super::clamp_volume(-1.0), 0.0);
        assert_eq!(super::clamp_volume(f32::NAN), 0.0);
        assert_eq!(super::clamp_volume(0.4), 0.4);
    }
}
