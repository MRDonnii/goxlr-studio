# goxlr-engine

GoXLR Utility's daemon (`daemon/` from [GoXLR-on-Linux/goxlr-utility](https://github.com/GoXLR-on-Linux/goxlr-utility) v1.2.4, MIT – see `LICENSE`) turned into a library, so GoXLR Studio runs the GoXLR engine on a thread inside its own process. The other GoXLR Utility crates (`goxlr-usb`, `goxlr-ipc`, `goxlr-types`, `goxlr-audio`, `goxlr-profile-loader`, `goxlr-scribbles`) are used unchanged from the same release tag.

Changes from upstream (marked `GoXLR Studio:` in the code):

- `src/main.rs` → `src/lib.rs`: `run()` (blocking, restartable), `request_stop()`, `is_ready()`, `set_activate_hook()` instead of `main()`; no command line of its own; no message box or process exit on errors (they are returned to GoXLR Studio); the logger is installed once per process; the tray icon is never shown and no UI is opened on launch; `log_directory()` tells GoXLR Studio where goxlr-daemon.log is.
- `src/events.rs`: "Activate"/"OpenUi" show GoXLR Studio's window instead of GoXLR Utility's UI.
- `src/platform/mod.rs`: autostart is left to GoXLR Studio (no `GoXLR Utility.lnk`).
- `src/platform/windows.rs`: the "already running" check looks for another `goxlr-daemon.exe`.
- `src/tray/windows.rs`: the hidden window is called "GoXLR Studio Engine" and its class may already be registered (engine started again).
- `src/servers/http_server.rs` + `web-content/`: GoXLR Utility's web UI is not included (a short page points to GoXLR Studio). The HTTP/WebSocket API on 127.0.0.1:14564 is unchanged.
- `Cargo.toml`: own manifest with the versions of the 1.2.4 workspace; HTTPS (firmware version check) uses Windows' own TLS (native-tls/schannel) instead of rustls; no Windows resource file (GoXLR Studio has its own).
- `Cargo.toml`: the `tts` feature (read-aloud of button changes, switched on by GoXLR Studio) is built without `tolk` (screen-reader bridge that needs MSVC to compile); Windows speaks through WinRT.
- Linux/macOS-only files are removed (GoXLR Studio is Windows-only).
