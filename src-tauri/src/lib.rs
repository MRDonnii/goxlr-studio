mod apo;
mod audio;
mod daemon;
mod store;

use serde::Deserialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const DAEMON_URL: &str = "ws://127.0.0.1:14564/api/websocket";
const SCENE_KEYS: [Code; 9] = [
    Code::Digit1, Code::Digit2, Code::Digit3, Code::Digit4, Code::Digit5, Code::Digit6, Code::Digit7, Code::Digit8, Code::Digit9,
];

#[derive(Deserialize, Clone)]
struct SceneRef {
    id: String,
    name: String,
}

struct AppState {
    daemon: daemon::Daemon,
    close_to_tray: AtomicBool,
    scenes: Mutex<Vec<SceneRef>>,
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

#[tauri::command]
async fn apo_takeover(enable: bool) -> Result<(), String> {
    blocking(move || apo::takeover(enable)).await
}

#[tauri::command]
async fn apo_read_config() -> Result<String, String> {
    blocking(apo::read_current_config).await
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
fn set_scenes(app: AppHandle, state: State<'_, AppState>, scenes: Vec<SceneRef>) -> Result<(), String> {
    *state.scenes.lock().unwrap() = scenes;
    rebuild_tray_menu(&app).map_err(|e| e.to_string())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let state = app.state::<AppState>();
    let scenes = state.scenes.lock().unwrap().clone();
    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(app, "show", "Åbn GoXLR Studio", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "mute-mic", "Mute / unmute mikrofon", true, None::<&str>)?)?;
    if !scenes.is_empty() {
        let sub = Submenu::with_id(app, "scenes", "Scener", true)?;
        for (i, s) in scenes.iter().enumerate() {
            let accel = (i < 9).then(|| format!("Ctrl+Alt+{}", i + 1));
            sub.append(&MenuItem::with_id(app, format!("scene:{}", s.id), &s.name, true, accel.as_deref())?)?;
        }
        menu.append(&sub)?;
    }
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
            if let Some(i) = SCENE_KEYS.iter().position(|c| shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, *c)) {
                let _ = app.emit("scene-hotkey", i);
            } else if shortcut.matches(Modifiers::CONTROL | Modifiers::ALT, Code::KeyM) {
                let _ = app.emit("tray-action", "mute-mic");
            }
        })
        .build();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
        .plugin(shortcuts)
        .manage(AppState { daemon: daemon::Daemon::default(), close_to_tray: AtomicBool::new(true), scenes: Mutex::new(Vec::new()) })
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<AppState>();
            state.close_to_tray.store(prefs_close_to_tray(&handle), Ordering::SeqCst);
            state.daemon.clone().spawn(handle.clone(), DAEMON_URL.to_string());

            let gs = app.global_shortcut();
            for code in SCENE_KEYS.iter().copied().chain([Code::KeyM]) {
                if let Err(e) = gs.register(Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), code)) {
                    log::warn!("Kunne ikke registrere genvej {code:?}: {e}");
                }
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
            set_scenes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GoXLR Studio");
}
