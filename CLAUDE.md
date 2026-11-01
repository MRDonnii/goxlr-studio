# GoXLR Studio

Windows-app (Tauri 2: Rust + vanilla JS) der erstatter TC-Helicons GoXLR-app, Equalizer APO/Peace og lyd-hotkey-værktøjer. Svar brugeren på dansk.

## Arkitektur
- `public/` – UI (ES-moduler, ingen build). `js/api.js` taler med GoXLR Utility-daemonen (via Tauri-kommandoen `daemon_request` eller WebSocket i browser) og falder tilbage til `js/demo.js` når der ingen daemon er.
- `src-tauri/src/daemon.rs` – WebSocket-klient til GoXLR Utility (`ws://127.0.0.1:14564/api/websocket`), JSON-patches sendes som `daemon-patch`-events.
- `src-tauri/src/audio.rs` – Windows Core Audio: list enheder + skift standardenhed (IPolicyConfig).
- `src-tauri/src/apo.rs` – afspilnings-EQ: skriver filtre til `%ProgramData%\GoXLR Studio\GoXLR Studio.txt`; "Overtag APO" sætter én Include-linje i APO's config.txt (backup gemmes) via UAC.
- `src-tauri/src/lib.rs` – kommandoer, bakke-ikon, globale genveje (Ctrl+Alt+1–9 scener, Ctrl+Alt+M mute), luk-til-bakke, autostart.
- Kommando-/statusformater kommer fra GoXLR Utility: `ipc/src/lib.rs` og `ipc/src/device.rs` i github.com/GoXLR-on-Linux/goxlr-utility.

## Test
- `node --test tests/*.test.mjs` – EQ-matematik, APO-parser, JSON-patch.
- `STUDIO_PORT=14600 node server.js` – UI i browser (demo-tilstand uden daemon; proxier til daemon hvis den kører).
- Rust: `cd src-tauri && cargo check --target x86_64-pc-windows-msvc`. Fuldt byg sker i GitHub Actions (`.github/workflows/build.yml`) → artifact med installer + portable .exe; tag `v*` laver en release.

## Regler
- Ingen personlige data i repoet; commits med noreply-identitet.
- Firmware til GoXLR'en røres ikke (lukket, risiko for brick).
