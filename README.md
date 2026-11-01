# GoXLR Studio

Moderne Windows-app til GoXLR / GoXLR Mini med indbygget parametrisk afspilnings-EQ.

- Mixer, routing, mikrofon (gate, kompressor, 10-bånds hardware-EQ), effekter, lys og profiler
- Parametrisk EQ til afspilning med import af Equalizer APO- og AutoEQ-filer, A/B, fortryd og lyttetest
- Scener (volumer, mute, routing, Windows-lydenheder, EQ, lys) med globale genveje Ctrl+Alt+1–9
- Hurtigskift af Windows' standard-udgang og -mikrofon, auto-ducking, kommandopalet (Ctrl+K), bakke-ikon

Kræver [GoXLR Utility](https://github.com/GoXLR-on-Linux/goxlr-utility) som baggrundstjeneste. Afspilnings-EQ bruger Equalizer APO's lydmotor i baggrunden; selve APO-programmet skal ikke bruges.

Byg: `cd src-tauri && cargo tauri build` (Windows) – eller hent installeren fra Actions/Releases.
