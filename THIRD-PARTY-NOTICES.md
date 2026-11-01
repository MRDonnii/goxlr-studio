# Tredjepartskomponenter i GoXLR Studio

GoXLR Studio er MIT-licenseret. Windows-udgaven indeholder desuden disse komponenter:

## GoXLR-motoren – GoXLR Utility 1.2.4 (bygget ind i appen)
- Kilde: https://github.com/GoXLR-on-Linux/goxlr-utility (tag `v1.2.4`).
- Licens: MIT – Copyright (c) 2022 - 2024 Craig McLure, Nathan Adams. Fuld tekst: [`licenses/GoXLR-Utility-MIT.txt`](licenses/GoXLR-Utility-MIT.txt).
- GoXLR Utility's daemon ligger i [`src-tauri/goxlr-engine/`](src-tauri/goxlr-engine/) som et bibliotek og kører på en tråd inde i
  GoXLR Studio – der er ikke noget separat program. Ændringerne i forhold til GoXLR Utility er beskrevet i
  [`src-tauri/goxlr-engine/README.md`](src-tauri/goxlr-engine/README.md) og markeret `GoXLR Studio:` i koden.
- De øvrige GoXLR Utility-moduler (`goxlr-usb`, `goxlr-ipc`, `goxlr-types`, `goxlr-audio`, `goxlr-profile-loader`,
  `goxlr-scribbles`) bruges uændrede fra samme tag.

## EQ-motoren – Equalizer APO 1.4.2 (`EqualizerAPO.dll`)
- Kilde: https://sourceforge.net/projects/equalizerapo/ – den officielle x64-installer (SHA-256 `7403be74…5afa`) hentes i bygget, og
  motorfilerne bruges uændrede. Den tilsvarende kildekode (`EqualizerAPO-src-1.4.2.zip`) ligger ved hver GoXLR Studio-udgivelse.
- Licens: GNU GPL version 2 eller senere – Copyright (C) 2012 Jonas Thedering. Fuld tekst: [`licenses/GPL-2.0.txt`](licenses/GPL-2.0.txt).
- Installeres i `C:\Program Files\GoXLR Studio Engine\` og registreres i Windows' lydsystem, når du vælger det i appen. Motoren kører
  inde i Windows' lydtjeneste (som Equalizer APO altid gør) – GoXLR Studio linker ikke mod den, men styrer den via filer og
  registreringsdatabase. Installationen og testen af udgangene følger samme fremgangsmåde som Equalizer APO's Device Selector,
  så Equalizer APO's egne værktøjer og GoXLR Studio forstår hinandens installation.
- Medfølgende biblioteker, som motoren bruger:
  - FFTW 3 (`fftw3f.dll`) – GPL v2 eller senere, https://www.fftw.org/
  - libsndfile (`sndfile.dll`) – LGPL v2.1 eller senere, https://libsndfile.github.io/libsndfile/
  - Microsoft Visual C++ Runtime (`msvcp140*.dll`, `vcruntime140*.dll`) – Microsofts licens til videredistribution.

## Hardware-driver (følger ikke med)
TC-Helicons USB-driver til GoXLR skal være installeret i Windows. Den hentes fra TC-Helicon og er ikke en del af GoXLR Studio.
