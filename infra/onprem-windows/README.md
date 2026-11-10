# On-prem Windows host: Email-to-CRM runtime

Email-to-CRM runs as Docker containers on an on-prem mini-PC
(Windows 11 Pro, hostname `<HOSTNAME>`) on the office LAN.
This directory version-controls the box's resilience config so the setup is
reproducible and audit-replayable.

## Files
- `harden.ps1`: idempotent, replayable unattended-reboot hardening. Run elevated on the box (or over SSH as the local admin user). Pass `-AutologinPassword <pw>` to also enable auto-login. Never hardcodes a secret.
- `stack-watchdog.ps1`: the self-healing task body: starts Docker Desktop + Ollama, waits for the engine, and health-heals the n8n container on `:5678`. Runs at-logon + every 5 min via the `OnPrem-StackWatchdog` scheduled task.

## What `harden.ps1` does
1. Sets Docker Desktop `AutoStart=true` in `%APPDATA%\Docker\settings-store.json`.
2. Sets the power plan to never sleep on AC and disables hibernate + Fast Startup (`powercfg`).
3. Sets the `NoAutoRebootWithLoggedOnUsers` Windows Update policy so patches cannot force a reboot under a logged-on session.
4. Copies `stack-watchdog.ps1` to `C:\Users\<user>\onprem-hardening\` and registers the `OnPrem-StackWatchdog` scheduled task (at-logon trigger + 5-minute repetition, runs as the admin user with highest privileges, `IgnoreNew` for overlapping instances, 3 restarts on failure).
5. Optionally enables Windows auto-login through Sysinternals Autologon, which stores the credential as an encrypted LSA secret rather than a plaintext registry value.

## What `stack-watchdog.ps1` does on every tick
1. Starts the Ollama desktop app (or `ollama serve`) if no `ollama` process exists.
2. Starts Docker Desktop if it is not running.
3. Polls `docker ps` for up to 5 minutes until the engine answers.
4. Finds the container publishing port 5678 (falls back to any image matching `n8n`), starts it if stopped, then hits `http://localhost:5678/healthz`; anything other than HTTP 200 triggers `docker restart`.
5. Appends a timestamped line to `watchdog.log` next to the script for every action taken.

## Recovery model: why the box survives an unattended reboot
Cold boot (any cause) → Windows **auto-login** (admin user, encrypted LSA secret) → a desktop session exists → **`OnPrem-StackWatchdog`** (at-logon trigger) and Docker **AutoStart** launch Docker Desktop → engine comes up → **`unless-stopped`** containers start → n8n live. The watchdog's 5-minute loop also self-heals engine/container crashes, not just reboots.

Root cause of the outage that prompted this: an unattended power-on left the stack dead because (a) there was no Windows auto-login and (b) Docker Desktop `AutoStart=False`, so the engine never started without a manual login. Both are fixed by `harden.ps1`.

## Scheduling by hand (if not using `harden.ps1`)
The task `harden.ps1` registers is equivalent to:

```powershell
$wd   = "C:\Users\<user>\onprem-hardening\stack-watchdog.ps1"
$act  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wd`""
$t1   = New-ScheduledTaskTrigger -AtLogOn -User "<user>"
$t2   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$prin = New-ScheduledTaskPrincipal -UserId "<user>" -LogonType Interactive -RunLevel Highest
$set  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2)
Register-ScheduledTask -TaskName "OnPrem-StackWatchdog" -Action $act -Trigger $t1,$t2 -Principal $prin -Settings $set -Force
```

Check state with `Get-ScheduledTask OnPrem-StackWatchdog` and `Get-Content C:\Users\<user>\onprem-hardening\watchdog.log -Tail 20`.

## Access
`ssh <user>@<HOST_IP>` (Tailscale, key auth). n8n API at `http://<HOST_IP>:5678`. The n8n API key is read from `$env:N8N_API_KEY` on the operator's machine; it is never stored in this repository.

## Reproduce on a fresh box
1. Enable OpenSSH Server; add the admin public key to `C:\ProgramData\ssh\administrators_authorized_keys` (ACL must be Administrators + SYSTEM only).
2. Copy this directory to `C:\Users\<user>\onprem-hardening\`.
3. `net user <user> <password>`, set a known password.
4. `powershell -ExecutionPolicy Bypass -File harden.ps1 -User <user> -AutologinPassword <password>`
5. Set BIOS **"Restore on AC Power Loss = Power On"** (physical).

## Rollback
- Disable auto-login: run `Autologon64.exe` and choose Disable, or delete `AutoAdminLogon` / `DefaultUserName` / `DefaultPassword` under `HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`.
- `Unregister-ScheduledTask -TaskName OnPrem-StackWatchdog -Confirm:$false`
- Set `AutoStart` back to `false` in `settings-store.json`.
- `powercfg /h on` and restore the previous sleep timeouts.

## Not in git
The Windows credential and the n8n API key live in gitignored local env files. Never commit them.

Rationale + tradeoffs: [`docs/decisions/2026-07-22-onprem-unattended-resilience.md`](../../docs/decisions/2026-07-22-onprem-unattended-resilience.md).
