//! "Start med Windows": GoXLR Studio's own entry in HKCU\...\Run.
//!
//! The autostart plugin writes the exe path without quotes (`C:\...\GoXLR Studio\goxlr-studio.exe
//! --minimized` – a path with spaces) and the app's toggle only showed the saved setting, not
//! whether Windows really starts the app (settings moved to a fresh pc with "Flyt til ny pc", a
//! reinstall to another folder, or the app switched off under Windows' Startup apps). Here the
//! entry is written with a quoted path, checked at every start and its real state is reported.
use serde::Serialize;

pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
/// Windows' Startup apps (Task Manager / Settings → Apps → Start): first byte 2 = on, 3 = off.
pub const APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
pub const NAME: &str = "GoXLR Studio";
const APPROVED_ON: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/// The command Windows runs at sign-in.
pub fn command(exe: &str) -> String {
    const Q: char = '"';
    format!("{Q}{exe}{Q} --minimized")
}

/// The exe a Run command starts (quoted or not).
pub fn command_exe(cmd: &str) -> String {
    let c = cmd.trim();
    if let Some(rest) = c.strip_prefix('"') {
        return rest.split('"').next().unwrap_or("").to_string();
    }
    // Unquoted (as the autostart plugin wrote it): everything up to ".exe".
    match c.to_ascii_lowercase().find(".exe") {
        Some(i) => c[..i + 4].to_string(),
        None => c.split(' ').next().unwrap_or("").to_string(),
    }
}

#[derive(Serialize, Debug, Default, Clone, PartialEq)]
pub struct Status {
    /// There is a Run entry.
    pub registered: bool,
    /// It starts this exe, with a quoted path.
    pub points_here: bool,
    pub quoted: bool,
    /// Not switched off under Windows' Startup apps.
    pub approved: bool,
    /// Windows starts GoXLR Studio at sign-in.
    pub enabled: bool,
    pub command: Option<String>,
}

/// Pure: the state from the registry values.
pub fn status_of(cmd: Option<&str>, approved: Option<&[u8]>, exe: &str) -> Status {
    let registered = cmd.is_some();
    let quoted = cmd.is_some_and(|c| c.trim_start().starts_with('"'));
    let points_here = cmd.is_some_and(|c| command_exe(c).eq_ignore_ascii_case(exe)) && quoted;
    // Missing value = on; otherwise an odd first byte (3) means switched off.
    let approved = approved.map(|b| b.first().is_none_or(|&x| x & 1 == 0)).unwrap_or(true);
    Status { registered, points_here, quoted, approved, enabled: registered && approved && points_here, command: cmd.map(str::to_string) }
}

/// What to do at start when the user has "Start med Windows" on: write the entry when it is
/// missing or does not start this exe (quoted). Windows' own "off" is left alone (reported).
pub fn needs_repair(s: &Status) -> bool {
    !s.registered || !s.points_here
}

#[cfg(windows)]
mod reg {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::*;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn open(path: &str, access: REG_SAM_FLAGS, create: bool) -> Option<HKEY> {
        let w = wide(path);
        let mut h = HKEY::default();
        let r = unsafe {
            if create {
                RegCreateKeyExW(HKEY_CURRENT_USER, PCWSTR(w.as_ptr()), 0, PCWSTR::null(), REG_OPTION_NON_VOLATILE, access, None, &mut h, None)
            } else {
                RegOpenKeyExW(HKEY_CURRENT_USER, PCWSTR(w.as_ptr()), 0, access, &mut h)
            }
        };
        (r == ERROR_SUCCESS).then_some(h)
    }

    pub fn read(path: &str, name: &str) -> Option<(REG_VALUE_TYPE, Vec<u8>)> {
        let k = open(path, KEY_QUERY_VALUE, false)?;
        let n = wide(name);
        let mut ty = REG_VALUE_TYPE::default();
        let mut size = 0u32;
        let out = unsafe {
            if RegQueryValueExW(k, PCWSTR(n.as_ptr()), None, Some(&mut ty), None, Some(&mut size)) != ERROR_SUCCESS {
                None
            } else {
                let mut buf = vec![0u8; size as usize];
                if RegQueryValueExW(k, PCWSTR(n.as_ptr()), None, Some(&mut ty), Some(buf.as_mut_ptr()), Some(&mut size)) == ERROR_SUCCESS {
                    buf.truncate(size as usize);
                    Some((ty, buf))
                } else {
                    None
                }
            }
        };
        unsafe {
            let _ = RegCloseKey(k);
        }
        out
    }

    pub fn read_str(path: &str, name: &str) -> Option<String> {
        let (ty, buf) = read(path, name)?;
        if ty != REG_SZ && ty != REG_EXPAND_SZ {
            return None;
        }
        let u: Vec<u16> = buf.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        let end = u.iter().position(|&c| c == 0).unwrap_or(u.len());
        Some(String::from_utf16_lossy(&u[..end]))
    }

    pub fn write(path: &str, name: &str, ty: REG_VALUE_TYPE, data: &[u8]) -> Result<(), String> {
        let k = open(path, KEY_SET_VALUE, true).ok_or_else(|| format!("Kunne ikke åbne {path}"))?;
        let n = wide(name);
        let r = unsafe { RegSetValueExW(k, PCWSTR(n.as_ptr()), 0, ty, Some(data)) };
        unsafe {
            let _ = RegCloseKey(k);
        }
        if r == ERROR_SUCCESS { Ok(()) } else { Err(format!("Kunne ikke skrive {name} i {path}")) }
    }

    pub fn write_str(path: &str, name: &str, value: &str) -> Result<(), String> {
        let bytes: Vec<u8> = wide(value).iter().flat_map(|u| u.to_le_bytes()).collect();
        write(path, name, REG_SZ, &bytes)
    }

    pub fn delete(path: &str, name: &str) {
        if let Some(k) = open(path, KEY_SET_VALUE, false) {
            let n = wide(name);
            unsafe {
                let _ = RegDeleteValueW(k, PCWSTR(n.as_ptr()));
                let _ = RegCloseKey(k);
            }
        }
    }
}

fn exe() -> String {
    std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default()
}

/// The real state of "Start med Windows".
pub fn status() -> Status {
    #[cfg(windows)]
    {
        let cmd = reg::read_str(RUN_KEY, NAME);
        let approved = reg::read(APPROVED_KEY, NAME).map(|(_, b)| b);
        status_of(cmd.as_deref(), approved.as_deref(), &exe())
    }
    #[cfg(not(windows))]
    Status::default()
}

/// Switches "Start med Windows" on (quoted path, and on under Windows' Startup apps – the user
/// asked for it) or off.
pub fn set(enabled: bool) -> Result<Status, String> {
    #[cfg(windows)]
    {
        if enabled {
            reg::write_str(RUN_KEY, NAME, &command(&exe()))?;
            reg::write(APPROVED_KEY, NAME, windows::Win32::System::Registry::REG_BINARY, &APPROVED_ON)?;
        } else {
            reg::delete(RUN_KEY, NAME);
        }
    }
    #[cfg(not(windows))]
    let _ = enabled;
    Ok(status())
}

/// At start, with "Start med Windows" on: puts the entry back if it is missing, unquoted or
/// points to another exe. Returns what was done (for the log), if anything.
pub fn repair() -> Option<String> {
    let s = status();
    if !needs_repair(&s) {
        return None;
    }
    #[cfg(windows)]
    {
        let cmd = command(&exe());
        return Some(match reg::write_str(RUN_KEY, NAME, &cmd) {
            Ok(()) if s.registered => "Start med Windows: genvejen pegede forkert og er skrevet igen".to_string(),
            Ok(()) => "Start med Windows: genvejen manglede og er skrevet igen".to_string(),
            Err(e) => format!("Start med Windows kunne ikke skrives: {e}"),
        });
    }
    #[allow(unreachable_code)]
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"C:\Users\x\AppData\Local\GoXLR Studio\goxlr-studio.exe";

    #[test]
    fn quotes_the_path() {
        let q = '"';
        assert_eq!(command(EXE), format!("{q}{EXE}{q} --minimized"));
        assert_eq!(command_exe(&command(EXE)), EXE);
        assert_eq!(command_exe(&format!("{EXE} --minimized")), EXE);
    }

    #[test]
    fn reads_the_state() {
        let good = command(EXE);
        let s = status_of(Some(&good), None, EXE);
        assert!(s.enabled && s.quoted && s.points_here && s.approved);
        // The plugin's unquoted entry, a missing one, one to another folder: repaired at start.
        assert!(needs_repair(&status_of(Some(&format!("{EXE} --minimized")), None, EXE)));
        assert!(needs_repair(&status_of(None, None, EXE)));
        assert!(needs_repair(&status_of(Some("\"D:\\old\\goxlr-studio.exe\" --minimized"), None, EXE)));
        // Switched off under Windows' Startup apps: reported, not overruled.
        let off = status_of(Some(&good), Some(&[3, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]), EXE);
        assert!(!off.approved && !off.enabled && !needs_repair(&off));
        assert!(status_of(Some(&good), Some(&APPROVED_ON), EXE).enabled);
    }
}
