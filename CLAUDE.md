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

## Status og næste skridt
Færdigt og typetjekket (Rust): `set_hotkeys` (frie globale genveje, event `hotkey` med binding-id), `app_sessions`/`set_app_device` (lyd pr. app via IAudioPolicyConfigFactory), `apo_list_configs` (alle Peace/APO-presets), `apo_open_configurator`, `output_eq_status.devices` (APO aktiv pr. enhed), `set_tray` (bakkemenu med GoXLR-profiler, EQ-presets, scener). Frontend: `js/actions.js` (handlingskatalog + `runAction`), `js/views-hotkeys.js` (genvejs-side med tastefangst), GraphicEQ-import i `eq.js`.

Mangler (frontend-wiring):
1. `app.js`: tilføj siderne Genveje (`hotkeysView`) og Lyd pr. app; `ctx.hotkeys` (store-nøgle `hotkeys`, `[{id, accel, action}]`), `ctx.hotkeyStatus`, `ctx.saveHotkeys()` → `setHotkeys(...)`, `ctx.runAction`, `pauseHotkeys/resumeHotkeys` (unregister under tastefangst); lyt på Tauri-event `hotkey` og `tray-action` (`profile:…`, `eq-preset:…`, `eq-toggle`, `scene:…`, `mute-mic`) → `runAction`; erstat `set_scenes` med `setTray({scenes, profiles, active_profile, eq_presets, active_eq, eq_enabled})` ved ændringer; kommandopaletten skal bruge `actionCatalog`.
2. Ny `views-apps.js`: liste over `appSessions()` med udgang/mikrofon-valg (marker forældede id'er der ikke er blandt aktive enheder), regler `exe → output/input` (store `app-rules`) der håndhæves hvert 5. s, og "ret forældede automatisk".
3. `views-outeq.js`: preset-bar øverst (chips, aktiv = `state.presetName`, klik = `applyEqPreset`), knap "Importér alle Peace-presets" (`apoListConfigs()` → `parseApoConfig` pr. fil, spring tomme over), vis APO-status for valgt udgang fra `engine.devices` + knap til Configurator.
4. Scener: del `profile` (gem `profile_name`/`mic_profile_name`, indlæs først i `applyScene`).
5. Skjul Effekter-siden for Mini (`hardware.device_type === 'Mini'`).
6. Kør `node --test tests/*.test.mjs`, UI-test i browser (demo), `cargo check --target x86_64-pc-windows-msvc`, push → tjek Actions-bygget.
