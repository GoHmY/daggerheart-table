#Requires -RunAsAdministrator
# Met a jour l'application sans toucher aux donnees ni a la configuration,
# puis installe la mise a jour automatique (toutes les 5 minutes depuis GitHub).
$ErrorActionPreference = 'Stop'
$dir = 'C:\TableDaggerheart'
$raw = 'https://github.com/GoHmY/daggerheart-table/raw/main/serveur/maj'
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$ProgressPreference = 'SilentlyContinue'
Stop-ScheduledTask -TaskName 'Table Daggerheart' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Invoke-WebRequest "$raw/server.js"  -OutFile (Join-Path $dir 'server.js') -UseBasicParsing
Invoke-WebRequest "$raw/index.html" -OutFile (Join-Path $dir 'public\index.html') -UseBasicParsing
Invoke-WebRequest "$raw/admin.html" -OutFile (Join-Path $dir 'public\admin.html') -UseBasicParsing
Invoke-WebRequest "$raw/auto-maj.ps1" -OutFile (Join-Path $dir 'auto-maj.ps1') -UseBasicParsing
Start-ScheduledTask -TaskName 'Table Daggerheart'

# Mise a jour automatique : tache planifiee sous SYSTEM, toutes les 5 minutes
$act = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$dir\auto-maj.ps1`""
$trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5)
$set = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName 'Table Daggerheart MAJ auto' -Action $act -Trigger $trg -Settings $set -User 'SYSTEM' -RunLevel Highest -Force | Out-Null

Start-Sleep -Seconds 3
try { Write-Host ('Serveur : ' + (Invoke-WebRequest 'http://localhost:8090/api/ping' -UseBasicParsing).Content) -ForegroundColor Green }
catch { Write-Host 'Le serveur ne repond pas.' -ForegroundColor Red }
Write-Host 'Mise a jour automatique installee : le serveur verifie GitHub toutes les 5 minutes (journal : C:\TableDaggerheart\auto-maj.log).' -ForegroundColor Green
