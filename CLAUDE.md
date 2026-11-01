# GoXLR Studio

Selvstændig Windows-app (Tauri 2: Rust + vanilla JS) der erstatter GoXLR Utility/TC-Helicons app, Equalizer APO, Peace og AutoHotkey – ét program. Kun TC-Helicons USB-driver skal være installeret. Svar brugeren på dansk.

## Arkitektur
- `public/` – UI (ES-moduler, ingen build). `js/api.js` taler med GoXLR-motoren (via Tauri-kommandoen `daemon_request` eller WebSocket i browser) og falder tilbage til `js/demo.js` når der ingen motor er.
- `src-tauri/src/daemon_host.rs` – **indbygget GoXLR-motor**: GoXLR Utility's `goxlr-daemon.exe` (v1.2.4, MIT) bygges i CI og indlejres (build.rs, env `GOXLR_DAEMON_EXE`); pakkes ud til `%LOCALAPPDATA%\GoXLR Studio\engine\` og startes skjult (`--disable-tray true`) hvis ingen daemon svarer efter 2,5 s; stoppes ved Afslut. Samme profil-/indstillingsmapper som GoXLR Utility (`%APPDATA%\GoXLR-on-Linux\GoXLR-Utility`).
- `src-tauri/src/daemon.rs` – WebSocket-klient til motoren (`ws://127.0.0.1:14564/api/websocket`), JSON-patches sendes som `daemon-patch`-events.
- `src-tauri/src/engine.rs` – **indbygget EQ-motor**: Equalizer APO 1.4.2's motorfiler (GPL, uændrede, hentet + SHA-256-tjekket i CI, indlejret via env `ENGINE_DIR`) installeres i `C:\Program Files\GoXLR Studio Engine` og registreres (regsvr32 + port af Equalizer APO's `DeviceAPOInfo` install/uninstall: FxProperties, `Child APOs`, ejerskab). `ConfigPath` peger på `%ProgramData%\GoXLR Studio\engine` (overvåges af motoren → ændringer høres straks). Alt med admin kører i en elevated kopi af exe'en: `--engine-task <task.json> <result.json>` (`Task`: install/set-devices/uninstall/use-external/restore-external). En separat Equalizer APO tages backup af (`%ProgramData%\GoXLR Studio\apo-backup-*`) og afinstalleres stille før installation.
- `src-tauri/src/apo.rs` – renderer EQ til APO-syntaks og skriver `config.txt` i motorens mappe; finder gamle Peace/APO-presets (separat installation eller backups).
- `src-tauri/src/migrate.rs` – Overflytning: scanner AutoHotkey (inkl. Startup-genveje), TC-Helicon-profiler, APO/Peace; fuld backup til `%APPDATA%\GoXLR Studio\backup\<tid>`; liste over gamle programmer (Uninstall-nøgler) med kategori keep/replace/engine/check og start af deres afinstallation.
- `src-tauri/src/audio.rs` – Windows Core Audio: list enheder + skift standardenhed (IPolicyConfig). `apps.rs` – lyd pr. app.
- `src-tauri/src/lib.rs` – kommandoer, bakke-ikon (rød prik ved mute), frie globale genveje (`set_hotkeys`), luk-til-bakke, autostart, `helper_main` (CLI-tilstande).
- `src-tauri/src/osd.rs` – OSD-vindue (`public/osd.html`), vises uden at tage fokus; springes over når hovedvinduet har fokus.
- `src-tauri/src/api.rs` – lokalt HTTP-API (token påkrævet): `/state`, `/actions`, `/action/<id>` → event `api-action`.
- `src-tauri/src/update.rs` – auto-opdatering fra GitHub-releases (kun URL'er under repoets releases/download, SHA-256 fra GitHubs `digest`), installer `/S` eller udskift portable exe.
- `src-tauri/src/keys.rs` – `send_keys` (SendInput af en genvej) og `discord_running`. `meters.rs` – peak-niveauer til VU-metre.
- `public/js/extras.js` – rene hjælpere (enhed-navne-fallback, crossfeed/loudness, AutoEQ, versioner, app-triggers, AutoHotkey-parser `parseAhk`, `faderLeds`, `micMutedForChat`) med tests i `tests/extras.test.mjs`.
- `THIRD-PARTY-NOTICES.md` + `licenses/` – licenser for de indlejrede motorer; release vedlægger `EqualizerAPO-src-1.4.2.zip`.
- Kommando-/statusformater kommer fra GoXLR Utility: `ipc/src/lib.rs` og `ipc/src/device.rs` i github.com/GoXLR-on-Linux/goxlr-utility.

## Test
- `node --test tests/*.test.mjs` – EQ-matematik, APO-parser, JSON-patch, extras (AHK-import, AutoEQ, opdatering m.m.).
- `cd src-tauri && cargo test --lib` (Linux kræver webkit2gtk/gtk-dev) – motor-registrering, migrering, API.
- `STUDIO_PORT=14600 node server.js` – UI i browser (demo-tilstand uden daemon; `?mini` = GoXLR Mini; motorer og overflytning simuleres i `native.js`).
- Rust: `cd src-tauri && cargo check --target x86_64-pc-windows-msvc`. Med indlejrede motorer: sæt `ENGINE_DIR` (mappe med de 8 motorfiler), `ENGINE_VERSION`, `GOXLR_DAEMON_EXE`. Fuldt byg sker i GitHub Actions (`.github/workflows/build.yml`).

## Regler
- Ingen personlige data i repoet; commits med noreply-identitet.
- Firmware til GoXLR'en røres ikke (lukket, risiko for brick).

## Status og næste skridt
Version 0.3.2 – selvstændig. Færdigt:
- Indbygget GoXLR-motor og EQ-motor (se Arkitektur), siden **Overflytning** (backup, AHK→genveje, Peace-presets, TC-Helicon-profiler, "husk lyd pr. app", afinstallér gamle programmer; driveren markeres BEHOLD), EQ-motor-kort med valg af udgange.
- 0.3.2: VU-metre ved hver fader (`meters.rs`: baggrundstråd læser Windows' `IAudioMeterInformation` for alle aktive endpoints ~30 Hz mens UI'et spørger; `audio_levels`; mic fra daemonens `GetMicLevel`; kanal→GoXLR-udgang via `channelEndpoint`); EQ-motor kan sættes på "en anden måde" (`mode`: lfx-gfx/sfx-efx/sfx-mfx = Equalizer APO's fejlfindingsmuligheder) hvis EQ ikke høres; Lyd pr. app: "Tilføj regel" for apps der ikke kører, "Husk" vælger processen der har en enhed (Discord).
- 0.3.1: mixerens faders tegnes som hardwarens 15 LED'er (`faderLeds`: `colour_one` = over knappen, `colour_two` = under; Gradient blender under knappen), demo matcher Mini-layoutet; Discord-mute-synk (`discord.js`: når GoXLR-mic-mute mod voice chat skifter, trykkes Discords "Toggle Mute"-genvej via `send_keys`/SendInput, standard Ctrl+Shift+Alt+D, kun hvis Discord kører); dansk README med download-link.
- Fra 0.2: genveje, lyd pr. app, bakkemenu, hurtig-skift, preset-chips, AutoEQ, EQ følger profil, crossfeed/loudness, OSD, API, backup, Diagnose, auto-opdatering.
- Release: hæv `version` i `src-tauri/tauri.conf.json` (+ Cargo.toml/package.json) og push til main → bygget opretter selv tag `v<version>` og GitHub-release (tag-push er blokeret fra cloud-sessioner) med `*-setup.exe`, `.msi`, `GoXLR-Studio-portable.exe`, `THIRD-PARTY-NOTICES.md` og APO-kildekoden.

Næste skridt:
- Test hos brugeren på Windows: "Erstat med indbygget motor" (afinstallerer Equalizer APO efter backup), at EQ høres på GoXLR-udgangene, at den indbyggede GoXLR-motor overtager efter afinstallation af GoXLR Utility, AHK-import, OSD i spil.
- GoXLR Studios egen afinstallation fjerner ikke EQ-motoren endnu (brug "Fjern EQ-motor" først). `goxlr-studio.exe --engine-uninstall` findes; mangler NSIS-hook der springer over ved opdatering.
- Mulige forbedringer: niveaumåler i bakken, MQTT, signerede opdateringer.
