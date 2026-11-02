mod api;
mod apo;
mod apps;
mod audio;
mod daemon;
mod daemon_host;
mod deck;
mod driver;
mod engine;
mod history;
mod keys;
mod media;
mod meters;
mod midi;
mod migrate;
mod movepc;
mod mqtt;
mod obs;
mod osd;
mod session;
mod soundcheck;
mod sounds;
mod spectrum;
mod store;
mod update;

use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use std::collections::HashMap;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const DAEMON_URL: &str = "ws://127.0.0.1:14564/api/websocket";

#[derive(Deserialize, Clone)]
struct HotkeyBinding {
    id: String,
    accel: String,
}

#[derive(serde::Serialize)]
struct HotkeyResult {
    id: String,
    ok: bool,
    error: Option<String>,
}

#[derive(Deserialize, Clone, Default)]
struct SceneRef {
    id: String,
    name: String,
}

#[derive(Deserialize, Clone, Default)]
struct TrayModel {
    scenes: Vec<SceneRef>,
    profiles: Vec<String>,
    active_profile: Option<String>,
    eq_presets: Vec<String>,
    active_eq: Option<String>,
    eq_enabled: bool,
    /// The menu texts in the UI's language (Danish when missing).
    #[serde(default)]
    labels: HashMap<String, String>,
}

impl TrayModel {
    fn label<'a>(&'a self, key: &str, danish: &'a str) -> &'a str {
        self.labels.get(key).map(String::as_str).filter(|s| !s.is_empty()).unwrap_or(danish)
    }
}

struct AppState {
    daemon: daemon::Daemon,
    close_to_tray: AtomicBool,
    tray: Mutex<TrayModel>,
    hotkeys: Mutex<HashMap<u32, String>>,
    api: Arc<api::Api>,
    /// An action this process was started with (Stream Deck link or --action), for the UI.
    launch_action: Mutex<Option<String>>,
}

#[tauri::command]
async fn daemon_request(state: State<'_, AppState>, data: Value) -> Result<Value, String> {
    state.daemon.request(data).await
}

#[tauri::command]
fn daemon_connected(state: State<'_, AppState>) -> bool {
    state.daemon.connected()
}

#[tauri::command]
fn store_get(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    store::get(&app, &key)
}

#[tauri::command]
fn store_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    store::set(&app, &key, &value)
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn audio_devices() -> Result<Vec<audio::AudioDevice>, String> {
    blocking(audio::list).await
}

#[tauri::command]
async fn set_default_device(id: String, role: String) -> Result<(), String> {
    blocking(move || audio::set_default(&id, &role)).await
}

#[tauri::command]
async fn output_eq_apply(eq: apo::OutputEq) -> Result<(), String> {
    blocking(move || apo::apply(&eq)).await
}

/// Medieknapper: what plays now (Windows' media controls).
#[tauri::command]
async fn media_now() -> Result<media::NowPlaying, String> {
    blocking(|| Ok(media::now())).await
}

/// Play/pause, next, previous, stop.
#[tauri::command]
async fn media_control(cmd: String) -> Result<(), String> {
    blocking(move || media::control(&cmd)).await
}

/// Fodpedal: start reading every MIDI input (pedals, controllers) – messages arrive as `midi` events.
#[tauri::command]
fn midi_start(app: AppHandle) {
    midi::start(app);
}

#[tauri::command]
fn midi_stop() {
    midi::stop();
}

/// The MIDI inputs that are open now (names).
#[tauri::command]
fn midi_ports() -> Vec<String> {
    midi::ports()
}

#[tauri::command]
async fn output_eq_status() -> Result<apo::EngineStatus, String> {
    blocking(|| Ok(apo::status())).await
}

/// Lets a separately installed Equalizer APO read GoXLR Studio's EQ (or gives it back).
#[tauri::command]
async fn apo_takeover(enable: bool) -> Result<(), String> {
    let task = if enable { engine::Task::UseExternal } else { engine::Task::RestoreExternal };
    let res = blocking(move || engine::run_elevated(&task)).await?;
    if res.ok { Ok(()) } else { Err(res.error.unwrap_or_else(|| "Ukendt fejl".into())) }
}

#[tauri::command]
async fn engine_info() -> Result<engine::EngineInfo, String> {
    blocking(|| Ok(engine::info())).await
}

/// Installs/changes/removes the built-in EQ engine (one UAC prompt).
#[tauri::command]
async fn engine_task(task: engine::Task) -> Result<engine::TaskResult, String> {
    blocking(move || engine::run_elevated(&task)).await
}

#[tauri::command]
async fn apo_read_config() -> Result<String, String> {
    blocking(apo::read_current_config).await
}

#[tauri::command]
fn set_hotkeys(app: AppHandle, state: State<'_, AppState>, bindings: Vec<HotkeyBinding>) -> Vec<HotkeyResult> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut map = state.hotkeys.lock().unwrap();
    map.clear();
    bindings
        .into_iter()
        .map(|b| {
            let res = b
                .accel
                .parse::<Shortcut>()
                .map_err(|e| format!("Ugyldig tast: {e}"))
                .and_then(|sc| {
                    gs.register(sc).map_err(|e| format!("Optaget af et andet program: {e}"))?;
                    map.insert(sc.id(), b.id.clone());
                    Ok(())
                });
            HotkeyResult { id: b.id, ok: res.is_ok(), error: res.err() }
        })
        .collect()
}

#[tauri::command]
async fn app_sessions() -> Result<Vec<apps::AppSession>, String> {
    blocking(apps::sessions).await
}

#[tauri::command]
async fn set_app_device(pid: u32, flow: String, id: Option<String>) -> Result<(), String> {
    blocking(move || apps::set(pid, &flow, id.as_deref())).await
}


#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let al = app.autolaunch();
    if enabled { al.enable() } else { al.disable() }.map_err(|e| e.to_string())
}

#[tauri::command]
fn set_close_to_tray(state: State<'_, AppState>, enabled: bool) {
    state.close_to_tray.store(enabled, Ordering::SeqCst);
}

#[tauri::command]
fn set_tray(app: AppHandle, state: State<'_, AppState>, model: TrayModel) -> Result<(), String> {
    *state.tray.lock().unwrap() = model;
    rebuild_tray_menu(&app).map_err(|e| e.to_string())
}

#[tauri::command]
async fn apo_list_configs() -> Result<Vec<apo::ConfigFile>, String> {
    blocking(apo::list_configs).await
}

#[tauri::command]
fn show_osd(app: AppHandle, text: String, kind: Option<String>) {
    osd::show(&app, text, kind.unwrap_or_default());
}

fn start_installed_utility() -> Result<String, String> {
    let mut roots = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(v) = std::env::var_os(var) {
            let base = std::path::PathBuf::from(v);
            roots.push(base.join("GoXLR Utility"));
            roots.push(base.join("Programs").join("GoXLR Utility"));
        }
    }
    for dir in roots {
        for exe in ["goxlr-launcher.exe", "goxlr-daemon.exe"] {
            let p = dir.join(exe);
            if p.exists() {
                std::process::Command::new(&p).current_dir(&dir).spawn().map_err(|e| e.to_string())?;
                return Ok(p.display().to_string());
            }
        }
    }
    Err("Fandt ingen GoXLR-motor".into())
}

/// Starts the built-in GoXLR engine (or an installed GoXLR Utility as fallback).
#[tauri::command]
async fn start_daemon() -> Result<String, String> {
    blocking(|| if daemon_host::bundled() { daemon_host::start() } else { start_installed_utility() }).await
}

#[derive(serde::Serialize)]
struct DaemonInfo {
    bundled: bool,
    version: String,
    /// GoXLR Studio's own engine runs (inside this process).
    started_by_us: bool,
    process_running: bool,
    /// Paths of other GoXLR engines running (an installed GoXLR Utility).
    foreign: Vec<String>,
    /// Why the built-in engine last stopped with an error.
    last_error: Option<String>,
}

/// Switches from an installed GoXLR Utility to GoXLR Studio's own engine.
#[tauri::command]
async fn daemon_takeover() -> Result<daemon_host::Takeover, String> {
    blocking(|| daemon_host::take_over(start_installed_utility)).await
}

#[tauri::command]
async fn daemon_info() -> Result<DaemonInfo, String> {
    blocking(|| {
        Ok(DaemonInfo {
            bundled: daemon_host::bundled(),
            version: daemon_host::DAEMON_VERSION.into(),
            started_by_us: daemon_host::started_by_us(),
            process_running: daemon_host::daemon_process_running(),
            foreign: daemon_host::foreign_engines(),
            last_error: daemon_host::last_error(),
        })
    })
    .await
}

/// GoXLR software that starts with Windows (scheduled tasks, Startup shortcuts).
#[tauri::command]
async fn migrate_autostarts() -> Result<Vec<migrate::Autostart>, String> {
    blocking(|| Ok(migrate::goxlr_autostarts())).await
}

#[tauri::command]
async fn migrate_scan() -> Result<migrate::Scan, String> {
    blocking(|| Ok(migrate::scan())).await
}

#[tauri::command]
async fn migrate_backup(stamp: String, goxlr_dirs: Vec<(String, String)>, studio_json: String) -> Result<migrate::BackupResult, String> {
    blocking(move || migrate::backup(&stamp, goxlr_dirs, &studio_json)).await
}

#[tauri::command]
async fn move_collect(dirs: Vec<(String, String)>) -> Result<movepc::Collected, String> {
    blocking(move || Ok(movepc::collect(dirs))).await
}

#[tauri::command]
async fn move_restore(files: Vec<movepc::MoveFile>, dirs: Vec<(String, String)>, stamp: String) -> Result<movepc::Restored, String> {
    blocking(move || movepc::restore(files, dirs, &stamp)).await
}

#[tauri::command]
async fn migrate_copy_profiles(files: Vec<String>, dest: String) -> Result<usize, String> {
    blocking(move || migrate::copy_profiles(files, dest)).await
}

#[tauri::command]
async fn migrate_disable_startup(entry: String) -> Result<String, String> {
    blocking(move || migrate::disable_startup(entry)).await
}

#[tauri::command]
async fn migrate_stop_ahk() -> Result<(), String> {
    blocking(migrate::stop_ahk).await
}

#[tauri::command]
async fn installed_apps() -> Result<Vec<migrate::InstalledApp>, String> {
    blocking(|| Ok(migrate::installed_apps())).await
}

#[tauri::command]
async fn run_uninstaller(key: String) -> Result<String, String> {
    blocking(move || migrate::run_uninstaller(&key)).await
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    migrate::open_path(path)
}

/// Peak levels (0–1) per audio endpoint id, for the VU meters.
#[tauri::command]
fn audio_levels() -> HashMap<String, f32> {
    meters::levels()
}

/// Home Assistant via MQTT (mqtt.rs): connect, publish (discovery + state from the UI), stop.
#[tauri::command]
fn mqtt_start(app: AppHandle, config: mqtt::Config) -> Result<(), String> {
    mqtt::start(app, config)
}

#[tauri::command]
fn mqtt_publish(messages: Vec<mqtt::Message>) -> Result<usize, String> {
    mqtt::publish(messages)
}

#[tauri::command]
fn mqtt_stop() {
    mqtt::stop()
}

#[tauri::command]
fn mqtt_status() -> mqtt::Status {
    mqtt::status()
}

/// This PC's address on the home network, for the phone remote's link.
#[tauri::command]
fn lan_ip() -> Option<String> {
    api::lan_ip()
}

/// One request to OBS Studio's WebSocket server (obs.rs), e.g. SetCurrentProgramScene.
#[tauri::command]
async fn obs_request(config: obs::Config, request_type: String, data: Option<Value>) -> Result<Value, String> {
    obs::request(config, request_type, data.unwrap_or(Value::Null)).await
}

/// Profilhistorik (history.rs).
#[tauri::command]
async fn history_snapshot(profiles: String, mics: String) -> Result<usize, String> {
    blocking(move || Ok(history::snapshot(&profiles, &mics))).await
}

#[tauri::command]
fn history_list(kind: String, name: String) -> Vec<history::Version> {
    history::list(&kind, &name)
}

#[tauri::command]
async fn history_restore(kind: String, name: String, version: String, folder: String) -> Result<(), String> {
    blocking(move || history::restore(&kind, &name, &version, &folder)).await
}

/// Lydtjek (soundcheck.rs): Windows settings that change or hide the sound.
#[tauri::command]
async fn soundcheck_report() -> Result<soundcheck::Report, String> {
    blocking(|| Ok(soundcheck::report())).await
}

#[tauri::command]
async fn soundcheck_set_ducking(value: u32) -> Result<(), String> {
    blocking(move || soundcheck::set_ducking(value)).await
}

#[tauri::command]
async fn soundcheck_restore_ducking() -> Result<Option<u32>, String> {
    blocking(soundcheck::restore_ducking).await
}

#[tauri::command]
async fn soundcheck_set_endpoint(id: String, volume: Option<f32>, mute: Option<bool>) -> Result<(), String> {
    blocking(move || soundcheck::set_endpoint(&id, volume, mute)).await
}

/// Live spectrum of an output (None = Windows' default output) for the EQ graph.
#[tauri::command]
async fn spectrum_read(device: Option<String>) -> spectrum::Spectrum {
    tauri::async_runtime::spawn_blocking(move || spectrum::read(device)).await.unwrap_or_else(|e| spectrum::Spectrum {
        device: String::new(),
        rate: 0,
        bands: Vec::new(),
        playing: false,
        error: Some(e.to_string()),
    })
}

/// Presses a key combination (Discord's "Toggle Mute" keybind).
#[tauri::command]
async fn send_keys(accel: String) -> Result<(), String> {
    blocking(move || keys::send(&accel)).await
}

#[tauri::command]
async fn discord_running() -> Result<bool, String> {
    blocking(|| Ok(keys::any_running(&["Discord.exe", "DiscordPTB.exe", "DiscordCanary.exe"]))).await
}

/// Opens a web link in the default browser (the webview itself never navigates away).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // https, or our own Stream Deck links (to test that Windows hands them to GoXLR Studio).
    let ours = url.starts_with(&format!("{}://action/", deck::SCHEME)) && !url.contains(' ');
    if !(url.starts_with("https://") || ours) || url.contains(['"', '\n', '\r']) {
        return Err("Kun https-links".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).creation_flags(0x0800_0000).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_api(app: AppHandle, state: State<'_, AppState>, config: api::ApiConfig) -> Result<(), String> {
    state.api.configure(app, config)
}

/// The frontend publishes its state and action list for GET /state and GET /actions.
#[tauri::command]
fn api_publish(state: State<'_, AppState>, status: Value, actions: Option<Value>) {
    *state.api.state.lock().unwrap() = status;
    if let Some(a) = actions {
        *state.api.actions.lock().unwrap() = a;
    }
}

/// The mic level (0–1) as a bar along the left edge of the tray icon: green, yellow near the top,
/// red at the very top.
fn draw_level(rgba: &mut [u8], w: u32, h: u32, level: f32) {
    let level = level.clamp(0.0, 1.0);
    let bar = (w as f32 * 0.2).ceil().max(2.0) as u32;
    let filled = (h as f32 * level).round() as u32;
    for y in 0..h {
        let from_bottom = h - 1 - y;
        for x in 0..bar {
            let i = ((y * w + x) * 4) as usize;
            let c: [u8; 4] = if from_bottom < filled {
                let at = from_bottom as f32 / h as f32;
                if at > 0.85 { [244, 63, 94, 255] } else if at > 0.65 { [251, 191, 36, 255] } else { [52, 211, 153, 255] }
            } else {
                [20, 26, 40, 200]
            };
            rgba[i..i + 4].copy_from_slice(&c);
        }
    }
}

/// Red dot on the tray icon while the mic is muted; with `level`, a level meter on its left edge.
#[tauri::command]
fn set_tray_status(app: AppHandle, muted: bool, tooltip: String, level: Option<f32>) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("main") else { return Ok(()) };
    let _ = tray.set_tooltip(Some(&tooltip));
    let Some(base) = app.default_window_icon() else { return Ok(()) };
    let (w, h) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
    if let Some(l) = level {
        draw_level(&mut rgba, w, h, l);
    }
    if muted {
        let (cx, cy, r) = (w as f32 * 0.72, h as f32 * 0.72, w as f32 * 0.28);
        for y in 0..h {
            for x in 0..w {
                let d = ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt();
                let i = ((y * w + x) * 4) as usize;
                if d <= r - r * 0.18 {
                    rgba[i..i + 4].copy_from_slice(&[244, 63, 94, 255]);
                } else if d <= r {
                    rgba[i..i + 4].copy_from_slice(&[255, 255, 255, 255]);
                }
            }
        }
    }
    tray.set_icon(Some(tauri::image::Image::new_owned(rgba, w, h))).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct AppInfo {
    version: String,
    installed: bool,
}

#[tauri::command]
fn app_info(app: AppHandle) -> AppInfo {
    AppInfo { version: app.package_info().version.to_string(), installed: update::is_installed() }
}

#[tauri::command]
async fn update_check(app: AppHandle) -> Result<Value, String> {
    update::check(app.package_info().version.to_string()).await
}

/// `background`: the app sits in the tray – install silently and start it in the tray again.
#[tauri::command]
async fn install_update(app: AppHandle, url: String, sha256: Option<String>, version: Option<String>, background: Option<bool>) -> Result<(), String> {
    let to = version.unwrap_or_else(|| "?".into()).trim_start_matches('v').to_string();
    blocking(move || update::prepare(&url, sha256.as_deref(), &to, background.unwrap_or(false))).await?;
    app.exit(0);
    Ok(())
}

/// The action this process was started with (once), e.g. by a Stream Deck button.
#[tauri::command]
fn take_launch_action(state: State<'_, AppState>) -> Option<String> {
    state.launch_action.lock().unwrap().take()
}

#[tauri::command]
fn sounds_list() -> Vec<sounds::SoundFile> {
    sounds::list()
}

#[tauri::command]
async fn sounds_save(name: String, data: String) -> Result<String, String> {
    blocking(move || sounds::save(&name, &data)).await
}

#[tauri::command]
async fn sounds_read(file: String) -> Result<String, String> {
    blocking(move || sounds::read(&file)).await
}

#[tauri::command]
fn sounds_delete(file: String) -> Result<(), String> {
    sounds::delete(&file)
}

#[tauri::command]
fn sounds_rename(file: String, name: String) -> Result<String, String> {
    sounds::rename(&file, &name)
}

#[tauri::command]
fn sounds_open_dir() -> Result<(), String> {
    let d = sounds::dir();
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    std::process::Command::new("explorer").arg(&d).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// TC-Helicon's GoXLR driver: installed or not, and where to get it (it is never touched).
#[tauri::command]
fn driver_info() -> driver::DriverInfo {
    driver::info()
}

/// For the Stream Deck page: the app's exe ("Åbn program") and whether goxlr-studio:// links
/// reach it (the installer registers them; the portable exe cannot).
#[tauri::command]
fn deck_info() -> Value {
    let exe = std::env::current_exe().ok().map(|p| p.display().to_string()).unwrap_or_default();
    let command = deck::registered_command();
    let here = command.as_deref().map(|c| deck::link_points_to(c, &exe)).unwrap_or(false);
    serde_json::json!({ "exe": exe, "link_registered": command.is_some(), "link_here": here, "link_command": command })
}

/// The outcome of the last update (once) and the end of update.log.
#[tauri::command]
fn update_result() -> Value {
    serde_json::json!({ "result": update::take_result(), "log": update::log_tail(40) })
}

/// The end of update.log (%APPDATA%\GoXLR Studio\logs), for Diagnose.
#[tauri::command]
fn update_log() -> Vec<String> {
    update::log_tail(40)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    use tauri::menu::CheckMenuItem;
    let model = app.state::<AppState>().tray.lock().unwrap().clone();
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "show", model.label("show", "Åbn GoXLR Studio"), true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if !model.profiles.is_empty() {
        let sub = Submenu::with_id(app, "profiles", model.label("profiles", "GoXLR-profil"), true)?;
        for p in &model.profiles {
            let on = model.active_profile.as_deref() == Some(p.as_str());
            sub.append(&CheckMenuItem::with_id(app, format!("profile:{p}"), p, true, on, None::<&str>)?)?;
        }
        menu.append(&sub)?;
    }
    if !model.eq_presets.is_empty() {
        let sub = Submenu::with_id(app, "eq", model.label("eq", "EQ-preset"), true)?;
        sub.append(&CheckMenuItem::with_id(app, "eq-toggle", model.label("eq_toggle", "EQ aktiv"), true, model.eq_enabled, None::<&str>)?)?;
        sub.append(&PredefinedMenuItem::separator(app)?)?;
        for p in &model.eq_presets {
            let on = model.active_eq.as_deref() == Some(p.as_str());
            sub.append(&CheckMenuItem::with_id(app, format!("eq-preset:{p}"), p, true, on, None::<&str>)?)?;
        }
        menu.append(&sub)?;
    }
    if !model.scenes.is_empty() {
        let sub = Submenu::with_id(app, "scenes", model.label("scenes", "Scener"), true)?;
        for s in &model.scenes {
            sub.append(&MenuItem::with_id(app, format!("scene:{}", s.id), &s.name, true, None::<&str>)?)?;
        }
        menu.append(&sub)?;
    }
    menu.append(&MenuItem::with_id(app, "mute-mic", model.label("mute", "Mute / unmute mikrofon"), true, None::<&str>)?)?;
    // Nødknap: the EQ off at once, and the window shows what to do next.
    menu.append(&MenuItem::with_id(app, "restore-sound", model.label("restore", "Gendan lyd (slå EQ fra)"), true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", model.label("quit", "Afslut"), true, None::<&str>)?)?;
    Ok(menu)
}

fn rebuild_tray_menu(app: &AppHandle) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(build_menu(app)?))?;
    }
    Ok(())
}

/// Command-line modes that run without UI: the elevated engine helper, and engine removal
/// requested by GoXLR Studio's uninstaller.
pub fn helper_main(args: &[String]) -> Option<i32> {
    match args.first().map(String::as_str) {
        Some("--engine-task") => Some(engine::task_main(&args[1..])),
        // Called by GoXLR Studio's uninstaller (not during updates): remove everything the app set up.
        Some("--engine-uninstall") => {
            daemon_host::remove_ours();
            if engine::info().kind != "builtin" {
                return Some(0);
            }
            Some(match engine::run_elevated(&engine::Task::Uninstall) {
                Ok(r) if r.ok => 0,
                _ => 1,
            })
        }
        _ => None,
    }
}

fn prefs_flag(app: &AppHandle, key: &str, default: bool) -> bool {
    store::get(app, "prefs").ok().flatten().and_then(|v| v.get(key).and_then(Value::as_bool)).unwrap_or(default)
}

fn prefs_close_to_tray(app: &AppHandle) -> bool {
    store::get(app, "prefs")
        .ok()
        .flatten()
        .and_then(|v| v.get("closeToTray").and_then(Value::as_bool))
        .unwrap_or(true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Work from the app's own folder. Started by an installer, the app can inherit a temporary
    // folder that is deleted afterwards – then Windows cannot start anything as administrator
    // ("Den angivne sti findes ikke") and other programs the app starts can fail too.
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(std::path::Path::to_path_buf)) {
        let _ = std::env::set_current_dir(dir);
    }
    let shortcuts = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            let id = app.state::<AppState>().hotkeys.lock().unwrap().get(&shortcut.id()).cloned();
            let Some(id) = id else { return };
            // Released too, for push-to-talk (held keys); the UI ignores it for other bindings.
            let _ = app.emit(if event.state() == ShortcutState::Pressed { "hotkey" } else { "hotkey-release" }, id);
        })
        .build();

    tauri::Builder::default()
        // A second start hands its arguments over: a Stream Deck action, or just "show the window".
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| match deck::launch_action(&args) {
            Some(id) => {
                let _ = app.emit("deck-action", id);
            }
            None => show_main(app),
        }))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        // The app's own page may use the microphone without asking: "Optag og lyt", and the
        // device names the sound board needs to play on the GoXLR's "Sample" output.
        .on_permission_request(|webview, kind| {
            let ours = webview.url().map(|u| u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")).unwrap_or(false);
            match kind {
                tauri::webview::PermissionKind::Microphone if ours => tauri::webview::PermissionResponse::Allow,
                _ => tauri::webview::PermissionResponse::Default,
            }
        })
        .plugin(shortcuts)
        .manage(AppState {
            daemon: daemon::Daemon::default(),
            close_to_tray: AtomicBool::new(true),
            tray: Mutex::new(TrayModel::default()),
            hotkeys: Mutex::new(HashMap::new()),
            api: Arc::new(api::Api::default()),
            launch_action: Mutex::new(deck::launch_action(&std::env::args().collect::<Vec<_>>())),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            state.close_to_tray.store(prefs_close_to_tray(&handle), Ordering::SeqCst);
            state.daemon.clone().spawn(handle.clone(), DAEMON_URL.to_string());
            update::cleanup();
            session::watch(handle.clone());
            // The GoXLR engine runs inside GoXLR Studio: requests to show "its" UI show ours, and
            // the UI hears when it stops by itself (e.g. TC-Helicon's app took the GoXLR).
            let h = handle.clone();
            daemon_host::on_activate(move || show_main(&h));
            let h = handle.clone();
            daemon_host::on_stopped(move |error| {
                let _ = h.emit("engine-stopped", error);
            });
            // One app: GoXLR Studio runs its own GoXLR engine. An installed GoXLR Utility that is
            // running is switched off (and kept from autostarting) unless the user turned that off.
            {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(800));
                    // 0.3.x ran the engine as a separate goxlr-daemon.exe; it is part of the app now.
                    let retired = daemon_host::retire_old_engine();
                    if !prefs_flag(&h, "autoStartDaemon", true) {
                        return;
                    }
                    let builtin = daemon_host::bundled() && prefs_flag(&h, "builtinEngine", true);
                    if builtin && !daemon_host::foreign_engines().is_empty() {
                        match daemon_host::take_over(start_installed_utility) {
                            Ok(t) => {
                                let _ = h.emit("engine-takeover", serde_json::to_value(&t).unwrap_or_default());
                            }
                            Err(e) => {
                                let _ = h.emit("engine-takeover-failed", e);
                            }
                        }
                    } else if retired || !h.state::<AppState>().daemon.connected() {
                        let res = if daemon_host::bundled() { daemon_host::start() } else { start_installed_utility() };
                        if let Err(e) = res {
                            log::warn!("GoXLR-motor: {e}");
                        }
                    }
                });
            }
            if let Err(e) = osd::create(&handle) {
                log::warn!("OSD: {e}");
            }

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("GoXLR Studio")
                .menu(&build_menu(&handle)?)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    id => {
                        let _ = app.emit("tray-action", id.to_string());
                        if id == "restore-sound" {
                            show_main(app);
                        }
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // Autostart, or started by a Stream Deck button: stay in the tray.
            if std::env::args().any(|a| a == "--minimized") || state.launch_action.lock().unwrap().is_some() {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.app_handle().state::<AppState>().close_to_tray.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            daemon_request,
            daemon_connected,
            store_get,
            store_set,
            audio_devices,
            set_default_device,
            output_eq_apply,
            midi_start,
            media_now,
            media_control,
            midi_stop,
            midi_ports,
            output_eq_status,
            apo_takeover,
            apo_read_config,
            set_autostart,
            set_close_to_tray,
            set_tray,
            apo_list_configs,
            set_hotkeys,
            app_sessions,
            set_app_device,
            engine_info,
            engine_task,
            daemon_info,
            daemon_takeover,
            migrate_scan,
            migrate_autostarts,
            migrate_backup,
            move_collect,
            move_restore,
            migrate_copy_profiles,
            migrate_disable_startup,
            migrate_stop_ahk,
            installed_apps,
            run_uninstaller,
            open_path,
            open_url,
            send_keys,
            audio_levels,
            spectrum_read,
            obs_request,
            lan_ip,
            history_snapshot,
            history_list,
            history_restore,
            soundcheck_report,
            soundcheck_set_ducking,
            soundcheck_restore_ducking,
            soundcheck_set_endpoint,
            mqtt_start,
            mqtt_publish,
            mqtt_stop,
            mqtt_status,
            discord_running,
            show_osd,
            start_daemon,
            set_api,
            api_publish,
            set_tray_status,
            app_info,
            update_check,
            install_update,
            update_result,
            update_log,
            take_launch_action,
            deck_info,
            driver_info,
            sounds_list,
            sounds_save,
            sounds_read,
            sounds_delete,
            sounds_rename,
            sounds_open_dir,
        ])
        .build(tauri::generate_context!())
        .expect("error while building GoXLR Studio")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                daemon_host::stop();
            }
        });
}

#[cfg(test)]
mod tray_tests {
    #[test]
    fn level_bar_fills_from_the_bottom() {
        let (w, h) = (16u32, 16u32);
        let mut px = vec![0u8; (w * h * 4) as usize];
        super::draw_level(&mut px, w, h, 0.5);
        let at = |px: &[u8], x: u32, y: u32| px[((y * w + x) * 4) as usize..((y * w + x) * 4 + 4) as usize].to_vec();
        assert_eq!(at(&px, 0, 15), vec![52, 211, 153, 255]); // bottom: green
        assert_eq!(at(&px, 0, 0), vec![20, 26, 40, 200]); // top: empty
        assert_eq!(at(&px, 10, 15), vec![0, 0, 0, 0]); // the rest of the icon untouched
        super::draw_level(&mut px, w, h, 1.0);
        assert_eq!(at(&px, 0, 0), vec![244, 63, 94, 255]); // full: red at the top
    }
}
