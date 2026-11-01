//! Self-update from GitHub releases.
//!
//! Installing: download the installer (or the portable exe) and check its SHA-256. A hidden
//! PowerShell helper then waits for the app to exit, runs the installer (waiting for that process
//! only, not for what it starts), writes every step to %APPDATA%\GoXLR Studio\logs\update.log and
//! the outcome to update-result.json, and always starts the app again – also when the installer
//! failed, so the user is never left without it.
use serde_json::{json, Value};
use std::path::PathBuf;

const ALLOWED_PREFIX: &str = "https://github.com/MRDonnii/goxlr-studio/releases/download/";

/// The NSIS installer leaves an uninstaller next to the exe; the portable build has none.
pub fn is_installed() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("uninstall.exe").exists()))
        .unwrap_or(false)
}

/// %APPDATA%\GoXLR Studio\logs – the update log and the last update's outcome.
pub fn log_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("GoXLR Studio")
        .join("logs")
}

fn log_path() -> PathBuf {
    log_dir().join("update.log")
}

fn result_path() -> PathBuf {
    log_dir().join("update-result.json")
}

/// Appends one line, in local time, to update.log (rotated at 256 KB).
pub fn log(msg: &str) {
    use std::io::Write;
    let dir = log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = log_path();
    if std::fs::metadata(&path).map(|m| m.len() > 256 * 1024).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join("update.old.log"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {msg}", chrono::Local::now().format("%Y-%m-%d %H:%M:%S"));
    }
}

/// The last `lines` lines of update.log, for Diagnose and "Kopiér rapport".
pub fn log_tail(lines: usize) -> Vec<String> {
    let text = std::fs::read_to_string(log_path()).unwrap_or_default();
    let all: Vec<&str> = text.lines().map(|l| l.trim_start_matches('\u{feff}')).filter(|l| !l.is_empty()).collect();
    all[all.len().saturating_sub(lines)..].iter().map(|s| s.to_string()).collect()
}

/// The outcome of the last update, once: the file is renamed after reading.
pub fn take_result() -> Option<Value> {
    let path = result_path();
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::rename(&path, log_dir().join("update-result.seen.json"));
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

fn write_result(v: &Value) {
    let _ = std::fs::create_dir_all(log_dir());
    let _ = std::fs::write(result_path(), v.to_string());
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Windows PowerShell by full path (not whatever "powershell" PATH finds first).
#[cfg(windows)]
fn powershell_exe() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(|r| PathBuf::from(r).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"))
        .filter(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("powershell"))
}

#[cfg(windows)]
fn powershell(script: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new(powershell_exe())
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(not(windows))]
fn powershell(_script: &str) -> Result<String, String> {
    Err("Kun på Windows".into())
}

fn download(url: &str, sha256: Option<&str>) -> Result<PathBuf, String> {
    if !url.starts_with(ALLOWED_PREFIX) {
        return Err("Opdateringer hentes kun fra GoXLR Studios GitHub-releases".into());
    }
    let name = url.rsplit('/').next().unwrap_or("update.exe").replace("%20", " ");
    if !name.to_lowercase().ends_with(".exe") || name.contains("..") || name.contains('\\') {
        return Err("Ugyldigt filnavn".into());
    }
    let dir = std::env::temp_dir().join("goxlr-studio-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(&name);
    let _ = std::fs::remove_file(&dest);
    powershell(&format!(
        "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -UseBasicParsing -Uri {} -OutFile {}",
        ps_quote(url),
        ps_quote(&dest.display().to_string())
    ))
    .map_err(|e| format!("Download fejlede: {e}"))?;
    if let Some(want) = sha256.map(|s| s.trim_start_matches("sha256:").to_lowercase()).filter(|s| s.len() == 64) {
        let got = powershell(&format!("(Get-FileHash -Algorithm SHA256 -LiteralPath {}).Hash", ps_quote(&dest.display().to_string())))?.to_lowercase();
        if got != want {
            let _ = std::fs::remove_file(&dest);
            return Err("Filen matcher ikke GitHubs checksum – opdateringen er afbrudt".into());
        }
    }
    Ok(dest)
}

/// Everything the update helper needs to know.
pub struct Helper<'a> {
    /// This process: the helper waits for it to exit.
    pub pid: u32,
    /// The app's exe (installed or portable), started again at the end.
    pub exe: &'a str,
    /// The downloaded installer or new portable exe.
    pub file: &'a str,
    pub installed: bool,
    /// The app was in the tray: install silently and start it in the tray again.
    pub background: bool,
    pub log: &'a str,
    pub result: &'a str,
    pub from: &'a str,
    pub to: &'a str,
}

/// The PowerShell helper. It never uses `Start-Process -Wait`, which waits for every process the
/// installer starts as well; it waits for the installer itself with a time limit, retries once
/// when the installer gave up (exit code 2, e.g. the app could not be closed yet), and starts the
/// app again whatever happened.
pub fn helper_script(h: &Helper) -> String {
    let (exe, file, log, result) = (ps_quote(h.exe), ps_quote(h.file), ps_quote(h.log), ps_quote(h.result));
    // Process name = file name without .exe (split by hand: tests run on Linux, paths are Windows').
    let base = h.exe.rsplit(['\\', '/']).next().unwrap_or("goxlr-studio.exe");
    let name = ps_quote(base.strip_suffix(".exe").or_else(|| base.strip_suffix(".EXE")).unwrap_or(base));
    // Passive shows the installer's progress bar (and its error, if any); silent shows nothing.
    let installer_args = if h.background { "'/S','/UPDATE'" } else { "'/P','/UPDATE'" };
    let start = if h.background {
        format!("Start-Process -FilePath {exe} -ArgumentList '--minimized' -ErrorAction Stop")
    } else {
        format!("Start-Process -FilePath {exe} -ErrorAction Stop")
    };
    let install = if h.installed {
        format!(
            r#"$code = -1
for ($try = 1; $try -le 2; $try++) {{
  try {{
    $p = Start-Process -FilePath {file} -ArgumentList {installer_args} -PassThru -ErrorAction Stop
    $null = $p.Handle
    if ($p.WaitForExit(600000)) {{ $code = $p.ExitCode }} else {{ $code = -2; Log 'Installeren blev ikke færdig inden for 10 minutter' }}
  }} catch {{ $code = -3; Log ('Kunne ikke starte installeren: ' + $_.Exception.Message) }}
  Log ('Installeren sluttede med kode ' + $code + ' (forsøg ' + $try + ')')
  if ($code -ne 2) {{ break }}
  Start-Sleep -Seconds 3
}}"#
        )
    } else {
        format!(
            r#"$code = 0
try {{
  Move-Item -Force -LiteralPath {exe} -Destination ({exe} + '.old') -ErrorAction Stop
  Copy-Item -Force -LiteralPath {file} -Destination {exe} -ErrorAction Stop
  Log 'Den nye exe-fil er lagt på plads'
}} catch {{
  $code = -4
  Log ('Kunne ikke udskifte exe-filen: ' + $_.Exception.Message)
  if (-not (Test-Path -LiteralPath {exe}) -and (Test-Path -LiteralPath ({exe} + '.old'))) {{ Move-Item -Force -LiteralPath ({exe} + '.old') -Destination {exe} }}
}}"#
        )
    };
    format!(
        r#"$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
function Log([string]$m) {{ try {{ Add-Content -LiteralPath {log} -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 }} catch {{ }} }}
Log 'Hjælperen kører: venter på at GoXLR Studio {from} lukker'
try {{ Wait-Process -Id {pid} -Timeout 60 -ErrorAction Stop }} catch {{ }}
if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{
  Log 'GoXLR Studio lukkede ikke af sig selv inden for 60 sekunder – stopper den'
  Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}}
Start-Sleep -Milliseconds 800
Log 'Installerer {to}'
{install}
try {{ [ordered]@{{ 'from' = {from_q}; 'to' = {to_q}; 'code' = $code; 'installed' = {installed}; 'at' = (Get-Date -Format 's') }} | ConvertTo-Json | Set-Content -LiteralPath {result} -Encoding UTF8 }} catch {{ }}
Start-Sleep -Seconds 1
$running = @(Get-Process -Name {name} -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -eq {exe} }})
if ($running.Count -eq 0) {{
  try {{ {start}; Log 'GoXLR Studio er startet igen' }} catch {{ Log ('Kunne ikke starte GoXLR Studio: ' + $_.Exception.Message) }}
}} else {{ Log 'GoXLR Studio kører allerede' }}
"#,
        pid = h.pid,
        from = h.from.replace('\'', ""),
        to = h.to.replace('\'', ""),
        from_q = ps_quote(h.from),
        to_q = ps_quote(h.to),
        installed = if h.installed { "$true" } else { "$false" },
    )
}

/// PowerShell's -EncodedCommand: UTF-16LE in base64, so paths with æ/ø/å or quotes survive.
pub fn encode_command(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Starts the helper hidden and detached from the app. A console app started without any console
/// (DETACHED_PROCESS, as before 0.4.4) is not reliable for PowerShell, so it gets a hidden one.
#[cfg(windows)]
fn spawn_helper(script: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let encoded = encode_command(script);
    let ps = powershell_exe();
    let spawn = |flags: u32| {
        Command::new(&ps)
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-EncodedCommand", &encoded])
            .creation_flags(flags)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };
    // Leave a job the app may run in, so closing the app cannot take the helper along; not every
    // job allows that, so try without as well.
    spawn(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB)
        .or_else(|_| spawn(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP))
        .map(|_| ())
        .map_err(|e| format!("Kunne ikke starte opdateringen: {e}"))
}

#[cfg(not(windows))]
fn spawn_helper(_script: &str) -> Result<(), String> {
    Err("Kun på Windows".into())
}

/// Downloads and verifies, then starts the helper. The caller exits the app afterwards.
pub fn prepare(url: &str, sha256: Option<&str>, to: &str, background: bool) -> Result<(), String> {
    let from = env!("CARGO_PKG_VERSION");
    log(&format!("Opdatering {from} → {to}: henter {url}"));
    let file = download(url, sha256).inspect_err(|e| log(&format!("Fejl: {e}")))?;
    log(if sha256.is_some() { "Hentet, og filen matcher GitHubs SHA-256" } else { "Hentet (GitHub opgav ingen SHA-256)" });
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let (exe, file, log_file, result) =
        (exe.display().to_string(), file.display().to_string(), log_path().display().to_string(), result_path().display().to_string());
    let script = helper_script(&Helper {
        pid: std::process::id(),
        exe: &exe,
        file: &file,
        installed: is_installed(),
        background,
        log: &log_file,
        result: &result,
        from,
        to,
    });
    // Overwritten by the helper; if it never gets that far, the next start says so.
    write_result(&json!({ "from": from, "to": to, "code": null }));
    spawn_helper(&script).inspect_err(|e| log(&format!("Fejl: {e}")))?;
    log("Hjælperen er startet – GoXLR Studio lukker nu");
    Ok(())
}

/// Removes the previous portable exe left behind by an update.
pub fn cleanup() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(PathBuf::from(format!("{}.old", exe.display())));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn helper(installed: bool, background: bool) -> String {
        helper_script(&Helper {
            pid: 4242,
            exe: r"C:\Users\Søren O'Hara\AppData\Local\GoXLR Studio\goxlr-studio.exe",
            file: r"C:\Users\Søren O'Hara\AppData\Local\Temp\goxlr-studio-update\GoXLR.Studio_0.4.4_x64-setup.exe",
            installed,
            background,
            log: r"C:\Users\Søren O'Hara\AppData\Roaming\GoXLR Studio\logs\update.log",
            result: r"C:\Users\Søren O'Hara\AppData\Roaming\GoXLR Studio\logs\update-result.json",
            from: "0.4.3",
            to: "0.4.4",
        })
    }

    #[test]
    fn helper_waits_for_the_installer_only_and_always_restarts_the_app() {
        let s = helper(true, false);
        // Start-Process -Wait would also wait for everything the installer starts.
        assert!(!s.contains("-Wait "));
        assert!(s.contains("-PassThru"));
        assert!(s.contains("WaitForExit(600000)"));
        assert!(s.contains("'/P','/UPDATE'"));
        assert!(s.contains("Wait-Process -Id 4242"));
        // Quotes in paths are doubled, so the script stays valid.
        assert!(s.contains("'C:\\Users\\Søren O''Hara\\AppData\\Local\\GoXLR Studio\\goxlr-studio.exe'"));
        assert!(s.contains("Get-Process -Name 'goxlr-studio'"));
        // The result is written before the app is started again, and the app is started last.
        let result = s.find("ConvertTo-Json").unwrap();
        let restart = s.rfind("Start-Process -FilePath 'C:\\Users\\Søren O''Hara\\AppData\\Local\\GoXLR Studio\\goxlr-studio.exe'").unwrap();
        assert!(result < restart);
        assert!(s.contains("if ($code -ne 2) { break }"));
    }

    #[test]
    fn background_updates_are_silent_and_return_to_the_tray() {
        let s = helper(true, true);
        assert!(s.contains("'/S','/UPDATE'"));
        assert!(s.contains("-ArgumentList '--minimized'"));
    }

    #[test]
    fn portable_update_swaps_the_exe_and_puts_it_back_on_failure() {
        let s = helper(false, false);
        assert!(!s.contains("/UPDATE"));
        assert!(s.contains("Move-Item -Force -LiteralPath"));
        assert!(s.contains("$code = -4"));
        assert!(s.contains("'installed' = $false"));
    }

    #[test]
    fn encoded_command_is_utf16le_base64() {
        use base64::Engine;
        let enc = encode_command("Log 'æøå'");
        let bytes = base64::engine::general_purpose::STANDARD.decode(enc).unwrap();
        let units: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(String::from_utf16(&units).unwrap(), "Log 'æøå'");
    }
}
