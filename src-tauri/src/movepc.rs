//! "Flyt til ny pc": GoXLR profiles, mic profiles, presets, samples, icons and the sound bank as
//! base64 in one file (the UI adds GoXLR Studio's own settings), and back again on the new pc.
//! Only plain files at the top of each folder, with the right file types. An existing file with
//! other content is copied to %APPDATA%\GoXLR Studio\backup\<time> before it is replaced.
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const MAX_FILE: u64 = 25 * 1024 * 1024;
const MAX_TOTAL: u64 = 150 * 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MoveFile {
    pub kind: String,
    pub name: String,
    /// base64
    pub data: String,
}

#[derive(Serialize, Default, Debug)]
pub struct Collected {
    pub files: Vec<MoveFile>,
    /// "kind/name" of files left out (too big, or the total got too big).
    pub skipped: Vec<String>,
}

#[derive(Serialize, Default, Debug)]
pub struct Restored {
    pub written: usize,
    pub same: usize,
    pub skipped: Vec<String>,
    /// Folder with the files that were replaced, if any.
    pub backup: Option<String>,
}

/// The file types a kind of folder may hold.
pub fn extensions(kind: &str) -> &'static [&'static str] {
    match kind {
        "profiles" => &["goxlr"],
        "mic-profiles" => &["goxlrmicprofile"],
        "presets" => &["preset"],
        "samples" => &["wav", "mp3", "flac", "ogg"],
        "icons" => &["png", "jpg", "jpeg", "gif", "bmp"],
        "sounds" => crate::sounds::EXTENSIONS,
        _ => &[],
    }
}

/// A bare file name of an allowed type for the kind; None for anything else (paths, "..", other types).
pub fn safe_name(kind: &str, name: &str) -> Option<String> {
    let n = name.trim();
    if n.is_empty() || n.len() > 160 || n.starts_with('.') || n.chars().any(|c| c.is_control() || matches!(c, '\\' | '/' | ':' | '<' | '>' | '"' | '|' | '?' | '*')) {
        return None;
    }
    let ext = n.rsplit_once('.')?.1.to_lowercase();
    extensions(kind).contains(&ext.as_str()).then(|| n.to_string())
}

/// The folder for a kind: the sound bank is GoXLR Studio's own; the rest come from the GoXLR engine.
fn folder(kind: &str, dirs: &[(String, String)]) -> Option<PathBuf> {
    if kind == "sounds" {
        return Some(crate::sounds::dir());
    }
    dirs.iter().find(|(k, _)| k == kind).map(|(_, d)| PathBuf::from(d)).filter(|p| !p.as_os_str().is_empty())
}

pub fn collect(dirs: Vec<(String, String)>) -> Collected {
    let b64 = base64::engine::general_purpose::STANDARD;
    let mut out = Collected::default();
    let mut total = 0u64;
    let mut kinds: Vec<String> = dirs.iter().map(|(k, _)| k.clone()).collect();
    kinds.push("sounds".into());
    kinds.dedup();
    for kind in kinds {
        let Some(dir) = folder(&kind, &dirs) else { continue };
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        let mut entries: Vec<_> = rd.flatten().filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false)).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let Some(name) = e.file_name().to_str().and_then(|n| safe_name(&kind, n)) else { continue };
            let size = e.metadata().map(|m| m.len()).unwrap_or(u64::MAX);
            if size > MAX_FILE || total + size > MAX_TOTAL {
                out.skipped.push(format!("{kind}/{name}"));
                continue;
            }
            if let Ok(bytes) = std::fs::read(e.path()) {
                total += size;
                out.files.push(MoveFile { kind: kind.clone(), name, data: b64.encode(bytes) });
            }
        }
    }
    out
}

pub fn restore(files: Vec<MoveFile>, dirs: Vec<(String, String)>, stamp: &str) -> Result<Restored, String> {
    if stamp.is_empty() || stamp.contains(['\\', '/', '.', ':']) {
        return Err("Ugyldigt navn".into());
    }
    let b64 = base64::engine::general_purpose::STANDARD;
    let backup = crate::migrate::backup_root().join(format!("{stamp} før flytning"));
    let mut out = Restored::default();
    for f in files {
        let (Some(name), Some(dir)) = (safe_name(&f.kind, &f.name), folder(&f.kind, &dirs)) else {
            out.skipped.push(format!("{}/{}", f.kind, f.name));
            continue;
        };
        let Ok(bytes) = b64.decode(f.data.as_bytes()) else {
            out.skipped.push(format!("{}/{name}", f.kind));
            continue;
        };
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let target = dir.join(&name);
        if let Ok(old) = std::fs::read(&target) {
            if old == bytes {
                out.same += 1;
                continue;
            }
            let keep = backup.join(&f.kind);
            std::fs::create_dir_all(&keep).map_err(|e| e.to_string())?;
            std::fs::write(keep.join(&name), &old).map_err(|e| format!("Backup af {name}: {e}"))?;
            out.backup = Some(backup.display().to_string());
        }
        write_file(&target, &bytes).map_err(|e| format!("{name}: {e}"))?;
        out.written += 1;
    }
    Ok(out)
}

/// Write via a temporary file, so a half-written profile never replaces a good one.
fn write_file(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = target.with_extension("studio-tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, target).or_else(|_| {
        let _ = std::fs::remove_file(target);
        std::fs::rename(&tmp, target)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_bare_names_of_the_right_type() {
        assert_eq!(safe_name("profiles", "Headset.goxlr").as_deref(), Some("Headset.goxlr"));
        assert_eq!(safe_name("mic-profiles", "Standard.goxlrMicProfile").as_deref(), Some("Standard.goxlrMicProfile"));
        assert!(safe_name("profiles", "..\\..\\evil.goxlr").is_none());
        assert!(safe_name("profiles", "a/b.goxlr").is_none());
        assert!(safe_name("profiles", "run.exe").is_none());
        assert!(safe_name("sounds", "Applaus.mp3").is_some());
        assert!(safe_name("unknown", "x.goxlr").is_none());
        assert!(safe_name("profiles", ".goxlr").is_none());
    }

    #[test]
    fn restore_backs_up_what_it_replaces() {
        let root = std::env::temp_dir().join(format!("studio-move-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let prof = root.join("profiles");
        std::fs::create_dir_all(&prof).unwrap();
        std::fs::write(prof.join("A.goxlr"), b"old").unwrap();
        std::fs::write(prof.join("B.goxlr"), b"same").unwrap();
        let dirs = vec![("profiles".to_string(), prof.display().to_string())];
        let collected = collect(dirs.clone());
        assert_eq!(collected.files.iter().filter(|f| f.kind == "profiles").count(), 2);
        let b64 = base64::engine::general_purpose::STANDARD;
        let files = vec![
            MoveFile { kind: "profiles".into(), name: "A.goxlr".into(), data: b64.encode(b"new") },
            MoveFile { kind: "profiles".into(), name: "B.goxlr".into(), data: b64.encode(b"same") },
            MoveFile { kind: "profiles".into(), name: "C.goxlr".into(), data: b64.encode(b"c") },
            MoveFile { kind: "profiles".into(), name: "../x.goxlr".into(), data: b64.encode(b"x") },
        ];
        let r = restore(files, dirs, "test").unwrap();
        assert_eq!((r.written, r.same, r.skipped.len()), (2, 1, 1));
        assert_eq!(std::fs::read(prof.join("A.goxlr")).unwrap(), b"new");
        let backup = PathBuf::from(r.backup.unwrap());
        assert_eq!(std::fs::read(backup.join("profiles").join("A.goxlr")).unwrap(), b"old");
        let _ = std::fs::remove_dir_all(&backup);
        let _ = std::fs::remove_dir_all(&root);
    }
}
