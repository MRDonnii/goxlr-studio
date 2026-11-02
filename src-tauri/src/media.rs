//! Medieknapper og "spiller nu": Windows' own media controls (the ones the volume pop-up shows) –
//! what plays now (title, artist, app) and play/pause, next and previous for that player. Falls back
//! to the keyboard's media keys when no player has registered with Windows.
use serde::Serialize;

#[derive(Serialize, Default, Clone, Debug, PartialEq)]
pub struct NowPlaying {
    pub available: bool,
    pub playing: bool,
    pub title: String,
    pub artist: String,
    pub app: String,
}

/// "Spotify.exe" / "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" → a short app name.
pub fn app_name(id: &str) -> String {
    let base = id.split('!').next_back().unwrap_or(id);
    let base = base.rsplit(['\\', '/']).next().unwrap_or(base);
    let base = base.strip_suffix(".exe").or_else(|| base.strip_suffix(".EXE")).unwrap_or(base);
    let base = base.rsplit('.').next().filter(|s| !s.is_empty()).unwrap_or(base);
    match base.to_lowercase().as_str() {
        "zunemusic" => "Medieafspiller".into(),
        "chrome" => "Chrome".into(),
        "msedge" => "Edge".into(),
        "firefox" => "Firefox".into(),
        "spotify" => "Spotify".into(),
        _ => base.to_string(),
    }
}

/// The media key that does the same as a command (fallback without a registered player).
pub fn media_key(cmd: &str) -> Option<&'static str> {
    match cmd {
        "play-pause" => Some("MediaPlayPause"),
        "next" => Some("MediaTrackNext"),
        "previous" => Some("MediaTrackPrevious"),
        "stop" => Some("MediaStop"),
        _ => None,
    }
}

#[cfg(windows)]
mod imp {
    use super::{app_name, NowPlaying};
    use windows::Media::Control::{GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

    fn session() -> Option<Session> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let mgr = Manager::RequestAsync().ok()?.get().ok()?;
        mgr.GetCurrentSession().ok()
    }

    pub fn now() -> NowPlaying {
        let Some(s) = session() else { return NowPlaying::default() };
        let props = s.TryGetMediaPropertiesAsync().ok().and_then(|op| op.get().ok());
        let playing = s.GetPlaybackInfo().ok().and_then(|i| i.PlaybackStatus().ok()).map(|st| st == Status::Playing).unwrap_or(false);
        NowPlaying {
            available: true,
            playing,
            title: props.as_ref().and_then(|p| p.Title().ok()).map(|t| t.to_string_lossy()).unwrap_or_default(),
            artist: props.as_ref().and_then(|p| p.Artist().ok()).map(|t| t.to_string_lossy()).unwrap_or_default(),
            app: s.SourceAppUserModelId().map(|id| app_name(&id.to_string_lossy())).unwrap_or_default(),
        }
    }

    /// True when a registered player took the command.
    pub fn control(cmd: &str) -> bool {
        let Some(s) = session() else { return false };
        let op = match cmd {
            "play-pause" => s.TryTogglePlayPauseAsync(),
            "next" => s.TrySkipNextAsync(),
            "previous" => s.TrySkipPreviousAsync(),
            "stop" => s.TryStopAsync(),
            _ => return false,
        };
        op.ok().and_then(|o| o.get().ok()).unwrap_or(false)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::NowPlaying;
    pub fn now() -> NowPlaying {
        NowPlaying::default()
    }
    pub fn control(_cmd: &str) -> bool {
        false
    }
}

pub use imp::now;

/// Play/pause, next, previous or stop – the current player, else the media key.
pub fn control(cmd: &str) -> Result<(), String> {
    if imp::control(cmd) {
        return Ok(());
    }
    let key = media_key(cmd).ok_or_else(|| format!("Ukendt mediekommando: {cmd}"))?;
    crate::keys::send(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_names_are_short() {
        assert_eq!(app_name("Spotify.exe"), "Spotify");
        assert_eq!(app_name("C:\\Program Files\\VLC\\vlc.exe"), "vlc");
        assert_eq!(app_name("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Medieafspiller");
        assert_eq!(app_name("Chrome"), "Chrome");
        assert_eq!(media_key("next"), Some("MediaTrackNext"));
        assert_eq!(media_key("x"), None);
    }
}
