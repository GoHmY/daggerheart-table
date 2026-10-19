#Requires -RunAsAdministrator
# Active l'envoi des codes de recuperation par mail (compte Gmail dedie + mot de passe d'application).
$ErrorActionPreference = 'Stop'
$dir = 'C:\TableDaggerheart'
$cfgPath = Join-Path $dir 'config.json'
$c = (Get-Content $cfgPath -Raw -Encoding UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
$user = Read-Host 'Adresse Gmail d envoi [gohmyserv@gmail.com]'
if (-not $user) { $user = 'gohmyserv@gmail.com' }
$sec = Read-Host 'Mot de passe d application Gmail (16 lettres, rien ne s affiche)' -AsSecureString
$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try { $pass = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) -replace '\s', '' } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
if ($pass.Length -ne 16) { Write-Host 'Un mot de passe d application Gmail fait 16 lettres. Rien n a ete modifie.' -ForegroundColor Red; return }

# Test d'envoi avant d'enregistrer
Write-Host 'Test d envoi en cours...'
try {
  [Net.ServicePointManager]::SecurityProtocol = 'Tls12'
  $smtp = New-Object Net.Mail.SmtpClient('smtp.gmail.com', 587)
  $smtp.EnableSsl = $true
  $smtp.Credentials = New-Object Net.NetworkCredential($user, $pass)
  $msg = New-Object Net.Mail.MailMessage($user, $user, 'Table Daggerheart : mails actives', 'Ce message confirme que le serveur peut envoyer les codes de recuperation.')
  $smtp.Send($msg); $msg.Dispose(); $smtp.Dispose()
  Write-Host "Mail de test envoye a $user." -ForegroundColor Green
} catch { Write-Host ('Echec du test : ' + $_.Exception.InnerException.Message + ' ' + $_.Exception.Message) -ForegroundColor Red; Write-Host 'Verifiez l adresse et le mot de passe d application. Rien n a ete modifie.'; return }

$c | Add-Member -NotePropertyName mailUser -NotePropertyValue $user -Force
$c | Add-Member -NotePropertyName mailPass -NotePropertyValue $pass -Force
[IO.File]::WriteAllText($cfgPath, ($c | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
$pass = $null
Stop-ScheduledTask -TaskName 'Table Daggerheart' -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName 'Table Daggerheart'
Start-Sleep -Seconds 3
try { Write-Host ('Serveur : ' + (Invoke-WebRequest 'http://localhost:8090/api/ping' -UseBasicParsing).Content) -ForegroundColor Green }
catch { Write-Host 'Le serveur ne repond pas.' -ForegroundColor Red }
