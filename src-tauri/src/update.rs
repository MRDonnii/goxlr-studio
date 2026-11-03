//! Self-update from GitHub releases.
//!
//! Checking: every release carries `latest.json` (written by the build: version, notes and each
//! file's SHA-256). It is fetched from github.com/…/releases/latest/download/ – an ordinary file
//! download. GitHub's API allows only 60 requests an hour per internet connection without login
//! (a user got "GitHub svarede 403"), so it is only used for releases without latest.json.
//!
//! Installing: download the installer (or the portable exe) and check its SHA-256. A hidden
//! PowerShell helper then waits for the app to exit, runs the installer (waiting for that process
//! only, not for what it starts), writes every step to %APPDATA%\GoXLR Studio\logs\update.log and
//! the outcome to update-result.json, and always starts the app again – also when the installer
//! failed, so the user is never left without it.
use serde_json::{json, Value};
use std::path::PathBuf;

const ALLOWED_PREFIX: &str = "https://github.com/MRDonnii/goxlr-studio/releases/download/";
#[cfg(windows)]
const LATEST_JSON: &str = "https://github.com/MRDonnii/goxlr-studio/releases/latest/download/latest.json";
#[cfg(windows)]
const LATEST_API: &str = "https://api.github.com/repos/MRDonnii/goxlr-studio/releases/latest";

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

/// A release as the UI expects it (GitHub's API shape): tag_name, body, html_url and assets with
/// name, browser_download_url and digest. Used for latest.json and for the API's answer.
pub fn release_from_json(text: &str) -> Result<Value, String> {
    let mut v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("Ugyldigt svar fra GitHub: {e}"))?;
    let tag = v.get("tag_name").and_then(Value::as_str).unwrap_or("");
    if !tag.starts_with('v') || tag.len() < 2 {
        return Err("Svaret fra GitHub mangler et versionsnummer".into());
    }
    if !v.get("assets").map(Value::is_array).unwrap_or(false) {
        return Err("Svaret fra GitHub mangler filerne".into());
    }
    if v.get("body").map(Value::is_null).unwrap_or(true) {
        v["body"] = json!("");
    }
    Ok(v)
}

/// What to tell the user when GitHub's API does not answer 200.
pub fn http_error(status: u16, reset: Option<u64>, now: u64) -> String {
    match status {
        403 | 429 => {
            let wait = reset
                .filter(|r| *r > now)
                .map(|r| format!(" Prøv igen om {} min.", (r - now).div_ceil(60)))
                .unwrap_or_default();
            format!("GitHub tager højst imod 60 opdateringstjek i timen fra samme internetforbindelse, og grænsen er nået lige nu. Det går over af sig selv.{wait}")
        }
        404 => "GitHub viser ingen udgivelser for GoXLR Studio. Er repoet privat, kan hverken appen eller andre se dem – gør det offentligt på GitHub (Settings → Danger Zone → Change repository visibility).".into(),
        s => format!("GitHub svarede {s}"),
    }
}

// ---------- Signed updates ----------
// When CI has the secret UPDATE_SIGNING_KEY, it builds the matching public key into the app
// (UPDATE_PUBKEY) and signs latest.json (ed25519, latest.json.sig). Such an app installs only what a
// correctly signed latest.json lists, with the SHA-256 given there – a release someone else uploaded
// or altered is refused. Apps built without the key work as before.
const UPDATE_PUBKEY: Option<&str> = option_env!("UPDATE_PUBKEY");

pub fn signing_required() -> bool {
    UPDATE_PUBKEY.map(|k| !k.trim().is_empty()).unwrap_or(false)
}

/// Checks an ed25519 signature (base64) of `data` against a public key (base64, 32 bytes).
pub fn verify_signature(pubkey_b64: &str, data: &[u8], sig_b64: &str) -> Result<(), String> {
    use base64::Engine;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};
    let b64 = base64::engine::general_purpose::STANDARD;
    let key: [u8; 32] = b64.decode(pubkey_b64.trim()).ok().and_then(|k| k.try_into().ok()).ok_or("Ugyldig offentlig nøgle")?;
    let sig: [u8; 64] = b64.decode(sig_b64.trim()).ok().and_then(|s| s.try_into().ok()).ok_or("Ugyldig signatur")?;
    let key = VerifyingKey::from_bytes(&key).map_err(|_| "Ugyldig offentlig nøgle")?;
    key.verify(data, &Signature::from_bytes(&sig)).map_err(|_| "Signaturen passer ikke".to_string())
}

/// The (url, sha256) of every file in the last correctly signed latest.json.
static VERIFIED: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

fn remember_verified(rel: &Value) {
    let files: Vec<(String, String)> = rel["assets"].as_array().into_iter().flatten()
        .filter_map(|a| Some((a["browser_download_url"].as_str()?.to_string(), a["digest"].as_str()?.trim_start_matches("sha256:").to_lowercase())))
        .collect();
    *VERIFIED.lock().unwrap() = files;
}

/// With signing required: is this exactly a file (and SHA-256) from the signed latest.json?
pub fn verified_file(url: &str, sha256: Option<&str>) -> bool {
    let Some(sha) = sha256.map(|s| s.trim_start_matches("sha256:").to_lowercase()) else { return false };
    VERIFIED.lock().unwrap().iter().any(|(u, s)| u == url && *s == sha)
}

/// latest.json (as bytes) checked against its signature; the release marked `signed`.
pub fn signed_release(json: &[u8], sig: Option<&str>, pubkey: &str) -> Result<Value, String> {
    let sig = sig.ok_or("Udgivelsen er ikke signeret – den installeres ikke. Hent den selv fra GitHub, hvis du stoler på den.")?;
    verify_signature(pubkey, json, sig).map_err(|e| format!("Udgivelsens signatur passer ikke ({e}) – den installeres ikke."))?;
    let mut rel = release_from_json(&String::from_utf8_lossy(json))?;
    rel["signed"] = json!(true);
    remember_verified(&rel);
    Ok(rel)
}

/// Finds the newest release: latest.json first (no hourly limit), GitHub's API as a fallback.
#[cfg(windows)]
pub async fn check(current: String) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .user_agent(format!("GoXLR-Studio/{current}"))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    if let Some(key) = UPDATE_PUBKEY.filter(|_| signing_required()) {
        // Signed updates: only latest.json and its signature count (GitHub's API cannot be checked).
        let r = client.get(LATEST_JSON).send().await.map_err(|e| format!("Kunne ikke kontakte GitHub: {e}"))?;
        if !r.status().is_success() {
            return Err(format!("GitHub svarede {} på latest.json", r.status().as_u16()));
        }
        let bytes = r.bytes().await.map_err(|e| e.to_string())?;
        let sig = match client.get(format!("{LATEST_JSON}.sig")).send().await {
            Ok(r) if r.status().is_success() => r.text().await.ok(),
            _ => None,
        };
        return signed_release(&bytes, sig.as_deref(), key);
    }
    if let Ok(r) = client.get(LATEST_JSON).send().await {
        if r.status().is_success() {
            if let Ok(rel) = release_from_json(&r.text().await.unwrap_or_default()) {
                return Ok(rel);
            }
        }
    }
    let r = client
        .get(LATEST_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Kunne ikke kontakte GitHub: {e}"))?;
    let status = r.status().as_u16();
    if status != 200 {
        let reset = r.headers().get("x-ratelimit-reset").and_then(|v| v.to_str().ok()).and_then(|s| s.parse().ok());
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        return Err(http_error(status, reset, now));
    }
    release_from_json(&r.text().await.map_err(|e| e.to_string())?)
}

#[cfg(not(windows))]
pub async fn check(_current: String) -> Result<Value, String> {
    Err("Kun på Windows".into())
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
    // Started from its own folder (never a working directory that may disappear).
    let start = if h.background {
        format!("Start-Process -FilePath {exe} -ArgumentList '--minimized' -WorkingDirectory (Split-Path -Parent {exe}) -ErrorAction Stop")
    } else {
        format!("Start-Process -FilePath {exe} -WorkingDirectory (Split-Path -Parent {exe}) -ErrorAction Stop")
    };
    let install = if h.installed {
        format!(
            r#"$code = -1
for ($try = 1; $try -le 2; $try++) {{
  try {{
    $p = Start-Process -FilePath {file} -ArgumentList {installer_args} -WorkingDirectory (Split-Path -Parent {file}) -PassThru -ErrorAction Stop
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
function Old {{ Get-Process -Id {pid} -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -eq {exe} }} }}
$old = Old
if ($old) {{ try {{ $old | Wait-Process -Timeout 60 -ErrorAction Stop }} catch {{ }} }}
$old = Old
if ($old) {{
  Log 'GoXLR Studio lukkede ikke af sig selv inden for 60 sekunder – stopper den'
  $old | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}}
Start-Sleep -Milliseconds 800
# Another GoXLR Studio (started as administrator or as another account, e.g. by a scheduled task)
# keeps the exe locked, and the installer cannot replace it. Stop what may be stopped, log the rest.
$others = @(Get-Process -Name {name} -ErrorAction SilentlyContinue | Where-Object {{ $_.Id -ne {pid} }})
if ($others.Count -gt 0) {{
  Log ('Andre GoXLR Studio-processer kører: ' + (($others | ForEach-Object {{ $_.Id }}) -join ', ') + ' – stopper dem')
  $others | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  $left = @(Get-Process -Name {name} -ErrorAction SilentlyContinue | Where-Object {{ $_.Id -ne {pid} }})
  if ($left.Count -gt 0) {{ Log ('Kunne ikke stoppe ' + $left.Count + ' GoXLR Studio (kører som administrator eller anden konto) – exe-filen kan være låst') }}
}}
Log 'Installerer {to}'
{install}
# The installer can end with 0 without replacing a locked exe: check the version it left behind.
if ($code -eq 0) {{
  try {{
    $v = (Get-Item -LiteralPath {exe}).VersionInfo.ProductVersion
    $now = ([version]($v -replace '[^0-9.]', '')).ToString(3)
    if ($now -ne ({to_q} -replace '^[vV]', '')) {{ $code = -5; Log ('Exe-filen er stadig version ' + $now + ' efter installationen – den blev ikke udskiftet') }}
    else {{ Log ('Exe-filen er nu version ' + $now) }}
  }} catch {{ Log ('Kunne ikke læse exe-filens version: ' + $_.Exception.Message) }}
}}
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
            .current_dir(std::env::temp_dir())
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
    if signing_required() && !verified_file(url, sha256) {
        let e = "Filen er ikke fra en korrekt signeret udgivelse – den installeres ikke".to_string();
        log(&format!("Fejl: {e} ({url})"));
        return Err(e);
    }
    log(&format!("Opdatering {from} → {to}: henter {url}"));
    let file = download(url, sha256).inspect_err(|e| log(&format!("Fejl: {e}")))?;
    log(if signing_required() { "Hentet, og filen matcher SHA-256 fra den signerede udgivelse" } else if sha256.is_some() { "Hentet, og filen matcher GitHubs SHA-256" } else { "Hentet (GitHub opgav ingen SHA-256)" });
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
    spawn_helper(&script).inspect_err(|e| {
        log(&format!("Fejl: {e}"));
        let _ = std::fs::remove_file(result_path());
    })?;
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
        // Only GoXLR Studio itself is waited for or stopped (Windows can reuse a process id).
        assert!(s.contains("Get-Process -Id 4242 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq 'C:\\Users\\Søren O''Hara\\AppData\\Local\\GoXLR Studio\\goxlr-studio.exe' }"));
        assert!(s.contains("$old | Stop-Process -Force"));
        // A locked exe (another GoXLR Studio as administrator) is found by its version.
        assert!(s.contains("VersionInfo.ProductVersion"));
        assert!(s.contains("$code = -5"));
        assert!(!s.contains("Stop-Process -Id"));
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

    #[test]
    fn releases_are_read_from_latest_json_and_the_api() {
        let rel = release_from_json("\u{feff}{\"tag_name\":\"v0.4.4\",\"assets\":[{\"name\":\"GoXLR.Studio_0.4.4_x64-setup.exe\"}]}").unwrap();
        assert_eq!(rel["tag_name"], "v0.4.4");
        assert_eq!(rel["body"], "");
        assert!(release_from_json("{\"message\":\"Not Found\"}").is_err());
        assert!(release_from_json("{\"tag_name\":\"v0.4.4\"}").is_err());
        assert!(release_from_json("<html>").is_err());
    }

    #[test]
    fn signed_latest_json_is_checked_byte_for_byte() {
        use base64::Engine;
        use ed25519_dalek::{Signer, SigningKey};
        let b64 = base64::engine::general_purpose::STANDARD;
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let public = b64.encode(key.verifying_key().to_bytes());
        let json = br#"{"tag_name":"v9.9.9","body":"","assets":[{"name":"a-setup.exe","browser_download_url":"https://github.com/x/releases/download/v9.9.9/a-setup.exe","digest":"sha256:ABCD"}]}"#;
        let sig = b64.encode(key.sign(json).to_bytes());
        let rel = signed_release(json, Some(&sig), &public).unwrap();
        assert_eq!(rel["signed"], json!(true));
        assert!(verified_file("https://github.com/x/releases/download/v9.9.9/a-setup.exe", Some("sha256:abcd")));
        assert!(!verified_file("https://github.com/x/releases/download/v9.9.9/a-setup.exe", Some("sha256:ffff")));
        assert!(!verified_file("https://evil.example/a-setup.exe", Some("abcd")));
        // One changed byte, a missing or foreign signature: refused.
        let mut changed = json.to_vec();
        changed[20] ^= 1;
        assert!(signed_release(&changed, Some(&sig), &public).is_err());
        assert!(signed_release(json, None, &public).is_err());
        let other = b64.encode(SigningKey::from_bytes(&[8u8; 32]).verifying_key().to_bytes());
        assert!(signed_release(json, Some(&sig), &other).is_err());
        assert!(verify_signature(&public, json, "not base64!").is_err());
    }

    #[test]
    fn github_limits_are_explained() {
        let t = http_error(403, Some(1_000 + 125), 1_000);
        assert!(t.contains("60 opdateringstjek i timen"));
        assert!(t.contains("om 3 min"));
        assert!(!http_error(429, None, 0).contains(" min."));
        assert!(http_error(404, None, 0).contains("privat"));
        assert_eq!(http_error(500, None, 0), "GitHub svarede 500");
    }
}
