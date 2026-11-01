//! GoXLR Utility's daemon (v1.2.4, MIT – see ../LICENSE) as a library, so GoXLR Studio runs the
//! GoXLR engine on a thread inside its own process instead of as a separate goxlr-daemon.exe.
//!
//! This file is upstream's `daemon/src/main.rs`; changes are marked "GoXLR Studio:". The rest of
//! the engine is upstream's code (see ../README.md for the full list of changes).

extern crate core;

use std::fs::create_dir_all;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::time::Duration;

use actix_web::dev::ServerHandle;
use anyhow::{Context, Result, bail};
use clap::Parser;
use enum_map::EnumMap;
use file_rotate::compression::Compression;
use file_rotate::suffix::AppendCount;
use file_rotate::{ContentLimit, FileRotate};
use json_patch::Patch;
use lazy_static::lazy_static;
use log::{debug, error, info, warn};
use simplelog::{
    ColorChoice, CombinedLogger, ConfigBuilder, TermLogger, TerminalMode, WriteLogger,
};
use sys_locale::get_locale;

use tokio::join;
use tokio::sync::{broadcast, mpsc, oneshot};

use goxlr_ipc::{FirmwareSource, HttpSettings, LogLevel};

use crate::cli::{Cli, LevelFilter};
use crate::events::{DaemonState, EventTriggers, spawn_event_handler};
use crate::files::{FileManager, spawn_file_notification_service};
use crate::platform::perform_preflight;
use crate::platform::spawn_runtime;
use crate::primary_worker::spawn_usb_handler;
use crate::servers::http_server::spawn_http_server;
use crate::servers::ipc_server::{bind_socket, spawn_ipc_server};
use crate::settings::SettingsHandle;
use crate::shutdown::Shutdown;
use crate::tts::spawn_tts_service;

mod audio;
mod cli;
mod device;
mod events;
mod files;
mod firmware;
mod mic_profile;
mod platform;
mod primary_worker;
mod profile;
mod servers;
mod settings;
mod shutdown;
mod tray;
mod tts;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[allow(dead_code)]
const ICON: &[u8] = include_bytes!("../resources/goxlr-utility-large.png");

const FIRMWARE_PATHS: EnumMap<FirmwareSource, &str> = EnumMap::from_array([
    "https://utility.frostycoolslug.com/update-site/stable/",
    "https://utility.frostycoolslug.com/update-site/beta/",
]);

/**
This is ugly, and I know it's ugly. I need to rework how the Primary Worker is constructed
so that various variables can be easily passed through it down to the device level via a struct
rather than through additional parameters. When that comes, this will be removed!
*/
static OVERRIDE_SAMPLER_INPUT: Mutex<Option<String>> = Mutex::new(None);
static OVERRIDE_SAMPLER_OUTPUT: Mutex<Option<String>> = Mutex::new(None);

/**
This is also ugly, but for now it's important to allow users to simply disable aggregate
management, and have the utility obey.
*/
pub static HANDLE_MACOS_AGGREGATES: Mutex<Option<bool>> = Mutex::new(Some(true));

lazy_static! {
    /**
    This is a fetcher of the system locale, used for language and translations of the UI.
    the sys-locale package should give us valid readings on Linux, MacOS and Windows
     */
    static ref SYSTEM_LOCALE: String = get_locale()
        .unwrap_or_else(|| String::from("en_GB"))
        .replace('-', "_");
}

// This is for global 'JSON Patches', for when something changes.
#[derive(Debug, Clone)]
pub struct PatchEvent {
    pub data: Patch,
}

// ---------------------------------------------------------------------------------------------
// GoXLR Studio: control of the engine from the host application (replaces upstream's `main`).
// ---------------------------------------------------------------------------------------------

type Hook = Box<dyn Fn() + Send + Sync>;

static ACTIVATE_HOOK: Mutex<Option<Hook>> = Mutex::new(None);
static GLOBAL_TX: Mutex<Option<mpsc::Sender<EventTriggers>>> = Mutex::new(None);
static READY: AtomicBool = AtomicBool::new(false);
static LOGGER: Once = Once::new();

/// Called whenever something asks the engine to show its UI (a client's "Activate"/"OpenUi").
/// GoXLR Studio shows its own window; GoXLR Utility's UI is never opened.
pub fn set_activate_hook(hook: impl Fn() + Send + Sync + 'static) {
    *ACTIVATE_HOOK.lock().unwrap() = Some(Box::new(hook));
}

pub(crate) fn activate_ui() {
    if let Some(hook) = ACTIVATE_HOOK.lock().unwrap().as_ref() {
        hook();
    }
}

/// True while the engine is running and its IPC and HTTP/WebSocket API are up.
pub fn is_ready() -> bool {
    READY.load(Ordering::Relaxed)
}

/// Asks a running engine to shut down cleanly (what "Quit" in GoXLR Utility's tray did).
pub fn request_stop() -> bool {
    let tx = GLOBAL_TX.lock().unwrap().clone();
    match tx {
        Some(tx) => tx.try_send(EventTriggers::Stop(false)).is_ok(),
        None => false,
    }
}

/// Runs the engine until it is stopped and returns why it stopped. Blocks the calling thread,
/// which also runs the engine's hidden window for Windows shutdown/sleep/lock messages, so call
/// it on a dedicated thread. It can be called again after it has returned.
pub fn run() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("goxlr-engine")
        .build()
        .context("Could not start the GoXLR engine")?;
    let result = runtime.block_on(run_utility());
    READY.store(false, Ordering::Relaxed);
    GLOBAL_TX.lock().unwrap().take();
    runtime.shutdown_timeout(Duration::from_secs(3));
    if let Err(e) = &result {
        error!("GoXLR engine stopped: {e:#}");
    }
    result
}

async fn run_utility() -> Result<()> {
    // GoXLR Studio: the process' command line belongs to GoXLR Studio, so the engine always
    // starts with the daemon's defaults (same settings file as GoXLR Utility).
    let args: Cli = Cli::parse_from(["goxlr-daemon"]);
    let settings = SettingsHandle::load(args.config).await?;

    // Set the MacOS Aggregate management..
    let aggregates = settings.get_macos_handle_aggregates().await;
    HANDLE_MACOS_AGGREGATES.lock().unwrap().replace(aggregates);

    // Configure and / or create the log path, and file name.
    let log_path = settings.get_log_directory().await;
    if !log_path.clone().exists()
        && let Err(e) = create_dir_all(log_path.clone())
    {
        bail!("Unable to create log directory: {}", e);
    }
    let log_file = log_path.join("goxlr-daemon.log");

    // We need to ignore a couple of packages log output so create a builder.
    let mut config = ConfigBuilder::new();

    // The tracing package, when used, will output to INFO from zbus every second..
    config.add_filter_ignore_str("tracing");

    // Actix is a little noisy on startup and shutdown, so quiet it a bit :)
    config.add_filter_ignore_str("actix_server::accept");
    config.add_filter_ignore_str("actix_server::worker");
    config.add_filter_ignore_str("actix_server::server");
    config.add_filter_ignore_str("actix_server::builder");
    config.add_filter_ignore_str("zbus");
    config.add_filter_ignore_str("hyper_util");
    config.add_filter_ignore_str("reqwest");

    // I'm generally not interested in the Symphonia header announcements which go to INFO,
    // it's only useful in a development setting!
    config.add_filter_ignore_str("symphonia");

    let timezone_calculated = config.set_time_offset_to_local().is_ok();

    // Configure the log level, prioritise the CLI, but otherwise config.
    let log_level = if let Some(cli_level) = args.log_level {
        match cli_level {
            LevelFilter::Off => log::LevelFilter::Off,
            LevelFilter::Error => log::LevelFilter::Error,
            LevelFilter::Warn => log::LevelFilter::Warn,
            LevelFilter::Info => log::LevelFilter::Info,
            LevelFilter::Debug => log::LevelFilter::Debug,
            LevelFilter::Trace => log::LevelFilter::Trace,
        }
    } else {
        match settings.get_log_level().await {
            LogLevel::Off => log::LevelFilter::Off,
            LogLevel::Error => log::LevelFilter::Error,
            LogLevel::Warn => log::LevelFilter::Warn,
            LogLevel::Info => log::LevelFilter::Info,
            LogLevel::Debug => log::LevelFilter::Debug,
            LogLevel::Trace => log::LevelFilter::Trace,
        }
    };

    // GoXLR Studio: a process can only install one logger, and the engine may be started more
    // than once while GoXLR Studio runs, so the logger (and the panic logger) is set up once.
    LOGGER.call_once(|| {
        // Create a file rotator, that will compress and rotate files after 5Mb
        let file_rotator = FileRotate::new(
            log_file,
            AppendCount::new(5),
            ContentLimit::Bytes(1024 * 1024 * 2),
            Compression::OnRotate(1),
            None,
        );

        // Create the loggers :)
        let _ = CombinedLogger::init(vec![
            TermLogger::new(
                log_level,
                config.build(),
                TerminalMode::Mixed,
                ColorChoice::Auto,
            ),
            WriteLogger::new(log_level, config.build(), file_rotator),
        ]);

        // Enable the PANIC logger..
        log_panics::init();
    });

    if !timezone_calculated {
        warn!("Unable to calculate timezone, using UTC for log timestamps");
    }

    if is_root() {
        // GoXLR Studio: never exit the host process from inside the engine.
        bail!("The GoXLR engine is not designed to be run as root");
    }

    if let Some(device) = args.override_sample_input_device {
        OVERRIDE_SAMPLER_INPUT.lock().unwrap().replace(device);
    }

    if let Some(device) = args.override_sample_output_device {
        OVERRIDE_SAMPLER_OUTPUT.lock().unwrap().replace(device);
    }

    info!("Starting GoXLR Daemon v{} (inside GoXLR Studio)", VERSION);
    info!("System Locale: {}", *SYSTEM_LOCALE);

    // Before we do anything, perform platform pre-flight to make
    // sure we're allowed to start.
    info!("Performing Platform Preflight...");
    perform_preflight()?;

    let bind_address = if let Some(address) = args.http_bind_address {
        debug!("Command Line Override, binding to: {}", address);
        address
    } else if settings.get_allow_network_access().await {
        String::from("0.0.0.0")
    } else {
        String::from("localhost")
    };

    debug!("HTTP Bind Address: {}", bind_address);
    let http_settings = HttpSettings {
        enabled: !args.http_disable,
        bind_address,
        cors_enabled: args.http_enable_cors,
        port: args.http_port,
    };

    // Create the Global Event Channel..
    let (global_tx, global_rx) = mpsc::channel(32);
    // GoXLR Studio: keep a sender so the host can stop the engine.
    GLOBAL_TX.lock().unwrap().replace(global_tx.clone());

    // Create the 'Patch' Sending Channel..
    let (broadcast_tx, broadcast_rx) = broadcast::channel(16);
    drop(broadcast_rx);

    // Create the USB Event Channel..
    let (usb_tx, usb_rx) = mpsc::channel(32);

    // Create the TTS Event Channel..
    let (tts_sender, tts_rx) = mpsc::channel(32);

    // Create the HTTP Run Channel..
    let (httpd_tx, httpd_rx) = tokio::sync::oneshot::channel();

    // Create the Device shutdown signallers..
    let (device_state_tx, device_state_rx) = mpsc::channel(1);

    // Create the Shutdown Signallers..
    let shutdown = Shutdown::new();
    let shutdown_blocking = Arc::new(AtomicBool::new(false));

    // GoXLR Studio: never show GoXLR Utility's tray icon, GoXLR Studio has its own.
    let show_tray = Arc::new(AtomicBool::new(false));

    // Configure, and Start the File Manager Service..
    let file_manager = FileManager::new(&settings).await;
    let file_paths = file_manager.paths().clone();

    let (file_tx, file_rx) = mpsc::channel(20);
    let file_handle = tokio::spawn(spawn_file_notification_service(
        file_paths.clone(),
        file_tx,
        shutdown.clone(),
    ));

    // Spawn the IPC Socket..
    let ipc_socket = bind_socket().await;
    if let Err(e) = ipc_socket {
        error!("Error Binding IPC Socket: {}", e);
        shutdown.trigger();
        bail!("{}", e);
    }

    let (ready_tx, ready_rx) = oneshot::channel();

    // Start the USB Device Handler
    let usb_handle = tokio::spawn(spawn_usb_handler(
        usb_rx,
        file_rx,
        device_state_rx,
        broadcast_tx.clone(),
        global_tx.clone(),
        ready_tx,
        shutdown.clone(),
        settings.clone(),
        http_settings.clone(),
        file_manager,
    ));

    // Wait until the handler is setup
    let _ = ready_rx.await;

    // Launch the IPC Server..
    let ipc_socket = ipc_socket?;
    let communications_handle = tokio::spawn(spawn_ipc_server(
        ipc_socket,
        usb_tx.clone(),
        shutdown.clone(),
    ));

    // Run the HTTP Server (if enabled)..
    let mut http_server: Result<Option<ServerHandle>> = Ok(None);
    if http_settings.enabled {
        // Spawn a oneshot channel for managing the HTTP Server
        if http_settings.cors_enabled {
            warn!("HTTP Cross Origin Requests enabled, this may be a security risk.");
        }

        tokio::spawn(spawn_http_server(
            usb_tx.clone(),
            httpd_tx,
            broadcast_tx.clone(),
            http_settings.clone(),
            file_paths.clone(),
        ));
        http_server = httpd_rx.await?;
        if let Err(e) = http_server {
            // Force a shutdown, if we bail! here, the entire async runtime will keep on going
            // despite the server being pretty much dead, and threads may still be active causing
            // us to go zombie.
            shutdown.trigger();
            bail!("Unable to Start HTTP Server: {}", e);
        }
    } else {
        warn!("HTTP Server Disabled");
    }

    // Start the TTS Service..
    let tts_handle = tokio::spawn(spawn_tts_service(
        settings.clone(),
        tts_rx,
        shutdown.clone(),
    ));

    let mut local_shutdown = shutdown.clone();
    let state = DaemonState {
        tts_sender,

        show_tray,
        shutdown,
        shutdown_blocking,

        settings_handle: settings.clone(),
        http_settings: http_settings.clone(),
    };

    // Spawn the general event handler..
    let event_handle = tokio::spawn(spawn_event_handler(
        state.clone(),
        global_rx,
        device_state_tx,
    ));

    // Spawn the Platform Runtime (if needed)
    let platform_handle = tokio::spawn(spawn_runtime(state.clone(), global_tx.clone()));

    // GoXLR Studio: GoXLR Studio is the UI, so the engine never opens one on launch.
    READY.store(true, Ordering::Relaxed);

    // Tray management has to occur on the main thread, so we'll start it now.
    // GoXLR Studio: this runs on the engine's own thread. Without it the engine still works, it
    // just can't react to Windows shutdown/sleep, so a failure is logged instead of fatal.
    if let Err(e) = tray::handle_tray(state.clone(), global_tx.clone()) {
        warn!("Unable to create the engine's message window: {e}");
    }

    // If the tray handler dies for any reason, we should still make sure we've been asked to
    // shut down.
    local_shutdown.recv().await;
    info!("Shutting down daemon");
    READY.store(false, Ordering::Relaxed);

    if let Ok(Some(server)) = http_server {
        // We only need to Join on the HTTP Server if it exists..
        let _ = join!(
            usb_handle,
            communications_handle,
            server.stop(false),
            file_handle,
            tts_handle,
            event_handle,
            platform_handle
        );
    } else {
        let _ = join!(
            usb_handle,
            communications_handle,
            file_handle,
            tts_handle,
            event_handle,
            platform_handle
        );
    }
    Ok(())
}

#[cfg(target_family = "unix")]
fn is_root() -> bool {
    nix::unistd::Uid::effective().is_root()
}

#[cfg(not(target_family = "unix"))]
fn is_root() -> bool {
    // On non-unix systems, we can't root check, assume we're good!
    false
}
