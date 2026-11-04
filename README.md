# GoXLR Studio

*Dansk · [English](README.en.md)*

**Ét program til din GoXLR eller GoXLR Mini på Windows.** GoXLR Studio styrer mixeren, mikrofonen, lyset og profilerne. Det giver hele Windows en EQ (fx til dine hovedtelefoner), sender hver app til den rigtige kanal og giver dig genvejstaster til det hele. Dermed erstatter det GoXLR Utility, Equalizer APO, Peace og AutoHotkey.

![Mixeren i GoXLR Studio](docs/screenshots/mixer.png)

## Hent den

**[⬇ Download nyeste version](https://github.com/MRDonnii/goxlr-studio/releases/latest)** – vælg filen der ender på `x64-setup.exe`.

1. Kør installeren. Windows viser måske "Windows beskyttede din pc", fordi appen ikke er kodesigneret: klik **Flere oplysninger → Kør alligevel**.
2. Start GoXLR Studio. Den finder selv din GoXLR. GoXLR-motoren er en del af appen, så der kører ikke noget ved siden af.
3. Har du brugt andre programmer før, så åbn siden **Overflytning**. Den henter dine genveje, EQ-presets og profiler over, tager backup og hjælper dig med at afinstallere det gamle.

Krav: Windows 10/11 og TC-Helicons USB-driver til GoXLR. Driveren følger med TC-Helicons app eller kan hentes hos TC-Helicon. Den gør GoXLR'en til et lydkort i Windows og skal blive installeret.

Appen opdaterer sig selv, når der kommer en ny version.

## Hvad er GoXLR Studio?

GoXLR'en er en mixer fra TC-Helicon. For at styre den fra Windows bruger man normalt TC-Helicons app eller GoXLR Utility. Vil man også have EQ på hovedtelefonerne, lyd pr. app eller taster til profilskift, kommer Equalizer APO, Peace og AutoHotkey oveni. GoXLR Studio samler det hele i ét program:

- **GoXLR-motoren er bygget ind.** Den del, der taler med GoXLR'en over USB, kommer fra open source-projektet GoXLR Utility og kører inde i GoXLR Studio. Dine profiler og indstillinger fra GoXLR Utility virker uændret.
- **EQ-motoren er bygget ind.** Afspilnings-EQ'en bruger Equalizer APO's lydmotor, som GoXLR Studio selv installerer, tester og styrer. Du skal ikke have Equalizer APO eller Peace.
- **Kun TC-Helicons USB-driver** skal være installeret ved siden af.

## Det kan den

### Mixer

Kanalerne fra din GoXLR med samme LED-farver som på hardwaren, et VU-meter ved hver kanal, mute og valg af kilde. Under dem ligger alle kanalers lydstyrke og mikrofonens niveau. Øverst skifter du Windows' standard-udgang og -mikrofon med ét klik, fx fra GoXLR "System" til dine højttalere. Topbjælken skifter GoXLR-profil, EQ-preset og scene. **ChatMix** er én knap til balancen mellem chat og spil. **Spiller nu** viser sangen fra Spotify, browseren m.fl. med afspil/pause, næste og forrige – og de tre findes også som handlinger til genveje, fodpedal, Stream Deck og mobilen.

### Afspilnings-EQ for hele Windows

![Afspilnings-EQ](docs/screenshots/afspilnings-eq.png)

- Parametrisk EQ med en kurve, du trækker i, og fortryd/gentag – eller **sliders** med gain, frekvens, Q og filtertype pr. bånd og en preamp-slider
- **Venstre og højre øre hver for sig**, Band-pass/All-pass og stejle low/high-cut (op til 48 dB/oktav)
- **Live-spektrum** bag kurven: du ser, hvor musikken eller spillet har sin energi, mens du stiller på EQ'en
- **A/B ved samme lydstyrke:** den højeste af A og B sænkes, så du hører forskellen i klang og ikke bare i lydstyrke. Med **blindtest** hører du dem som X og Y uden at vide, hvilken er hvilken
- **Balance:** løfter du et bånd, sænkes hele gulvet (preamp) lige så meget – så du får balance i stedet for bare mere lyd
- **Klip-beskyttelse og headroom:** appen regner på hele kæden (EQ, Loudness og Crossfeed) og sænker selv lyden, hvis den ellers ville forvrænge. "Auto" sætter preamp lige under grænsen
- Presets, også dine gamle Peace/Equalizer APO-presets, som importeres med ét klik og lyder præcis som før (også GraphicEQ)
- AutoEQ-søgning, der finder korrektion til netop dine hovedtelefoner
- **Høretest:** find den svageste tone, du kan høre, på hvert øre, og få en personlig EQ til dine ører og dine hovedtelefoner
- **Rumkorrektion:** importér dine REW-målinger (.mdat eller tekst) fra en målemikrofon som UMIK-1 – også uden kalibreringsfil, den kan lægges på bagefter. GoXLR Studio lægger målingerne sammen og laver et preset efter en rum-kurve: toppe og rumtoppe dæmpes, smalle huller fyldes ikke op, og der løftes ikke under det, højttalerne kan spille. Venstre og højre kan korrigeres hver for sig, og en kontrolmåling vises sammen med det beregnede
- **Højttalere:** afstand til hver højttaler giver den rigtige forsinkelse, polariteten kan vendes, og dit eget FIR-filter (WAV fra REW, rePhase eller DRC) kan lægges oven i
- **Dynamik:** GoXLR Studios egen limiter og kompressor sidst i kæden – beskyt mod pludselige spidser, eller brug Natmode, så stille tale og høje effekter ligger tættere
- **Linkwitz-Riley** (LR 12/24/48) på low/high cut, til delefiltre og subwoofer
- Crossfeed, loudness, mono og balance til hovedtelefoner
- **Lyder det forkert?** Vælg fx "skarp" eller "mudret", og EQ'en justeres et lille skridt. Eksport og import af alle presets
- **EQ pr. app:** fx Call of Duty med fodtrins-EQ og Spotify med musik-EQ på samme tid (Lyd pr. app → EQ pr. app)
- **EQ pr. kanal:** sit eget preset på Spil, Musik, Chat og System. Apps følger deres kanal, så Spotify får musik-EQ og spillet fodtrins-EQ – og hver GoXLR-profil kan have sit eget sæt
- **Virtuelle højttalere:** hovedtelefoner lyder som to højttalere foran dig (valgfrit i et rum) i stedet for inde i hovedet
- **Rene stemmer i chatten:** tastatur, blæser og hund fjernes fra vennernes stemmer (RNNoise)
- **Spil-presets** til fx CS2/Valorant, Warzone/Battlefield og Fortnite/Apex
- **Lige lydniveau:** mål Spil, Musik og Chat, mens de spiller, og de højeste sænkes, så musikken ikke drukner spillet (intet hæves)
- EQ der skifter med GoXLR-profilen, fx ét preset til "Headset" og et andet til "Speakers"
- Lyttetest i appen, så du kan høre forskellen med og uden EQ

**EQ-motoren tester sig selv.** Windows kan sætte EQ-motoren på en udgang på tre måder, og det er forskelligt fra pc til pc, hvilken der virker. Efter installationen åbner GoXLR Studio hver udgang og tjekker, at motoren faktisk bliver indlæst. Hvis den ikke gør, prøver den selv de andre måder. Du kan altid trykke **Test EQ-motoren** igen.

![EQ-motoren tester udgangene](docs/screenshots/eq-motor.png)

### Mikrofon

![Mikrofon](docs/screenshots/mikrofon.png)

Mikrofon-EQ'en kører i GoXLR'ens egen chip, så den bruger hverken CPU eller giver forsinkelse. Her finder du også gain, noise gate, kompressor og mikrofonprofiler.

**Vælg din mikrofon** blandt 51 modeller, fx Røde NT1, Shure SM7B, Fifine K688 og Audio-Technica AT2020. GoXLR Studio foreslår så EQ, noise gate, kompressor og de-esser ud fra mikrofonens frekvenskurve. EQ'en er en klar talestemme minus mikrofonens egen klang, tilpasset GoXLR'ens bånd. **Mikrofon-assistenten** lytter til dit rum og din stemme og sætter gain og noise gate, og med **Optag og lyt** hører du resultatet. Er du tilfreds, kan du **dele dine indstillinger** som en fil med en ven.

**Stemme-forbedrer:** mere fylde, mere klarhed, mindre næset eller mudret med ét klik.

**Ren mikrofon – spil med højttalere uden at genere de andre:** en ekkofjerner fjerner det, højttalerne spiller (spillet, musik og dine medspilleres egne stemmer), fra din mikrofon, og en støjfjerner tager blæser, brum, tastatur og klik. Det kører i GoXLR Studios EQ-motor på GoXLR'ens Chat Mic, så det virker i Discord, spil og alle andre programmer – uden Discords egen støjfjerner. GoXLR Studio holder selv øje med, hvilke kanaler der spiller på højttalerne, og hvor højt.

**Automatisk noise gate:** tærsklen følger rummets støj, så gaten hverken klipper stille tale eller lukker spillyd igennem.

**Limiter (beskyt mod råb):** ét klik gør GoXLR'ens kompressor til en limiter, så råb og grin ikke klipper på stream, i Discord eller i optagelser. Dine egne kompressor-indstillinger kommer tilbage, når den slås fra.

### Lyd pr. app

![Lyd pr. app](docs/screenshots/lyd-pr-app.png)

Send hver app til sin kanal på GoXLR'en og skru på dens egen lydstyrke, fx Spotify → Music, Discord → Chat og spil → System. Reglerne bliver holdt, også når appen genstarter. Apps, der efter en driveropdatering peger på en GoXLR-enhed, som ikke findes længere, bliver rettet. Du kan også lade ting ske automatisk, når en bestemt app starter.

**Automatik når en enhed tilsluttes** (siden Lydenheder): sæt et USB- eller Bluetooth-headset til, og GoXLR Studio skifter fx til profilen "Headset" og sender lyden til headsettet. Tag det ud, og den skifter tilbage til "Speakers". Det kan også ske, når appen starter.

### Genveje, kommandolinje og besked over spil

![Genveje](docs/screenshots/genveje.png)

Frie globale genveje til profiler, EQ-presets, scener, mute og meget mere. De virker også midt i spil, og G-taster fra Logitech G HUB kan bruges (F13–F24). Dine gamle AutoHotkey-genveje kan hentes direkte over.

**Ctrl+K** åbner en kommandolinje, hvor du kan søge efter alt, appen kan:

![Kommandolinje](docs/screenshots/kommandopalet.png)

Når en genvej bruges, viser en lille boks øverst på skærmen i et sekund, hvad der skete, også over spil. Bakke-ikonet får en rød prik, når mikrofonen er muted, og dets menu kan skifte profil, EQ og scene.

![Besked over spil](docs/screenshots/osd.png)

### Stream Deck

![Stream Deck](docs/screenshots/stream-deck.png)

Læg enhver handling på en tast på en Stream Deck, fx Streonor, Elgato eller Ulanzi. Siden **Stream Deck** viser alle handlinger, og du kopierer det, dit Stream Deck-program skal bruge:

- et link (`goxlr-studio://action/…`) til handlingen "Website"
- en kommando til "Åbn program"
- en tast til "Hotkey"
- en web-adresse til det lokale API

Linket starter også GoXLR Studio, hvis appen ikke kører.

**Plugin til Elgato Stream Deck med status:** tasterne lyser, når det, de styrer, er slået til – fx rød, når mikrofonen er muted, eller når en profil eller et EQ-preset er i brug. Drejeknapperne på Stream Deck + styrer lydstyrken. Hent `GoXLR-Studio.streamDeckPlugin` ved udgivelsen (eller fra Stream Deck-siden i appen) og dobbeltklik på den. **Streonor** (MiraBox StreamDock) får det samme plugin med ét klik på "Installér pluginnet" på Stream Deck-siden.

### Fodpedal

![Fodpedal](docs/screenshots/fodpedal.png)

Brug en fodpedal som knap – fx push-to-talk med foden. USB-pedaler, der sender en tast, Elgato Stream Deck Pedal og MIDI-pedaler/-controllere. Hver pedal kan køre en handling ved tryk, virke mens den holdes (push-to-talk/-mute), gøre to forskellige ting ved kort tryk og hold – og en MIDI-fader kan styre en kanals lydstyrke. Tryk "+ Tilføj pedal" og træd på den.

### Sampler (den store GoXLR)

![Sampler](docs/screenshots/sampler.png)

Lyde på sampler-knapperne i tre banker, med afspilningsmåde (afspil/stop, hold, loop), rækkefølge og start/slut pr. lyd. Optag ved at holde en knap nede – også sekunderne før du trykkede.

### Scener

![Scener](docs/screenshots/scener.png)

Gem hele lydopsætningen som en scene, fx "Gaming", "Stream" eller "Film": lydstyrker, mute, routing, monitor-mix, Windows-enheder, EQ og lys. Du skifter med én genvej (Ctrl+Alt+1–9) eller fra topbjælken.

### Lys

![Lys](docs/screenshots/lys.png)

Farvetemaer til hele mixeren, farver og stil på hver fader, animationer og farver på alle knapper.

### Routing

![Routing](docs/screenshots/routing.png)

Hvilke kilder der går til hovedtelefoner, stream, chat-mic, sampler og line out – ét klik pr. felt.

### Overflytning fra de gamle programmer

![Overflytning](docs/screenshots/overflytning.png)

GoXLR Studio tager backup af det hele og henter dine AutoHotkey-genveje, Peace-presets og TC-Helicon-profiler. Det overtager fra GoXLR Utility og hjælper dig med at afinstallere de gamle programmer. Driveren bliver.

### Indstillinger, Discord og meget mere

![Indstillinger](docs/screenshots/indstillinger.png)

![Lyst tema](docs/screenshots/tema-lyst.png)

- **GoXLR-indstillinger:** cough-knappen, hvad GoXLR'en gør når pc'en sover/vågner/lukker, skærmene over faderne, VOD-tilstand og oplæsning af ændringer

  ![GoXLR-indstillinger](docs/screenshots/goxlr-indstillinger.png)

- **Lydklip:** gem de sidste 15–120 sekunder af stream-mixet som WAV med en knap eller genvej
- **Spiltilstand:** når et spil kører i fuld skærm, stopper Windows' notifikationslyde, og dine egne handlinger kan køre (fx EQ "Fodtrin") – alt kommer tilbage, når spillet slutter
- **Tidsstyring:** fx kl. 22 → EQ "Sen aften" og loft på hovedtelefonerne, kl. 7 → tilbage igen
- **Flyt til ny pc:** én fil med indstillinger, genveje, pedaler, regler, EQ-presets og tema – og GoXLR-profiler, mikrofonprofiler, samples og lydbanken. Åbn den på den nye pc, så er alt med
- **Discord:** GoXLR'ens mute-knap muter også Discord, med det røde ikon
- Auto-ducking, der skruer ned for musik og spil, mens du taler – eller mens vennerne taler i Discord
- **Høreværn:** påmindelse efter lang tid med høj lyd og et valgfrit loft for hovedtelefonerne
- **Profilhistorik:** tidligere versioner af dine GoXLR- og mikrofonprofiler kan gendannes
- **Temaer** (her Lyst): lyst, mørkt (eller automatisk som Windows), Sort (OLED), Nordlys, Solnedgang, Skov og Papir – og valgfri accentfarve
- Start med Windows og luk til bakke-ikonet
- Automatiske opdateringer
- **Home Assistant** via MQTT: GoXLR Studio dukker op som en enhed med mikrofon-mute, "Mikrofon åben" (fx til en ON AIR-lampe), GoXLR-profil, EQ-preset, scene, lydstyrker, ChatMix, limiter, spiltilstand og "Gem lydklip"
- **OBS:** skift OBS-scene med genveje, Stream Deck eller automatik, lad scenen følge GoXLR-profilen, og "Stream-sikker musik" tager musikken ud af streamen
- **Fjernbetjening på mobilen:** mute, profiler, scener, EQ og lydstyrke fra telefonen på samme wifi
- Lokalt API til fx Stream Deck
- **Lydtjek**, der finder Windows-indstillinger, som ændrer lyden (fx at Windows skruer ned for spillet under opkald), og retter dem med ét klik
- Dansk og engelsk: appen følger Windows' sprog og kan skiftes under Indstillinger
- En side med **Diagnose**, hvor du kan kopiere eller gemme en rapport (uden adgangskoder), hvis noget driller
- **Fejlfinder**: appen genkender kendte fejl (driver, GoXLR Utility, USB, port optaget …), viser årsagen med en løsning og starter selv GoXLR-motoren igen; GoXLR-motorens log kan ses på Diagnose
- Effekter på den store GoXLR: reverb, echo, pitch, gender, megafon, robot og hardtune

*Billederne er taget med appens demo-data i GoXLR Mini-layout.*

## Indeholder

GoXLR Studio er MIT-licenseret. GoXLR Utility's motor (MIT) er bygget ind i selve appen, og Equalizer APO's lydmotor (GPL v2) bruges uændret – se [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Udvikling

- UI: `public/` (vanilla JS, ingen build) – `STUDIO_PORT=14600 node server.js` kører den i en browser med demo-data (`?mini` for GoXLR Mini).
- GoXLR-motoren: `src-tauri/goxlr-engine/` (se dens README), EQ-motoren: `src-tauri/src/engine.rs`.
- Tests: `node --test tests/*.test.mjs` og `cd src-tauri && cargo test --lib`; `cargo check --target x86_64-pc-windows-msvc` tjekker Windows-delen.
- Windows-bygget sker i GitHub Actions; en ny version i `src-tauri/tauri.conf.json` på `main` udgives automatisk.
