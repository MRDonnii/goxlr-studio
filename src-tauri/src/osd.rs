//! On-screen display: a small always-on-top, non-activating window that briefly shows what a hotkey did.
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

static GENERATION: AtomicU64 = AtomicU64::new(0);
const W: f64 = 380.0;
const H: f64 = 76.0;

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let w = WebviewWindowBuilder::new(app, "osd", WebviewUrl::App("osd.html".into()))
        .title("GoXLR Studio OSD")
        .inner_size(W, H)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .visible(false)
        .build()?;
    let _ = w.set_ignore_cursor_events(true);
    Ok(())
}

fn place(app: &AppHandle, w: &tauri::WebviewWindow) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let scale = m.scale_factor();
        let size = m.size();
        let pos = m.position();
        let x = pos.x as f64 + (size.width as f64 - W * scale) / 2.0;
        let y = pos.y as f64 + 56.0 * scale;
        let _ = w.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
    }
}

#[cfg(windows)]
fn show_no_activate(w: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE};
    if let Ok(h) = w.hwnd() {
        let hwnd = HWND(h.0 as _);
        // Showing through Win32 keeps focus in the game instead of activating the OSD.
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

#[cfg(not(windows))]
fn show_no_activate(w: &tauri::WebviewWindow) {
    let _ = w.show();
}

pub fn show(app: &AppHandle, text: String, kind: String) {
    // Not needed while the user is looking at the app itself.
    if let Some(main) = app.get_webview_window("main") {
        if main.is_visible().unwrap_or(false) && main.is_focused().unwrap_or(false) {
            return;
        }
    }
    let Some(w) = app.get_webview_window("osd") else { return };
    let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    place(app, &w);
    let _ = w.emit("osd", serde_json::json!({ "text": text, "kind": kind }));
    show_no_activate(&w);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1600));
        if GENERATION.load(Ordering::SeqCst) == gen {
            if let Some(w) = app.get_webview_window("osd") {
                let _ = w.hide();
            }
        }
    });
}
