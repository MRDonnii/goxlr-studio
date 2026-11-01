//! Self-update from GitHub releases: download the installer (or the portable exe), check its
//! SHA-256 against the digest GitHub publishes, then swap it in after the app has exited.
use std::path::PathBuf;

const ALLOWED_PREFIX: &str = "https://github.com/MRDonnii/goxlr-studio/releases/download/";

/// The NSIS installer leaves an uninstaller next to the exe; the portable build has none.
pub fn is_installed() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.join("uninstall.exe").exists()))
        .unwrap_or(false)
}

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

#[cfg(windows)]
fn powershell(script: &str) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("powershell")
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

/// Downloads and verifies, then starts a helper that waits for this process to exit,
/// installs/replaces and relaunches. The caller exits the app afterwards.
pub fn prepare(url: &str, sha256: Option<&str>) -> Result<(), String> {
    let file = download(url, sha256)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let pid = std::process::id();
    let f = ps_quote(&file.display().to_string());
    let e = ps_quote(&exe.display().to_string());
    let body = if is_installed() {
        // /UPDATE: Tauri's installer updates in place and never runs the old uninstaller.
        format!("Start-Process -Wait -FilePath {f} -ArgumentList '/S','/UPDATE'; Start-Process -FilePath {e}")
    } else {
        format!("Move-Item -Force -LiteralPath {e} -Destination ({e} + '.old'); Copy-Item -Force -LiteralPath {f} -Destination {e}; Start-Process -FilePath {e}")
    };
    let script = format!("Wait-Process -Id {pid} -Timeout 30 -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; {body}");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = script;
        Err("Kun på Windows".into())
    }
}

/// Removes the previous portable exe left behind by an update.
pub fn cleanup() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(PathBuf::from(format!("{}.old", exe.display())));
    }
}
