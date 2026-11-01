# GoXLR Studio

Windows-app (Tauri 2: Rust + vanilla JS) der erstatter TC-Helicons GoXLR-app, Equalizer APO/Peace og lyd-hotkey-værktøjer. Svar brugeren på dansk.

## Arkitektur
- `public/` – UI (ES-moduler, ingen build). `js/api.js` taler med GoXLR Utility-daemonen (via Tauri-kommandoen `daemon_request` eller WebSocket i browser) og falder tilbage til `js/demo.js` når der ingen daemon er.
- `src-tauri/src/daemon.rs` – WebSocket-klient til GoXLR Utility (`ws://127.0.0.1:14564/api/websocket`), JSON-patches sendes som `daemon-patch`-events.
- `src-tauri/src/audio.rs` – Windows Core Audio: list enheder + skift standardenhed (IPolicyConfig).
- `src-tauri/src/apo.rs` – afspilnings-EQ: skriver filtre til `%ProgramData%\GoXLR Studio\GoXLR Studio.txt`; "Overtag APO" sætter én Include-linje i APO's config.txt (backup gemmes) via UAC.
- `src-tauri/src/lib.rs` – kommandoer, bakke-ikon (rød prik ved mute), frie globale genveje (`set_hotkeys`), luk-til-bakke, autostart, `start_daemon`.
- `src-tauri/src/osd.rs` – OSD-vindue (`public/osd.html`), vises uden at tage fokus; springes over når hovedvinduet har fokus.
- `src-tauri/src/api.rs` – lokalt HTTP-API (token påkrævet): `/state`, `/actions`, `/action/<id>` → event `api-action`.
- `src-tauri/src/update.rs` – auto-opdatering fra GitHub-releases (kun URL'er under repoets releases/download, SHA-256 fra GitHubs `digest`), installer `/S` eller udskift portable exe.
- `public/js/extras.js` – rene hjælpere (enhed-navne-fallback, crossfeed/loudness, AutoEQ, versioner, app-triggers) med tests i `tests/extras.test.mjs`.
- Kommando-/statusformater kommer fra GoXLR Utility: `ipc/src/lib.rs` og `ipc/src/device.rs` i github.com/GoXLR-on-Linux/goxlr-utility.

## Test
- `node --test tests/*.test.mjs` – EQ-matematik, APO-parser, JSON-patch.
- `STUDIO_PORT=14600 node server.js` – UI i browser (demo-tilstand uden daemon; proxier til daemon hvis den kører).
- Rust: `cd src-tauri && cargo check --target x86_64-pc-windows-msvc`. Fuldt byg sker i GitHub Actions (`.github/workflows/build.yml`) → artifact med installer + portable .exe; tag `v*` laver en release.

## Regler
- Ingen personlige data i repoet; commits med noreply-identitet.
- Firmware til GoXLR'en røres ikke (lukket, risiko for brick).

## Status og næste skridt
Version 0.2.0. Færdigt:
- Genveje, lyd pr. app (regler, ret forældede, automatik når en app starter/lukker), bakkemenu, hurtig-skift i topbjælken, kommandopalet over `actionCatalog`.
- Afspilnings-EQ: preset-chips med "ændret"-prik, Peace-import, AutoEQ-søgning, EQ følger GoXLR-profil (`outputEq.profileLinks`), crossfeed + loudness (`outputEq.extras`, sendes som `extra`-linjer/ekstra bånd), APO-status pr. udgang, APO-vagthund (banner når Peace har overskrevet config.txt).
- Enheder huskes med navn (`*_name`) i scener, app-regler og EQ-udgang, så de findes igen efter driver-opdateringer.
- OSD ovenpå spil, rød prik i bakke-ikonet ved mute, start af GoXLR Utility, lokalt API, backup/gendan, Diagnose-side, auto-opdatering (tjek hver 6. time, auto-installation når appen ligger i bakken).
- Release: hæv `version` i `src-tauri/tauri.conf.json` (+ Cargo.toml/package.json) og push til main → bygget opretter selv tag `v<version>` og GitHub-release (tag-push er blokeret fra cloud-sessioner) med `*-setup.exe`, `.msi` og `GoXLR-Studio-portable.exe` (auto-opdatering vælger setup eller portable).

Næste skridt:
- Test hos brugeren på Windows: OSD i spil (fokus må ikke stjæles), genveje med AutoHotkey kørende, lyd pr. app, Peace-import, APO-vagthund, opdatering fra 0.2.0 → 0.2.1.
- Mulige forbedringer: niveaumåler i bakken, MQTT, signerede opdateringer (tauri-plugin-updater kræver en hemmelig nøgle i repo-secrets).
