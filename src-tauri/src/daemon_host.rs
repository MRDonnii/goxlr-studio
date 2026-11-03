//! Built-in GoXLR engine: GoXLR Utility's daemon (MIT licence, see THIRD-PARTY-NOTICES.md) is
//! compiled into GoXLR Studio (`goxlr-engine/`) and runs on its own thread inside this process.
//! There is no separate goxlr-daemon.exe, no GoXLR Utility tray icon and no GoXLR Utility UI.
//! It uses the same settings/profile folders as GoXLR Utility, so existing profiles keep working,
//! and the same local API (127.0.0.1:14564), which `daemon.rs` and the UI talk to.
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
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
static HISTORY: Mutex<VecDeque<Attempt>> = Mutex::new(VecDeque::new());
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

/// One start (or stop) of the engine, for Diagnose and the troubleshooter.
#[derive(Clone, serde::Serialize)]
pub struct Attempt {
    /// Unix time in milliseconds.
    pub at: u64,
    pub ok: bool,
    pub text: String,
}

fn note(ok: bool, text: &str) {
    let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    if ok {
        log::info!("GoXLR-motor: {text}");
    } else {
        log::warn!("GoXLR-motor: {text}");
    }
    let mut h = HISTORY.lock().unwrap();
    h.push_back(Attempt { at, ok, text: text.to_string() });
    while h.len() > 20 {
        h.pop_front();
    }
}

/// The latest starts and stops of the engine (oldest first).
pub fn attempts() -> Vec<Attempt> {
    HISTORY.lock().unwrap().iter().cloned().collect()
}

/// Starts the engine on its own thread and waits (up to `wait`) until it is up or has failed.
pub fn start_and_wait(wait: Duration) -> Result<String, String> {
    let res = start_inner(wait);
    match &res {
        Ok(t) => note(true, t),
        Err(e) => note(false, e),
    }
    res
}

/// Errors where trying again does not help (the user has to do something first).
pub fn worth_retrying(e: &str) -> bool {
    let l = e.to_lowercase();
    !(l.contains("driver") || l.contains("administrator") || l.contains("goxlr utility kører") || l.contains("kun i windows"))
}

/// Starts the engine and tries again after each of `delays` (seconds) while it fails with an
/// error that can pass by itself – right after an update the old GoXLR Studio can still be
/// closing and hold the engine's pipe and port for a few seconds.
pub fn start_with_retry(delays: &[u64]) -> Result<String, String> {
    let mut last = start();
    for &d in delays {
        match &last {
            Err(e) if worth_retrying(e) => {}
            _ => break,
        }
        note(false, &format!("Prøver igen om {d} s"));
        std::thread::sleep(Duration::from_secs(d));
        last = start();
    }
    last
}

fn start_inner(wait: Duration) -> Result<String, String> {
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
    match &error {
        Some(e) => note(false, &format!("Stoppede: {e}")),
        None => note(true, "Stoppede"),
    }
    if let Some(f) = ON_STOPPED.get() {
        f(error);
    }
}

/// The engine's errors are in English; the common ones get a Danish explanation.
#[cfg_attr(not(windows), allow(dead_code))]
fn friendly_error(e: &str) -> String {
    let l = e.to_lowercase();
    if l.contains("goxlr daemon is already running") {
        "En anden GoXLR-motor svarer allerede – typisk den gamle GoXLR Studio, der stadig er ved at lukke efter en opdatering, eller GoXLR Utility".into()
    } else if l.contains("named pipe error") {
        format!("GoXLR-motorens interne forbindelse (named pipe) svarer ikke – genstart pc'en ({e})")
    } else if l.contains("unable to create log directory") {
        format!("GoXLR-motoren kan ikke oprette sin log-mappe ({e})")
    } else if l.contains("run as root") {
        "GoXLR-motoren må ikke køre som administrator – start GoXLR Studio normalt".into()
    } else if l.contains("driver was not found") {
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

/// goxlr-daemon.log (the engine's own log; same folder as GoXLR Utility's).
pub fn log_file() -> Option<PathBuf> {
    #[cfg(windows)]
    return goxlr_engine::log_directory().map(|d| d.join("goxlr-daemon.log"));
    #[cfg(not(windows))]
    None
}

/// The last `n` lines of a log file (only its end is read).
pub fn tail_lines(path: &Path, n: usize) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return Vec::new() };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(256 * 1024);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        lines.remove(0); // cut in the middle of a line
    }
    let from = lines.len().saturating_sub(n);
    lines[from..].iter().map(|l| l.trim_end().to_string()).filter(|l| !l.is_empty()).collect()
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
        assert!(friendly_error("The GoXLR Daemon is already running.").contains("gamle GoXLR Studio"));
        assert_eq!(friendly_error("something else"), "something else");
    }

    #[test]
    fn retries_only_what_can_pass() {
        assert!(worth_retrying(&friendly_error("The GoXLR Daemon is already running.")));
        assert!(worth_retrying(&friendly_error("Unable to Start HTTP Server: address in use")));
        assert!(!worth_retrying(&friendly_error("The GoXLR Driver was not found, please install it and try again.")));
        assert!(!worth_retrying("GoXLR Utility kører stadig og styrer GoXLR'en"));
        assert!(!worth_retrying(&friendly_error("The GoXLR engine is not designed to be run as root")));
    }

    #[test]
    fn reads_the_end_of_a_log() {
        let dir = std::env::temp_dir().join(format!("gxs-tail-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("x.log");
        let body = (0..30000).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        std::fs::write(&p, body).unwrap();
        let t = tail_lines(&p, 3);
        assert_eq!(t, vec!["line 29997", "line 29998", "line 29999"]);
        assert!(tail_lines(&dir.join("missing.log"), 3).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn recognises_the_old_separate_engine() {
        let old = old_engine_dir().join("goxlr-daemon.exe").display().to_string();
        assert!(is_old_ours(&Some(old.to_uppercase())));
        assert!(!is_old_ours(&Some(r"C:\Program Files\GoXLR Utility\goxlr-daemon.exe".into())));
        assert!(!is_old_ours(&None));
    }
}
