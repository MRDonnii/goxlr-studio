# Signerede opdateringer

GoXLR Studio kan signere sine udgivelser med en egen ed25519-nøgle. Når den er sat op, installerer appen kun en opdatering, hvis udgivelsens `latest.json` (listen over filer med SHA-256) er signeret med nøglen. En udgivelse, som nogen har ændret eller lagt op uden nøglen, bliver afvist.

## Sådan slås det til (én gang)
1. Lav en privat nøgle: 32 tilfældige bytes, skrevet som base64. I PowerShell:
   ```powershell
   $b = New-Object byte[] 32
   [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
   [Convert]::ToBase64String($b)
   ```
2. Gem nøglen et sikkert sted, fx i en adgangskode-manager. **Mister du den, kan apps med signering ikke opdatere sig selv mere** – så skal den nye version installeres i hånden én gang.
3. På GitHub: repoet → **Settings → Secrets and variables → Actions → New repository secret**. Kald den `UPDATE_SIGNING_KEY` og indsæt nøglen.
4. Næste udgivelse bygges med den offentlige nøgle i appen, og `latest.json` signeres (`latest.json.sig`). Under Indstillinger → Opdateringer står der derefter "Kun signerede opdateringer".

Den private nøgle må aldrig ligge i repoet, i en besked eller i en fil, andre kan se.

## Uden nøgle
Uden secret bygges appen som før: den kontrollerer kun filernes SHA-256 fra GitHub.
