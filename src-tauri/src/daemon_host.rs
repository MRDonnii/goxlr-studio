//! Built-in GoXLR engine: GoXLR Utility's daemon (MIT licence, see THIRD-PARTY-NOTICES.md) is
//! compiled into GoXLR Studio (`goxlr-engine/`) and runs on its own thread inside this process.
//! There is no separate goxlr-daemon.exe, no GoXLR Utility tray icon and no GoXLR Utility UI.
//! It uses the same settings/profile folders as GoXLR Utility, so existing profiles keep working,
//! and the same local API (127.0.0.1:14564), which `daemon.rs` and the UI talk to.
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[cfg(windows)]
pub const DAEMON_VERSION: &str = goxlr_engine::VERSION;
#[cfg(not(windows))]
pub const DAEMON_VERSION: &str = "";

struct Engine {
    thread: Option<JoinHandle<()>>,
    last_error: Option<String>,
}

static ENGINE: Mutex<Engine> = Mutex::new(Engine { thread: None, last_error: None });
static ON_STOPPED: OnceLock<Box<dyn Fn(Option<String>) + Send + Sync>> = OnceLock::new();

/// This build contains the GoXLR engine (always on Windows).
pub fn bundled() -> bool {
    cfg!(windows)
}

/// Called when the engine stops by itself (with the reason if it failed).
pub fn on_stopped(f: impl Fn(Option<String>) + Send + Sync + 'static) {
    let _ = ON_STOPPED.set(Box::new(f));
}

/// Something asked the engine to show its UI (e.g. a GoXLR Utility client): show ours.
pub fn on_activate(f: impl Fn() + Send + Sync + 'static) {
    #[cfg(windows)]
    goxlr_engine::set_activate_hook(f);
    #[cfg(not(windows))]
    let _ = f;
}

pub fn running() -> bool {
    ENGINE.lock().unwrap().thread.as_ref().is_some_and(|t| !t.is_finished())
}

fn ready() -> bool {
    #[cfg(windows)]
    return goxlr_engine::is_ready();
    #[cfg(not(windows))]
    false
}

/// Why the engine last stopped with an error, if it did.
pub fn last_error() -> Option<String> {
    ENGINE.lock().unwrap().last_error.clone()
}

/// Starts the engine on its own thread and waits (up to `wait`) until it is up or has failed.
pub fn start_and_wait(wait: Duration) -> Result<String, String> {
    if !bundled() {
        return Err("GoXLR-motoren findes kun i Windows-udgaven".into());
    }
    {
        let mut e = ENGINE.lock().unwrap();
        if e.thread.as_ref().is_some_and(|t| !t.is_finished()) {
            return Ok("GoXLR-motoren kører".into());
        }
        if let Some(t) = e.thread.take() {
            let _ = t.join();
        }
        if !foreign_engines().is_empty() {
            return Err("GoXLR Utility kører stadig og styrer GoXLR'en".into());
        }
        e.last_error = None;
        let thread = std::thread::Builder::new()
            .name("goxlr-engine".into())
            .spawn(run_engine)
            .map_err(|e| format!("Kunne ikke starte GoXLR-motoren: {e}"))?;
        e.thread = Some(thread);
    }
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline {
        if ready() {
            return Ok("GoXLR-motoren er startet".into());
        }
        if !running() {
            return Err(last_error().unwrap_or_else(|| "GoXLR-motoren stoppede".into()));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok("GoXLR-motoren starter".into())
}

/// Starts the engine (see `start_and_wait`).
pub fn start() -> Result<String, String> {
    start_and_wait(Duration::from_secs(8))
}

fn run_engine() {
    #[cfg(windows)]
    let error = goxlr_engine::run().err().map(|e| friendly_error(&format!("{e:#}")));
    #[cfg(not(windows))]
    let error: Option<String> = None;
    ENGINE.lock().unwrap().last_error = error.clone();
    if let Some(f) = ON_STOPPED.get() {
        f(error);
    }
}

/// The engine's errors are in English; the common ones get a Danish explanation.
#[cfg_attr(not(windows), allow(dead_code))]
fn friendly_error(e: &str) -> String {
    let l = e.to_lowercase();
    if l.contains("driver was not found") {
        "TC-Helicons GoXLR-driver blev ikke fundet – installér den og start GoXLR Studio igen".into()
    } else if l.contains("official goxlr application") {
        "TC-Helicons GoXLR-app kører – luk den, så kan GoXLR Studio styre GoXLR'en".into()
    } else if l.contains("already running") {
        "GoXLR Utility kører stadig og styrer GoXLR'en".into()
    } else if l.contains("http server") {
        format!("Port 14564 er optaget af et andet program ({e})")
    } else {
        e.to_string()
    }
}

/// Stops the engine cleanly (called when the app quits) – waits a few seconds for it to finish.
pub fn stop() {
    let Some(thread) = ENGINE.lock().unwrap().thread.take() else { return };
    let deadline = Instant::now() + Duration::from_secs(6);
    let mut asked = false;
    while !thread.is_finished() && Instant::now() < deadline {
        #[cfg(windows)]
        if !asked {
            asked = goxlr_engine::request_stop();
        }
        #[cfg(not(windows))]
        let _ = &mut asked;
        std::thread::sleep(Duration::from_millis(50));
    }
    if thread.is_finished() {
        let _ = thread.join();
    }
}

pub fn started_by_us() -> bool {
    running()
}

// ---------------------------------------------------------------------------------------------
// One app: take over from an installed GoXLR Utility (and from the separate engine of 0.3.x).
// ---------------------------------------------------------------------------------------------

/// Where GoXLR Studio 0.3.x unpacked its separate goxlr-daemon.exe.
fn old_engine_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("GoXLR Studio").join("engine")
}

fn is_old_ours(path: &Option<String>) -> bool {
    let old = old_engine_dir().join("goxlr-daemon.exe").display().to_string();
    path.as_deref().is_some_and(|p| p.eq_ignore_ascii_case(&old))
}

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

/// GoXLR engines running outside GoXLR Studio (an installed GoXLR Utility, or 0.3.x's separate one).
pub fn foreign_engines() -> Vec<String> {
    processes()
        .into_iter()
        .filter(|(_, n, _)| n.eq_ignore_ascii_case("goxlr-daemon.exe"))
        .map(|(_, n, p)| p.unwrap_or(n))
        .collect()
}

/// Any GoXLR engine is running (GoXLR Studio's own or another one).
pub fn daemon_process_running() -> bool {
    running() || !foreign_engines().is_empty()
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
    /// GoXLR Utility programs that were stopped.
    pub stopped: Vec<String>,
    pub autostart_disabled: Option<String>,
    /// The separate engine of GoXLR Studio 0.3.x was stopped and removed.
    pub old_engine_removed: bool,
    pub started: String,
    pub restored_utility: bool,
    /// GoXLR Utility still starts with Windows through these (mindre fejl 3: the app must not say
    /// "GoXLR Utility er koblet fra" while a scheduled task starts it again at the next login).
    pub autostart_remaining: Vec<crate::migrate::Autostart>,
}

/// Stops an installed GoXLR Utility (and 0.3.x's separate engine), keeps GoXLR Utility from
/// starting with Windows and starts the engine inside GoXLR Studio instead. If that fails,
/// GoXLR Utility is started again so the GoXLR keeps working.
pub fn take_over(restart_utility: impl Fn() -> Result<String, String>) -> Result<Takeover, String> {
    if !bundled() {
        return Err("GoXLR-motoren findes kun i Windows-udgaven".into());
    }
    let mut t = Takeover::default();
    for (pid, name, path) in processes() {
        if UTILITY_EXES.iter().any(|n| n.eq_ignore_ascii_case(&name)) && kill(pid) {
            if is_old_ours(&path) {
                t.old_engine_removed = true;
            } else {
                t.stopped.push(path.unwrap_or(name));
            }
        }
    }
    // GoXLR Utility starts itself through "GoXLR Utility.lnk" in the Startup folder.
    if let Some(startup) = std::env::var_os("APPDATA").map(|a| PathBuf::from(a).join(r"Microsoft\Windows\Start Menu\Programs\Startup")) {
        let link = startup.join("GoXLR Utility.lnk");
        let mentions_studio = |b: &[u8]| {
            let wide: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
            String::from_utf8_lossy(b).to_lowercase().contains("goxlr studio") || String::from_utf16_lossy(&wide).to_lowercase().contains("goxlr studio")
        };
        match std::fs::read(&link) {
            // A link to 0.3.x's separate engine: GoXLR Studio starts its engine itself now.
            Ok(bytes) if mentions_studio(&bytes) => {
                let _ = std::fs::remove_file(&link);
            }
            Ok(_) => {
                if let Ok(dest) = crate::migrate::disable_startup(link.display().to_string()) {
                    t.autostart_disabled = Some(dest);
                }
            }
            Err(_) => {}
        }
    }
    // Give the USB device a moment to be released.
    let killed = !t.stopped.is_empty() || t.old_engine_removed;
    std::thread::sleep(Duration::from_millis(if killed { 1500 } else { 0 }));
    remove_old_engine();
    t.autostart_remaining = crate::migrate::goxlr_autostarts().into_iter().filter(|a| a.enabled && a.owner != "driver").collect();
    match start_and_wait(Duration::from_secs(10)) {
        Ok(msg) => t.started = msg,
        Err(e) => {
            if !t.stopped.is_empty() {
                t.restored_utility = restart_utility().is_ok();
            }
            return Err(format!("{e}{}", if t.restored_utility { " – GoXLR Utility er startet igen" } else { "" }));
        }
    }
    Ok(t)
}

/// Stops and removes the separate engine of GoXLR Studio 0.3.x, if it is still around after the
/// update (it is ours, so this happens regardless of the "use the built-in engine" setting).
pub fn retire_old_engine() -> bool {
    let mut stopped = false;
    for (pid, _, path) in processes() {
        if is_old_ours(&path) && kill(pid) {
            stopped = true;
        }
    }
    if stopped {
        std::thread::sleep(Duration::from_millis(1500));
    }
    remove_old_engine();
    stopped
}

/// Removes the separate engine GoXLR Studio 0.3.x unpacked (the engine is part of the app now).
fn remove_old_engine() {
    let dir = old_engine_dir();
    if dir.join("goxlr-daemon.exe").exists() {
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Stops GoXLR Studio's engine and removes leftovers of 0.3.x's separate engine
/// (used when GoXLR Studio is uninstalled).
pub fn remove_ours() {
    stop();
    for (pid, _, path) in processes() {
        if is_old_ours(&path) {
            kill(pid);
        }
    }
    std::thread::sleep(Duration::from_millis(300));
    remove_old_engine();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explains_engine_errors() {
        assert!(friendly_error("The GoXLR Driver was not found, please install it and try again.").contains("driver"));
        assert!(friendly_error("The official GoXLR Application is currently running, Please close it").contains("TC-Helicons GoXLR-app"));
        assert!(friendly_error("GoXLR Utility is already running, please stop it and try again.").contains("GoXLR Utility kører"));
        assert!(friendly_error("Unable to Start HTTP Server: address in use").contains("14564"));
        assert_eq!(friendly_error("something else"), "something else");
    }

    #[test]
    fn recognises_the_old_separate_engine() {
        let old = old_engine_dir().join("goxlr-daemon.exe").display().to_string();
        assert!(is_old_ours(&Some(old.to_uppercase())));
        assert!(!is_old_ours(&Some(r"C:\Program Files\GoXLR Utility\goxlr-daemon.exe".into())));
        assert!(!is_old_ours(&None));
    }
}
