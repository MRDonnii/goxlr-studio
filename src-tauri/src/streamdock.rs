//! Streonor / MiraBox StreamDock: the same plugin as for Elgato's Stream Deck (streamdeck/), with
//! the StreamDock manifest, written straight into the StreamDock app's plugin folder
//! (%APPDATA%\HotSpot\StreamDock\plugins). The app reads plugins when it starts.
use serde::Serialize;
use std::path::PathBuf;

include!(concat!(env!("OUT_DIR"), "/plugin_files.rs"));

pub const FOLDER: &str = "com.goxlrstudio.sdPlugin";
const SD_MANIFEST: &str = "manifest.streamdock.json";

#[derive(Serialize, Debug, Default)]
pub struct Info {
    /// The StreamDock app's plugin folder (it exists = the app has been installed and started once).
    pub plugins_dir: Option<String>,
    /// Version of our plugin there, if installed.
    pub installed: Option<String>,
    /// The version this app carries.
    pub bundled: String,
}

/// The files to write for StreamDock: its manifest as manifest.json, the Elgato one left out.
pub fn streamdock_files() -> Vec<(&'static str, &'static [u8])> {
    let sd = PLUGIN_FILES.iter().find(|(n, _)| *n == SD_MANIFEST).map(|(_, b)| *b);
    PLUGIN_FILES
        .iter()
        .filter(|(n, _)| *n != SD_MANIFEST)
        .map(|(n, b)| if *n == "manifest.json" { (*n, sd.unwrap_or(b)) } else { (*n, *b) })
        .collect()
}

fn manifest_version(bytes: &[u8]) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(bytes).ok()?.get("Version")?.as_str().map(String::from)
}

fn plugins_dir() -> Option<PathBuf> {
    let base = std::env::var_os("APPDATA").map(PathBuf::from)?;
    let app = base.join("HotSpot").join("StreamDock");
    app.is_dir().then(|| app.join("plugins"))
}

pub fn info() -> Info {
    let dir = plugins_dir();
    let installed = dir.as_ref().and_then(|d| std::fs::read(d.join(FOLDER).join("manifest.json")).ok()).and_then(|b| manifest_version(&b));
    let bundled = streamdock_files().iter().find(|(n, _)| *n == "manifest.json").and_then(|(_, b)| manifest_version(b)).unwrap_or_default();
    Info { plugins_dir: dir.map(|d| d.display().to_string()), installed, bundled }
}

/// Writes (or updates) the plugin; returns its folder.
pub fn install() -> Result<String, String> {
    let dir = plugins_dir().ok_or("Fandt ikke Streonor/StreamDock-programmet (mappen %APPDATA%\\HotSpot\\StreamDock). Installér og start det én gang først.")?;
    let target = dir.join(FOLDER);
    for (name, bytes) in streamdock_files() {
        let path = target.join(name);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
        }
        std::fs::write(&path, bytes).map_err(|e| format!("{name}: {e}"))?;
    }
    Ok(target.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn streamdock_gets_its_own_manifest() {
        let files = streamdock_files();
        assert!(!files.iter().any(|(n, _)| *n == SD_MANIFEST));
        let m: serde_json::Value = serde_json::from_slice(files.iter().find(|(n, _)| *n == "manifest.json").unwrap().1).unwrap();
        assert_eq!(m["SDKVersion"], 1);
        assert!(m["Actions"].as_array().unwrap().iter().any(|a| a["Controllers"].as_array().is_some_and(|c| c.iter().any(|x| x == "Knob"))));
        for need in ["plugin.html", "plugin.js", "common.js", "pi.html", "pi.js", "imgs/key-on.png", "imgs/key-on@2x.png"] {
            assert!(files.iter().any(|(n, _)| *n == need), "{need}");
        }
        assert!(!info().bundled.is_empty());
    }
}
