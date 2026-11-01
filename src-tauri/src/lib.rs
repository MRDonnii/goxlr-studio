mod api;
mod apo;
mod apps;
mod audio;
mod daemon;
mod daemon_host;
mod engine;
mod keys;
mod meters;
mod migrate;
mod osd;
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
}

struct AppState {
    daemon: daemon::Daemon,
    close_to_tray: AtomicBool,
    tray: Mutex<TrayModel>,
    hotkeys: Mutex<HashMap<u32, String>>,
    api: Arc<api::Api>,
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
    started_by_us: bool,
    process_running: bool,
}

#[tauri::command]
async fn daemon_info() -> Result<DaemonInfo, String> {
    blocking(|| {
        Ok(DaemonInfo {
            bundled: daemon_host::bundled(),
            version: daemon_host::DAEMON_VERSION.into(),
            started_by_us: daemon_host::started_by_us(),
            process_running: daemon_host::daemon_process_running(),
        })
    })
    .await
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
    if !url.starts_with("https://") || url.contains(['"', '\n', '\r']) {
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

/// Red dot on the tray icon while the mic is muted.
#[tauri::command]
fn set_tray_status(app: AppHandle, muted: bool, tooltip: String) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("main") else { return Ok(()) };
    let _ = tray.set_tooltip(Some(&tooltip));
    let Some(base) = app.default_window_icon() else { return Ok(()) };
    let (w, h) = (base.width(), base.height());
    let mut rgba = base.rgba().to_vec();
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
async fn install_update(app: AppHandle, url: String, sha256: Option<String>) -> Result<(), String> {
    blocking(move || update::prepare(&url, sha256.as_deref())).await?;
    app.exit(0);
    Ok(())
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
    menu.append(&MenuItem::with_id(app, "show", "Åbn GoXLR Studio", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    if !model.profiles.is_empty() {
        let sub = Submenu::with_id(app, "profiles", "GoXLR-profil", true)?;
        for p in &model.profiles {
            let on = model.active_profile.as_deref() == Some(p.as_str());
            sub.append(&CheckMenuItem::with_id(app, format!("profile:{p}"), p, true, on, None::<&str>)?)?;
        }
        menu.append(&sub)?;
    }
    if !model.eq_presets.is_empty() {
        let sub = Submenu::with_id(app, "eq", "EQ-preset", true)?;
        sub.append(&CheckMenuItem::with_id(app, "eq-toggle", "EQ aktiv", true, model.eq_enabled, None::<&str>)?)?;
        sub.append(&PredefinedMenuItem::separator(app)?)?;
        for p in &model.eq_presets {
            let on = model.active_eq.as_deref() == Some(p.as_str());
            sub.append(&CheckMenuItem::with_id(app, format!("eq-preset:{p}"), p, true, on, None::<&str>)?)?;
        }
        menu.append(&sub)?;
    }
    if !model.scenes.is_empty() {
        let sub = Submenu::with_id(app, "scenes", "Scener", true)?;
        for s in &model.scenes {
            sub.append(&MenuItem::with_id(app, format!("scene:{}", s.id), &s.name, true, None::<&str>)?)?;
        }
        menu.append(&sub)?;
    }
    menu.append(&MenuItem::with_id(app, "mute-mic", "Mute / unmute mikrofon", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Afslut", true, None::<&str>)?)?;
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
        Some("--engine-uninstall") => {
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
    let shortcuts = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            let id = app.state::<AppState>().hotkeys.lock().unwrap().get(&shortcut.id()).cloned();
            if let Some(id) = id {
                let _ = app.emit("hotkey", id);
            }
        })
        .build();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(shortcuts)
        .manage(AppState {
            daemon: daemon::Daemon::default(),
            close_to_tray: AtomicBool::new(true),
            tray: Mutex::new(TrayModel::default()),
            hotkeys: Mutex::new(HashMap::new()),
            api: Arc::new(api::Api::default()),
        })
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            state.close_to_tray.store(prefs_close_to_tray(&handle), Ordering::SeqCst);
            state.daemon.clone().spawn(handle.clone(), DAEMON_URL.to_string());
            update::cleanup();
            // Start the built-in GoXLR engine unless another daemon answers within a moment.
            if prefs_flag(&handle, "autoStartDaemon", true) {
                let h = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(2500));
                    if !h.state::<AppState>().daemon.connected() {
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
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            if std::env::args().any(|a| a == "--minimized") {
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
            migrate_scan,
            migrate_backup,
            migrate_copy_profiles,
            migrate_disable_startup,
            migrate_stop_ahk,
            installed_apps,
            run_uninstaller,
            open_path,
            open_url,
            send_keys,
            audio_levels,
            discord_running,
            show_osd,
            start_daemon,
            set_api,
            api_publish,
            set_tray_status,
            app_info,
            install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building GoXLR Studio")
        .run(|_app, event| {
            if let tauri::RunEvent::Exit = event {
                daemon_host::stop();
            }
        });
}
