#Requires -RunAsAdministrator
# Met la Table Daggerheart en ligne en HTTPS via un tunnel Cloudflare, sans ouvrir de port sur la box.
# Le serveur et le tunnel tournent tous deux sous le compte isole svc-daggerheart.
$ErrorActionPreference = 'Stop'
$dir  = 'C:\TableDaggerheart'
$user = 'svc-daggerheart'
$raw  = 'https://github.com/GoHmY/daggerheart-table/raw/main/serveur/maj'
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$ProgressPreference = 'SilentlyContinue'

# 1. Mise a jour de l'application (affichage de l'adresse publique pour le MJ)
Stop-ScheduledTask -TaskName 'Table Daggerheart' -ErrorAction SilentlyContinue
Stop-ScheduledTask -TaskName 'Table Daggerheart Tunnel' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Invoke-WebRequest "$raw/server.js"  -OutFile (Join-Path $dir 'server.js') -UseBasicParsing
Invoke-WebRequest "$raw/index.html" -OutFile (Join-Path $dir 'public\index.html') -UseBasicParsing

# 2. Cloudflared
$cf  = Join-Path $dir 'cloudflared'
New-Item -ItemType Directory -Force $cf | Out-Null
$exe = Join-Path $cf 'cloudflared.exe'
if (-not (Test-Path $exe)) { Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $exe -UseBasicParsing }
$log = Join-Path $dir 'data\tunnel.log'
if (Test-Path $log) { Remove-Item $log -Force }

# 3. Nouveau mot de passe aleatoire du compte isole, les deux taches enregistrees avec
Add-Type -AssemblyName System.Web
$pw = [System.Web.Security.Membership]::GeneratePassword(32, 6)
Set-LocalUser -Name $user -Password (ConvertTo-SecureString $pw -AsPlainText -Force)
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$trigger  = New-ScheduledTaskTrigger -AtStartup
$tasks = @(
  @{ n = 'Table Daggerheart';        e = (Join-Path $dir 'node\node.exe'); a = 'server.js' },
  @{ n = 'Table Daggerheart Tunnel'; e = $exe; a = "tunnel --no-autoupdate --url http://localhost:8090 --logfile `"$log`"" }
)
foreach ($t in $tasks) {
  $act = New-ScheduledTaskAction -Execute $t.e -Argument $t.a -WorkingDirectory $dir
  Register-ScheduledTask -TaskName $t.n -Action $act -Trigger $trigger -Settings $settings -User $user -Password $pw -RunLevel Limited -Force | Out-Null
}
$pw = $null

# 4. Raccourci pour retrouver l'adresse
$helper = @"
`$m = Select-String -Path '$log' -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1
if (`$m) { `$m.Matches[0].Value; Set-Clipboard `$m.Matches[0].Value; 'Adresse copiee dans le presse-papiers.' } else { 'Tunnel pas encore pret, reessayez dans 30 secondes.' }
Read-Host 'Entree pour fermer'
"@
Set-Content (Join-Path $dir 'ADRESSE.ps1') $helper -Encoding ASCII

# 5. Demarrage et affichage de l'adresse
Start-ScheduledTask 'Table Daggerheart'
Start-ScheduledTask 'Table Daggerheart Tunnel'
$url = $null
for ($i = 0; $i -lt 30 -and -not $url; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path $log) { $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1; if ($m) { $url = $m.Matches[0].Value } }
}
Get-ScheduledTask 'Table Daggerheart*' | Select-Object TaskName, State | Format-Table -AutoSize | Out-String | Write-Host
if ($url) { Write-Host "Adresse publique : $url" -ForegroundColor Green }
else { Write-Host 'Tunnel lance, adresse pas encore disponible. Lancez ADRESSE.ps1 dans un instant.' -ForegroundColor Yellow }
