# Mise a jour automatique de la Table Daggerheart (tache planifiee, compte SYSTEM, toutes les 15 minutes).
# Ne touche jamais aux donnees ni a config.json. Verifie le code avant de l'installer et revient en arriere si le serveur ne repond plus.
$ErrorActionPreference = 'Stop'
$dir = 'C:\TableDaggerheart'
$raw = 'https://github.com/GoHmY/daggerheart-table/raw/main/serveur/maj'
$log = Join-Path $dir 'auto-maj.log'
function Log($m) { Add-Content $log ((Get-Date -Format 'yyyy-MM-dd HH:mm') + '  ' + $m); if ((Get-Item $log).Length -gt 200KB) { Get-Content $log -Tail 500 | Set-Content $log } }
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'
$ProgressPreference = 'SilentlyContinue'
$files = @(@{ n = 'server.js'; d = 'server.js' }, @{ n = 'index.html'; d = 'public\index.html' }, @{ n = 'admin.html'; d = 'public\admin.html' })
$tmp = Join-Path $env:TEMP ('dh-maj-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  foreach ($f in $files) { Invoke-WebRequest "$raw/$($f.n)?t=$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" -OutFile (Join-Path $tmp $f.n) -UseBasicParsing -TimeoutSec 60 }
  $changed = $files | Where-Object { -not (Test-Path (Join-Path $dir $_.d)) -or (Get-FileHash (Join-Path $tmp $_.n)).Hash -ne (Get-FileHash (Join-Path $dir $_.d)).Hash }
  if (-not $changed) { return }
  # Pas de redemarrage pendant une partie : on attend que plus personne ne soit connecte (au plus 24 h)
  $wait = Join-Path $dir 'maj-en-attente.txt'
  try { $st = Invoke-RestMethod 'http://localhost:8090/api/local/status' -TimeoutSec 5 } catch { $st = $null }
  if ($st -and $st.online -gt 0) {
    if (-not (Test-Path $wait)) { Set-Content $wait (Get-Date -Format o); Log ("Mise a jour disponible, reportee : " + $st.online + " joueur(s) connecte(s).") }
    if (((Get-Date) - [datetime](Get-Content $wait -Raw).Trim()).TotalHours -lt 24) { return }
    Log 'Mise a jour en attente depuis 24 h : installation malgre les joueurs connectes.'
  }
  Remove-Item $wait -Force -ErrorAction SilentlyContinue
  & (Join-Path $dir 'node\node.exe') --check (Join-Path $tmp 'server.js'); if ($LASTEXITCODE -ne 0) { Log 'Nouvelle version refusee : server.js invalide.'; return }
  foreach ($h in 'index.html', 'admin.html') { if (-not (Select-String -Path (Join-Path $tmp $h) -Pattern '</html>' -Quiet)) { Log "Nouvelle version refusee : $h incomplet."; return } }
  $bk = Join-Path $dir 'version-precedente'; New-Item -ItemType Directory -Force (Join-Path $bk 'public') | Out-Null
  foreach ($f in $files) { $src = Join-Path $dir $f.d; if (Test-Path $src) { Copy-Item $src (Join-Path $bk $f.d) -Force } }
  Stop-ScheduledTask -TaskName 'Table Daggerheart' -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2
  foreach ($f in $files) { Copy-Item (Join-Path $tmp $f.n) (Join-Path $dir $f.d) -Force }
  Start-ScheduledTask -TaskName 'Table Daggerheart'; Start-Sleep -Seconds 5
  try { $r = Invoke-WebRequest 'http://localhost:8090/api/ping' -UseBasicParsing -TimeoutSec 10; Log ('Mise a jour installee (' + (($changed | ForEach-Object { $_.n }) -join ', ') + ') : ' + $r.Content) }
  catch {
    Log 'Le serveur ne repond plus apres la mise a jour : retour a la version precedente.'
    Stop-ScheduledTask -TaskName 'Table Daggerheart' -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2
    foreach ($f in $files) { $b = Join-Path $bk $f.d; if (Test-Path $b) { Copy-Item $b (Join-Path $dir $f.d) -Force } }
    Start-ScheduledTask -TaskName 'Table Daggerheart'
  }
} catch { Log ('Erreur : ' + $_.Exception.Message) }
finally { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
