<#
  Unattended-reboot hardening — replayable, idempotent.
  Run in an ELEVATED PowerShell on the on-prem mini-PC, or over SSH as the admin user.
  Deploy this file next to stack-watchdog.ps1.

  Auto-login is the one password-gated step. It is OPTIONAL here: pass
  -AutologinPassword to enable Windows auto-login via Sysinternals Autologon
  (stored as an ENCRYPTED LSA secret, never cleartext). NEVER hardcode the
  password in this file. Setting the Windows account password itself is a
  separate authorized step (`net user <user> <pw>`), not done here.

  Context + rollback: docs/decisions/2026-07-22-onprem-unattended-resilience.md
#>
param(
  [string]$User = "<user>",        # local admin account that owns the Docker Desktop session
  [string]$AutologinPassword       # optional; if set, enables auto-login. Never hardcode; pass at invocation or read from $env:AUTOLOGIN_PASSWORD
)
$ErrorActionPreference = "Stop"
$bk = "C:\Users\$User\onprem-hardening"
New-Item -ItemType Directory -Path $bk -Force | Out-Null

# 1. Docker Desktop starts on login
$ds = "$env:APPDATA\Docker\settings-store.json"
if (Test-Path $ds) {
  $j = Get-Content $ds -Raw | ConvertFrom-Json
  if ($j.PSObject.Properties.Name -contains "AutoStart") { $j.AutoStart = $true }
  else { $j | Add-Member -NotePropertyName AutoStart -NotePropertyValue $true -Force }
  ($j | ConvertTo-Json -Depth 100) | Set-Content $ds -Encoding utf8
}

# 2. Never sleep on AC; disable hibernate + Fast Startup
powercfg /change standby-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /change hibernate-timeout-ac 0
powercfg /change monitor-timeout-ac 0
powercfg /h off

# 3. Block Windows Update forced reboots while a user is logged on
$au = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU"
New-Item -Path $au -Force | Out-Null
New-ItemProperty -Path $au -Name NoAutoRebootWithLoggedOnUsers -Value 1 -PropertyType DWord -Force | Out-Null

# 4. Deploy watchdog + register the self-healing scheduled task
Copy-Item "$PSScriptRoot\stack-watchdog.ps1" "$bk\stack-watchdog.ps1" -Force
$wd   = "$bk\stack-watchdog.ps1"
$act  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wd`""
$t1   = New-ScheduledTaskTrigger -AtLogOn -User $User
$t2   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$prin = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Highest
$set  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
          -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName "OnPrem-StackWatchdog" -Action $act -Trigger $t1,$t2 -Principal $prin -Settings $set -Force | Out-Null

# 5. Optional: Windows auto-login (encrypted LSA secret via Sysinternals Autologon)
if ($AutologinPassword) {
  $al = "$bk\Autologon64.exe"
  if (!(Test-Path $al)) { Invoke-WebRequest "https://live.sysinternals.com/Autologon64.exe" -OutFile $al -UseBasicParsing }
  & $al $User $env:COMPUTERNAME $AutologinPassword /accepteula | Out-Null
}

"HARDEN COMPLETE  auto-login=" + (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon').AutoAdminLogon `
  + "  watchdog=" + (Get-ScheduledTask OnPrem-StackWatchdog).State
