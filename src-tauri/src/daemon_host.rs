//! Built-in GoXLR engine: GoXLR Utility's daemon (MIT licence, see THIRD-PARTY-NOTICES.md) is
//! embedded at build time and run hidden by GoXLR Studio, so GoXLR Utility does not need to be
//! installed. It uses the same settings/profile folders as GoXLR Utility, so existing profiles keep
//! working. If another daemon is already running (e.g. an installed GoXLR Utility), that one is used.
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;

#[cfg(bundled_daemon)]
static DAEMON: &[u8] = include_bytes!(env!("GOXLR_DAEMON_PATH"));
#[cfg(not(bundled_daemon))]
static DAEMON: &[u8] = &[];

pub const DAEMON_VERSION: &str = match option_env!("GOXLR_DAEMON_VERSION") {
    Some(v) => v,
    None => "",
};

static CHILD: Mutex<Option<Child>> = Mutex::new(None);

pub fn bundled() -> bool {
    !DAEMON.is_empty()
}

fn exe_path() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("GoXLR Studio").join("engine").join("goxlr-daemon.exe")
}

/// Any goxlr-daemon.exe running (ours or an installed GoXLR Utility).
pub fn daemon_process_running() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq goxlr-daemon.exe", "/FO", "CSV", "/NH"])
            .creation_flags(0x0800_0000)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("goxlr-daemon.exe"))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    false
}

fn ours_alive() -> bool {
    let mut guard = CHILD.lock().unwrap();
    match guard.as_mut() {
        Some(c) => match c.try_wait() {
            Ok(None) => true,
            _ => {
                *guard = None;
                false
            }
        },
        None => false,
    }
}

/// Starts the embedded daemon (unpacking it first). Returns a short status text.
pub fn start() -> Result<String, String> {
    if !bundled() {
        return Err("Denne version indeholder ikke GoXLR-motoren".into());
    }
    if ours_alive() {
        return Ok("GoXLR-motoren kører".into());
    }
    if daemon_process_running() {
        return Ok("En GoXLR-motor kører allerede".into());
    }
    let exe = exe_path();
    if let Some(dir) = exe.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let current = std::fs::read(&exe).ok();
    if current.as_deref() != Some(DAEMON) {
        let tmp = exe.with_extension("tmp");
        std::fs::write(&tmp, DAEMON).map_err(|e| format!("Kunne ikke pakke GoXLR-motoren ud: {e}"))?;
        std::fs::rename(&tmp, &exe).map_err(|e| format!("Kunne ikke pakke GoXLR-motoren ud: {e}"))?;
    }
    let mut cmd = std::process::Command::new(&exe);
    cmd.args(["--disable-tray", "true"]);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let child = cmd.spawn().map_err(|e| format!("Kunne ikke starte GoXLR-motoren: {e}"))?;
    *CHILD.lock().unwrap() = Some(child);
    Ok("GoXLR-motoren er startet".into())
}

/// Stops the daemon if GoXLR Studio started it (called when the app quits).
pub fn stop() {
    if let Some(mut c) = CHILD.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

pub fn started_by_us() -> bool {
    ours_alive()
}

// ---------------------------------------------------------------------------------------------
// One app: take over from an installed GoXLR Utility.
// ---------------------------------------------------------------------------------------------

/// Running processes as (pid, exe name, full path).
#[cfg(windows)]
fn processes() -> Vec<(u32, String, Option<String>)> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    let mut out = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut ok = Process32FirstW(snap, &mut e).is_ok();
        while ok {
            let end = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
            let name = String::from_utf16_lossy(&e.szExeFile[..end]);
            let pid = e.th32ProcessID;
            let mut path = None;
            if let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                let mut buf = [0u16; 1024];
                let mut len = buf.len() as u32;
                if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok() {
                    path = Some(String::from_utf16_lossy(&buf[..len as usize]));
                }
                let _ = CloseHandle(h);
            }
            out.push((pid, name, path));
            ok = Process32NextW(snap, &mut e).is_ok();
        }
        let _ = CloseHandle(snap);
    }
    out
}

#[cfg(not(windows))]
fn processes() -> Vec<(u32, String, Option<String>)> {
    Vec::new()
}

const UTILITY_EXES: [&str; 4] = ["goxlr-daemon.exe", "goxlr-launcher.exe", "goxlr-utility-ui.exe", "goxlr-utility.exe"];

fn is_ours(path: &Option<String>) -> bool {
    path.as_deref().map(|p| p.eq_ignore_ascii_case(&exe_path().display().to_string())).unwrap_or(false)
}

/// Paths of GoXLR engines that are not GoXLR Studio's own (e.g. an installed GoXLR Utility).
pub fn foreign_engines() -> Vec<String> {
    processes()
        .into_iter()
        .filter(|(_, n, p)| n.eq_ignore_ascii_case("goxlr-daemon.exe") && !is_ours(p))
        .map(|(_, n, p)| p.unwrap_or(n))
        .collect()
}

#[cfg(windows)]
fn kill(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) else { return false };
        let ok = TerminateProcess(h, 0).is_ok();
        let _ = CloseHandle(h);
        ok
    }
}

#[cfg(not(windows))]
fn kill(_pid: u32) -> bool {
    false
}

#[derive(serde::Serialize, Default)]
pub struct Takeover {
    pub stopped: Vec<String>,
    pub autostart_disabled: Option<String>,
    pub started: String,
    pub restored_utility: bool,
}

/// Stops an installed GoXLR Utility, keeps it from starting with Windows and starts GoXLR Studio's
/// own engine instead. If that fails, GoXLR Utility is started again so the GoXLR keeps working.
pub fn take_over(restart_utility: impl Fn() -> Result<String, String>) -> Result<Takeover, String> {
    if !bundled() {
        return Err("Denne version indeholder ikke GoXLR-motoren".into());
    }
    let mut t = Takeover::default();
    for (pid, name, path) in processes() {
        if UTILITY_EXES.iter().any(|n| n.eq_ignore_ascii_case(&name)) && !is_ours(&path) && kill(pid) {
            t.stopped.push(path.unwrap_or(name));
        }
    }
    // GoXLR Utility starts itself through "GoXLR Utility.lnk" in the Startup folder.
    if let Some(startup) = std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join(r"Microsoft\Windows\Start Menu\Programs\Startup")) {
        let link = startup.join("GoXLR Utility.lnk");
        let points_to_us = std::fs::read(&link)
            .map(|b| String::from_utf8_lossy(&b).to_lowercase().contains("goxlr studio") || String::from_utf16_lossy(&b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect::<Vec<_>>()).to_lowercase().contains("goxlr studio"))
            .unwrap_or(true);
        if link.exists() && !points_to_us {
            if let Ok(dest) = crate::migrate::disable_startup(link.display().to_string()) {
                t.autostart_disabled = Some(dest);
            }
        }
    }
    // Give the USB device a moment to be released.
    std::thread::sleep(std::time::Duration::from_millis(if t.stopped.is_empty() { 0 } else { 1500 }));
    match start() {
        Ok(msg) => t.started = msg,
        Err(e) => {
            t.restored_utility = restart_utility().is_ok();
            return Err(format!("{e}{}", if t.restored_utility { " – GoXLR Utility er startet igen" } else { "" }));
        }
    }
    Ok(t)
}

/// Stops GoXLR Studio's own engine wherever it was started from and removes the unpacked copy
/// (used when GoXLR Studio is uninstalled).
pub fn remove_ours() {
    stop();
    for (pid, _, path) in processes() {
        if is_ours(&path) {
            kill(pid);
        }
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    if let Some(dir) = exe_path().parent() {
        let _ = std::fs::remove_dir_all(dir);
    }
}
