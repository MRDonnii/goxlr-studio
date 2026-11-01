//! "Move to GoXLR Studio": finds the old setup (AutoHotkey scripts, TC-Helicon app profiles,
//! Equalizer APO/Peace) and backs everything up before the user uninstalls anything.
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct AhkScript {
    pub path: String,
    pub text: String,
    /// Started with Windows from the Startup folder (file or shortcut).
    pub autostart: bool,
    pub startup_entry: Option<String>,
}

#[derive(Serialize, Default)]
pub struct TcHelicon {
    pub installed: bool,
    pub dir: Option<String>,
    pub profiles: Vec<String>,
    pub mic_profiles: Vec<String>,
}

#[derive(Serialize, Default)]
pub struct ApoInfo {
    pub config_dir: Option<String>,
    pub peace_installed: bool,
    pub peace_txt: Option<String>,
    pub preset_files: usize,
}

#[derive(Serialize)]
pub struct Scan {
    pub ahk: Vec<AhkScript>,
    pub ahk_running: bool,
    pub tc_helicon: TcHelicon,
    pub apo: ApoInfo,
    pub backup_root: String,
}

fn env_path(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

fn documents_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(home) = env_path("USERPROFILE") {
        for sub in ["Documents", "Dokumenter", "OneDrive\\Documents", "OneDrive\\Dokumenter", "Desktop", "Skrivebord", "OneDrive\\Desktop", "OneDrive\\Skrivebord", "AutoHotkey"] {
            let p = home.join(sub);
            if p.is_dir() && !v.contains(&p) {
                v.push(p);
            }
        }
    }
    v
}

fn startup_dir() -> Option<PathBuf> {
    env_path("APPDATA").map(|a| a.join(r"Microsoft\Windows\Start Menu\Programs\Startup"))
}

pub fn backup_root() -> PathBuf {
    env_path("APPDATA").unwrap_or_else(std::env::temp_dir).join("GoXLR Studio").join("backup")
}

/// Shortcuts (.lnk) store their target as UTF-16 and/or ANSI text; pull out any *.ahk path.
fn ahk_paths_in_lnk(bytes: &[u8]) -> Vec<String> {
    let mut texts = vec![bytes.iter().map(|&b| if (32..127).contains(&b) { b as char } else { '\0' }).collect::<String>()];
    for off in 0..2 {
        let u: Vec<u16> = bytes[off..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        texts.push(String::from_utf16_lossy(&u).chars().map(|c| if c.is_control() { '\0' } else { c }).collect());
    }
    let mut out = Vec::new();
    for t in texts {
        for seg in t.split('\0') {
            let lower = seg.to_lowercase();
            if let (Some(end), Some(start)) = (lower.find(".ahk"), lower.find(":\\")) {
                if start >= 1 && end > start {
                    let p = seg[start - 1..end + 4].to_string();
                    if !out.contains(&p) {
                        out.push(p);
                    }
                }
            }
        }
    }
    out
}

fn walk(dir: &Path, depth: u8, ext: &str, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            let name = e.file_name().to_string_lossy().to_lowercase();
            if depth > 0 && !name.starts_with('.') && name != "node_modules" {
                walk(&p, depth - 1, ext, out);
            }
        } else if p.extension().map(|x| x.eq_ignore_ascii_case(ext)).unwrap_or(false) {
            out.push(p);
        }
        if out.len() > 500 {
            return;
        }
    }
}

fn read_small(p: &Path, max: u64) -> Option<String> {
    if p.metadata().ok()?.len() > max {
        return None;
    }
    let bytes = std::fs::read(p).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn names(dir: &Path, ext: &str) -> Vec<String> {
    let mut v = Vec::new();
    walk(dir, 0, ext, &mut v);
    let mut n: Vec<String> = v.iter().filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned())).collect();
    n.sort();
    n
}

fn ahk_running() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("tasklist")
            .args(["/FO", "CSV", "/NH"])
            .creation_flags(0x0800_0000)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("autohotkey"))
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    false
}

pub fn scan() -> Scan {
    // AutoHotkey: scripts mentioning the GoXLR, plus whatever the Startup folder launches.
    let mut startup: Vec<(PathBuf, String)> = Vec::new();
    if let Some(sd) = startup_dir() {
        if let Ok(rd) = std::fs::read_dir(&sd) {
            for e in rd.flatten() {
                let p = e.path();
                let ext = p.extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
                if ext == "ahk" {
                    startup.push((p.clone(), p.display().to_string()));
                } else if ext == "lnk" {
                    if let Ok(b) = std::fs::read(&p) {
                        for t in ahk_paths_in_lnk(&b) {
                            startup.push((PathBuf::from(t), p.display().to_string()));
                        }
                    }
                }
            }
        }
    }
    let mut candidates: Vec<PathBuf> = startup.iter().map(|(p, _)| p.clone()).collect();
    for d in documents_dirs() {
        walk(&d, 3, "ahk", &mut candidates);
    }
    let mut ahk = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for p in candidates {
        let key = p.display().to_string().to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        let Some(text) = read_small(&p, 1024 * 1024) else { continue };
        let entry = startup.iter().find(|(sp, _)| sp == &p).map(|(_, e)| e.clone());
        if !text.to_lowercase().contains("goxlr") && entry.is_none() {
            continue;
        }
        ahk.push(AhkScript { path: p.display().to_string(), text, autostart: entry.is_some(), startup_entry: entry });
    }

    // TC-Helicon's own app keeps profiles under Documents\GoXLR.
    let mut tc = TcHelicon::default();
    for base in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(b) = env_path(base) {
            if b.join("TC-Helicon").join("GoXLR").is_dir() {
                tc.installed = true;
            }
        }
    }
    for d in documents_dirs() {
        let g = d.join("GoXLR");
        if g.is_dir() {
            tc.profiles = names(&g.join("Profiles"), "goxlr");
            tc.mic_profiles = names(&g.join("Mic Profiles"), "goxlrMicProfile");
            tc.dir = Some(g.display().to_string());
            break;
        }
    }

    let mut apo = ApoInfo::default();
    if let Some(dir) = crate::apo::original_config_dir() {
        let root = dir.parent().map(Path::to_path_buf).unwrap_or_else(|| dir.clone());
        apo.peace_installed = root.join("Peace.exe").exists() || dir.join("Peace.exe").exists();
        apo.peace_txt = read_small(&dir.join("peace.txt"), 512 * 1024);
        let mut files = Vec::new();
        walk(&dir, 2, "txt", &mut files);
        apo.preset_files = files.len();
        apo.config_dir = Some(dir.display().to_string());
    }

    Scan { ahk, ahk_running: ahk_running(), tc_helicon: tc, apo, backup_root: backup_root().display().to_string() }
}

const MAX_FILE: u64 = 100 * 1024 * 1024;
const MAX_TOTAL: u64 = 1024 * 1024 * 1024;

fn copy_tree(src: &Path, dst: &Path, depth: u8, total: &mut u64, count: &mut usize) {
    let Ok(rd) = std::fs::read_dir(src) else { return };
    let _ = std::fs::create_dir_all(dst);
    for e in rd.flatten() {
        let p = e.path();
        let target = dst.join(e.file_name());
        if p.is_dir() {
            if depth > 0 {
                copy_tree(&p, &target, depth - 1, total, count);
            }
            continue;
        }
        let len = p.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
        if len > MAX_FILE || *total + len > MAX_TOTAL {
            continue;
        }
        if std::fs::copy(&p, &target).is_ok() {
            *total += len;
            *count += 1;
        }
    }
}

#[derive(Serialize)]
pub struct BackupResult {
    pub path: String,
    pub files: usize,
    pub bytes: u64,
}

/// Copies the old setup into %APPDATA%\GoXLR Studio\backup\<timestamp>.
/// `goxlr_dirs` are GoXLR Utility's folders as reported by the daemon; `studio_json` is the app's own settings.
pub fn backup(stamp: &str, goxlr_dirs: Vec<(String, String)>, studio_json: &str) -> Result<BackupResult, String> {
    if stamp.is_empty() || stamp.contains(['\\', '/', '.', ':']) {
        return Err("Ugyldigt navn".into());
    }
    let root = backup_root().join(stamp);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let (mut total, mut count) = (0u64, 0usize);
    let scan = scan();
    if let Some(dir) = &scan.apo.config_dir {
        copy_tree(Path::new(dir), &root.join("Equalizer APO config"), 4, &mut total, &mut count);
    }
    if let Some(dir) = &scan.tc_helicon.dir {
        copy_tree(Path::new(dir), &root.join("TC-Helicon GoXLR"), 3, &mut total, &mut count);
    }
    for (label, dir) in goxlr_dirs {
        let safe: String = label.chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-').collect();
        copy_tree(Path::new(&dir), &root.join("GoXLR Utility").join(safe), 3, &mut total, &mut count);
    }
    // GoXLR Utility's own settings (also used by GoXLR Studio's built-in GoXLR engine).
    if let Some(cfg) = env_path("APPDATA").map(|a| a.join("GoXLR-on-Linux").join("GoXLR-Utility")) {
        copy_tree(&cfg, &root.join("GoXLR Utility").join("settings"), 4, &mut total, &mut count);
    }
    let ahk_dir = root.join("AutoHotkey");
    for s in &scan.ahk {
        let _ = std::fs::create_dir_all(&ahk_dir);
        let name = Path::new(&s.path).file_name().map(|n| n.to_owned()).unwrap_or_default();
        if std::fs::write(ahk_dir.join(name), &s.text).is_ok() {
            count += 1;
        }
    }
    std::fs::write(root.join("GoXLR Studio settings.json"), studio_json).map_err(|e| e.to_string())?;
    std::fs::write(
        root.join("LÆS MIG.txt"),
        "Backup lavet af GoXLR Studio før afinstallation af gamle programmer.\r\n\
         - Equalizer APO config: hele APO's config-mappe (inkl. Peace-presets og config.txt).\r\n\
         - GoXLR Utility: profiler, mikrofonprofiler, presets, samples og indstillinger.\r\n\
         - TC-Helicon GoXLR: profiler fra TC-Helicons egen app (hvis fundet).\r\n\
         - AutoHotkey: dine scripts.\r\n\
         - GoXLR Studio settings.json: kan gendannes under Indstillinger > Backup.\r\n",
    )
    .map_err(|e| e.to_string())?;
    Ok(BackupResult { path: root.display().to_string(), files: count + 2, bytes: total })
}

/// Copies TC-Helicon app profiles into GoXLR Utility's folders without overwriting.
pub fn copy_profiles(files: Vec<String>, dest: String) -> Result<usize, String> {
    let dest = PathBuf::from(dest);
    if !dest.is_dir() {
        return Err("GoXLR Utility's profilmappe findes ikke".into());
    }
    let mut n = 0;
    for f in files {
        let p = PathBuf::from(&f);
        let ok_ext = p.extension().map(|x| x.eq_ignore_ascii_case("goxlr") || x.eq_ignore_ascii_case("goxlrMicProfile")).unwrap_or(false);
        let Some(name) = p.file_name() else { continue };
        if !ok_ext || dest.join(name).exists() {
            continue;
        }
        if std::fs::copy(&p, dest.join(name)).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

/// Moves an AutoHotkey startup entry into the backup folder so it no longer starts with Windows.
pub fn disable_startup(entry: String) -> Result<String, String> {
    let p = PathBuf::from(&entry);
    let sd = startup_dir().ok_or("Fandt ikke Startup-mappen")?;
    if p.parent() != Some(sd.as_path()) {
        return Err("Kun genveje i Startup-mappen kan slås fra her".into());
    }
    let dest_dir = backup_root().join("autostart-slået-fra");
    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(p.file_name().ok_or("Ugyldig sti")?);
    std::fs::rename(&p, &dest).or_else(|_| std::fs::copy(&p, &dest).and_then(|_| std::fs::remove_file(&p))).map_err(|e| e.to_string())?;
    Ok(dest.display().to_string())
}

/// Ends running AutoHotkey processes (so their hotkeys are freed for GoXLR Studio).
pub fn stop_ahk() -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        for im in ["AutoHotkey.exe", "AutoHotkey64.exe", "AutoHotkey32.exe", "AutoHotkeyU64.exe", "AutoHotkeyU32.exe", "AutoHotkeyA32.exe"] {
            let _ = std::process::Command::new("taskkill").args(["/IM", im, "/F"]).creation_flags(0x0800_0000).output();
        }
        Ok(())
    }
    #[cfg(not(windows))]
    Err("Kun på Windows".into())
}

pub fn open_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err("Mappen findes ikke".into());
    }
    std::process::Command::new("explorer").arg(p).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[test]
    fn finds_ahk_in_lnk() {
        let mut b = vec![0u8, 1, 2];
        b.extend("C:\\Users\\x\\Documents\\goxlr.ahk".bytes());
        b.push(0);
        for u in "D:\\Scripts\\hot keys.ahk".encode_utf16() {
            b.extend(u.to_le_bytes());
        }
        let v = super::ahk_paths_in_lnk(&b);
        assert!(v.iter().any(|p| p == "C:\\Users\\x\\Documents\\goxlr.ahk"));
        assert!(v.iter().any(|p| p == "D:\\Scripts\\hot keys.ahk"));
    }
}

// ---------------------------------------------------------------------------------------------
// Installed programs related to the old setup, with their uninstallers.
// ---------------------------------------------------------------------------------------------
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct InstalledApp {
    pub key: String,
    pub name: String,
    pub publisher: String,
    pub version: String,
    /// "replace" = GoXLR Studio does this now, "keep" = must stay (driver), "engine" = handled by
    /// the EQ-engine switch, "check" = only remove if not used for anything else.
    pub category: String,
    pub note: String,
    #[serde(skip)]
    pub uninstall: String,
}

/// Classifies an uninstall entry by its display name; None = unrelated program.
pub fn classify(name: &str) -> Option<(&'static str, &'static str)> {
    let n = name.to_lowercase();
    if n.contains("goxlr studio") {
        return None;
    }
    if (n.contains("goxlr") || n.contains("tc-helicon")) && n.contains("driver") {
        return Some(("keep", "Driveren får GoXLR'en til at virke som lydkort i Windows. Den skal blive."));
    }
    if n.contains("goxlr utility") {
        return Some(("replace", "GoXLR Studio har sin egen GoXLR-motor. Dine profiler bliver liggende."));
    }
    // Peace's entry is called "Peace Equalizer, interface Equalizer APO", so check it first.
    if n.starts_with("peace") || n.contains("peace equalizer") {
        return Some(("replace", "GoXLR Studio har EQ, presets og genveje. Importér presets først."));
    }
    if n.contains("equalizer apo") {
        return Some(("engine", "Erstattes af GoXLR Studios indbyggede EQ-motor (under Afspilnings-EQ)."));
    }
    if n.contains("autohotkey") {
        return Some(("check", "Genvejene er flyttet til GoXLR Studio. Afinstallér kun, hvis du ikke bruger andre AutoHotkey-scripts."));
    }
    if n.contains("goxlr") || n.contains("tc-helicon") {
        return Some(("check", "TC-Helicons egen app. Fjern den kun, hvis driveren står som et separat program på listen."));
    }
    None
}

/// Parses `reg query <Uninstall> /s` output into (key, values) blocks.
fn parse_reg_blocks(text: &str) -> Vec<(String, Vec<(String, String)>)> {
    let mut out: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for line in text.lines() {
        if line.starts_with("HKEY_") {
            out.push((line.trim().to_string(), Vec::new()));
        } else if let Some((_, vals)) = out.last_mut() {
            let t = line.trim();
            for ty in ["REG_SZ", "REG_EXPAND_SZ", "REG_DWORD"] {
                let sep = format!("    {ty}    ");
                if let Some(i) = line.find(&sep) {
                    vals.push((line[..i].trim().to_string(), line[i + sep.len()..].trim().to_string()));
                    break;
                }
                if t.ends_with(ty) {
                    vals.push((t[..t.len() - ty.len()].trim().to_string(), String::new()));
                    break;
                }
            }
        }
    }
    out
}

pub fn installed_apps() -> Vec<InstalledApp> {
    let roots = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    let mut apps: Vec<InstalledApp> = Vec::new();
    for root in roots {
        #[allow(unused_mut)]
        let mut cmd = std::process::Command::new("reg");
        cmd.args(["query", root, "/s"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let Ok(out) = cmd.output() else { continue };
        for (key, vals) in parse_reg_blocks(&String::from_utf8_lossy(&out.stdout)) {
            let get = |k: &str| vals.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.clone()).unwrap_or_default();
            let name = get("DisplayName");
            let uninstall = get("UninstallString");
            if name.is_empty() || uninstall.is_empty() || get("SystemComponent") == "0x1" {
                continue;
            }
            let Some((category, note)) = classify(&name) else { continue };
            if apps.iter().any(|a| a.name == name) {
                continue;
            }
            apps.push(InstalledApp { key, name, publisher: get("Publisher"), version: get("DisplayVersion"), category: category.into(), note: note.into(), uninstall });
        }
    }
    apps.sort_by(|a, b| a.category.cmp(&b.category).then(a.name.cmp(&b.name)));
    apps
}

/// Splits an UninstallString into program and arguments.
pub fn split_command(cmd: &str) -> (String, String) {
    let c = cmd.trim();
    if let Some(rest) = c.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return (rest[..end].to_string(), rest[end + 1..].trim().to_string());
        }
    }
    let lower = c.to_lowercase();
    if let Some(i) = lower.find(".exe") {
        return (c[..i + 4].to_string(), c[i + 4..].trim().to_string());
    }
    (c.to_string(), String::new())
}

/// Starts the vendor's own uninstaller (it asks for confirmation and admin rights itself).
pub fn run_uninstaller(key: &str) -> Result<String, String> {
    let app = installed_apps().into_iter().find(|a| a.key == key).ok_or("Programmet findes ikke længere")?;
    if app.category == "keep" {
        return Err("Driveren skal blive installeret".into());
    }
    let (program, args) = split_command(&app.uninstall);
    let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
    let script = if args.is_empty() {
        format!("Start-Process -FilePath {}", q(&program))
    } else {
        format!("Start-Process -FilePath {} -ArgumentList {}", q(&program), q(&args))
    };
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let st = cmd.status().map_err(|e| e.to_string())?;
    if !st.success() {
        return Err(format!("Kunne ikke starte afinstallationen af {}", app.name));
    }
    Ok(app.name)
}

#[cfg(test)]
mod app_tests {
    use super::*;

    #[test]
    fn classifies_old_programs() {
        assert_eq!(classify("TC-Helicon GoXLR Driver").unwrap().0, "keep");
        assert_eq!(classify("GoXLR Utility").unwrap().0, "replace");
        assert_eq!(classify("Equalizer APO").unwrap().0, "engine");
        assert_eq!(classify("Peace Equalizer, interface Equalizer APO").unwrap().0, "replace");
        assert_eq!(classify("AutoHotkey 2.0.18").unwrap().0, "check");
        assert!(classify("GoXLR Studio").is_none());
        assert!(classify("Google Chrome").is_none());
    }

    #[test]
    fn parses_reg_output_and_commands() {
        let text = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\EqualizerAPO\r\n    DisplayName    REG_SZ    Equalizer APO\r\n    UninstallString    REG_SZ    \"C:\\Program Files\\EqualizerAPO\\Uninstall.exe\"\r\n    NoModify    REG_DWORD    0x1\r\n";
        let b = parse_reg_blocks(text);
        assert_eq!(b.len(), 1);
        assert!(b[0].1.iter().any(|(k, v)| k == "DisplayName" && v == "Equalizer APO"));
        assert_eq!(split_command("\"C:\\Program Files\\X\\un.exe\" /S"), ("C:\\Program Files\\X\\un.exe".into(), "/S".into()));
        assert_eq!(split_command("MsiExec.exe /X{ABC}"), ("MsiExec.exe".into(), "/X{ABC}".into()));
    }
}
