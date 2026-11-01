//! Stream Deck and other button boxes (Streonor, Elgato, Ulanzi …): any of GoXLR Studio's actions
//! can be started with a link, `goxlr-studio://action/<id>` (the installer registers the link type),
//! or on the command line, `goxlr-studio.exe --action <id>`. Windows then starts a second
//! goxlr-studio.exe; the single-instance plugin hands its arguments to the running app and exits.
//! If GoXLR Studio was not running, it starts in the tray and runs the action once the GoXLR is
//! connected.

pub const SCHEME: &str = "goxlr-studio";

/// The action asked for in a process's arguments, if any.
pub fn launch_action(args: &[String]) -> Option<String> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        let a = a.trim();
        if a == "--action" {
            return it.next().map(|s| s.trim().to_string()).filter(|s| valid(s));
        }
        if let Some(id) = a.strip_prefix("--action=") {
            return Some(id.trim().to_string()).filter(|s| valid(s));
        }
        if let Some(id) = link_action(a) {
            return Some(id);
        }
    }
    None
}

/// `goxlr-studio://action/<id>` → id. The id is percent-encoded in the links the app hands out
/// (`profile%3AHeadset`); a trailing slash or query that some programs add is ignored.
fn link_action(arg: &str) -> Option<String> {
    let rest = arg.get(..SCHEME.len() + 1).filter(|p| p.eq_ignore_ascii_case(&format!("{SCHEME}:")))?;
    let rest = arg[rest.len()..].trim_start_matches('/');
    let rest = rest.get(..7).filter(|p| p.eq_ignore_ascii_case("action/")).map(|p| &rest[p.len()..])?;
    let rest = rest.split(['?', '#']).next().unwrap_or("").trim_end_matches('/');
    Some(crate::api::percent_decode(rest)).filter(|s| valid(s))
}

fn valid(id: &str) -> bool {
    !id.is_empty() && id.len() <= 512 && !id.chars().any(char::is_control)
}

/// Whether the registered link command (`"C:\…\goxlr-studio.exe" "%1"`) starts this exe.
pub fn link_points_to(command: &str, exe: &str) -> bool {
    !exe.is_empty() && command.to_lowercase().contains(&exe.to_lowercase())
}

/// The command Windows runs for goxlr-studio:// links (HKEY_CLASSES_ROOT merges the user's
/// registration from the installer with a machine-wide one), if the link type is registered.
#[cfg(windows)]
pub fn registered_command() -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CLASSES_ROOT, RRF_RT_REG_SZ};
    let path: Vec<u16> = format!(r"{SCHEME}\shell\open\command").encode_utf16().chain(Some(0)).collect();
    let mut size = 0u32;
    unsafe { RegGetValueW(HKEY_CLASSES_ROOT, PCWSTR(path.as_ptr()), PCWSTR::null(), RRF_RT_REG_SZ, None, None, Some(&mut size)) }
        .ok()
        .ok()?;
    let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
    unsafe {
        RegGetValueW(HKEY_CLASSES_ROOT, PCWSTR(path.as_ptr()), PCWSTR::null(), RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr().cast()), Some(&mut size))
    }
    .ok()
    .ok()?;
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    Some(String::from_utf16_lossy(&buf[..end]))
}

#[cfg(not(windows))]
pub fn registered_command() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn actions_from_links_and_the_command_line() {
        let exe = r"C:\Users\x\AppData\Local\GoXLR Studio\goxlr-studio.exe";
        assert_eq!(launch_action(&args(&[exe, "goxlr-studio://action/mute-mic"])).as_deref(), Some("mute-mic"));
        assert_eq!(launch_action(&args(&[exe, "goxlr-studio://action/profile%3AHeadset/"])).as_deref(), Some("profile:Headset"));
        assert_eq!(launch_action(&args(&[exe, "GOXLR-STUDIO://Action/eq-preset%3AFodtrin%20(FPS)"])).as_deref(), Some("eq-preset:Fodtrin (FPS)"));
        assert_eq!(launch_action(&args(&[exe, "goxlr-studio:action/vol-up%3AMusic?x=1"])).as_deref(), Some("vol-up:Music"));
        assert_eq!(launch_action(&args(&[exe, "goxlr-studio://action/R%C3%B8de"])).as_deref(), Some("Røde"));
        assert_eq!(launch_action(&args(&[exe, "--action", "scene:abc"])).as_deref(), Some("scene:abc"));
        assert_eq!(launch_action(&args(&[exe, "--action=discord-deafen"])).as_deref(), Some("discord-deafen"));
        // Unfinished or broken percent signs are kept as they are.
        assert_eq!(launch_action(&args(&[exe, "goxlr-studio://action/50%"])).as_deref(), Some("50%"));
        assert_eq!(launch_action(&args(&[exe, "goxlr-studio://action/a%2"])).as_deref(), Some("a%2"));
        // Nothing to do.
        assert_eq!(launch_action(&args(&[exe])), None);
        assert_eq!(launch_action(&args(&[exe, "--minimized"])), None);
        assert_eq!(launch_action(&args(&[exe, "goxlr-studio://action/"])), None);
        assert_eq!(launch_action(&args(&[exe, "goxlr-studio://settings"])), None);
        assert_eq!(launch_action(&args(&[exe, "--action"])), None);
        assert_eq!(launch_action(&args(&[exe, "goxlr-studio://action/a%0Ab"])), None);
    }

    #[test]
    fn registered_link_must_start_this_exe() {
        let exe = r"C:\Users\x\AppData\Local\GoXLR Studio\goxlr-studio.exe";
        assert!(link_points_to(r#""C:\Users\X\AppData\Local\GoXLR Studio\goxlr-studio.exe" "%1""#, exe));
        assert!(!link_points_to(r#""C:\Program Files\GoXLR Studio\goxlr-studio.exe" "%1""#, exe));
        assert!(!link_points_to("", ""));
    }
}
