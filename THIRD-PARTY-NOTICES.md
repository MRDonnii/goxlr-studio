# Tredjepartskomponenter i GoXLR Studio

GoXLR Studio er MIT-licenseret. Windows-udgaven indeholder desuden disse uændrede komponenter,
som kører som selvstændige programmer/moduler ved siden af appen:

## GoXLR-motoren – GoXLR Utility 1.2.4 (`goxlr-daemon.exe`)
- Kilde: https://github.com/GoXLR-on-Linux/goxlr-utility (tag `v1.2.4`), bygget uændret af GoXLR Studios GitHub Actions.
- Licens: MIT – Copyright (c) 2022 - 2024 Craig McLure, Nathan Adams. Fuld tekst: [`licenses/GoXLR-Utility-MIT.txt`](licenses/GoXLR-Utility-MIT.txt).
- Pakkes ud til `%LOCALAPPDATA%\GoXLR Studio\engine\` og startes skjult af GoXLR Studio.

## EQ-motoren – Equalizer APO 1.4.2 (`EqualizerAPO.dll`)
- Kilde: https://sourceforge.net/projects/equalizerapo/ – den officielle x64-installer (SHA-256 `7403be74…5afa`) hentes i bygget, og
  motorfilerne bruges uændrede. Den tilsvarende kildekode (`EqualizerAPO-src-1.4.2.zip`) ligger ved hver GoXLR Studio-udgivelse.
- Licens: GNU GPL version 2 eller senere – Copyright (C) 2012 Jonas Thedering. Fuld tekst: [`licenses/GPL-2.0.txt`](licenses/GPL-2.0.txt).
- Installeres i `C:\Program Files\GoXLR Studio Engine\` og registreres i Windows' lydsystem, når du vælger det i appen.
- Medfølgende biblioteker, som motoren bruger:
  - FFTW 3 (`fftw3f.dll`) – GPL v2 eller senere, https://www.fftw.org/
  - libsndfile (`sndfile.dll`) – LGPL v2.1 eller senere, https://libsndfile.github.io/libsndfile/
  - Microsoft Visual C++ Runtime (`msvcp140*.dll`, `vcruntime140*.dll`) – Microsofts licens til videredistribution.

Selve GoXLR Studio linker ikke mod disse komponenter; de leveres sammen med appen og kommunikerer via filer, registreringsdatabase
og GoXLR Utility's lokale WebSocket-API.

## Hardware-driver (følger ikke med)
TC-Helicons USB-driver til GoXLR skal være installeret i Windows. Den hentes fra TC-Helicon og er ikke en del af GoXLR Studio.
