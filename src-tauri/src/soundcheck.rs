//! Lydtjek: Windows settings that change or hide the sound without GoXLR Studio – the "lower other
//! sounds during calls" setting, outputs/inputs muted or turned down in Windows, and the format each
//! device runs at. The page (public/js/views-soundcheck.js) decides what to show from the report.
//!
//! The only registry value it changes is the user's own ducking setting (HKCU), and only after
//! the old value is saved in %APPDATA%\GoXLR Studio\backup\windows-ducking.json ("Fortryd").
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// HKCU\Software\Microsoft\Multimedia\Audio, UserDuckingPreference: what Windows does with other
/// sounds when it detects communications (0 mute, 1 −80 % (default), 2 −50 %, 3 nothing).
#[cfg_attr(not(windows), allow(dead_code))]
pub const DUCKING_KEY: &str = r"Software\Microsoft\Multimedia\Audio";
#[cfg_attr(not(windows), allow(dead_code))]
pub const DUCKING_VALUE: &str = "UserDuckingPreference";

#[derive(Serialize, Clone, Debug)]
pub struct Endpoint {
    pub id: String,
    pub name: String,
    pub flow: &'static str,
    pub default: bool,
    pub default_comm: bool,
    /// Windows' volume for the device, 0–1.
    pub volume: Option<f32>,
    pub muted: Option<bool>,
    pub format: Option<crate::audio::DeviceFormat>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Report {
    /// None = not set (Windows then lowers other sounds by 80 %).
    pub ducking: Option<u32>,
    /// A backup of the ducking value exists, so "Fortryd" is possible.
    pub ducking_backup: bool,
    pub endpoints: Vec<Endpoint>,
}

#[derive(Serialize, Deserialize, Debug, PartialEq)]
pub struct DuckingBackup {
    pub saved_at: String,
    /// The value before GoXLR Studio changed it; None = it wasn't set.
    pub value: Option<u32>,
}

pub fn backup_path() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("GoXLR Studio").join("backup").join("windows-ducking.json")
}

/// Saves the value Windows had before the first change. An existing backup is never overwritten –
/// it holds the original setting.
pub fn save_backup(path: &std::path::Path, value: Option<u32>, now: &str) -> Result<bool, String> {
    if path.exists() {
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&DuckingBackup { saved_at: now.into(), value }).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(true)
}

pub fn read_backup(path: &std::path::Path) -> Option<DuckingBackup> {
    serde_json::from_str(std::fs::read_to_string(path).ok()?.trim_start_matches('\u{feff}')).ok()
}

pub fn report() -> Report {
    let endpoints = crate::audio::list()
        .unwrap_or_default()
        .into_iter()
        .map(|d| {
            let (volume, muted) = imp::volume(&d.id).map(|(v, m)| (Some(v), Some(m))).unwrap_or((None, None));
            Endpoint { format: crate::audio::device_format(&d.id), id: d.id, name: d.name, flow: d.flow, default: d.default, default_comm: d.default_comm, volume, muted }
        })
        .collect();
    Report { ducking: imp::read_ducking(), ducking_backup: backup_path().exists(), endpoints }
}

/// Changes Windows' ducking setting – backup first.
pub fn set_ducking(value: u32) -> Result<(), String> {
    if value > 3 {
        return Err("Ugyldig værdi".into());
    }
    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
    save_backup(&backup_path(), imp::read_ducking(), &now)?;
    imp::write_ducking(Some(value))
}

/// Puts the setting back as it was before GoXLR Studio changed it.
pub fn restore_ducking() -> Result<Option<u32>, String> {
    let b = read_backup(&backup_path()).ok_or("Der er ingen backup af indstillingen")?;
    imp::write_ducking(b.value)?;
    Ok(b.value)
}

/// Windows' volume (0–1) and/or mute for a device.
pub fn set_endpoint(id: &str, volume: Option<f32>, mute: Option<bool>) -> Result<(), String> {
    imp::set_volume(id, volume.map(|v| v.clamp(0.0, 1.0)), mute)
}

#[cfg(windows)]
mod imp {
    use super::{DUCKING_KEY, DUCKING_VALUE};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{BOOL, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
    use windows::Win32::System::Registry::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    pub fn read_ducking() -> Option<u32> {
        let (k, v) = (wide(DUCKING_KEY), wide(DUCKING_VALUE));
        let mut h = HKEY::default();
        unsafe {
            if RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(k.as_ptr()), 0, KEY_READ, &mut h) != ERROR_SUCCESS {
                return None;
            }
            let mut ty = REG_VALUE_TYPE::default();
            let mut data = [0u8; 4];
            let mut size = 4u32;
            let r = RegQueryValueExW(h, PCWSTR(v.as_ptr()), None, Some(&mut ty), Some(data.as_mut_ptr()), Some(&mut size));
            let _ = RegCloseKey(h);
            (r == ERROR_SUCCESS && ty == REG_DWORD && size == 4).then(|| u32::from_le_bytes(data))
        }
    }

    /// None removes the value (Windows' default).
    pub fn write_ducking(value: Option<u32>) -> Result<(), String> {
        let (k, v) = (wide(DUCKING_KEY), wide(DUCKING_VALUE));
        let mut h = HKEY::default();
        unsafe {
            let r = RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(k.as_ptr()), 0, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, None, &mut h, None);
            if r != ERROR_SUCCESS {
                return Err(windows::core::Error::from(r.to_hresult()).message());
            }
            let r = match value {
                Some(x) => RegSetValueExW(h, PCWSTR(v.as_ptr()), 0, REG_DWORD, Some(&x.to_le_bytes())),
                None => match RegDeleteValueW(h, PCWSTR(v.as_ptr())) {
                    e if e == ERROR_FILE_NOT_FOUND => ERROR_SUCCESS,
                    e => e,
                },
            };
            let _ = RegCloseKey(h);
            if r != ERROR_SUCCESS {
                return Err(windows::core::Error::from(r.to_hresult()).message());
            }
        }
        Ok(())
    }

    fn endpoint(id: &str) -> Result<IAudioEndpointVolume, String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.message())?;
            let w = wide(id);
            let dev = en.GetDevice(PCWSTR(w.as_ptr())).map_err(|e| e.message())?;
            dev.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None).map_err(|e| e.message())
        }
    }

    pub fn volume(id: &str) -> Option<(f32, bool)> {
        let ep = endpoint(id).ok()?;
        unsafe { Some((ep.GetMasterVolumeLevelScalar().ok()?, ep.GetMute().ok()?.as_bool())) }
    }

    pub fn set_volume(id: &str, volume: Option<f32>, mute: Option<bool>) -> Result<(), String> {
        let ep = endpoint(id)?;
        unsafe {
            if let Some(v) = volume {
                ep.SetMasterVolumeLevelScalar(v, std::ptr::null()).map_err(|e| e.message())?;
            }
            if let Some(m) = mute {
                ep.SetMute(BOOL::from(m), std::ptr::null()).map_err(|e| e.message())?;
            }
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn read_ducking() -> Option<u32> {
        None
    }
    pub fn write_ducking(_: Option<u32>) -> Result<(), String> {
        Err("Kun på Windows".into())
    }
    pub fn volume(_: &str) -> Option<(f32, bool)> {
        None
    }
    pub fn set_volume(_: &str, _: Option<f32>, _: Option<bool>) -> Result<(), String> {
        Err("Kun på Windows".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_backup_is_kept() {
        let dir = std::env::temp_dir().join(format!("goxlr-soundcheck-{}", std::process::id()));
        let p = dir.join("windows-ducking.json");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(save_backup(&p, None, "2026-11-01 23:40:00").unwrap());
        // A second change must not overwrite the original setting.
        assert!(!save_backup(&p, Some(3), "2026-11-02 10:00:00").unwrap());
        assert_eq!(read_backup(&p), Some(DuckingBackup { saved_at: "2026-11-01 23:40:00".into(), value: None }));
        std::fs::write(&p, "\u{feff}{\"saved_at\":\"x\",\"value\":1}").unwrap();
        assert_eq!(read_backup(&p).unwrap().value, Some(1));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
