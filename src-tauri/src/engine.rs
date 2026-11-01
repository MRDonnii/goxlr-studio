//! Built-in EQ engine.
//!
//! System-wide EQ on Windows needs an audio-engine plug-in (APO) that Windows loads into its
//! audio service for each output. GoXLR Studio ships Equalizer APO's engine DLL (GPL-2.0,
//! embedded at build time, see THIRD-PARTY-NOTICES.md) and installs/registers it itself, so
//! neither Equalizer APO nor Peace has to be installed. The registry layout below is a port of
//! Equalizer APO 1.4's DeviceAPOInfo (install/uninstall per device), so an installation made here
//! is understood by Equalizer APO's own tools and vice versa.
//!
//! Everything that writes to HKLM or Program Files runs in an elevated copy of this exe
//! (`--engine-task <task.json> <result.json>`), started with one UAC prompt.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const PRE_MIX: &str = "{EACD2258-FCAC-4FF4-B36D-419E924A6D79}";
pub const POST_MIX: &str = "{EC1CC9CE-FAED-4822-828A-82A81A6F018F}";

const APP_KEY: &str = r"SOFTWARE\EqualizerAPO";
const CHILD_KEY: &str = r"SOFTWARE\EqualizerAPO\Child APOs";
const RENDER_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render";
const AUDIO_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Audio";
const UNINSTALL_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\EqualizerAPO";
const PREV_CONFIG_VALUE: &str = "GoXLRStudioPreviousConfigPath";

const CONNECTION_VALUE: &str = "{a45c254e-df1c-4efd-8020-67d146a850e0},2";
const DEVICE_VALUE: &str = "{b3f8fa53-0004-438e-9003-51a46e139bfc},6";
const COMBINED_DEVICE_VALUE: &str = "{b3f8fa53-0004-438e-9003-51a46e139bfc},41";
const LFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},1";
const GFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},2";
const SFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},5";
const MFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},6";
const EFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},7";
const MULTI_SFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},13";
const MULTI_MFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},14";
const MULTI_EFX: &str = "{d04e05a6-594b-4fb6-a80d-01af5eed7d1d},15";
const ALL_FX: [&str; 5] = [LFX, GFX, SFX, MFX, EFX];
const FX_TITLE: &str = "{b725f130-47ef-101a-a5f1-02608c9eebac},10";
const SFX_MODES: &str = "{d3993a3f-99c2-4402-b5ec-a92a0367664b},5";
const MFX_MODES: &str = "{d3993a3f-99c2-4402-b5ec-a92a0367664b},6";
const EFX_MODES: &str = "{d3993a3f-99c2-4402-b5ec-a92a0367664b},7";
const DEFAULT_MODE: &str = "{C18E2F7E-933D-4965-B7D1-1EEF228D2AF3}";
const DISABLE_ENHANCEMENTS: &str = "{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5";
const INSTALL_VERSION: &str = "2";
const NOKEY: &str = "!KEY";
const NOVALUE: &str = "!VALUE";
const DEVICE_STATE_NOTPRESENT: u32 = 0x4;

// Files of Equalizer APO's engine, embedded by build.rs when ENGINE_DIR is set (CI does this).
#[cfg(bundled_engine)]
include!(concat!(env!("OUT_DIR"), "/engine_files.rs"));
#[cfg(not(bundled_engine))]
pub static ENGINE_FILES: &[(&str, &[u8])] = &[];
#[cfg(bundled_engine)]
pub const ENGINE_VERSION: &str = env!("ENGINE_VERSION");
#[cfg(not(bundled_engine))]
pub const ENGINE_VERSION: &str = "";

pub fn bundled() -> bool {
    !ENGINE_FILES.is_empty()
}

pub fn install_dir() -> PathBuf {
    let base = std::env::var_os("ProgramFiles").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    base.join("GoXLR Studio Engine")
}

/// The folder Equalizer APO's engine reads its config.txt from when GoXLR Studio owns it.
pub fn config_dir() -> PathBuf {
    crate::apo::studio_dir().join("engine")
}

fn same_path(a: &str, b: &Path) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches('\\').to_lowercase();
    norm(a) == norm(&b.display().to_string())
}

fn is_ours(guid: &str) -> bool {
    guid.eq_ignore_ascii_case(PRE_MIX) || guid.eq_ignore_ascii_case(POST_MIX)
}

pub fn endpoint_id(guid: &str) -> String {
    format!("{{0.0.0.00000000}}.{}", guid.to_lowercase())
}

// ---------------------------------------------------------------------------------------------
// Registry access (HKLM, 64-bit view)
// ---------------------------------------------------------------------------------------------
#[cfg(windows)]
mod reg {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::*;
    use windows::Win32::System::Registry::*;

    pub fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn err(path: &str, e: WIN32_ERROR) -> String {
        format!("{path}: {}", windows::core::Error::from(e.to_hresult()).message())
    }

    pub struct Key(pub HKEY);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                let _ = RegCloseKey(self.0);
            }
        }
    }

    pub fn open(path: &str, access: REG_SAM_FLAGS) -> Result<Key, String> {
        let w = wide(path);
        let mut h = HKEY::default();
        let r = unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, PCWSTR(w.as_ptr()), 0, access | KEY_WOW64_64KEY, &mut h) };
        if r != ERROR_SUCCESS {
            return Err(err(path, r));
        }
        Ok(Key(h))
    }

    pub fn create(path: &str) -> Result<(), String> {
        let w = wide(path);
        let mut h = HKEY::default();
        let r = unsafe {
            RegCreateKeyExW(HKEY_LOCAL_MACHINE, PCWSTR(w.as_ptr()), 0, PCWSTR::null(), REG_OPTION_NON_VOLATILE, KEY_ALL_ACCESS | KEY_WOW64_64KEY, None, &mut h, None)
        };
        if r != ERROR_SUCCESS {
            return Err(err(path, r));
        }
        drop(Key(h));
        Ok(())
    }

    pub fn exists(path: &str) -> bool {
        open(path, KEY_READ).is_ok()
    }

    fn query(path: &str, name: &str) -> Option<(REG_VALUE_TYPE, Vec<u8>)> {
        let k = open(path, KEY_QUERY_VALUE).ok()?;
        let n = wide(name);
        let mut ty = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        let r = unsafe { RegQueryValueExW(k.0, PCWSTR(n.as_ptr()), None, Some(&mut ty), None, Some(&mut size)) };
        if r != ERROR_SUCCESS {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let r = unsafe { RegQueryValueExW(k.0, PCWSTR(n.as_ptr()), None, Some(&mut ty), Some(buf.as_mut_ptr()), Some(&mut size)) };
        if r != ERROR_SUCCESS {
            return None;
        }
        buf.truncate(size as usize);
        Some((ty, buf))
    }

    pub fn value_exists(path: &str, name: &str) -> bool {
        query(path, name).is_some()
    }

    pub fn read_str(path: &str, name: &str) -> Option<String> {
        let (ty, buf) = query(path, name)?;
        if ty != REG_SZ && ty != REG_EXPAND_SZ {
            return None;
        }
        let u: Vec<u16> = buf.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let end = u.iter().position(|&c| c == 0).unwrap_or(u.len());
        Some(String::from_utf16_lossy(&u[..end]))
    }

    pub fn read_dword(path: &str, name: &str) -> Option<u32> {
        let (ty, buf) = query(path, name)?;
        (ty == REG_DWORD && buf.len() >= 4).then(|| u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]))
    }

    fn set(path: &str, name: &str, ty: REG_VALUE_TYPE, data: &[u8]) -> Result<(), String> {
        let k = open(path, KEY_SET_VALUE)?;
        let n = wide(name);
        let r = unsafe { RegSetValueExW(k.0, PCWSTR(n.as_ptr()), 0, ty, Some(data)) };
        if r != ERROR_SUCCESS {
            return Err(err(&format!("{path}\\{name}"), r));
        }
        Ok(())
    }

    pub fn write_str(path: &str, name: &str, value: &str) -> Result<(), String> {
        let bytes: Vec<u8> = wide(value).iter().flat_map(|u| u.to_le_bytes()).collect();
        set(path, name, REG_SZ, &bytes)
    }

    pub fn write_multi(path: &str, name: &str, value: &str) -> Result<(), String> {
        let mut w = wide(value);
        w.push(0);
        let bytes: Vec<u8> = w.iter().flat_map(|u| u.to_le_bytes()).collect();
        set(path, name, REG_MULTI_SZ, &bytes)
    }

    pub fn write_dword(path: &str, name: &str, value: u32) -> Result<(), String> {
        set(path, name, REG_DWORD, &value.to_le_bytes())
    }

    pub fn delete_value(path: &str, name: &str) -> Result<(), String> {
        let Ok(k) = open(path, KEY_SET_VALUE) else { return Ok(()) };
        let n = wide(name);
        let r = unsafe { RegDeleteValueW(k.0, PCWSTR(n.as_ptr())) };
        if r != ERROR_SUCCESS && r != ERROR_FILE_NOT_FOUND {
            return Err(err(&format!("{path}\\{name}"), r));
        }
        Ok(())
    }

    pub fn delete_tree(path: &str) -> Result<(), String> {
        let w = wide(path);
        let r = unsafe { RegDeleteTreeW(HKEY_LOCAL_MACHINE, PCWSTR(w.as_ptr())) };
        if r != ERROR_SUCCESS && r != ERROR_FILE_NOT_FOUND {
            return Err(err(path, r));
        }
        Ok(())
    }

    pub fn subkeys(path: &str) -> Vec<String> {
        let Ok(k) = open(path, KEY_ENUMERATE_SUB_KEYS) else { return vec![] };
        let mut out = Vec::new();
        for i in 0.. {
            let mut buf = [0u16; 256];
            let mut len = buf.len() as u32;
            let r = unsafe { RegEnumKeyExW(k.0, i, PWSTR(buf.as_mut_ptr()), &mut len, None, PWSTR::null(), None, None) };
            if r != ERROR_SUCCESS {
                break;
            }
            out.push(String::from_utf16_lossy(&buf[..len as usize]));
        }
        out
    }

    pub fn has_values(path: &str) -> bool {
        let Ok(k) = open(path, KEY_QUERY_VALUE) else { return false };
        let mut buf = [0u16; 256];
        let mut len = buf.len() as u32;
        let r = unsafe { RegEnumValueW(k.0, 0, PWSTR(buf.as_mut_ptr()), &mut len, None, None, None, None) };
        r == ERROR_SUCCESS
    }

    /// Administrators take ownership of a key Windows protects (port of RegistryHelper::takeOwnership).
    pub fn take_ownership(path: &str) -> Result<(), String> {
        use windows::Win32::Security::*;
        use windows::Win32::System::SystemServices::*;
        use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token).map_err(|e| e.message())?;
            let mut luid = LUID::default();
            LookupPrivilegeValueW(PCWSTR::null(), SE_TAKE_OWNERSHIP_NAME, &mut luid).map_err(|e| e.message())?;
            let mut tp = TOKEN_PRIVILEGES { PrivilegeCount: 1, Privileges: [LUID_AND_ATTRIBUTES { Luid: luid, Attributes: SE_PRIVILEGE_ENABLED }] };
            AdjustTokenPrivileges(token, false, Some(&tp), std::mem::size_of::<TOKEN_PRIVILEGES>() as u32, None, None).map_err(|e| e.message())?;
            let result = (|| {
                let key = open(path, REG_SAM_FLAGS(0x0008_0000))?; // WRITE_OWNER
                let mut sid = PSID::default();
                AllocateAndInitializeSid(&SECURITY_NT_AUTHORITY, 2, SECURITY_BUILTIN_DOMAIN_RID as u32, DOMAIN_ALIAS_RID_ADMINS as u32, 0, 0, 0, 0, 0, 0, &mut sid)
                    .map_err(|e| e.message())?;
                let mut sd = SECURITY_DESCRIPTOR::default();
                let psd = PSECURITY_DESCRIPTOR(&mut sd as *mut _ as *mut core::ffi::c_void);
                let r = InitializeSecurityDescriptor(psd, SECURITY_DESCRIPTOR_REVISION)
                    .and_then(|_| SetSecurityDescriptorOwner(psd, sid, false))
                    .map_err(|e| e.message())
                    .and_then(|_| {
                        let r = RegSetKeySecurity(key.0, OWNER_SECURITY_INFORMATION, psd);
                        if r == ERROR_SUCCESS { Ok(()) } else { Err(err(path, r)) }
                    });
                FreeSid(sid);
                r
            })();
            tp.Privileges[0].Attributes = TOKEN_PRIVILEGES_ATTRIBUTES(0);
            let _ = AdjustTokenPrivileges(token, false, Some(&tp), std::mem::size_of::<TOKEN_PRIVILEGES>() as u32, None, None);
            let _ = CloseHandle(token);
            result
        }
    }

    /// Grants Administrators full control on a key (port of RegistryHelper::makeWritable).
    pub fn make_writable(path: &str) -> Result<(), String> {
        use windows::Win32::Security::Authorization::*;
        use windows::Win32::Security::*;
        use windows::Win32::System::SystemServices::*;
        unsafe {
            let key = open(path, REG_SAM_FLAGS(0x0002_0000 | 0x0004_0000))?; // READ_CONTROL | WRITE_DAC
            let mut size = 0u32;
            let _ = RegGetKeySecurity(key.0, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR(std::ptr::null_mut()), &mut size);
            let mut old = vec![0u8; size.max(64) as usize];
            let r = RegGetKeySecurity(key.0, DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR(old.as_mut_ptr() as _), &mut size);
            if r != ERROR_SUCCESS {
                return Err(err(path, r));
            }
            let mut present = BOOL(0);
            let mut defaulted = BOOL(0);
            let mut old_acl: *mut ACL = std::ptr::null_mut();
            GetSecurityDescriptorDacl(PSECURITY_DESCRIPTOR(old.as_mut_ptr() as _), &mut present, &mut old_acl, &mut defaulted).map_err(|e| e.message())?;
            let mut sid = PSID::default();
            AllocateAndInitializeSid(&SECURITY_NT_AUTHORITY, 2, SECURITY_BUILTIN_DOMAIN_RID as u32, DOMAIN_ALIAS_RID_ADMINS as u32, 0, 0, 0, 0, 0, 0, &mut sid)
                .map_err(|e| e.message())?;
            let ea = EXPLICIT_ACCESS_W {
                grfAccessPermissions: KEY_ALL_ACCESS.0,
                grfAccessMode: SET_ACCESS,
                grfInheritance: SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                Trustee: TRUSTEE_W {
                    pMultipleTrustee: std::ptr::null_mut(),
                    MultipleTrusteeOperation: NO_MULTIPLE_TRUSTEE,
                    TrusteeForm: TRUSTEE_IS_SID,
                    TrusteeType: TRUSTEE_IS_GROUP,
                    ptstrName: PWSTR(sid.0 as *mut u16),
                },
            };
            let mut new_acl: *mut ACL = std::ptr::null_mut();
            let r = SetEntriesInAclW(Some(&[ea]), if old_acl.is_null() { None } else { Some(old_acl) }, &mut new_acl);
            if r != ERROR_SUCCESS {
                FreeSid(sid);
                return Err(err(path, r));
            }
            let mut sd = SECURITY_DESCRIPTOR::default();
            let psd = PSECURITY_DESCRIPTOR(&mut sd as *mut _ as *mut core::ffi::c_void);
            let res = InitializeSecurityDescriptor(psd, SECURITY_DESCRIPTOR_REVISION)
                .and_then(|_| SetSecurityDescriptorDacl(psd, true, Some(new_acl), false))
                .map_err(|e| e.message())
                .and_then(|_| {
                    let r = RegSetKeySecurity(key.0, DACL_SECURITY_INFORMATION, psd);
                    if r == ERROR_SUCCESS { Ok(()) } else { Err(err(path, r)) }
                });
            let _ = LocalFree(HLOCAL(new_acl as _));
            FreeSid(sid);
            res
        }
    }
}

#[cfg(not(windows))]
mod reg {
    pub fn exists(_: &str) -> bool { false }
    pub fn value_exists(_: &str, _: &str) -> bool { false }
    pub fn read_str(_: &str, _: &str) -> Option<String> { None }
    pub fn read_dword(_: &str, _: &str) -> Option<u32> { None }
    pub fn subkeys(_: &str) -> Vec<String> { vec![] }
    pub fn has_values(_: &str) -> bool { false }
    fn no() -> Result<(), String> { Err("Kun på Windows".into()) }
    pub fn create(_: &str) -> Result<(), String> { no() }
    pub fn write_str(_: &str, _: &str, _: &str) -> Result<(), String> { no() }
    pub fn write_multi(_: &str, _: &str, _: &str) -> Result<(), String> { no() }
    pub fn write_dword(_: &str, _: &str, _: u32) -> Result<(), String> { no() }
    pub fn delete_value(_: &str, _: &str) -> Result<(), String> { no() }
    pub fn delete_tree(_: &str) -> Result<(), String> { no() }
    pub fn take_ownership(_: &str) -> Result<(), String> { no() }
    pub fn make_writable(_: &str) -> Result<(), String> { no() }
}

// ---------------------------------------------------------------------------------------------
// Status (read-only, works without admin)
// ---------------------------------------------------------------------------------------------
#[derive(Serialize, Clone, Debug)]
pub struct EngineDevice {
    pub id: String,
    pub guid: String,
    pub name: String,
    pub installed: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct EngineInfo {
    /// "builtin" = GoXLR Studio's own engine, "external" = a separate Equalizer APO install, "none".
    pub kind: String,
    /// This build carries the engine files.
    pub bundled: bool,
    pub version: String,
    pub install_path: Option<String>,
    pub config_path: Option<String>,
    /// Equalizer APO's engine reads GoXLR Studio's config folder.
    pub uses_our_config: bool,
    /// Config folder of a separate Equalizer APO (where Peace keeps its presets).
    pub external_config: Option<String>,
    pub devices: Vec<EngineDevice>,
}

fn fx_key(guid: &str) -> String {
    format!(r"{RENDER_KEY}\{guid}\FxProperties")
}

fn device_installed(guid: &str) -> bool {
    let fx = fx_key(guid);
    ALL_FX.iter().any(|v| reg::read_str(&fx, v).map(|g| is_ours(&g)).unwrap_or(false))
}

pub fn devices() -> Vec<EngineDevice> {
    let mut out = Vec::new();
    for guid in reg::subkeys(RENDER_KEY) {
        let key = format!(r"{RENDER_KEY}\{guid}");
        let state = reg::read_dword(&key, "DeviceState").unwrap_or(0);
        if state & DEVICE_STATE_NOTPRESENT != 0 {
            continue;
        }
        let props = format!(r"{key}\Properties");
        let dev = reg::read_str(&props, DEVICE_VALUE).unwrap_or_default();
        let conn = reg::read_str(&props, CONNECTION_VALUE).unwrap_or_default();
        let name = match (dev.is_empty(), conn.is_empty()) {
            (false, false) => format!("{dev} ({conn})"),
            (false, true) => dev,
            (true, false) => conn,
            _ => guid.clone(),
        };
        out.push(EngineDevice { id: endpoint_id(&guid), installed: device_installed(&guid), guid, name });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

pub fn info() -> EngineInfo {
    let install_path = reg::read_str(APP_KEY, "InstallPath");
    let config_path = reg::read_str(APP_KEY, "ConfigPath");
    let ours = install_dir();
    let kind = match &install_path {
        Some(p) if same_path(p, &ours) => "builtin",
        Some(p) if Path::new(p).join("EqualizerAPO.dll").exists() => "external",
        _ => "none",
    };
    let uses_our_config = config_path.as_deref().map(|p| same_path(p, &config_dir())).unwrap_or(false);
    let external_config = if kind == "external" {
        let prev = reg::read_str(APP_KEY, PREV_CONFIG_VALUE);
        let candidates = [prev, (!uses_our_config).then(|| config_path.clone()).flatten(), install_path.as_ref().map(|p| format!(r"{p}\config"))];
        candidates.into_iter().flatten().find(|p| Path::new(p).is_dir())
    } else {
        None
    };
    EngineInfo {
        kind: kind.into(),
        bundled: bundled(),
        version: ENGINE_VERSION.into(),
        install_path,
        config_path,
        uses_our_config,
        external_config,
        devices: if kind == "none" { devices().into_iter().map(|d| EngineDevice { installed: false, ..d }).collect() } else { devices() },
    }
}

// ---------------------------------------------------------------------------------------------
// Device install / uninstall (port of DeviceAPOInfo, render devices, default install state)
// ---------------------------------------------------------------------------------------------
#[derive(Clone, Copy, PartialEq, Debug)]
enum Mode {
    LfxGfx,
    SfxMfx,
    SfxEfx,
}

struct DeviceState {
    guid: String,
    installed: bool,
    originals: [String; 5],
    mode: Mode,
}

fn load_device(guid: &str) -> Result<DeviceState, String> {
    let key = format!(r"{RENDER_KEY}\{guid}");
    let fx = fx_key(guid);
    let mut originals: [String; 5] = Default::default();
    let mut mode = Mode::LfxGfx;
    let mut installed = false;
    if !reg::exists(&fx) {
        for o in originals.iter_mut() {
            *o = NOKEY.into();
        }
    } else {
        let mut found_at = [false; 5];
        for (i, name) in ALL_FX.iter().enumerate() {
            match reg::read_str(&fx, name) {
                Some(v) if is_ours(&v) => {
                    originals[i] = NOVALUE.into();
                    found_at[i] = true;
                }
                Some(v) => originals[i] = v,
                None => originals[i] = NOVALUE.into(),
            }
        }
        if found_at.iter().any(|&f| f) {
            installed = true;
            let child = format!(r"{CHILD_KEY}\{guid}");
            if reg::exists(&child) {
                let version = reg::read_str(&child, "Version").unwrap_or_else(|| "1".into());
                if version != INSTALL_VERSION && version != "1" {
                    return Err(format!("Ukendt installationsversion {version} på {guid}"));
                }
                for (i, name) in ALL_FX.iter().enumerate() {
                    if let Some(v) = reg::read_str(&child, name) {
                        originals[i] = v;
                    }
                }
            } else if let Some(v) = reg::read_str(CHILD_KEY, guid) {
                if let Some(i) = found_at.iter().position(|&f| f) {
                    originals[i] = v;
                }
            }
            mode = if found_at[0] || found_at[1] {
                Mode::LfxGfx
            } else if found_at[4] {
                Mode::SfxEfx
            } else {
                Mode::SfxMfx
            };
        } else {
            // Only use LFX/GFX if the driver supplied only those APOs (Windows 8.1+ logic).
            let has = |n: &str| reg::value_exists(&fx, n);
            mode = if (has(LFX) || has(GFX)) && ![SFX, MFX, EFX, MULTI_SFX, MULTI_MFX, MULTI_EFX].iter().any(|n| has(n)) {
                Mode::LfxGfx
            } else if reg::value_exists(&format!(r"{key}\Properties"), COMBINED_DEVICE_VALUE) {
                Mode::SfxMfx
            } else {
                Mode::SfxEfx
            };
        }
    }
    Ok(DeviceState { guid: guid.into(), installed, originals, mode })
}

fn original_pre_mix(d: &DeviceState) -> String {
    let o = &d.originals;
    let g = match d.mode {
        Mode::LfxGfx => {
            if o[0] == NOVALUE && o[1] == NOVALUE { &o[2] } else { &o[0] }
        }
        Mode::SfxMfx => {
            if o[2] == NOVALUE && o[3] == NOVALUE { &o[0] } else { &o[2] }
        }
        Mode::SfxEfx => {
            if o[2] == NOVALUE && o[4] == NOVALUE { &o[0] } else { &o[2] }
        }
    };
    if g == NOKEY || g == NOVALUE { String::new() } else { g.clone() }
}

fn original_post_mix(d: &DeviceState) -> String {
    let o = &d.originals;
    let g = match d.mode {
        Mode::LfxGfx => {
            if o[0] == NOVALUE && o[1] == NOVALUE { &o[3] } else { &o[1] }
        }
        Mode::SfxMfx => {
            if o[2] == NOVALUE && o[3] == NOVALUE { &o[1] } else { &o[3] }
        }
        Mode::SfxEfx => {
            if o[2] == NOVALUE && o[4] == NOVALUE { &o[1] } else { &o[4] }
        }
    };
    if g == NOKEY || g == NOVALUE { String::new() } else { g.clone() }
}

fn install_device(d: &DeviceState) -> Result<(), String> {
    let key = format!(r"{RENDER_KEY}\{}", d.guid);
    let fx = fx_key(&d.guid);
    let child = format!(r"{CHILD_KEY}\{}", d.guid);
    reg::create(CHILD_KEY)?;
    reg::create(&child)?;
    if !reg::exists(&fx) {
        if reg::create(&fx).is_err() {
            // Permissions were not sufficient, so change them (as Equalizer APO does).
            reg::take_ownership(&key)?;
            reg::make_writable(&key)?;
            reg::create(&fx)?;
        }
        reg::write_str(&fx, FX_TITLE, "GoXLR Studio EQ")?;
        for name in ALL_FX {
            reg::write_str(&child, name, NOKEY)?;
        }
    } else {
        for name in ALL_FX {
            let v = reg::read_str(&fx, name).filter(|v| !is_ours(v)).unwrap_or_else(|| NOVALUE.into());
            reg::write_str(&child, name, &v)?;
        }
    }
    reg::write_str(&child, "PreMixChild", &original_pre_mix(d))?;
    reg::write_str(&child, "PostMixChild", &original_post_mix(d))?;
    reg::write_str(&child, "AllowSilentBufferModification", "false")?;
    reg::delete_value(&child, "DisableAutomaticAdjustment")?;
    reg::write_str(&child, "Version", INSTALL_VERSION)?;
    match d.mode {
        Mode::LfxGfx => {
            reg::write_str(&fx, LFX, PRE_MIX)?;
            reg::write_str(&fx, GFX, POST_MIX)?;
            for n in [SFX, MFX, EFX] {
                reg::delete_value(&fx, n)?;
            }
        }
        Mode::SfxMfx => {
            reg::delete_value(&fx, LFX)?;
            reg::delete_value(&fx, GFX)?;
            reg::write_str(&fx, SFX, PRE_MIX)?;
            if !reg::value_exists(&fx, SFX_MODES) {
                reg::write_multi(&fx, SFX_MODES, DEFAULT_MODE)?;
            }
            reg::write_str(&fx, MFX, POST_MIX)?;
            if !reg::value_exists(&fx, MFX_MODES) {
                reg::write_multi(&fx, MFX_MODES, DEFAULT_MODE)?;
            }
        }
        Mode::SfxEfx => {
            reg::delete_value(&fx, LFX)?;
            reg::delete_value(&fx, GFX)?;
            reg::write_str(&fx, SFX, PRE_MIX)?;
            if !reg::value_exists(&fx, SFX_MODES) {
                reg::write_multi(&fx, SFX_MODES, DEFAULT_MODE)?;
            }
            reg::write_str(&fx, EFX, POST_MIX)?;
            if !reg::value_exists(&fx, EFX_MODES) {
                reg::write_multi(&fx, EFX_MODES, DEFAULT_MODE)?;
            }
        }
    }
    // Force-enable enhancements, otherwise Windows skips the APO.
    reg::delete_value(&fx, DISABLE_ENHANCEMENTS)
}

fn uninstall_device(d: &DeviceState) -> Result<(), String> {
    let fx = fx_key(&d.guid);
    if d.originals[0] == NOKEY {
        reg::delete_tree(&fx)?;
    } else {
        for (i, name) in ALL_FX.iter().enumerate() {
            if d.originals[i] == NOVALUE {
                reg::delete_value(&fx, name)?;
            } else if !d.originals[i].is_empty() {
                reg::write_str(&fx, name, &d.originals[i])?;
            }
        }
    }
    if reg::value_exists(CHILD_KEY, &d.guid) {
        reg::delete_value(CHILD_KEY, &d.guid)?;
    }
    reg::delete_tree(&format!(r"{CHILD_KEY}\{}", d.guid))?;
    if reg::exists(CHILD_KEY) && reg::subkeys(CHILD_KEY).is_empty() && !reg::has_values(CHILD_KEY) {
        reg::delete_tree(CHILD_KEY)?;
    }
    Ok(())
}

/// Installs on exactly `wanted` (endpoint ids or GUIDs) and removes the engine from all other outputs.
fn apply_devices(wanted: &[String], log: &mut Vec<String>) -> Result<(), String> {
    let want = |guid: &str| wanted.iter().any(|w| w.to_lowercase().ends_with(&guid.to_lowercase()));
    for dev in devices() {
        let d = load_device(&dev.guid)?;
        if want(&dev.guid) && !d.installed {
            install_device(&d)?;
            log.push(format!("EQ-motor sat på: {}", dev.name));
        } else if !want(&dev.guid) && d.installed {
            uninstall_device(&d)?;
            log.push(format!("EQ-motor fjernet fra: {}", dev.name));
        } else if d.installed {
            reg::delete_value(&fx_key(&dev.guid), DISABLE_ENHANCEMENTS)?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Elevated tasks
// ---------------------------------------------------------------------------------------------
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum Task {
    /// Install (or update) the built-in engine and put it on these outputs. A separate
    /// Equalizer APO is backed up and uninstalled first.
    Install { devices: Vec<String> },
    /// Change which outputs the engine runs on.
    SetDevices { devices: Vec<String> },
    /// Remove the built-in engine completely.
    Uninstall,
    /// Keep a separate Equalizer APO but let it read GoXLR Studio's config folder.
    UseExternal,
    /// Give a separate Equalizer APO its own config folder back.
    RestoreExternal,
}

#[derive(Serialize, Deserialize, Debug, Default)]
pub struct TaskResult {
    pub ok: bool,
    pub error: Option<String>,
    pub log: Vec<String>,
    /// Windows should be restarted for the change to be heard everywhere.
    pub reboot: bool,
}

fn hidden(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000);
    }
    c
}

fn powershell(script: &str) -> Result<(), String> {
    let out = hidden("powershell").args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

fn restart_audio(log: &mut Vec<String>) -> bool {
    match powershell("Restart-Service -Name Audiosrv -Force -ErrorAction Stop") {
        Ok(()) => {
            log.push("Windows-lydtjenesten er genstartet".into());
            true
        }
        Err(e) => {
            log.push(format!("Kunne ikke genstarte lydtjenesten ({e}) – genstart pc'en"));
            false
        }
    }
}

fn copy_tree(src: &Path, dst: &Path) {
    let Ok(rd) = std::fs::read_dir(src) else { return };
    let _ = std::fs::create_dir_all(dst);
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            copy_tree(&p, &dst.join(e.file_name()));
        } else {
            let _ = std::fs::copy(&p, dst.join(e.file_name()));
        }
    }
}

fn ensure_config_dir(log: &mut Vec<String>) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if !dir.join("config.txt").exists() {
        std::fs::write(dir.join("config.txt"), "# GoXLR Studio\r\n").map_err(|e| e.to_string())?;
    }
    // Users may write (the app runs unelevated), the audio service (LOCAL SERVICE) must read.
    let st = hidden("icacls")
        .arg(&dir)
        .args(["/grant", "*S-1-5-32-545:(OI)(CI)M", "/grant", "*S-1-5-19:(OI)(CI)RX", "/T", "/C", "/Q"])
        .status()
        .map_err(|e| e.to_string())?;
    if !st.success() {
        log.push("Advarsel: kunne ikke sætte rettigheder på config-mappen".into());
    }
    Ok(())
}

/// Backs up and silently uninstalls a separately installed Equalizer APO (its uninstaller deletes
/// the config folder with the Peace presets, so they are copied to ProgramData first).
fn remove_external(log: &mut Vec<String>) -> Result<(), String> {
    let Some(install) = reg::read_str(APP_KEY, "InstallPath") else { return Ok(()) };
    if same_path(&install, &install_dir()) {
        return Ok(());
    }
    let install = PathBuf::from(install.trim().trim_matches('"'));
    let uninstaller = install.join("Uninstall.exe");
    if !uninstaller.exists() {
        return Ok(());
    }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let backup = crate::apo::studio_dir().join(format!("apo-backup-{stamp}"));
    let cfg = reg::read_str(APP_KEY, PREV_CONFIG_VALUE)
        .or_else(|| reg::read_str(APP_KEY, "ConfigPath").filter(|p| !same_path(p, &config_dir())))
        .map(PathBuf::from)
        .unwrap_or_else(|| install.join("config"));
    copy_tree(&cfg, &backup.join("config"));
    let old = backup.join("config").join("config.txt.goxlr-studio-backup");
    if old.exists() {
        let _ = std::fs::copy(&old, backup.join("config").join("config.txt"));
    }
    log.push(format!("Equalizer APO's config (inkl. Peace-presets) gemt i {}", backup.display()));
    let st = std::process::Command::new(&uninstaller)
        .arg("/S")
        .arg(format!("_?={}", install.display()))
        .status()
        .map_err(|e| format!("Equalizer APO's afinstallation: {e}"))?;
    if !st.success() {
        return Err(format!("Equalizer APO's afinstallation fejlede (kode {:?})", st.code()));
    }
    // With _?= the uninstaller cannot delete itself; tidy up what is left.
    let _ = std::fs::remove_file(&uninstaller);
    let _ = std::fs::remove_dir(&install);
    let _ = reg::delete_tree(UNINSTALL_KEY);
    log.push("Den separate Equalizer APO er afinstalleret".into());
    Ok(())
}

fn install_engine(devices: &[String], log: &mut Vec<String>) -> Result<bool, String> {
    if !bundled() {
        return Err("Denne version af GoXLR Studio indeholder ikke EQ-motoren".into());
    }
    remove_external(log)?;
    let dir = install_dir();
    let updating = dir.join("EqualizerAPO.dll").exists();
    if updating {
        // The audio service keeps the DLL loaded; stop it so the files can be replaced.
        let _ = powershell("Stop-Service -Name Audiosrv -Force -ErrorAction Stop");
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    for (name, bytes) in ENGINE_FILES {
        let target = dir.join(name);
        if std::fs::read(&target).map(|b| b == *bytes).unwrap_or(false) {
            continue;
        }
        if std::fs::write(&target, bytes).is_err() {
            // Still locked: move it aside, Windows deletes it on the next restart.
            let aside = dir.join(format!("{name}.old-{}", std::process::id()));
            std::fs::rename(&target, &aside).map_err(|e| format!("{name}: {e}"))?;
            std::fs::write(&target, bytes).map_err(|e| format!("{name}: {e}"))?;
        }
    }
    log.push(format!("Motorfiler lagt i {}", dir.display()));
    let dll = dir.join("EqualizerAPO.dll");
    let st = hidden("regsvr32").arg("/s").arg(&dll).status().map_err(|e| e.to_string())?;
    if !st.success() {
        return Err(format!("Registrering af motoren fejlede (regsvr32 kode {:?})", st.code()));
    }
    reg::create(APP_KEY)?;
    reg::write_str(APP_KEY, "InstallPath", &dir.display().to_string())?;
    ensure_config_dir(log)?;
    reg::write_str(APP_KEY, "ConfigPath", &config_dir().display().to_string())?;
    reg::delete_value(APP_KEY, PREV_CONFIG_VALUE)?;
    reg::write_str(APP_KEY, "EnableTrace", "false")?;
    reg::create(AUDIO_KEY)?;
    reg::write_dword(AUDIO_KEY, "DisableProtectedAudioDG", 1)?;
    apply_devices(devices, log)?;
    Ok(!restart_audio(log))
}

fn uninstall_engine(log: &mut Vec<String>) -> Result<bool, String> {
    apply_devices(&[], log)?;
    let dir = install_dir();
    let dll = dir.join("EqualizerAPO.dll");
    if dll.exists() {
        let _ = hidden("regsvr32").args(["/u", "/s"]).arg(&dll).status();
    }
    if reg::read_str(APP_KEY, "InstallPath").map(|p| same_path(&p, &dir)).unwrap_or(false) {
        reg::delete_tree(APP_KEY)?;
        reg::delete_value(AUDIO_KEY, "DisableProtectedAudioDG")?;
    }
    let reboot = !restart_audio(log);
    if std::fs::remove_dir_all(&dir).is_err() {
        log.push("Nogle motorfiler fjernes først efter genstart".into());
    }
    log.push("EQ-motoren er fjernet".into());
    Ok(reboot)
}

fn use_external(enable: bool, log: &mut Vec<String>) -> Result<bool, String> {
    if !reg::exists(APP_KEY) {
        return Err("Equalizer APO er ikke installeret".into());
    }
    let ours = config_dir().display().to_string();
    if enable {
        ensure_config_dir(log)?;
        let current = reg::read_str(APP_KEY, "ConfigPath").unwrap_or_default();
        if !same_path(&current, &config_dir()) {
            reg::write_str(APP_KEY, PREV_CONFIG_VALUE, &current)?;
        }
        reg::write_str(APP_KEY, "ConfigPath", &ours)?;
        log.push("Equalizer APO læser nu GoXLR Studios EQ".into());
    } else {
        let prev = reg::read_str(APP_KEY, PREV_CONFIG_VALUE)
            .or_else(|| reg::read_str(APP_KEY, "InstallPath").map(|p| format!(r"{p}\config")))
            .ok_or("Kender ikke den tidligere config-mappe")?;
        reg::write_str(APP_KEY, "ConfigPath", &prev)?;
        reg::delete_value(APP_KEY, PREV_CONFIG_VALUE)?;
        // Undo the Include-line takeover of GoXLR Studio 0.1/0.2 if it is still there.
        let old = Path::new(&prev).join("config.txt.goxlr-studio-backup");
        if old.exists() && std::fs::copy(&old, Path::new(&prev).join("config.txt")).is_ok() {
            let _ = std::fs::remove_file(&old);
            log.push("Den oprindelige config.txt er gendannet".into());
        }
        log.push("Equalizer APO bruger igen sin egen config-mappe".into());
    }
    Ok(!restart_audio(log))
}

pub fn run_task(task: &Task) -> TaskResult {
    let mut log = Vec::new();
    let res = match task {
        Task::Install { devices } => install_engine(devices, &mut log),
        Task::SetDevices { devices } => apply_devices(devices, &mut log).map(|_| !restart_audio(&mut log)),
        Task::Uninstall => uninstall_engine(&mut log),
        Task::UseExternal => use_external(true, &mut log),
        Task::RestoreExternal => use_external(false, &mut log),
    };
    match res {
        Ok(reboot) => TaskResult { ok: true, error: None, log, reboot },
        Err(e) => TaskResult { ok: false, error: Some(e), log, reboot: false },
    }
}

/// Entry point of the elevated helper process: `--engine-task <task.json> <result.json>`.
pub fn task_main(args: &[String]) -> i32 {
    let (Some(task_path), Some(result_path)) = (args.first(), args.get(1)) else { return 2 };
    let result = match std::fs::read_to_string(task_path).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Task>(&t).map_err(|e| e.to_string())) {
        Ok(task) => run_task(&task),
        Err(e) => TaskResult { ok: false, error: Some(format!("Ugyldig opgave: {e}")), ..Default::default() },
    };
    let ok = result.ok;
    let _ = std::fs::write(result_path, serde_json::to_string(&result).unwrap_or_default());
    if ok { 0 } else { 1 }
}

/// Runs a task in an elevated copy of this exe (one UAC prompt) and waits for it.
#[cfg(windows)]
pub fn run_elevated(task: &Task) -> Result<TaskResult, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, ERROR_CANCELLED};
    use windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let dir = std::env::temp_dir().join("goxlr-studio-engine");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let task_path = dir.join(format!("task-{stamp}.json"));
    let result_path = dir.join(format!("result-{stamp}.json"));
    std::fs::write(&task_path, serde_json::to_string(task).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let file = reg::wide(&exe.display().to_string());
    let params = reg::wide(&format!("--engine-task \"{}\" \"{}\"", task_path.display(), result_path.display()));
    let verb = reg::wide("runas");
    let mut info: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC;
    info.lpVerb = PCWSTR(verb.as_ptr());
    info.lpFile = PCWSTR(file.as_ptr());
    info.lpParameters = PCWSTR(params.as_ptr());
    info.nShow = SW_HIDE.0;
    let started = unsafe { ShellExecuteExW(&mut info) };
    if let Err(e) = started {
        let _ = std::fs::remove_file(&task_path);
        if e.code() == ERROR_CANCELLED.to_hresult() {
            return Err("Administrator-adgang blev afvist – intet er ændret".into());
        }
        return Err(format!("Kunne ikke starte med administrator-adgang: {}", e.message()));
    }
    let mut code = 0u32;
    unsafe {
        WaitForSingleObject(info.hProcess, INFINITE);
        let _ = GetExitCodeProcess(info.hProcess, &mut code);
        let _ = CloseHandle(info.hProcess);
    }
    let _ = std::fs::remove_file(&task_path);
    let text = std::fs::read_to_string(&result_path).map_err(|_| format!("Opgaven gav intet svar (kode {code})"))?;
    let _ = std::fs::remove_file(&result_path);
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[cfg(not(windows))]
pub fn run_elevated(_task: &Task) -> Result<TaskResult, String> {
    Err("Kun på Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(originals: [&str; 5], mode: Mode) -> DeviceState {
        DeviceState { guid: "{x}".into(), installed: false, originals: originals.map(String::from), mode }
    }

    #[test]
    fn original_child_apos_follow_equalizer_apo() {
        // Driver with SFX/MFX/EFX: SFX/EFX mode chains to the original SFX and EFX.
        let d = dev([NOVALUE, NOVALUE, "{S}", "{M}", "{E}"], Mode::SfxEfx);
        assert_eq!(original_pre_mix(&d), "{S}");
        assert_eq!(original_post_mix(&d), "{E}");
        // Driver with only LFX/GFX.
        let d = dev(["{L}", "{G}", NOVALUE, NOVALUE, NOVALUE], Mode::LfxGfx);
        assert_eq!(original_pre_mix(&d), "{L}");
        assert_eq!(original_post_mix(&d), "{G}");
        // No FxProperties at all.
        let d = dev([NOKEY; 5], Mode::LfxGfx);
        assert_eq!(original_pre_mix(&d), "");
        assert_eq!(original_post_mix(&d), "");
        // LFX/GFX mode on a device that only had SFX/MFX falls back to those.
        let d = dev([NOVALUE, NOVALUE, "{S}", "{M}", NOVALUE], Mode::LfxGfx);
        assert_eq!(original_pre_mix(&d), "{S}");
        assert_eq!(original_post_mix(&d), "{M}");
    }

    #[test]
    fn task_json_shape() {
        let t: Task = serde_json::from_str(r#"{"action":"install","devices":["{0.0.0.00000000}.{abc}"]}"#).unwrap();
        assert!(matches!(t, Task::Install { .. }));
        let t: Task = serde_json::from_str(r#"{"action":"use-external"}"#).unwrap();
        assert!(matches!(t, Task::UseExternal));
    }
}
