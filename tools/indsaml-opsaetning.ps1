# Samler din nuvaerende lydopsaetning (GoXLR, Equalizer APO/Peace, hotkeys, lydenheder) i en zip paa skrivebordet.
# Koer:  powershell -ExecutionPolicy Bypass -File .\indsaml-opsaetning.ps1
$ErrorActionPreference = 'SilentlyContinue'
$out = Join-Path $env:TEMP "goxlr-studio-opsaetning"
Remove-Item $out -Recurse -Force
New-Item $out -ItemType Directory | Out-Null
$maxBytes = 2MB
$textExt = '.txt','.cfg','.ini','.json','.xml','.config','.ahk','.goxlr','.goxlrMicProfile','.preset','.ps1','.reg'

function Copy-Small($src, $dstName) {
  if (-not (Test-Path $src)) { return }
  $dst = Join-Path $out $dstName
  Get-ChildItem $src -Recurse -File | Where-Object { $_.Length -le $maxBytes -and ($textExt -contains $_.Extension.ToLower()) } | ForEach-Object {
    $rel = $_.FullName.Substring((Resolve-Path $src).Path.Length).TrimStart('\')
    $target = Join-Path $dst $rel
    New-Item (Split-Path $target) -ItemType Directory -Force | Out-Null
    Copy-Item $_.FullName $target
  }
  Get-ChildItem $src -Recurse -File | Select-Object FullName, Length, LastWriteTime | Export-Csv (Join-Path $out "$dstName-filliste.csv") -NoTypeInformation -Encoding UTF8
}

# Lydenheder
Get-PnpDevice -Class AudioEndpoint | Select-Object FriendlyName, Status, InstanceId | Export-Csv "$out\lydenheder.csv" -NoTypeInformation -Encoding UTF8
foreach ($flow in 'Render','Capture') {
  $base = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\$flow"
  Get-ChildItem $base | ForEach-Object {
    $p = Get-ItemProperty "$($_.PSPath)\Properties"
    $fx = Get-ItemProperty "$($_.PSPath)\FxProperties"
    [pscustomobject]@{
      Flow = $flow; Id = $_.PSChildName; State = (Get-ItemProperty $_.PSPath).DeviceState
      Name = $p.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'; Interface = $p.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
      HasFx = [bool]$fx
    }
  } | Export-Csv "$out\endpoints-$flow.csv" -NoTypeInformation -Encoding UTF8
}

# Equalizer APO / Peace
$apo = (Get-ItemProperty 'HKLM:\SOFTWARE\EqualizerAPO').ConfigPath
if (-not $apo) { $apo = 'C:\Program Files\EqualizerAPO\config' }
Copy-Small $apo 'EqualizerAPO-config'
reg export 'HKLM\SOFTWARE\EqualizerAPO' "$out\EqualizerAPO-registry.reg" /y | Out-Null
reg export 'HKCU\SOFTWARE\EqualizerAPO' "$out\EqualizerAPO-user-registry.reg" /y | Out-Null

# GoXLR (TC-Helicon app og GoXLR Utility)
Copy-Small "$env:USERPROFILE\Documents\GoXLR" 'GoXLR-Documents'
Copy-Small "$env:LOCALAPPDATA\TC-Helicon" 'TC-Helicon-LocalAppData'
Copy-Small "$env:APPDATA\TC-Helicon" 'TC-Helicon-AppData'
Copy-Small "$env:APPDATA\goxlr-utility" 'goxlr-utility'
Copy-Small "$env:LOCALAPPDATA\goxlr-utility" 'goxlr-utility-local'

# Hotkey- og lydvaerktoejer
Copy-Small "$env:APPDATA\SoundSwitch" 'SoundSwitch'
Copy-Small "$env:LOCALAPPDATA\SoundSwitch" 'SoundSwitch-local'
Copy-Small "$env:USERPROFILE\Documents\AutoHotkey" 'AutoHotkey'
Copy-Small "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup" 'Startup'
Get-ChildItem "$env:APPDATA\Elgato\StreamDeck\ProfilesV2" -Recurse -Filter manifest.json | ForEach-Object {
  $t = Join-Path $out ("StreamDeck\" + $_.FullName.Substring("$env:APPDATA\Elgato\StreamDeck\ProfilesV2".Length).TrimStart('\'))
  New-Item (Split-Path $t) -ItemType Directory -Force | Out-Null; Copy-Item $_.FullName $t
}
Get-ChildItem "$env:LOCALAPPDATA\Packages" -Directory | Where-Object Name -match 'EarTrumpet' | ForEach-Object { Copy-Small "$($_.FullName)\LocalState" 'EarTrumpet' }

# Installerede programmer og autostart (kun lyd-relevante)
$pat = 'GoXLR|TC-Helicon|Equalizer|Peace|SoundSwitch|Voicemeeter|VB-Audio|AutoHotkey|Stream ?Deck|EarTrumpet|Wave Link|Broadcast|Sonar|Nahimic|Dolby|DTS|Realtek|Discord|OBS|Spotify'
Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' |
  Where-Object { $_.DisplayName -match $pat } | Select-Object DisplayName, DisplayVersion, Publisher, InstallLocation | Export-Csv "$out\programmer.csv" -NoTypeInformation -Encoding UTF8
Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location | Export-Csv "$out\autostart.csv" -NoTypeInformation -Encoding UTF8
Get-Process | Where-Object { $_.ProcessName -match $pat } | Select-Object ProcessName, Path | Export-Csv "$out\koerende.csv" -NoTypeInformation -Encoding UTF8
Get-ScheduledTask | Where-Object { $_.TaskName -match $pat } | Select-Object TaskName, TaskPath, State | Export-Csv "$out\planlagte-opgaver.csv" -NoTypeInformation -Encoding UTF8
"$([Environment]::OSVersion.VersionString)  $(Get-Date -Format s)" | Out-File "$out\info.txt"

$zip = Join-Path ([Environment]::GetFolderPath('Desktop')) 'goxlr-studio-opsaetning.zip'
Remove-Item $zip -Force
Compress-Archive -Path "$out\*" -DestinationPath $zip
Remove-Item $out -Recurse -Force
Write-Host "Faerdig: $zip" -ForegroundColor Green
