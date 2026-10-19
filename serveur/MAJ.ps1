#Requires -RunAsAdministrator
# Met a jour l'application sans toucher aux donnees ni a la configuration.
$ErrorActionPreference = 'Stop'
$dir = 'C:\TableDaggerheart'
$raw = 'https://github.com/GoHmY/daggerheart-table/raw/main/serveur/maj'
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$ProgressPreference = 'SilentlyContinue'
Stop-ScheduledTask -TaskName 'Table Daggerheart' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Invoke-WebRequest "$raw/server.js"  -OutFile (Join-Path $dir 'server.js') -UseBasicParsing
Invoke-WebRequest "$raw/index.html" -OutFile (Join-Path $dir 'public\index.html') -UseBasicParsing
Start-ScheduledTask -TaskName 'Table Daggerheart'
Start-Sleep -Seconds 3
try { Write-Host ('Serveur : ' + (Invoke-WebRequest 'http://localhost:8090/api/ping' -UseBasicParsing).Content) -ForegroundColor Green }
catch { Write-Host 'Le serveur ne repond pas.' -ForegroundColor Red }
