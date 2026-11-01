//! Output EQ engine backed by Equalizer APO's audio processing object.
//! The app writes its filters to a file under ProgramData; APO's config.txt only needs one Include line.
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Deserialize, Debug, Clone)]
pub struct Band {
    pub enabled: bool,
    #[serde(rename = "type")]
    pub kind: String,
    pub freq: f64,
    pub gain: f64,
    pub q: f64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct OutputEq {
    pub enabled: bool,
    pub preamp: f64,
    pub bands: Vec<Band>,
    pub target: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct DeviceApo {
    pub id: String,
    pub name: String,
    pub apo: bool,
}

#[derive(Serialize, Default)]
pub struct EngineStatus {
    pub devices: Vec<DeviceApo>,
    pub available: bool,
    pub running: bool,
    pub apo_installed: bool,
    pub taken_over: bool,
    pub device: Option<String>,
    pub latency_ms: Option<f64>,
    pub reason: Option<String>,
    pub config_dir: Option<String>,
}

const INCLUDE_FILE: &str = "GoXLR Studio.txt";
const BACKUP_SUFFIX: &str = ".goxlr-studio-backup";

pub fn studio_dir() -> PathBuf {
    let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    base.join("GoXLR Studio")
}

fn eq_file() -> PathBuf {
    studio_dir().join(INCLUDE_FILE)
}

#[cfg(windows)]
pub fn apo_config_dir() -> Option<PathBuf> {
    use windows::core::w;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ};
    let mut buf = vec![0u16; 1024];
    let mut len = (buf.len() * 2) as u32;
    let res = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            w!(r"SOFTWARE\EqualizerAPO"),
            w!("ConfigPath"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    let path = if res.is_ok() {
        let n = (len as usize / 2).saturating_sub(1);
        PathBuf::from(String::from_utf16_lossy(&buf[..n]))
    } else {
        PathBuf::from(r"C:\Program Files\EqualizerAPO\config")
    };
    path.is_dir().then_some(path)
}

#[cfg(not(windows))]
pub fn apo_config_dir() -> Option<PathBuf> {
    None
}

fn include_line() -> String {
    format!("Include: {}", eq_file().display())
}

fn is_taken_over(dir: &std::path::Path) -> bool {
    std::fs::read_to_string(dir.join("config.txt"))
        .map(|t| t.lines().any(|l| l.trim() == include_line()))
        .unwrap_or(false)
}

pub fn render(eq: &OutputEq, device_name: Option<&str>) -> String {
    let mut out = String::from("# Skrevet af GoXLR Studio – rediger i appen, ikke her.\n");
    match (eq.target.as_deref(), device_name) {
        (Some(id), _) if id.contains('{') => {
            // Endpoint ids end in the device GUID, which APO's Device: selector matches.
            let guid = &id[id.rfind('{').unwrap_or(0)..];
            out.push_str(&format!("Device: {guid}\n"));
        }
        (_, Some(name)) => out.push_str(&format!("Device: {name}\n")),
        _ => out.push_str("Device: all\n"),
    }
    if !eq.enabled {
        return out;
    }
    out.push_str(&format!("Preamp: {:.1} dB\n", eq.preamp));
    for b in eq.bands.iter().filter(|b| b.enabled) {
        let kind = match b.kind.as_str() {
            "HP" => "HPQ",
            "LP" => "LPQ",
            k => k,
        };
        let has_gain = matches!(b.kind.as_str(), "PK" | "LSC" | "HSC");
        let gain = if has_gain { format!(" Gain {:.1} dB", b.gain) } else { String::new() };
        out.push_str(&format!("Filter: ON {kind} Fc {:.1} Hz{gain} Q {:.3}\n", b.freq, b.q));
    }
    out
}

pub fn apply(eq: &OutputEq) -> Result<(), String> {
    let dir = studio_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = eq.target.as_deref().and_then(crate::audio::name_of);
    let text = render(eq, name.as_deref());
    let tmp = dir.join("eq.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, eq_file()).map_err(|e| e.to_string())
}

fn hidden_command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd
}

fn reg_query(key: &str) -> String {
    hidden_command("reg")
        .args(["query", key, "/s"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase())
        .unwrap_or_default()
}

// Equalizer APO's effect CLSID as written into an endpoint's FxProperties by its Configurator.
const APO_CLSIDS: [&str; 2] = ["eacd2258-fcac-4ff4-b36d-419e924a6d79", "ec1cc9ce-faed-4822-828a-82a81a6f018f"];

/// Which active output devices Equalizer APO is attached to.
pub fn device_apo_status() -> Vec<DeviceApo> {
    let child = reg_query(r"HKLM\SOFTWARE\EqualizerAPO\Child APOs");
    crate::audio::list()
        .unwrap_or_default()
        .into_iter()
        .filter(|d| d.flow == "render")
        .map(|d| {
            let guid = d.id[d.id.rfind('{').unwrap_or(0)..].to_lowercase();
            let fx = reg_query(&format!(r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render\{guid}\FxProperties"));
            let apo = APO_CLSIDS.iter().any(|c| fx.contains(c)) || child.contains(&guid);
            DeviceApo { id: d.id, name: d.name, apo }
        })
        .collect()
}

pub fn open_configurator() -> Result<(), String> {
    let dir = apo_config_dir().ok_or("Equalizer APO er ikke installeret")?;
    let exe = dir.parent().unwrap_or(&dir).join("Configurator.exe");
    if !exe.exists() {
        return Err(format!("Fandt ikke {}", exe.display()));
    }
    let arg = format!("Start-Process -Verb RunAs -FilePath '{}'", exe.display().to_string().replace('\'', "''"));
    hidden_command("powershell").args(["-NoProfile", "-Command", &arg]).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn status() -> EngineStatus {
    let Some(dir) = apo_config_dir() else {
        return EngineStatus {
            reason: Some("Equalizer APO's lydmotor er ikke installeret. Installer den (kun motoren – du behøver aldrig åbne den) for at aktivere afspilnings-EQ.".into()),
            ..Default::default()
        };
    };
    let taken = is_taken_over(&dir);
    EngineStatus {
        devices: device_apo_status(),
        available: true,
        apo_installed: true,
        taken_over: taken,
        running: taken,
        latency_ms: Some(0.0),
        reason: (!taken).then(|| "Klar. Tryk \"Overtag APO\" én gang – din nuværende APO-opsætning gemmes som backup.".into()),
        config_dir: Some(dir.display().to_string()),
        device: None,
    }
}

pub fn read_current_config() -> Result<String, String> {
    let dir = apo_config_dir().ok_or("Equalizer APO er ikke installeret")?;
    let main = dir.join("config.txt");
    let backup = dir.join(format!("config.txt{BACKUP_SUFFIX}"));
    let src = if is_taken_over(&dir) && backup.exists() { backup } else { main };
    let mut out = String::new();
    expand(&src, &dir, &mut out, 0)?;
    Ok(out)
}

fn expand(file: &std::path::Path, base: &std::path::Path, out: &mut String, depth: u8) -> Result<(), String> {
    if depth > 8 {
        return Ok(());
    }
    let text = std::fs::read_to_string(file).map_err(|e| format!("{}: {e}", file.display()))?;
    out.push_str(&format!("# ---- {} ----\n", file.display()));
    for line in text.lines() {
        if let Some(rest) = line.trim().strip_prefix("Include:") {
            let p = PathBuf::from(rest.trim());
            let p = if p.is_absolute() { p } else { base.join(p) };
            let _ = expand(&p, p.parent().unwrap_or(base), out, depth + 1);
        } else {
            out.push_str(line);
            out.push('\n');
        }
    }
    Ok(())
}

/// Points APO's config.txt at our file (or restores the backup). Needs one UAC prompt.
#[cfg(windows)]
pub fn takeover(enable: bool) -> Result<(), String> {
    use base64::Engine;
    let dir = apo_config_dir().ok_or("Equalizer APO er ikke installeret")?;
    std::fs::create_dir_all(studio_dir()).map_err(|e| e.to_string())?;
    if !eq_file().exists() {
        std::fs::write(eq_file(), "Device: all\n").map_err(|e| e.to_string())?;
    }
    let cfg = dir.join("config.txt");
    let bak = dir.join(format!("config.txt{BACKUP_SUFFIX}"));
    let ps_str = |p: &std::path::Path| p.display().to_string().replace('\'', "''");
    let script = if enable {
        format!(
            "$c='{c}'; $b='{b}'; if (-not (Test-Path $b)) {{ Copy-Item $c $b -Force }}; Set-Content -Path $c -Value '{inc}' -Encoding UTF8",
            c = ps_str(&cfg),
            b = ps_str(&bak),
            inc = include_line().replace('\'', "''")
        )
    } else {
        format!("$c='{c}'; $b='{b}'; if (Test-Path $b) {{ Copy-Item $b $c -Force; Remove-Item $b -Force }}", c = ps_str(&cfg), b = ps_str(&bak))
    };
    let utf16: Vec<u8> = script.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(utf16);
    let outer = format!(
        "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','{encoded}'"
    );
    let status = hidden_command("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &outer])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Handlingen blev annulleret".into());
    }
    if is_taken_over(&dir) != enable {
        return Err("APO-konfigurationen blev ikke ændret (UAC afvist?)".into());
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn takeover(_enable: bool) -> Result<(), String> {
    Err("Kun på Windows".into())
}

#[derive(Serialize)]
pub struct ConfigFile {
    pub name: String,
    pub text: String,
}

/// Every Peace/APO preset file in the config folder (Peace saves presets as .txt there).
pub fn list_configs() -> Result<Vec<ConfigFile>, String> {
    let dir = apo_config_dir().ok_or("Equalizer APO er ikke installeret")?;
    let mut out = Vec::new();
    let mut stack = vec![dir.clone()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                if stack.len() < 32 {
                    stack.push(p);
                }
                continue;
            }
            let is_txt = p.extension().map(|x| x.eq_ignore_ascii_case("txt")).unwrap_or(false);
            let name = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if !is_txt || name.eq_ignore_ascii_case("config") || p.metadata().map(|m| m.len() > 512 * 1024).unwrap_or(true) {
                continue;
            }
            let rel = p.strip_prefix(&dir).unwrap_or(&p).with_extension("");
            if let Ok(text) = std::fs::read_to_string(&p) {
                out.push(ConfigFile { name: rel.display().to_string(), text });
            }
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}
