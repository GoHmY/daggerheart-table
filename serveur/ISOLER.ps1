#Requires -RunAsAdministrator
# Fait tourner la Table Daggerheart dans un compte isole, sans aucun droit hors de son dossier.
$ErrorActionPreference = 'Stop'
$dir  = 'C:\TableDaggerheart'
$user = 'svc-daggerheart'
$task = 'Table Daggerheart'

# 1. Compte local dedie, mot de passe aleatoire que personne ne connait
Add-Type -AssemblyName System.Web
$pw  = [System.Web.Security.Membership]::GeneratePassword(32, 6)
$sec = ConvertTo-SecureString $pw -AsPlainText -Force
if (Get-LocalUser -Name $user -ErrorAction SilentlyContinue) { Set-LocalUser -Name $user -Password $sec }
else { New-LocalUser -Name $user -Password $sec -PasswordNeverExpires -UserMayNotChangePassword -Description 'Compte isole de la Table Daggerheart' | Out-Null }
foreach ($g in Get-LocalGroup) { try { Remove-LocalGroupMember -Group $g.Name -Member $user -ErrorAction Stop } catch {} }

# 2. Droits : lecture seule sur l'appli, ecriture uniquement dans data
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
New-Item -ItemType Directory -Force (Join-Path $dir 'data') | Out-Null
icacls $dir /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' "${user}:(OI)(CI)RX" /T /C /Q | Out-Null
icacls (Join-Path $dir 'data') /grant "${user}:(OI)(CI)M" /T /C /Q | Out-Null

# 3. Interdit explicitement les dossiers sensibles connus
foreach ($p in 'C:\FTP', 'C:\palworld-backups') { if (Test-Path $p) { icacls $p /deny "${user}:(OI)(CI)F" /C /Q | Out-Null } }

# 4. La tache tourne desormais sous ce compte, sans elevation
$action   = New-ScheduledTaskAction -Execute (Join-Path $dir 'node\node.exe') -Argument 'server.js' -WorkingDirectory $dir
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -User $user -Password $pw -RunLevel Limited -Force | Out-Null
$pw = $null
Start-ScheduledTask -TaskName $task
Start-Sleep -Seconds 4

# 5. Verification
$proc = Get-CimInstance Win32_Process -Filter "name='node.exe'" | Where-Object { $_.CommandLine -like '*server.js*' }
$owner = if ($proc) { (Invoke-CimMethod -InputObject $proc[0] -MethodName GetOwner).User } else { 'aucun processus' }
Write-Host ("Compte du serveur : " + $owner)
Write-Host ("Groupes du compte : " + ((Get-LocalGroup | Where-Object { (Get-LocalGroupMember $_.Name -ErrorAction SilentlyContinue).Name -match $user }).Name -join ', '))
try { Invoke-WebRequest 'http://localhost:8090/api/ping' -UseBasicParsing | Out-Null; Write-Host 'Serveur en ligne et isole.' -ForegroundColor Green }
catch { Write-Host 'Le serveur ne repond pas.' -ForegroundColor Red }
