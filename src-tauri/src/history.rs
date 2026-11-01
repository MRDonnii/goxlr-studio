//! Profilhistorik: earlier versions of the GoXLR profiles (.goxlr) and mic profiles
//! (.goxlrMicProfile), kept in %APPDATA%\GoXLR Studio\profile-history\<kind>\<name>\<time>.<ext>.
//! A version is saved whenever a profile file differs from its newest version (the UI asks every few
//! minutes and after "Gem"); the 30 newest per profile are kept. Restoring saves the current file
//! as a version first, so a restore can itself be undone.
use serde::Serialize;
use std::path::{Path, PathBuf};

pub const KEEP: usize = 30;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Version {
    /// File name in the history folder ("20261102-003512.goxlr").
    pub file: String,
    /// "2026-11-02 00:35:12".
    pub at: String,
    pub size: u64,
}

pub fn root() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("GoXLR Studio").join("profile-history")
}

fn ext_of(kind: &str) -> Option<&'static str> {
    match kind {
        "profile" => Some("goxlr"),
        "mic" => Some("goxlrMicProfile"),
        _ => None,
    }
}

/// A profile name that can't leave its folder.
fn safe_name(name: &str) -> Option<String> {
    let n = name.trim();
    (!n.is_empty() && !n.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']) && n != "." && n != "..").then(|| n.to_string())
}

fn versions_dir(root: &Path, kind: &str, name: &str) -> Option<PathBuf> {
    ext_of(kind)?;
    Some(root.join(kind).join(safe_name(name)?))
}

/// Versions of one profile, newest first.
pub fn list_in(root: &Path, kind: &str, name: &str) -> Vec<Version> {
    let Some(dir) = versions_dir(root, kind, name) else { return Vec::new() };
    let ext = ext_of(kind).unwrap_or_default();
    let mut out: Vec<Version> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            let stamp = file.strip_suffix(&format!(".{ext}"))?;
            let at = stamp_text(stamp)?;
            Some(Version { file, at, size: e.metadata().ok()?.len() })
        })
        .collect();
    out.sort_by(|a, b| b.file.cmp(&a.file));
    out
}

/// "20261102-003512" (optionally "-2") → "2026-11-02 00:35:12".
fn stamp_text(s: &str) -> Option<String> {
    let b = s.as_bytes();
    if b.len() < 15 || b[8] != b'-' || !s[..8].chars().all(|c| c.is_ascii_digit()) || !s[9..15].chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(format!("{}-{}-{} {}:{}:{}", &s[0..4], &s[4..6], &s[6..8], &s[9..11], &s[11..13], &s[13..15]))
}

/// Saves the file as a new version if it differs from the newest one. Returns the version saved.
pub fn save_version(root: &Path, kind: &str, name: &str, file: &Path, stamp: &str) -> Result<Option<String>, String> {
    let dir = versions_dir(root, kind, name).ok_or("Ugyldigt profilnavn")?;
    let ext = ext_of(kind).ok_or("Ukendt profiltype")?;
    let data = std::fs::read(file).map_err(|e| e.to_string())?;
    if let Some(newest) = list_in(root, kind, name).first() {
        if std::fs::read(dir.join(&newest.file)).ok().as_deref() == Some(&data[..]) {
            return Ok(None);
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut target = format!("{stamp}.{ext}");
    for n in 2.. {
        if !dir.join(&target).exists() {
            break;
        }
        target = format!("{stamp}-{n}.{ext}");
    }
    std::fs::write(dir.join(&target), data).map_err(|e| e.to_string())?;
    // Only the newest are kept.
    for old in list_in(root, kind, name).into_iter().skip(KEEP) {
        let _ = std::fs::remove_file(dir.join(old.file));
    }
    Ok(Some(target))
}

/// Saves a version of every profile in the folder that changed. Returns how many were saved.
pub fn snapshot_dir(root: &Path, kind: &str, folder: &Path, stamp: &str) -> usize {
    let Some(ext) = ext_of(kind) else { return 0 };
    std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension()?.to_str()? != ext {
                return None;
            }
            let name = p.file_stem()?.to_string_lossy().into_owned();
            save_version(root, kind, &name, &p, stamp).ok().flatten()
        })
        .count()
}

/// Puts a version back as the profile file (the current file is saved as a version first).
pub fn restore_in(root: &Path, kind: &str, name: &str, version: &str, folder: &Path, stamp: &str) -> Result<(), String> {
    let dir = versions_dir(root, kind, name).ok_or("Ugyldigt profilnavn")?;
    let ext = ext_of(kind).ok_or("Ukendt profiltype")?;
    if version.contains(['/', '\\']) || !version.ends_with(&format!(".{ext}")) {
        return Err("Ugyldig version".into());
    }
    let src = dir.join(version);
    let data = std::fs::read(&src).map_err(|_| "Versionen findes ikke længere".to_string())?;
    let target = folder.join(format!("{}.{ext}", safe_name(name).ok_or("Ugyldigt profilnavn")?));
    if target.exists() {
        save_version(root, kind, name, &target, stamp)?;
    }
    std::fs::write(&target, data).map_err(|e| e.to_string())
}

pub fn stamp_now() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

pub fn snapshot(profiles: &str, mics: &str) -> usize {
    let (r, s) = (root(), stamp_now());
    let mut n = 0;
    if !profiles.is_empty() {
        n += snapshot_dir(&r, "profile", Path::new(profiles), &s);
    }
    if !mics.is_empty() {
        n += snapshot_dir(&r, "mic", Path::new(mics), &s);
    }
    n
}

pub fn list(kind: &str, name: &str) -> Vec<Version> {
    list_in(&root(), kind, name)
}

pub fn restore(kind: &str, name: &str, version: &str, folder: &str) -> Result<(), String> {
    restore_in(&root(), kind, name, version, Path::new(folder), &stamp_now())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_kept_restored_and_pruned() {
        let base = std::env::temp_dir().join(format!("goxlr-history-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (root, folder) = (base.join("history"), base.join("profiles"));
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("Headset.goxlr");
        std::fs::write(&file, b"v1").unwrap();
        assert_eq!(snapshot_dir(&root, "profile", &folder, "20261102-000001"), 1);
        // Unchanged: no new version.
        assert_eq!(snapshot_dir(&root, "profile", &folder, "20261102-000002"), 0);
        std::fs::write(&file, b"v2").unwrap();
        assert_eq!(snapshot_dir(&root, "profile", &folder, "20261102-000003"), 1);
        let v = list_in(&root, "profile", "Headset");
        assert_eq!(v.iter().map(|x| x.at.as_str()).collect::<Vec<_>>(), ["2026-11-02 00:00:03", "2026-11-02 00:00:01"]);
        // Restore v1: the current file (v2) is already a version, v1 comes back.
        restore_in(&root, "profile", "Headset", "20261102-000001.goxlr", &folder, "20261102-000004").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"v1");
        assert!(restore_in(&root, "profile", "Headset", "../x.goxlr", &folder, "s").is_err());
        assert!(list_in(&root, "profile", "../etc").is_empty());
        // Only the newest KEEP versions stay.
        for i in 0..(KEEP + 5) {
            std::fs::write(&file, format!("x{i}")).unwrap();
            save_version(&root, "profile", "Headset", &file, &format!("20261103-{:06}", i)).unwrap();
        }
        assert_eq!(list_in(&root, "profile", "Headset").len(), KEEP);
        let _ = std::fs::remove_dir_all(&base);
    }
}
