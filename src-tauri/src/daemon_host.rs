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
