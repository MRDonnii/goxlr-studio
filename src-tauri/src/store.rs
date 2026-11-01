use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn path_for(app: &AppHandle, key: &str) -> Result<PathBuf, String> {
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Ugyldig nøgle".into());
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{key}.json")))
}

pub fn get(app: &AppHandle, key: &str) -> Result<Option<Value>, String> {
    let path = path_for(app, key)?;
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| e.to_string()),
        Err(_) => Ok(None),
    }
}

pub fn set(app: &AppHandle, key: &str, value: &Value) -> Result<(), String> {
    let path = path_for(app, key)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}
