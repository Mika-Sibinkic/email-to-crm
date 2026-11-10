$log = "C:\Users\<user>\onprem-hardening\watchdog.log"
function Log($m){ "$((Get-Date).ToString('s')) $m" | Out-File -Append -Encoding utf8 $log }
Log "watchdog tick start"
# 1. Ollama
if (-not (Get-Process ollama -ErrorAction SilentlyContinue)) {
  $app = "$env:LOCALAPPDATA\Programs\Ollama\ollama app.exe"
  if (Test-Path $app) { Start-Process $app } else { Start-Process "ollama" -ArgumentList "serve" -WindowStyle Hidden }
  Log "started ollama"
}
# 2. Docker Desktop
if (-not (Get-Process "Docker Desktop" -ErrorAction SilentlyContinue)) {
  Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  Log "started Docker Desktop"
}
# 3. Wait for engine
$ok=$false
for($i=0;$i -lt 60;$i++){ docker ps *> $null; if($LASTEXITCODE -eq 0){$ok=$true;break}; Start-Sleep 5 }
if(-not $ok){ Log "engine not up after wait"; exit }
# 4. Ensure n8n container running (discover by port 5678, fallback image name)
$n = docker ps -a --filter "publish=5678" --format "{{.Names}}" | Select-Object -First 1
if(-not $n){ $n = docker ps -a --format "{{.Names}} {{.Image}}" | Where-Object {$_ -match "n8n"} | ForEach-Object {($_ -split ' ')[0]} | Select-Object -First 1 }
if($n){
  $state = docker inspect -f "{{.State.Running}}" $n
  if($state -ne "true"){ docker start $n | Out-Null; Log "started container $n" }
  try { $r = Invoke-WebRequest "http://localhost:5678/healthz" -TimeoutSec 8 -UseBasicParsing; if($r.StatusCode -ne 200){ throw "bad" } Log "n8n healthy ($n)" }
  catch { docker restart $n | Out-Null; Log "health fail -> restarted $n" }
} else { Log "no n8n container found" }
