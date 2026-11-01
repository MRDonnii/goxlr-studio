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
    /// How the engine is hooked in on this output: "lfx-gfx", "sfx-mfx" or "sfx-efx".
    pub mode: Option<String>,
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
    /// Whether Windows can create GoXLR Studio's engine (only checked for the built-in engine).
    pub registration: Registration,
    /// Engine layout version written by the last successful install/repair (see ENGINE_SCHEMA).
    pub schema: u32,
    /// The version this app needs; when `schema` is older the engine is repaired once.
    pub schema_required: u32,
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
        let installed = device_installed(&guid);
        let mode = if installed { load_device(&guid).ok().map(|d| d.mode.as_str().to_string()) } else { None };
        out.push(EngineDevice { id: endpoint_id(&guid), installed, mode, guid, name });
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
        registration: if kind == "builtin" { registration() } else { Registration { ok: true, problems: vec![] } },
        schema: reg::read_dword(APP_KEY, SCHEMA_VALUE).unwrap_or(0),
        schema_required: ENGINE_SCHEMA,
    }
}

// ---------------------------------------------------------------------------------------------
// Registration of the engine in Windows (fejl 1): both COM classes must point to our DLL and be
// registered as audio effects, and protected audiodg must be off. Equalizer APO's uninstaller
// removes all of this (regsvr32 /u + DisableProtectedAudioDG), whichever DLL registered it.
// ---------------------------------------------------------------------------------------------

/// Bumped when an update needs the engine repaired once (registration, layout).
pub const ENGINE_SCHEMA: u32 = 2;
const SCHEMA_VALUE: &str = "GoXLRStudioEngineSchema";
const CLSID_KEY: &str = r"SOFTWARE\Classes\CLSID";
const APO_REG_KEY: &str = r"SOFTWARE\Classes\AudioEngine\AudioProcessingObjects";

/// What the registry says about the engine's registration (read without admin).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RegFacts {
    pub dll_exists: bool,
    /// InprocServer32 of the pre-mix and post-mix classes (None = not registered).
    pub pre_mix_path: Option<String>,
    pub post_mix_path: Option<String>,
    /// Registered as audio processing objects (AudioEngine\AudioProcessingObjects).
    pub pre_mix_apo: bool,
    pub post_mix_apo: bool,
    pub disable_protected_audiodg: Option<u32>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RegIssue {
    /// missing-dll, missing-clsid-pre-mix, wrong-path-post-mix, missing-apo-pre-mix, protected-audiodg …
    pub code: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Registration {
    pub ok: bool,
    pub problems: Vec<RegIssue>,
}

/// Classifies the registration (pure, see tests): empty = everything is in place.
pub fn classify_registration(f: &RegFacts, dll: &Path) -> Vec<RegIssue> {
    let issue = |code: &str, text: String| RegIssue { code: code.into(), text };
    let mut out = Vec::new();
    if !f.dll_exists {
        out.push(issue("missing-dll", format!("Motorfilen mangler ({})", dll.display())));
    }
    for (part, path, apo) in [("pre-mix", &f.pre_mix_path, f.pre_mix_apo), ("post-mix", &f.post_mix_path, f.post_mix_apo)] {
        match path {
            None => out.push(issue(&format!("missing-clsid-{part}"), format!("Motorens {part}-del er ikke registreret i Windows"))),
            Some(p) if !same_path(p.trim_matches('"'), dll) => out.push(issue(&format!("wrong-path-{part}"), format!("Motorens {part}-del peger på en anden fil ({p})"))),
            Some(_) => {}
        }
        if !apo {
            out.push(issue(&format!("missing-apo-{part}"), format!("Motorens {part}-del er ikke registreret som lydeffekt")));
        }
    }
    if f.disable_protected_audiodg != Some(1) {
        out.push(issue("protected-audiodg", "DisableProtectedAudioDG er ikke sat til 1".into()));
    }
    out
}

fn reg_facts() -> RegFacts {
    let dll = install_dir().join("EqualizerAPO.dll");
    let clsid_path = |g: &str| reg::read_str(&format!(r"{CLSID_KEY}\{g}\InprocServer32"), "");
    RegFacts {
        dll_exists: dll.is_file(),
        pre_mix_path: clsid_path(PRE_MIX),
        post_mix_path: clsid_path(POST_MIX),
        pre_mix_apo: reg::exists(&format!(r"{APO_REG_KEY}\{PRE_MIX}")),
        post_mix_apo: reg::exists(&format!(r"{APO_REG_KEY}\{POST_MIX}")),
        disable_protected_audiodg: reg::read_dword(AUDIO_KEY, "DisableProtectedAudioDG"),
    }
}

/// Read-only check (works without admin): used at startup, on the EQ page and in Overflytning.
pub fn registration() -> Registration {
    let problems = classify_registration(&reg_facts(), &install_dir().join("EqualizerAPO.dll"));
    Registration { ok: problems.is_empty(), problems }
}

fn write_engine_files(log: &mut Vec<String>) -> Result<(), String> {
    let dir = install_dir();
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
    Ok(())
}

/// Makes sure Windows can create the engine (elevated): registers the DLL and turns protected
/// audiodg off when something is missing, and says what was fixed. Returns true if it fixed anything.
fn ensure_engine_registered(log: &mut Vec<String>) -> Result<bool, String> {
    if !reg::read_str(APP_KEY, "InstallPath").is_some_and(|p| same_path(&p, &install_dir())) {
        return Ok(false); // not GoXLR Studio's engine
    }
    let before = registration();
    if before.ok {
        let _ = reg::write_dword(APP_KEY, SCHEMA_VALUE, ENGINE_SCHEMA);
        return Ok(false);
    }
    if before.problems.iter().any(|p| p.code == "missing-dll") {
        if !bundled() {
            return Err("Motorfilen mangler, og denne version indeholder den ikke".into());
        }
        write_engine_files(log)?;
    }
    let dll = install_dir().join("EqualizerAPO.dll");
    let st = hidden("regsvr32").arg("/s").arg(&dll).status().map_err(|e| e.to_string())?;
    if !st.success() {
        return Err(format!("Registrering af motoren fejlede (regsvr32 kode {:?})", st.code()));
    }
    reg::create(AUDIO_KEY)?;
    reg::write_dword(AUDIO_KEY, "DisableProtectedAudioDG", 1)?;
    let after = registration();
    if !after.ok {
        return Err(format!("Motoren kunne ikke registreres: {}", after.problems.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("; ")));
    }
    reg::write_dword(APP_KEY, SCHEMA_VALUE, ENGINE_SCHEMA)?;
    log.push(format!("Rettet: {} – motoren er registreret i Windows igen", before.problems.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("; ")));
    Ok(true)
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

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::LfxGfx => "lfx-gfx",
            Mode::SfxMfx => "sfx-mfx",
            Mode::SfxEfx => "sfx-efx",
        }
    }
    fn parse(s: &str) -> Option<Mode> {
        match s {
            "lfx-gfx" => Some(Mode::LfxGfx),
            "sfx-mfx" => Some(Mode::SfxMfx),
            "sfx-efx" => Some(Mode::SfxEfx),
            _ => None,
        }
    }
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
/// `mode` forces another way of hooking in (Equalizer APO's "troubleshooting options") for outputs
/// that don't play through the default one; outputs already installed differently are reinstalled.
/// Name of an output from the registry, also when it is not connected right now.
fn output_name(id: &str) -> String {
    let guid = id.rfind('{').map(|i| &id[i..]).unwrap_or(id);
    let props = format!(r"{RENDER_KEY}\{guid}\Properties");
    match (reg::read_str(&props, DEVICE_VALUE), reg::read_str(&props, CONNECTION_VALUE)) {
        (Some(d), Some(c)) => format!("{d} ({c})"),
        (Some(n), None) | (None, Some(n)) => n,
        _ => id.to_string(),
    }
}

/// Outputs asked for that are not among the present ones (pure, see tests).
pub fn missing_outputs<'a>(wanted: &'a [String], present_guids: &[String]) -> Vec<&'a String> {
    wanted.iter().filter(|w| !present_guids.iter().any(|g| w.to_lowercase().ends_with(&g.to_lowercase()))).collect()
}

fn apply_devices(wanted: &[String], mode: Option<&str>, log: &mut Vec<String>) -> Result<(), String> {
    let want = |guid: &str| wanted.iter().any(|w| w.to_lowercase().ends_with(&guid.to_lowercase()));
    let forced = mode.and_then(Mode::parse);
    // Mindre fejl 2: an output that was ticked but is not connected (e.g. Steam Streaming
    // Speakers) used to be skipped without a word.
    let present: Vec<String> = devices().into_iter().map(|d| d.guid).collect();
    for w in missing_outputs(wanted, &present) {
        log.push(format!("– {}: ikke tilsluttet lige nu – fik ikke EQ-motoren", output_name(w)));
    }
    for dev in devices() {
        let mut d = load_device(&dev.guid)?;
        if want(&dev.guid) && d.installed && forced.is_some_and(|m| m != d.mode) {
            uninstall_device(&d)?;
            d = load_device(&dev.guid)?;
        }
        if want(&dev.guid) && !d.installed {
            if let Some(m) = forced {
                d.mode = m;
            }
            install_device(&d)?;
            log.push(format!("EQ-motor sat på: {} ({})", dev.name, d.mode.as_str()));
        } else if !want(&dev.guid) && d.installed {
            uninstall_device(&d)?;
            log.push(format!("EQ-motor fjernet fra: {}", dev.name));
        } else if d.installed {
            reg::delete_value(&fx_key(&dev.guid), DISABLE_ENHANCEMENTS)?;
        }
    }
    for dev in devices() {
        if want(&dev.guid) && !dev.installed {
            log.push(format!("✗ {}: fik ikke EQ-motoren", dev.name));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Device test (port of Equalizer APO 1.4's DeviceTestThread): with the test pipe registered, the
// engine reports in from Windows' audio service when it is loaded on an output ("Initialize" of
// its pre-mix and post-mix part). Each output is opened briefly; outputs where the engine did not
// load are tried in the other ways of hooking in, like Equalizer APO does after every change.
// ---------------------------------------------------------------------------------------------
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct DeviceTest {
    pub guid: String,
    pub name: String,
    /// How the engine is hooked in on this output after the test.
    pub mode: String,
    pub pre_mix: bool,
    pub post_mix: bool,
    /// The engine is loaded on this output (both parts reported in).
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    /// config.txt's Device: line includes this output (fejl 2: "kører" alone is not enough).
    #[serde(default)]
    pub covered: Option<bool>,
    /// Highest peak measured on the output before the test (0..1).
    #[serde(default)]
    pub peak: Option<f32>,
}

const TEST_PIPE_VALUE: &str = "DeviceTestPipeName";
const TEST_PIPE_NAME: &str = "GoXLRStudioEngineTest";
/// The order Equalizer APO tries (Windows 8.1+), minus the way that was already tested.
const TEST_MODES: [Mode; 3] = [Mode::SfxEfx, Mode::SfxMfx, Mode::LfxGfx];

#[derive(Deserialize)]
struct TestMessage {
    #[serde(rename = "deviceGuid")]
    device_guid: String,
    stage: String,
    phase: String,
}

/// Marks the parts the engine reported in for (messages as sent by EqualizerAPO.dll).
fn apply_test_messages(messages: &[String], results: &mut [DeviceTest]) {
    for m in messages {
        let Ok(msg) = serde_json::from_str::<TestMessage>(m) else { continue };
        if msg.phase != "Initialize" {
            continue;
        }
        if let Some(r) = results.iter_mut().find(|r| r.guid.eq_ignore_ascii_case(&msg.device_guid)) {
            match msg.stage.as_str() {
                "PreMix" => r.pre_mix = true,
                "PostMix" => r.post_mix = true,
                _ => {}
            }
            r.ok = r.pre_mix && r.post_mix;
        }
    }
}

fn mode_label(mode: &str) -> &'static str {
    match mode {
        "sfx-efx" => "SFX/EFX",
        "sfx-mfx" => "SFX/MFX",
        _ => "LFX/GFX",
    }
}

/// Receives the engine's test messages on a named pipe (port of Equalizer APO's ReceiveThread).
#[cfg(windows)]
mod pipe {
    use std::sync::{Arc, Mutex};
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::*;
    use windows::Win32::Security::*;
    use windows::Win32::Storage::FileSystem::*;
    use windows::Win32::System::Pipes::*;

    pub struct Receiver {
        path: Vec<u16>,
        messages: Arc<Mutex<Vec<String>>>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    struct Handle(HANDLE);
    unsafe impl Send for Handle {}

    fn create(path: &[u16]) -> Option<Handle> {
        unsafe {
            // NULL DACL: the engine runs in Windows' audio service (LOCAL SERVICE) and must connect.
            let mut sd = SECURITY_DESCRIPTOR::default();
            let psd = PSECURITY_DESCRIPTOR(&mut sd as *mut _ as *mut core::ffi::c_void);
            InitializeSecurityDescriptor(psd, windows::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION).ok()?;
            SetSecurityDescriptorDacl(psd, true, None, false).ok()?;
            let sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: psd.0, bInheritHandle: false.into() };
            let h = CreateNamedPipeW(
                PCWSTR(path.as_ptr()),
                PIPE_ACCESS_INBOUND,
                PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                0,
                1024,
                0,
                Some(&sa),
            );
            (!h.is_invalid()).then_some(Handle(h))
        }
    }

    impl Receiver {
        pub fn start(name: &str) -> Option<Receiver> {
            let path = super::reg::wide(&format!(r"\\.\pipe\{name}"));
            let messages = Arc::new(Mutex::new(Vec::new()));
            // The first instance exists before the engine can try to connect.
            let first = create(&path)?;
            let (m, p) = (messages.clone(), path.clone());
            let thread = std::thread::spawn(move || serve(first, &p, &m));
            Some(Receiver { path, messages, thread: Some(thread) })
        }

        pub fn messages(&self) -> Vec<String> {
            self.messages.lock().unwrap().clone()
        }
    }

    fn serve(first: Handle, path: &[u16], messages: &Mutex<Vec<String>>) {
        let mut pipe = first;
        loop {
            let connected = match unsafe { ConnectNamedPipe(pipe.0, None) } {
                Ok(()) => true,
                Err(e) => e.code() == ERROR_PIPE_CONNECTED.to_hresult(),
            };
            // A new instance listens before this one is read, so messages that arrive at the same
            // time (several outputs, two parts each) are not lost.
            let next = create(path);
            let mut stop = next.is_none();
            if connected {
                let mut buf = [0u8; 1024];
                let mut read = 0u32;
                if unsafe { ReadFile(pipe.0, Some(&mut buf), Some(&mut read), None) }.is_ok() && read > 0 {
                    let s = String::from_utf8_lossy(&buf[..read as usize]).to_string();
                    if s == "stop" {
                        stop = true;
                    } else {
                        messages.lock().unwrap().push(s);
                    }
                }
                let _ = unsafe { DisconnectNamedPipe(pipe.0) };
            }
            let _ = unsafe { CloseHandle(pipe.0) };
            match next {
                Some(n) if !stop => pipe = n,
                Some(n) => {
                    let _ = unsafe { CloseHandle(n.0) };
                    return;
                }
                None => return,
            }
        }
    }

    impl Drop for Receiver {
        fn drop(&mut self) {
            // Wake the server with "stop", as Equalizer APO's ReceiveThread does (waiting for a
            // free pipe instance if the engine is just sending a message).
            let mut delivered = false;
            for _ in 0..3 {
                let opened = unsafe { CreateFileW(PCWSTR(self.path.as_ptr()), GENERIC_WRITE.0, FILE_SHARE_NONE, None, OPEN_EXISTING, FILE_FLAGS_AND_ATTRIBUTES(0), None) };
                match opened {
                    Ok(h) => {
                        let mut written = 0u32;
                        delivered = unsafe { WriteFile(h, Some(b"stop"), Some(&mut written), None) }.is_ok();
                        unsafe {
                            let _ = FlushFileBuffers(h);
                            let _ = CloseHandle(h);
                        }
                        break;
                    }
                    Err(_) => {
                        let _ = unsafe { WaitNamedPipeW(PCWSTR(self.path.as_ptr()), 1000) };
                    }
                }
            }
            // Never hang the elevated helper: without the stop message the thread is left behind.
            if let Some(t) = self.thread.take() {
                if delivered {
                    let _ = t.join();
                }
            }
        }
    }
}

/// Opens a shared-mode stream on an output, so Windows' audio engine loads its effects (port of
/// DeviceAPOInfo::testAPOInstallation).
#[cfg(windows)]
fn open_output(guid: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let en: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(|e| e.message())?;
        let id = reg::wide(&endpoint_id(guid));
        let dev = en.GetDevice(PCWSTR(id.as_ptr())).map_err(|e| e.message())?;
        let state = dev.GetState().map_err(|e| e.message())?;
        if state != DEVICE_STATE_ACTIVE {
            return Err("udgangen er ikke tilsluttet".into());
        }
        let client: IAudioClient = dev.Activate(CLSCTX_ALL, None).map_err(|e| e.message())?;
        let format = client.GetMixFormat().map_err(|e| e.message())?;
        let r = client.Initialize(AUDCLNT_SHAREMODE_SHARED, 0, 1_000_000, 0, format, None);
        CoTaskMemFree(Some(format as *const _));
        r.map_err(|e| e.message())
    }
}

#[cfg(not(windows))]
fn open_output(_guid: &str) -> Result<(), String> {
    Err("Kun på Windows".into())
}

fn reinstall(guid: &str, mode: Mode) -> Result<(), String> {
    let mut d = load_device(guid)?;
    if d.installed {
        uninstall_device(&d)?;
        d = load_device(guid)?;
    }
    d.mode = mode;
    install_device(&d)
}

/// One test round: restart the audio service with the test pipe registered, open the outputs and
/// collect the engine's messages for up to 3 seconds.
fn test_round(results: &mut [DeviceTest], which: &[usize], log: &mut Vec<String>) {
    for &i in which {
        let r = &mut results[i];
        (r.pre_mix, r.post_mix, r.ok, r.error) = (false, false, false, None);
    }
    #[cfg(windows)]
    let receiver = pipe::Receiver::start(TEST_PIPE_NAME);
    #[cfg(not(windows))]
    let receiver: Option<()> = None;
    if receiver.is_none() {
        log.push("Kunne ikke starte testen af EQ-motoren".into());
    }
    // Registered before the restart, so outputs that start playing right away report in too.
    let _ = reg::write_str(APP_KEY, TEST_PIPE_VALUE, TEST_PIPE_NAME);
    restart_audio(log);
    for &i in which {
        if let Err(e) = open_output(&results[i].guid) {
            results[i].error = Some(e);
        }
    }
    #[cfg(windows)]
    if let Some(rx) = &receiver {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while std::time::Instant::now() < deadline {
            apply_test_messages(&rx.messages(), results);
            if which.iter().all(|&i| results[i].ok || results[i].error.is_some()) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        apply_test_messages(&rx.messages(), results);
    }
    let _ = reg::delete_value(APP_KEY, TEST_PIPE_VALUE);
    #[cfg(windows)]
    drop(receiver);
}

/// Tests the engine on these outputs and, with `auto_adjust`, hooks it in another way where it did
/// not load (SFX/EFX → SFX/MFX → LFX/GFX), keeping the best way found.
fn test_outputs(guids: &[String], auto_adjust: bool, log: &mut Vec<String>) -> Vec<DeviceTest> {
    let names: std::collections::HashMap<String, String> = devices().into_iter().map(|d| (d.guid.to_lowercase(), d.name)).collect();
    let mut results: Vec<DeviceTest> = guids
        .iter()
        .map(|g| DeviceTest { guid: g.clone(), name: names.get(&g.to_lowercase()).cloned().unwrap_or_else(|| g.clone()), ..Default::default() })
        .collect();
    let mut remaining: Vec<Vec<Mode>> = vec![TEST_MODES.to_vec(); results.len()];
    let mut best: Vec<Option<(u8, Mode)>> = vec![None; results.len()];
    let mut pending: Vec<usize> = (0..results.len()).collect();
    log.push("Tester at EQ-motoren bliver indlæst på udgangene…".into());
    while !pending.is_empty() {
        for &i in &pending {
            if let Ok(d) = load_device(&results[i].guid) {
                remaining[i].retain(|m| *m != d.mode);
                results[i].mode = d.mode.as_str().into();
            }
        }
        test_round(&mut results, &pending, log);
        let failing: Vec<usize> = pending.iter().copied().filter(|&i| !results[i].ok && results[i].error.is_none()).collect();
        if !auto_adjust || failing.is_empty() {
            break;
        }
        let mut next = Vec::new();
        let mut changed = false;
        for i in failing {
            let Some(cur) = Mode::parse(&results[i].mode) else { continue };
            let score = results[i].pre_mix as u8 + results[i].post_mix as u8;
            if best[i].map_or(true, |(s, _)| score > s) {
                best[i] = Some((score, cur));
            }
            if !remaining[i].is_empty() {
                let m = remaining[i].remove(0);
                if reinstall(&results[i].guid, m).is_ok() {
                    log.push(format!("{}: prøver en anden måde ({})", results[i].name, mode_label(m.as_str())));
                    next.push(i);
                    changed = true;
                }
            } else if let Some((_, m)) = best[i] {
                // Nothing worked fully: keep the way that worked best.
                if m != cur && reinstall(&results[i].guid, m).is_ok() {
                    results[i].mode = m.as_str().into();
                    changed = true;
                }
            }
        }
        if next.is_empty() {
            if changed {
                restart_audio(log);
            }
            break;
        }
        pending = next;
    }
    results
}

/// Tests the installed outputs among `wanted` and reports per output. Returns true when Windows
/// should be restarted (the engine did not load everywhere).
fn verify(wanted: &[String], auto_adjust: bool, log: &mut Vec<String>, tests: &mut Vec<DeviceTest>, sound: &mut Vec<String>) -> bool {
    let guids: Vec<String> = devices()
        .into_iter()
        .filter(|d| d.installed && wanted.iter().any(|w| w.to_lowercase().ends_with(&d.guid.to_lowercase())))
        .map(|d| d.guid)
        .collect();
    if guids.is_empty() {
        return !restart_audio(log);
    }
    // Before the test restarts the audio service and interrupts what is playing.
    let (notes, per_output) = sound_check(log);
    *tests = test_outputs(&guids, auto_adjust, log);
    for t in tests.iter_mut() {
        if let Some((peak, covered)) = per_output.get(&t.guid.to_lowercase()) {
            t.peak = Some(*peak);
            t.covered = Some(*covered);
        }
    }
    for t in tests.iter() {
        log.push(match (&t.error, t.ok) {
            (_, true) => format!("✓ {}: EQ-motoren kører ({})", t.name, mode_label(&t.mode)),
            (Some(e), _) => format!("– {}: kunne ikke testes ({e})", t.name),
            (None, false) => format!("✗ {}: ikke indlæst", t.name),
        });
    }
    let failed: Vec<&str> = tests.iter().filter(|t| !t.ok && t.error.is_none()).map(|t| t.name.as_str()).collect();
    if !failed.is_empty() {
        let reg = registration();
        log.push(if reg.ok {
            format!("Motoren er registreret korrekt i Windows, men bliver ikke indlæst på: {}. Genstart pc'en, og tryk så \"Test EQ-motoren\" igen.", failed.join(", "))
        } else {
            format!("Motoren er ikke registreret korrekt i Windows ({}).", reg.problems.iter().map(|p| p.text.as_str()).collect::<Vec<_>>().join("; "))
        });
    }
    log.extend(notes.iter().cloned());
    *sound = notes;
    !failed.is_empty()
}

// ---------------------------------------------------------------------------------------------
// Where the EQ applies compared with where sound plays (fejl 2): an EQ for "System" is "running"
// but does nothing for Spotify on "Music".
// ---------------------------------------------------------------------------------------------

/// Which outputs config.txt's Device: line covers (Equalizer APO's rules: "all", GUIDs, or words
/// that must all occur in "device connection {guid}"; ";" separates alternatives).
#[derive(Debug, Clone, PartialEq)]
pub enum Coverage {
    All,
    Patterns(Vec<Vec<String>>),
}

/// Pure: the first Device: line of a config written by apo::render (no line = all outputs).
pub fn parse_coverage(config: &str) -> Coverage {
    for line in config.lines() {
        let l = line.trim().trim_start_matches('\u{feff}');
        let Some(rest) = l.strip_prefix("Device:") else { continue };
        let alts: Vec<Vec<String>> = rest
            .split(';')
            .map(|a| a.split_whitespace().map(|w| w.to_lowercase()).collect::<Vec<_>>())
            .filter(|w| !w.is_empty())
            .collect();
        if alts.is_empty() || alts.iter().any(|w| w.len() == 1 && w[0] == "all") {
            return Coverage::All;
        }
        return Coverage::Patterns(alts);
    }
    Coverage::All
}

impl Coverage {
    /// `device_string` as Equalizer APO builds it: "device connection {guid}".
    pub fn covers(&self, device_string: &str) -> bool {
        let full = device_string.to_lowercase();
        match self {
            Coverage::All => true,
            Coverage::Patterns(alts) => alts.iter().any(|words| words.iter().all(|w| full.contains(w.as_str()))),
        }
    }
}

/// One output during the sound check.
#[derive(Debug, Clone)]
pub struct OutputSound {
    pub name: String,
    pub device_string: String,
    pub installed: bool,
    pub peak: f32,
}

const PLAYING_PEAK: f32 = 0.003;

/// Pure: what to tell the user about where sound plays and where the EQ applies.
pub fn sound_notes(outputs: &[OutputSound], cov: &Coverage) -> Vec<String> {
    let applies: Vec<&str> = outputs.iter().filter(|o| o.installed && cov.covers(&o.device_string)).map(|o| o.name.as_str()).collect();
    let playing: Vec<&OutputSound> = outputs.iter().filter(|o| o.peak >= PLAYING_PEAK).collect();
    if playing.is_empty() {
        return vec!["Der spillede ingen lyd under testen – start fx musik, og tryk \"Test EQ-motoren\" igen for at se, om EQ'en rammer lyden.".into()];
    }
    let only = if applies.is_empty() { "ingen udgange".to_string() } else { applies.join(", ") };
    playing
        .iter()
        .map(|o| {
            if !o.installed {
                format!("⚠ Der spiller lyd på {}, som ikke har EQ-motoren.", o.name)
            } else if !cov.covers(&o.device_string) {
                format!("⚠ Der spiller lyd på {}, men EQ'en gælder kun {only}.", o.name)
            } else {
                format!("✓ Der spiller lyd på {}, og EQ'en gælder der.", o.name)
            }
        })
        .collect()
}

/// Highest peak per output over `ms` milliseconds (0 when it cannot be read).
#[cfg(windows)]
fn measure_peaks(guids: &[String], ms: u64) -> Vec<f32> {
    use windows::core::PCWSTR;
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::*;
    use windows::Win32::System::Com::*;
    let mut peaks = vec![0f32; guids.len()];
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return peaks };
        let meters: Vec<Option<IAudioMeterInformation>> = guids
            .iter()
            .map(|g| {
                let id = reg::wide(&endpoint_id(g));
                en.GetDevice(PCWSTR(id.as_ptr())).ok().and_then(|d| d.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None).ok())
            })
            .collect();
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ms);
        while std::time::Instant::now() < deadline {
            for (i, m) in meters.iter().enumerate() {
                if let Some(v) = m.as_ref().and_then(|m| m.GetPeakValue().ok()) {
                    peaks[i] = peaks[i].max(v);
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    peaks
}

#[cfg(not(windows))]
fn measure_peaks(guids: &[String], _ms: u64) -> Vec<f32> {
    vec![0.0; guids.len()]
}

/// Device string as Equalizer APO matches it: "device connection {guid}".
fn device_string(guid: &str) -> String {
    let props = format!(r"{RENDER_KEY}\{guid}\Properties");
    let dev = reg::read_str(&props, DEVICE_VALUE).unwrap_or_default();
    let conn = reg::read_str(&props, CONNECTION_VALUE).unwrap_or_default();
    format!("{dev} {conn} {guid}")
}

/// Measures where sound plays right now (before the test restarts the audio service) and compares
/// it with the outputs config.txt's Device: line covers.
fn sound_check(log: &mut Vec<String>) -> (Vec<String>, std::collections::HashMap<String, (f32, bool)>) {
    let outputs = devices();
    let guids: Vec<String> = outputs.iter().map(|d| d.guid.clone()).collect();
    let peaks = measure_peaks(&guids, 2000);
    let config = std::fs::read_to_string(config_dir().join("config.txt")).unwrap_or_default();
    let cov = parse_coverage(&config);
    let sounds: Vec<OutputSound> = outputs
        .iter()
        .zip(&peaks)
        .map(|(d, p)| OutputSound { name: d.name.clone(), device_string: device_string(&d.guid), installed: d.installed, peak: *p })
        .collect();
    let notes = sound_notes(&sounds, &cov);
    let per_output = outputs.iter().zip(&sounds).map(|(d, o)| (d.guid.to_lowercase(), (o.peak, cov.covers(&o.device_string)))).collect();
    log.push("Målt hvor der spiller lyd, og hvor EQ'en gælder (config.txt)".into());
    (notes, per_output)
}

fn installed_guids() -> Vec<String> {
    devices().into_iter().filter(|d| d.installed).map(|d| d.guid).collect()
}

// ---------------------------------------------------------------------------------------------
// Elevated tasks
// ---------------------------------------------------------------------------------------------
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "action", rename_all = "kebab-case")]
pub enum Task {
    /// Install (or update) the built-in engine and put it on these outputs. A separate
    /// Equalizer APO is backed up and uninstalled first.
    Install {
        devices: Vec<String>,
        #[serde(default)]
        mode: Option<String>,
    },
    /// Change which outputs the engine runs on (and optionally how it hooks in).
    SetDevices {
        devices: Vec<String>,
        #[serde(default)]
        mode: Option<String>,
    },
    /// Check that the engine is loaded on the outputs it is installed on and fix how it is
    /// hooked in where it isn't (what Equalizer APO's Device Selector does after every change).
    Test,
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
    /// Per output: is the engine loaded (see `Task::Test`).
    #[serde(default)]
    pub tests: Vec<DeviceTest>,
    /// Where sound was playing during the test compared with where the EQ applies (fejl 2).
    #[serde(default)]
    pub sound: Vec<String>,
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
        Ok(()) => true,
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
    // NSIS only recognises "_?=" unquoted and as the last parameter. Quoted (std quotes paths with
    // spaces) the uninstaller copies itself to %TEMP% and keeps running after this returns – and
    // its "regsvr32 /u" then unregistered the engine installed right after (fejl 1).
    let mut cmd = std::process::Command::new(&uninstaller);
    cmd.arg("/S");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.raw_arg(format!("_?={}", install.display()));
    }
    let st = cmd.status().map_err(|e| format!("Equalizer APO's afinstallation: {e}"))?;
    if !st.success() {
        return Err(format!("Equalizer APO's afinstallation fejlede (kode {:?})", st.code()));
    }
    // Belt and braces: wait until the uninstaller has really finished (its uninstall entry goes last).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while reg::exists(UNINSTALL_KEY) && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    // With _?= the uninstaller cannot delete itself; tidy up what is left.
    let _ = std::fs::remove_file(&uninstaller);
    let _ = std::fs::remove_dir(&install);
    let _ = reg::delete_tree(UNINSTALL_KEY);
    log.push("Den separate Equalizer APO er afinstalleret".into());
    Ok(())
}

fn install_engine(devices: &[String], mode: Option<&str>, log: &mut Vec<String>, tests: &mut Vec<DeviceTest>, sound: &mut Vec<String>) -> Result<bool, String> {
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
    write_engine_files(log)?;
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
    ensure_engine_registered(log)?;
    apply_devices(devices, mode, log)?;
    Ok(verify(devices, mode.is_none(), log, tests, sound))
}

fn uninstall_engine(log: &mut Vec<String>) -> Result<bool, String> {
    apply_devices(&[], None, log)?;
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
    let mut tests = Vec::new();
    let mut sound = Vec::new();
    let res = match task {
        Task::Install { devices, mode } => install_engine(devices, mode.as_deref(), &mut log, &mut tests, &mut sound),
        // A way chosen by hand is only tested; otherwise the way that works is found automatically.
        Task::SetDevices { devices, mode } => ensure_engine_registered(&mut log)
            .and_then(|_| apply_devices(devices, mode.as_deref(), &mut log))
            .map(|_| verify(devices, mode.is_none(), &mut log, &mut tests, &mut sound)),
        // Repairs what an older version or Equalizer APO's uninstaller left behind, then tests.
        Task::Test => ensure_engine_registered(&mut log).and_then(|_| {
            let guids = installed_guids();
            if guids.is_empty() {
                log.push("EQ-motoren er ikke sat på nogen udgang endnu".into());
                Ok(false)
            } else {
                Ok(verify(&guids, true, &mut log, &mut tests, &mut sound))
            }
        }),
        Task::Uninstall => uninstall_engine(&mut log),
        Task::UseExternal => use_external(true, &mut log),
        Task::RestoreExternal => use_external(false, &mut log),
    };
    match res {
        Ok(reboot) => TaskResult { ok: true, error: None, log, reboot, tests, sound },
        Err(e) => TaskResult { ok: false, error: Some(e), log, reboot: false, tests, sound },
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
    fn install_modes_roundtrip() {
        for m in ["lfx-gfx", "sfx-mfx", "sfx-efx"] {
            assert_eq!(Mode::parse(m).unwrap().as_str(), m);
        }
        assert!(Mode::parse("nope").is_none());
        let t: Task = serde_json::from_str(r#"{"action":"set-devices","devices":["{a}"],"mode":"sfx-efx"}"#).unwrap();
        assert!(matches!(t, Task::SetDevices { mode: Some(ref m), .. } if m == "sfx-efx"));
        let t: Task = serde_json::from_str(r#"{"action":"install","devices":[]}"#).unwrap();
        assert!(matches!(t, Task::Install { mode: None, .. }));
    }

    fn facts_ok() -> RegFacts {
        let dll = r"C:\Program Files\GoXLR Studio Engine\EqualizerAPO.dll".to_string();
        RegFacts { dll_exists: true, pre_mix_path: Some(dll.clone()), post_mix_path: Some(dll), pre_mix_apo: true, post_mix_apo: true, disable_protected_audiodg: Some(1) }
    }

    fn codes(f: &RegFacts) -> Vec<String> {
        classify_registration(f, Path::new(r"C:\Program Files\GoXLR Studio Engine\EqualizerAPO.dll")).into_iter().map(|i| i.code).collect()
    }

    #[test]
    fn registration_ok() {
        assert!(codes(&facts_ok()).is_empty());
        // Paths compare case-insensitively and may be quoted.
        let mut f = facts_ok();
        f.pre_mix_path = Some(r#""c:\program files\goxlr studio engine\EQUALIZERAPO.DLL""#.into());
        assert!(codes(&f).is_empty());
    }

    #[test]
    fn registration_after_equalizer_apo_uninstaller() {
        // What the report found after upgrading from 0.3.3: DLL in place, but no CLSIDs, no APO
        // registration and DisableProtectedAudioDG empty.
        let f = RegFacts { dll_exists: true, ..Default::default() };
        assert_eq!(
            codes(&f),
            ["missing-clsid-pre-mix", "missing-apo-pre-mix", "missing-clsid-post-mix", "missing-apo-post-mix", "protected-audiodg"]
        );
    }

    #[test]
    fn registration_wrong_path_and_flags() {
        let mut f = facts_ok();
        f.post_mix_path = Some(r"C:\Program Files\EqualizerAPO\EqualizerAPO.dll".into());
        f.disable_protected_audiodg = Some(0);
        assert_eq!(codes(&f), ["wrong-path-post-mix", "protected-audiodg"]);
        let f = RegFacts { dll_exists: false, ..facts_ok() };
        assert_eq!(codes(&f), ["missing-dll"]);
    }

    #[test]
    fn ticked_outputs_that_are_not_connected_are_reported() {
        let wanted = vec!["{0.0.0.00000000}.{aaaa}".to_string(), "{0.0.0.00000000}.{STEAM}".to_string()];
        let present = vec!["{AAAA}".to_string(), "{bbbb}".to_string()];
        assert_eq!(missing_outputs(&wanted, &present), vec![&wanted[1]]);
    }

    #[test]
    fn coverage_follows_equalizer_apo_device_rules() {
        let system = "TC-Helicon GoXLR System {58a6a695-a61b-4549-8340-5b88409d9be5}";
        let music = "TC-Helicon GoXLR Music {11111111-2222-3333-4444-555555555555}";
        let cov = parse_coverage("# x\nDevice: {58a6a695-a61b-4549-8340-5b88409d9be5}\nPreamp: -4 dB\n");
        assert!(cov.covers(system) && !cov.covers(music));
        assert_eq!(parse_coverage("Device: all\n"), Coverage::All);
        assert_eq!(parse_coverage("Preamp: 0 dB\n"), Coverage::All);
        let cov = parse_coverage("\u{feff}Device: GoXLR Music; Speakers\n");
        assert!(cov.covers(music) && !cov.covers(system) && cov.covers("Realtek Speakers {x}"));
    }

    #[test]
    fn sound_notes_find_eq_on_the_wrong_output() {
        // The report: Spotify on Music (peak 0.398), EQ only on System.
        let cov = parse_coverage("Device: {58a6a695-a61b-4549-8340-5b88409d9be5}\n");
        let out = |name: &str, guid: &str, installed: bool, peak: f32| OutputSound { name: name.into(), device_string: format!("TC-Helicon GoXLR {name} {guid}"), installed, peak };
        let outputs = [
            out("System", "{58a6a695-a61b-4549-8340-5b88409d9be5}", true, 0.0),
            out("Music", "{11111111-2222-3333-4444-555555555555}", true, 0.398),
            out("Højttalere", "{99999999-2222-3333-4444-555555555555}", false, 0.2),
        ];
        let notes = sound_notes(&outputs, &cov);
        assert_eq!(notes[0], "⚠ Der spiller lyd på Music, men EQ'en gælder kun System.");
        assert_eq!(notes[1], "⚠ Der spiller lyd på Højttalere, som ikke har EQ-motoren.");
        assert!(sound_notes(&outputs, &Coverage::All)[0].starts_with("✓ Der spiller lyd på Music"));
        let silent = [out("System", "{a}", true, 0.0)];
        assert!(sound_notes(&silent, &Coverage::All)[0].starts_with("Der spillede ingen lyd"));
    }

    #[test]
    fn engine_test_messages_mark_outputs() {
        let mut r = vec![
            DeviceTest { guid: "{AAAA}".into(), ..Default::default() },
            DeviceTest { guid: "{bbbb}".into(), ..Default::default() },
        ];
        let msgs = [
            r#"{"deviceGuid":"{aaaa}", "stage":"PreMix", "phase":"Initialize"}"#.to_string(),
            r#"{"deviceGuid":"{aaaa}", "stage":"PostMix", "phase":"Initialize"}"#.to_string(),
            r#"{"deviceGuid":"{bbbb}", "stage":"PostMix", "phase":"ChildAPO"}"#.to_string(),
            "not json".to_string(),
        ];
        apply_test_messages(&msgs, &mut r);
        assert!(r[0].pre_mix && r[0].post_mix && r[0].ok);
        assert!(!r[1].post_mix && !r[1].ok);
        let t: Task = serde_json::from_str(r#"{"action":"test"}"#).unwrap();
        assert!(matches!(t, Task::Test));
        assert_eq!(mode_label("sfx-efx"), "SFX/EFX");
    }

    #[test]
    fn task_json_shape() {
        let t: Task = serde_json::from_str(r#"{"action":"install","devices":["{0.0.0.00000000}.{abc}"]}"#).unwrap();
        assert!(matches!(t, Task::Install { .. }));
        let t: Task = serde_json::from_str(r#"{"action":"use-external"}"#).unwrap();
        assert!(matches!(t, Task::UseExternal));
    }
}
