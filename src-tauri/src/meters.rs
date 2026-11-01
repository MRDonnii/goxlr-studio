//! Live audio levels for the VU meters: a background thread reads Windows' peak meter of every
//! active output/input (the GoXLR's System, Game, Chat, Music … endpoints) about 30 times a second.
//! It only runs while the UI keeps asking, so it costs nothing when the window is hidden.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

static LEVELS: Mutex<Option<HashMap<String, f32>>> = Mutex::new(None);
static RUNNING: AtomicBool = AtomicBool::new(false);
static LAST_ASK: AtomicU64 = AtomicU64::new(0);

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Current peak (0.0–1.0) per endpoint id.
pub fn levels() -> HashMap<String, f32> {
    LAST_ASK.store(now_ms(), Ordering::SeqCst);
    if !RUNNING.swap(true, Ordering::SeqCst) {
        std::thread::spawn(run);
    }
    LEVELS.lock().unwrap().clone().unwrap_or_default()
}

#[cfg(windows)]
fn run() {
    use windows::Win32::Media::Audio::Endpoints::IAudioMeterInformation;
    use windows::Win32::Media::Audio::{eCapture, eRender, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let enumerate = || -> Vec<(String, IAudioMeterInformation)> {
        let mut out = Vec::new();
        unsafe {
            let Ok(en) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else { return out };
            for flow in [eRender, eCapture] {
                let Ok(col) = en.EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE) else { continue };
                let n = col.GetCount().unwrap_or(0);
                for i in 0..n {
                    let Ok(dev) = col.Item(i) else { continue };
                    let Ok(raw) = dev.GetId() else { continue };
                    let id = raw.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(raw.0 as _));
                    if let Ok(meter) = dev.Activate::<IAudioMeterInformation>(CLSCTX_ALL, None) {
                        out.push((id, meter));
                    }
                }
            }
        }
        out
    };
    let mut meters = enumerate();
    let mut enumerated = std::time::Instant::now();
    loop {
        if now_ms().saturating_sub(LAST_ASK.load(Ordering::SeqCst)) > 4000 {
            break;
        }
        if enumerated.elapsed() > std::time::Duration::from_secs(5) {
            meters = enumerate();
            enumerated = std::time::Instant::now();
        }
        let map: HashMap<String, f32> = meters.iter().filter_map(|(id, m)| unsafe { m.GetPeakValue() }.ok().map(|p| (id.clone(), p))).collect();
        *LEVELS.lock().unwrap() = Some(map);
        std::thread::sleep(std::time::Duration::from_millis(33));
    }
    drop(meters);
    *LEVELS.lock().unwrap() = None;
    RUNNING.store(false, Ordering::SeqCst);
}

#[cfg(not(windows))]
fn run() {
    RUNNING.store(false, Ordering::SeqCst);
}
