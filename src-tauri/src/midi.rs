//! Fodpedal: MIDI pedals and controllers. Every MIDI input is opened and each message is sent to
//! the UI as the event `midi` ({ port, data }). New devices are picked up every 3 seconds, so a
//! pedal plugged in later works without restarting. Runs in the background (also with the window
//! hidden in the tray). Windows only (WinMM through midir); elsewhere it does nothing.
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
pub struct MidiMessage {
    pub port: String,
    pub data: Vec<u8>,
}

/// Note on/off and control change only – the messages a pedal, a key or a fader sends.
pub fn wanted(data: &[u8]) -> bool {
    data.len() >= 3 && matches!(data[0] & 0xF0, 0x80 | 0x90 | 0xB0)
}

#[cfg(windows)]
mod imp {
    use super::{wanted, MidiMessage};
    use midir::{Ignore, MidiInput, MidiInputConnection};
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use tauri::{AppHandle, Emitter};

    static RUNNING: AtomicBool = AtomicBool::new(false);
    static PORTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

    pub fn start(app: AppHandle) {
        if RUNNING.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::Builder::new()
            .name("midi".into())
            .spawn(move || {
                let mut open: HashMap<String, MidiInputConnection<()>> = HashMap::new();
                while RUNNING.load(Ordering::SeqCst) {
                    if let Ok(probe) = MidiInput::new("GoXLR Studio") {
                        let names: Vec<String> = probe.ports().iter().filter_map(|p| probe.port_name(p).ok()).collect();
                        open.retain(|name, _| names.contains(name));
                        for name in &names {
                            if open.contains_key(name) {
                                continue;
                            }
                            let Ok(mut input) = MidiInput::new("GoXLR Studio") else { continue };
                            input.ignore(Ignore::All);
                            let Some(port) = input.ports().into_iter().find(|p| input.port_name(p).ok().as_deref() == Some(name.as_str())) else { continue };
                            let app2 = app.clone();
                            let port_name = Arc::new(name.clone());
                            if let Ok(conn) = input.connect(&port, "goxlr-studio-pedal", move |_, data, _| {
                                if wanted(data) {
                                    let _ = app2.emit("midi", MidiMessage { port: port_name.to_string(), data: data.to_vec() });
                                }
                            }, ()) {
                                open.insert(name.clone(), conn);
                            }
                        }
                        *PORTS.lock().unwrap() = open.keys().cloned().collect();
                    }
                    std::thread::sleep(std::time::Duration::from_secs(3));
                }
                open.clear();
                PORTS.lock().unwrap().clear();
            })
            .ok();
    }

    pub fn stop() {
        RUNNING.store(false, Ordering::SeqCst);
    }

    pub fn ports() -> Vec<String> {
        let mut p = PORTS.lock().unwrap().clone();
        p.sort();
        p
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn start(_app: tauri::AppHandle) {}
    pub fn stop() {}
    pub fn ports() -> Vec<String> {
        Vec::new()
    }
}

pub use imp::{ports, start, stop};

#[cfg(test)]
mod tests {
    #[test]
    fn only_notes_and_controls_are_passed_on() {
        assert!(super::wanted(&[0x90, 60, 100]));
        assert!(super::wanted(&[0x81, 60, 0]));
        assert!(super::wanted(&[0xB3, 64, 127]));
        assert!(!super::wanted(&[0xF8]));
        assert!(!super::wanted(&[0xE0, 0, 64]));
        assert!(!super::wanted(&[0xB0, 64]));
    }
}
