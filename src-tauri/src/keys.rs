//! Sends a key combination to Windows (used to press Discord's "Toggle Mute" keybind when the
//! GoXLR's mic mute changes – Discord offers no open API for setting mute).

/// "Ctrl+Shift+Alt+D" → (modifier VKs, key VK, extended?)
pub fn parse_accel(accel: &str) -> Option<(Vec<u16>, u16, bool)> {
    let mut mods = Vec::new();
    let mut key = None;
    for part in accel.split('+').map(str::trim) {
        match part {
            "Ctrl" | "Control" => mods.push(0x11),
            "Alt" => mods.push(0x12),
            "Shift" => mods.push(0x10),
            "Super" | "Win" | "Meta" => mods.push(0x5B),
            k => key = Some(k),
        }
    }
    let k = key?;
    let (vk, ext) = match k {
        _ if k.len() == 1 && k.chars().all(|c| c.is_ascii_alphanumeric()) => (k.to_ascii_uppercase().as_bytes()[0] as u16, false),
        _ if k.starts_with('F') && k[1..].parse::<u16>().map(|n| (1..=24).contains(&n)).unwrap_or(false) => (0x6F + k[1..].parse::<u16>().ok()?, false),
        _ if k.starts_with("Numpad") && k.len() == 7 => (0x60 + k[6..].parse::<u16>().ok()?, false),
        "PageUp" => (0x21, true),
        "PageDown" => (0x22, true),
        "End" => (0x23, true),
        "Home" => (0x24, true),
        "Left" => (0x25, true),
        "Up" => (0x26, true),
        "Right" => (0x27, true),
        "Down" => (0x28, true),
        "Insert" => (0x2D, true),
        "Delete" => (0x2E, true),
        "Space" => (0x20, false),
        "Enter" => (0x0D, false),
        "Tab" => (0x09, false),
        "Escape" => (0x1B, false),
        "Backspace" => (0x08, false),
        "Pause" => (0x13, false),
        "MediaPlayPause" => (0xB3, true),
        "MediaTrackNext" => (0xB0, true),
        "MediaTrackPrevious" => (0xB1, true),
        "MediaStop" => (0xB2, true),
        "AudioVolumeMute" => (0xAD, true),
        "AudioVolumeDown" => (0xAE, true),
        "AudioVolumeUp" => (0xAF, true),
        _ => return None,
    };
    Some((mods, vk, ext))
}

#[cfg(windows)]
pub fn send(accel: &str) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    let (mods, vk, ext) = parse_accel(accel).ok_or_else(|| format!("Ukendt tast: {accel}"))?;
    let input = |vk: u16, up: bool, extended: bool| {
        let scan = unsafe { MapVirtualKeyW(vk as u32, MAPVK_VK_TO_VSC) } as u16;
        let mut flags = KEYBD_EVENT_FLAGS(0);
        if up {
            flags |= KEYEVENTF_KEYUP;
        }
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
    };
    let press = |i: INPUT| unsafe {
        SendInput(&[i], std::mem::size_of::<INPUT>() as i32);
        std::thread::sleep(std::time::Duration::from_millis(25));
    };
    // Held briefly, one event at a time: some apps miss chords sent in a single burst.
    for m in &mods {
        press(input(*m, false, *m == 0x5B));
    }
    press(input(vk, false, ext));
    std::thread::sleep(std::time::Duration::from_millis(40));
    press(input(vk, true, ext));
    for m in mods.iter().rev() {
        press(input(*m, true, *m == 0x5B));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn send(_accel: &str) -> Result<(), String> {
    Err("Kun på Windows".into())
}

/// Is any of these executables running (case-insensitive image names)?
pub fn any_running(names: &[&str]) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = std::process::Command::new("tasklist").args(["/FO", "CSV", "/NH"]).creation_flags(0x0800_0000).output();
        let Ok(out) = out else { return false };
        let text = String::from_utf8_lossy(&out.stdout).to_lowercase();
        names.iter().any(|n| text.contains(&format!("\"{}\"", n.to_lowercase())))
    }
    #[cfg(not(windows))]
    {
        let _ = names;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::parse_accel;

    #[test]
    fn parses_accelerators() {
        assert_eq!(parse_accel("Ctrl+Shift+Alt+D"), Some((vec![0x11, 0x10, 0x12], 0x44, false)));
        assert_eq!(parse_accel("F13"), Some((vec![], 0x7C, false)));
        assert_eq!(parse_accel("Ctrl+PageUp"), Some((vec![0x11], 0x21, true)));
        assert_eq!(parse_accel("Alt+Numpad5"), Some((vec![0x12], 0x65, false)));
        assert_eq!(parse_accel("Ctrl+7"), Some((vec![0x11], 0x37, false)));
        assert_eq!(parse_accel("Ctrl+Shift"), None);
        assert_eq!(parse_accel("Ctrl+Wat"), None);
    }
}
