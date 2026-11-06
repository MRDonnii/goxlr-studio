//! Musik-popup: a small player card (cover, song, progress, ⏮ ⏯ ⏭, the GoXLR's Music volume) in a
//! corner of the screen. It shows over games without taking the focus – also when clicked
//! (WS_EX_NOACTIVATE) – on a song change if wanted, or by a key/Stream Deck. The page itself
//! (public/music.html) hides it again after a few seconds unless the mouse is on it.
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const W: f64 = 420.0;
const H: f64 = 136.0;
/// Space to the screen's edge (logical pixels).
const MARGIN: f64 = 16.0;

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let w = WebviewWindowBuilder::new(app, "music", WebviewUrl::App("music.html".into()))
        .title("GoXLR Studio – musik")
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
    no_activate(&w);
    Ok(())
}

/// Where the card goes: a corner of the primary screen's work area (above the taskbar).
/// `corner` = "top-left" | "top-right" | "bottom-left" | "bottom-right" (default).
pub fn corner_position(corner: &str, area: (f64, f64, f64, f64), scale: f64) -> (i32, i32) {
    let (ax, ay, aw, ah) = area;
    let (w, h, m) = (W * scale, H * scale, MARGIN * scale);
    let x = if corner.ends_with("left") { ax + m } else { ax + aw - w - m };
    let y = if corner.starts_with("top") { ay + m } else { ay + ah - h - m };
    (x.round() as i32, y.round() as i32)
}

fn place(app: &AppHandle, w: &tauri::WebviewWindow, corner: &str) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let a = m.work_area();
        let area = (a.position.x as f64, a.position.y as f64, a.size.width as f64, a.size.height as f64);
        let (x, y) = corner_position(corner, area, m.scale_factor());
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

#[cfg(windows)]
fn no_activate(w: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};
    if let Ok(h) = w.hwnd() {
        let hwnd = HWND(h.0 as _);
        // Clicking the buttons must not take the focus from a game.
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_NOACTIVATE.0 as isize | WS_EX_TOOLWINDOW.0 as isize);
        }
    }
}

#[cfg(not(windows))]
fn no_activate(_w: &tauri::WebviewWindow) {}

#[cfg(windows)]
fn show_no_activate(w: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE};
    if let Ok(h) = w.hwnd() {
        let hwnd = HWND(h.0 as _);
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

/// Shows (`Some(true)`), hides (`Some(false)`) or toggles (`None`) the card. `auto` = shown by a
/// song change (it hides itself sooner). Returns whether it is visible now.
pub fn set(app: &AppHandle, show: Option<bool>, auto: bool, corner: &str, seconds: u32) -> bool {
    let Some(w) = app.get_webview_window("music") else { return false };
    let visible = w.is_visible().unwrap_or(false);
    let show = show.unwrap_or(!visible);
    if !show {
        let _ = w.hide();
        return false;
    }
    if !visible {
        place(app, &w, corner);
    }
    let _ = w.emit("music-show", serde_json::json!({ "auto": auto, "seconds": seconds }));
    show_no_activate(&w);
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corners_stay_on_the_work_area() {
        // 1920×1040 work area (taskbar at the bottom), 100 %.
        let a = (0.0, 0.0, 1920.0, 1040.0);
        assert_eq!(corner_position("bottom-right", a, 1.0), (1920 - 420 - 16, 1040 - 136 - 16));
        assert_eq!(corner_position("top-left", a, 1.0), (16, 16));
        assert_eq!(corner_position("top-right", a, 1.0), (1920 - 436, 16));
        // 150 % on a second screen to the left.
        let (x, y) = corner_position("bottom-left", (-2560.0, 0.0, 2560.0, 1400.0), 1.5);
        assert_eq!((x, y), (-2560 + 24, 1400 - 204 - 24));
    }
}
