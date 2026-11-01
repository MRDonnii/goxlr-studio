// This file primarily handles 'global' events which may occur inside the daemon from a potential
// variety of sources, which affect other parts of the daemon.

use crate::primary_worker::DeviceStateChange;
use crate::{SettingsHandle, Shutdown};
use goxlr_ipc::{HttpSettings, PathTypes};
use log::{debug, warn};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::mpsc::{Receiver, Sender};
use tokio::sync::oneshot;
use tokio::{select, signal};

#[derive(Debug)]
#[allow(dead_code)]
pub enum EventTriggers {
    TTSMessage(String),
    Stop(bool),
    Sleep(oneshot::Sender<()>),
    Wake(oneshot::Sender<()>),
    Lock,
    Unlock,
    Open(PathTypes),
    Activate,
    OpenUi,
    DevicesStopped,
}

#[derive(Clone)]
pub struct DaemonState {
    pub show_tray: Arc<AtomicBool>,
    pub http_settings: HttpSettings,

    // TTS Output
    pub tts_sender: Sender<String>,

    // Shutdown Handlers
    pub shutdown: Shutdown,
    pub shutdown_blocking: Arc<AtomicBool>,

    // Settings Handle..
    pub settings_handle: SettingsHandle,
}

pub async fn spawn_event_handler(
    state: DaemonState,
    mut rx: Receiver<EventTriggers>,
    device_state_tx: Sender<DeviceStateChange>,
) {
    let mut triggered_device_stop = false;
    debug!("Starting Event Loop..");
    loop {
        select! {
            Ok(()) = signal::ctrl_c() => {
                debug!("Shutdown Phase 1 Triggered..");

                // Ctrl+C is a generic capture, although we should also check for SIGTERM under Linux..
                if !triggered_device_stop {
                    triggered_device_stop = true;
                    let _ = device_state_tx.send(DeviceStateChange::Shutdown(false)).await;
                }
            },
            Some(event) = rx.recv() => {
                match event {
                    EventTriggers::TTSMessage(message) => {
                        let _ = state.tts_sender.send(message).await;
                    }
                    EventTriggers::Stop(avoid_write) => {
                        if !triggered_device_stop {
                            debug!("Shutdown Phase 1 Triggered..");
                            triggered_device_stop = true;
                            let _ = device_state_tx.send(DeviceStateChange::Shutdown(avoid_write)).await;
                        } else {
                            debug!("Shutdown Phase 1 already in Progress");
                        }
                    }
                    EventTriggers::DevicesStopped => {
                        debug!("Shutdown Phase 2 Triggered..");

                        // This hits after devices have been stopped..
                        state.shutdown.trigger();
                        state.shutdown_blocking.store(true, Ordering::Relaxed);
                        break;
                    }

                    // In the case of Sleep / Wake, code elsewhere is going to be managing the
                    // things like inhibitors, so we need to pass on a sender so they can be
                    // notified when actions have been completed.
                    EventTriggers::Sleep(sender) => {
                        let _ = device_state_tx.send(DeviceStateChange::Sleep(sender)).await;
                    }
                    EventTriggers::Wake(sender) => {
                        let _ = device_state_tx.send(DeviceStateChange::Wake(sender)).await;
                    }
                    EventTriggers::Lock => {
                        debug!("Received Screen Lock Event..");
                    }
                    EventTriggers::Unlock => {
                        debug!("Received Screen Unlock Event");
                    }

                    EventTriggers::Open(path_type) => {
                        if let Err(error) = open::that(match path_type {
                            PathTypes::Profiles => state.settings_handle.get_profile_directory().await,
                            PathTypes::MicProfiles => state.settings_handle.get_mic_profile_directory().await,
                            PathTypes::Presets => state.settings_handle.get_presets_directory().await,
                            PathTypes::Samples => state.settings_handle.get_samples_directory().await,
                            PathTypes::Icons => state.settings_handle.get_icons_directory().await,
                            PathTypes::Logs => state.settings_handle.get_log_directory().await,
                            PathTypes::Backups => state.settings_handle.get_backup_directory().await,
                        }) {
                            warn!("Error Opening Path: {:?}", error);
                        };
                    },
                    // GoXLR Studio: GoXLR Studio is the UI. Requests to open the GoXLR Utility UI
                    // (a client's OpenUi/Activate) show GoXLR Studio's window instead.
                    EventTriggers::OpenUi | EventTriggers::Activate => {
                        crate::activate_ui();
                    }
                }
            },
        }
    }
}

#[allow(dead_code)]
fn get_util_url(state: &DaemonState) -> String {
    let mut host = String::from("localhost");
    if state.http_settings.bind_address != "localhost"
        && &state.http_settings.bind_address != "0.0.0.0"
    {
        host.clone_from(&state.http_settings.bind_address);
    }

    format!("http://{}:{}/", host, state.http_settings.port)
}
