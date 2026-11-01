//! Lydbanken: sound files in %APPDATA%\GoXLR Studio\sounds. The UI plays them on the GoXLR's
//! "Sample" output, so with the GoXLR's routing they reach Discord and the stream – also on a
//! GoXLR Mini, which has no sampler of its own.
use base64::Engine;
use serde::Serialize;
use std::path::PathBuf;

const EXTENSIONS: &[&str] = &["mp3", "wav", "ogg", "oga", "opus", "flac", "m4a", "aac", "webm"];
const MAX_BYTES: usize = 20 * 1024 * 1024;

#[derive(Serialize, Debug, PartialEq)]
pub struct SoundFile {
    /// File name in the sounds folder.
    pub file: String,
    /// Shown name (file name without extension).
    pub name: String,
    pub size: u64,
}

pub fn dir() -> PathBuf {
    std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("GoXLR Studio").join("sounds")
}

/// A file name that is safe inside the sounds folder and is an audio file; None otherwise.
pub fn safe_file(name: &str) -> Option<String> {
    let base = name.rsplit(['\\', '/']).next()?.trim();
    let cleaned: String = base.chars().filter(|c| !c.is_control() && !matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')).collect();
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    let ext = cleaned.rsplit_once('.')?.1.to_lowercase();
    if cleaned.len() > 120 || cleaned.starts_with('.') || !EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }
    Some(cleaned)
}

fn existing(file: &str) -> Result<PathBuf, String> {
    let f = safe_file(file).filter(|f| f == file).ok_or("Ugyldigt filnavn")?;
    let p = dir().join(f);
    if !p.is_file() {
        return Err("Lyden findes ikke længere".into());
    }
    Ok(p)
}

pub fn list() -> Vec<SoundFile> {
    let mut out: Vec<SoundFile> = std::fs::read_dir(dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let file = e.file_name().to_string_lossy().into_owned();
            safe_file(&file).filter(|f| *f == file)?;
            let size = e.metadata().ok()?.len();
            let name = file.rsplit_once('.').map(|(n, _)| n.to_string()).unwrap_or_else(|| file.clone());
            Some(SoundFile { file, name, size })
        })
        .collect();
    out.sort_by_key(|s| s.name.to_lowercase());
    out
}

/// Saves a sound (base64 from the UI); an existing name gets " (2)", " (3)" …
pub fn save(name: &str, data_b64: &str) -> Result<String, String> {
    let file = safe_file(name).ok_or("Kun lydfiler (mp3, wav, ogg, opus, flac, m4a, aac, webm)")?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64.trim()).map_err(|_| "Filen kunne ikke læses")?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("Lyden må højst fylde 20 MB".into());
    }
    let d = dir();
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    let (stem, ext) = file.rsplit_once('.').map(|(s, e)| (s.to_string(), e.to_string())).unwrap_or((file.clone(), String::new()));
    let mut target = file.clone();
    for n in 2.. {
        if !d.join(&target).exists() {
            break;
        }
        target = format!("{stem} ({n}).{ext}");
    }
    std::fs::write(d.join(&target), bytes).map_err(|e| e.to_string())?;
    Ok(target)
}

pub fn read(file: &str) -> Result<String, String> {
    let bytes = std::fs::read(existing(file)?).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

pub fn delete(file: &str) -> Result<(), String> {
    std::fs::remove_file(existing(file)?).map_err(|e| e.to_string())
}

/// Renames a sound (the extension stays).
pub fn rename(file: &str, new_name: &str) -> Result<String, String> {
    let from = existing(file)?;
    let ext = file.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    let target = safe_file(&format!("{}.{ext}", new_name.trim())).ok_or("Ugyldigt navn")?;
    if target != file && dir().join(&target).exists() {
        return Err("Der findes allerede en lyd med det navn".into());
    }
    std::fs::rename(from, dir().join(&target)).map_err(|e| e.to_string())?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_audio_files_with_safe_names() {
        assert_eq!(safe_file("Airhorn.mp3").as_deref(), Some("Airhorn.mp3"));
        assert_eq!(safe_file(r"C:\Users\x\Downloads\Ba dum tss.WAV").as_deref(), Some("Ba dum tss.WAV"));
        assert_eq!(safe_file("../../evil.mp3").as_deref(), Some("evil.mp3"));
        assert_eq!(safe_file("Hej?:*.ogg").as_deref(), Some("Hej.ogg"));
        assert_eq!(safe_file("virus.exe"), None);
        assert_eq!(safe_file(".mp3"), None);
        assert_eq!(safe_file("noext"), None);
    }
}
