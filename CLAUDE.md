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
Færdigt (backend + frontend):
- Frie globale genveje (`views-hotkeys.js`, store `hotkeys` = `[{id, accel, action}]`). Første start seeder Ctrl+Alt+M (mute) og Ctrl+Alt+1–9 for eksisterende scener; nye scener får næste ledige Ctrl+Alt+tal. Forslag med "Tilføj alle" til F13/F14 og Ctrl+PgUp/PgDn (Headset/Speakers). I browseren virker genvejene kun i fokuseret fane.
- `app.js`: Tauri-events `hotkey` (binding-id) og `tray-action` (action-id) → `runAction`; `syncTray()` kalder `setTray(...)` ved ændringer; topbjælke med hurtig-skift af GoXLR-profil, EQ til/fra + EQ-preset og de 3 første scener; kommandopaletten bygger på `actionCatalog` og viser genveje.
- Lyd pr. app (`views-apps.js`): apps grupperet pr. exe, forældede enheds-id'er markeres, regler (store `app-rules`) håndhæves hvert 5. s globalt (`startAppRules`), "Ret forældede nu" + pref `fixStaleApps`.
- Afspilnings-EQ: preset-chips øverst, "Importér alle Peace-presets", APO-status pr. udgang + knap til Configurator.
- Scener kan medtage GoXLR-profil/mikrofonprofil (indlæses først). Effekter-siden skjules for Mini (`?mini` i URL'en giver Mini i demo).

Næste skridt:
- Test i den rigtige Windows-app hos brugeren: genvejsregistrering mens AutoHotkey kører (skal vise "Optaget"), lyd pr. app på Windows 11, Peace-import med brugerens filer.
- Overvej at vise "ændret" på aktivt EQ-preset når båndene er redigeret.
