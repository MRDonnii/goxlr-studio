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
    /// Where in the song (ms, counted on to now while playing) and its length (0 = unknown).
    pub position_ms: u64,
    pub duration_ms: u64,
}

/// Live position: the player's last reported position plus the time since, while playing; never
/// past the end. Times in 100 ns ticks (Windows' TimeSpan/DateTime).
pub fn live_position(position: i64, end: i64, updated: i64, now: i64, playing: bool) -> u64 {
    let mut p = position.max(0);
    if playing && updated > 0 && now > updated {
        p += now - updated;
    }
    if end > 0 {
        p = p.min(end);
    }
    (p / 10_000) as u64
}

/// The bytes of a cover image as a data: URL (for <img>), or None when it is not an image.
pub fn data_url(content_type: &str, bytes: &[u8]) -> Option<String> {
    use base64::Engine as _;
    let ct = content_type.trim().to_ascii_lowercase();
    let ct = if ct.starts_with("image/") { ct } else if bytes.starts_with(&[0xff, 0xd8]) { "image/jpeg".into() } else if bytes.starts_with(b"\x89PNG") { "image/png".into() } else { return None };
    if bytes.is_empty() || bytes.len() > 4 * 1024 * 1024 {
        return None;
    }
    Some(format!("data:{ct};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
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
    use super::{app_name, data_url, live_position, NowPlaying};
    use std::sync::Mutex;
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
        let (mut position_ms, mut duration_ms) = (0, 0);
        if let Ok(t) = s.GetTimelineProperties() {
            let ticks = |r: windows::core::Result<windows::Foundation::TimeSpan>| r.map(|v| v.Duration).unwrap_or(0);
            let (start, end, pos) = (ticks(t.StartTime()), ticks(t.EndTime()), ticks(t.Position()));
            let updated = t.LastUpdatedTime().map(|d| d.UniversalTime).unwrap_or(0);
            if end > start {
                duration_ms = ((end - start) / 10_000) as u64;
                position_ms = live_position(pos - start, end - start, updated, now_ticks(), playing);
            }
        }
        NowPlaying {
            available: true,
            playing,
            title: props.as_ref().and_then(|p| p.Title().ok()).map(|t| t.to_string_lossy()).unwrap_or_default(),
            artist: props.as_ref().and_then(|p| p.Artist().ok()).map(|t| t.to_string_lossy()).unwrap_or_default(),
            app: s.SourceAppUserModelId().map(|id| app_name(&id.to_string_lossy())).unwrap_or_default(),
            position_ms,
            duration_ms,
        }
    }

    /// Now in Windows' DateTime ticks (100 ns since 1601).
    fn now_ticks() -> i64 {
        let unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as i64 / 100).unwrap_or(0);
        unix + 11_644_473_600 * 10_000_000
    }

    /// The current song's cover (data: URL), read once per song.
    static ART: Mutex<Option<(String, Option<String>)>> = Mutex::new(None);

    pub fn art() -> Option<String> {
        let s = session()?;
        let props = s.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
        let key = format!("{}\u{1}{}\u{1}{}", props.Title().map(|t| t.to_string_lossy()).unwrap_or_default(), props.Artist().map(|t| t.to_string_lossy()).unwrap_or_default(), props.AlbumTitle().map(|t| t.to_string_lossy()).unwrap_or_default());
        if let Some((k, v)) = ART.lock().ok()?.as_ref() {
            if *k == key {
                return v.clone();
            }
        }
        let read = || -> Option<String> {
            use windows::Storage::Streams::DataReader;
            let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
            let size = stream.Size().ok()? as u32;
            if size == 0 || size > 4 * 1024 * 1024 {
                return None;
            }
            let reader = DataReader::CreateDataReader(&stream).ok()?;
            reader.LoadAsync(size).ok()?.get().ok()?;
            let mut buf = vec![0u8; size as usize];
            reader.ReadBytes(&mut buf).ok()?;
            data_url(&stream.ContentType().map(|c| c.to_string_lossy()).unwrap_or_default(), &buf)
        };
        let v = read();
        if let Ok(mut a) = ART.lock() {
            *a = Some((key, v.clone()));
        }
        v
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
    pub fn art() -> Option<String> {
        None
    }
}

pub use imp::{art, now};

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

    #[test]
    fn position_runs_on_while_playing() {
        let s = 10_000_000; // 1 s in ticks
        assert_eq!(live_position(30 * s, 200 * s, 1000 * s, 1002 * s, true), 32_000);
        assert_eq!(live_position(30 * s, 200 * s, 1000 * s, 1002 * s, false), 30_000, "paused: as reported");
        assert_eq!(live_position(199 * s, 200 * s, 1000 * s, 1010 * s, true), 200_000, "never past the end");
        assert_eq!(live_position(-5, 0, 0, 10, true), 0);
    }

    #[test]
    fn covers_become_data_urls() {
        assert_eq!(data_url("image/png", &[1, 2, 3]).as_deref(), Some("data:image/png;base64,AQID"));
        assert_eq!(data_url("", &[0xff, 0xd8, 0xff]).as_deref(), Some("data:image/jpeg;base64,/9j/"));
        assert_eq!(data_url("text/html", b"<script>"), None, "only images");
        assert_eq!(data_url("image/png", &[]), None);
    }
}
