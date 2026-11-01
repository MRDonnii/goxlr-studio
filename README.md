# GoXLR Studio

Ét program til GoXLR og GoXLR Mini på Windows – i stedet for GoXLR Utility, Equalizer APO, Peace og AutoHotkey.

## Hent den

**[⬇ Download nyeste version](https://github.com/MRDonnii/goxlr-studio/releases/latest)** – vælg filen der ender på `x64-setup.exe`.

1. Kør installeren. Windows viser måske "Windows beskyttede din pc" (appen er ikke kodesigneret): klik **Flere oplysninger → Kør alligevel**.
2. Start GoXLR Studio. Den finder selv din GoXLR og starter sin indbyggede GoXLR-motor.
3. Har du brugt andre programmer før, så åbn siden **Overflytning** – den henter dine genveje, EQ-presets og profiler over, tager backup og hjælper dig med at afinstallere det gamle.

Krav: Windows 10/11 og TC-Helicons USB-driver til GoXLR (følger med TC-Helicons app, eller hentes hos TC-Helicon). Driveren gør GoXLR'en til et lydkort i Windows og skal blive installeret.

Appen opdaterer sig selv, når der kommer en ny version.

## Det kan den

- **Mixer** med faders der viser de samme LED-farver som hardwaren, mute, routing, mikrofon (gate, kompressor, EQ), effekter, lys og profiler
- **Hurtig-skift** af GoXLR-profil og EQ-preset fra topbjælken, bakke-ikonet eller frie globale genveje (fx F13/F14 fra G HUB, Ctrl+PgUp/PgDn)
- **Afspilnings-EQ for hele Windows** med indbygget EQ-motor: parametrisk EQ, presets, import af Peace/Equalizer APO-filer, AutoEQ-søgning efter dine hovedtelefoner, crossfeed og loudness, og EQ der skifter med GoXLR-profilen
- **Lyd pr. app** (fx Spotify → Music, Discord → Chat) med regler der holdes, og retning af apps der peger på forældede GoXLR-enheder
- **Discord**: GoXLR'ens mute-knap muter også Discord (via Discords "Slå mikrofonen fra/til"-genvej)
- Scener, auto-ducking, lille visning ovenpå spil ved genveje, lokalt API til Stream Deck/Home Assistant, backup og diagnose

## Indeholder

GoXLR Studio er MIT-licenseret og indeholder to open source-motorer uændret: GoXLR Utility (MIT) og Equalizer APO's lydmotor (GPL v2) – se [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Udvikling

- UI: `public/` (vanilla JS, ingen build) – `STUDIO_PORT=14600 node server.js` kører den i en browser med demo-data.
- Tests: `node --test tests/*.test.mjs` og `cd src-tauri && cargo test --lib`.
- Windows-bygget sker i GitHub Actions; en ny version i `src-tauri/tauri.conf.json` på `main` udgives automatisk.
