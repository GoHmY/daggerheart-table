#Requires -RunAsAdministrator
# Reinitialise le mot de passe de la page /admin de la Table Daggerheart (comptes et fiches intacts).
$ErrorActionPreference = 'Stop'
$dir  = 'C:\TableDaggerheart'
$data = Join-Path $dir 'data'
$code = Join-Path $data 'code-admin.txt'
if (Test-Path $code) { Remove-Item $code -Force }
New-Item -ItemType File -Force (Join-Path $data 'RESET-ADMIN') | Out-Null
Stop-ScheduledTask -TaskName 'Table Daggerheart' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'Table Daggerheart'
for ($i = 0; $i -lt 15 -and -not (Test-Path $code); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path $code) {
  Write-Host ''
  Write-Host ('Code de mise en place : ' + (Get-Content $code -Raw).Trim()) -ForegroundColor Green
  Write-Host 'Ouvrez http://gohmy-serv.freeboxos.fr/admin, entrez ce code et choisissez un nouveau mot de passe admin.'
} else { Write-Host 'Le serveur n a pas genere de code. Verifiez que la mise a jour (MAJ.ps1) est installee.' -ForegroundColor Red }
