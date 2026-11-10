---
choice: On-prem host unattended-reboot resilience, Windows auto-login + Docker Desktop autostart + self-healing watchdog task
tier: 2
date: 2026-07-22
status: accepted
alternatives_considered:
  - name: Migrate n8n/ollama off Docker Desktop to headless dockerd (WSL2 + systemd service, no interactive session required)
    reject_reason: A multi-hour migration, too risky for a live pipeline in the middle of an outage, and not needed to get the stack back up. It is the right long-term fix because it removes the need for auto-login.
  - name: Registry AutoAdminLogon with plaintext DefaultPassword in HKLM
    reject_reason: Stores the Windows password in cleartext in the registry, readable by any admin. Sysinternals Autologon stores the credential as an encrypted LSA secret instead.
  - name: Do nothing, rely on an in-office human to log in after every reboot
    reject_reason: This is what caused the outage. Nobody is in the office on nights and weekends.
corroborating_signals:
  - Firsthand recon 2026-07-22 on <HOSTNAME>, AutoAdminLogon empty AND Docker settings-store.json AutoStart=False, together the cause of the dead stack after an unattended power-on
  - Microsoft OpenSSH-on-Windows docs, administrators_authorized_keys strict-ACL requirement (Administrators+SYSTEM only) for admin key auth
  - Sysinternals Autologon (Microsoft-signed binary, Authenticode verified this session), LSA-secret credential storage
  - watchdog.log firsthand, Docker Desktop launch -> n8n healthz 200 in ~86s via the scheduled task, with zero manual clicks
confidence:
  primary_claim: VERIFIED
  cost_estimate: VERIFIED
verification_probe: |
  Supervised cold reboot of <HOSTNAME> with NO interactive login afterward.
  From the operator's laptop over Tailscale, poll:
    curl -s -o /dev/null -w "%{http_code}" -H "X-N8N-API-KEY: $N8N_API_KEY" http://<HOST_IP>:5678/healthz
  Expect 200 within ~3 minutes, no human touch. Chain proven if the box auto-logs-in the admin user,
  the at-logon watchdog fires, Docker Desktop starts, and the unless-stopped n8n container comes healthy.
rollback:
  commit_sha: "n/a; on-prem OS/infra change, not a repo commit. Pre-change snapshots on box at C:\\Users\\<user>\\onprem-hardening\\*.backup.*"
  steps:
    - "Autologon64.exe (GUI) -> Disable, or: reg delete HKLM Winlogon AutoAdminLogon/DefaultUserName/DefaultPassword"
    - "Unregister-ScheduledTask -TaskName OnPrem-StackWatchdog -Confirm:$false"
    - "Restore Docker settings-store.json from settings-store.backup.json (AutoStart=False)"
    - "Set-Service com.docker.service -StartupType Manual"
    - "powercfg /h on ; restore sleep timeouts from powercfg-sleep.backup.txt"
    - "Optional teardown of remote access: reg/GUI disable sshd service + remove administrators_authorized_keys"
---

## Context
The on-prem mini-PC (`<HOSTNAME>`, Win 11 Pro) runs the Email-to-CRM prod pipeline as Docker containers (n8n + ollama + cf-bypass). It powered off (cause unconfirmed: power loss, a Windows Update reboot, or someone switching it off), and when someone powered it back on in person, the container stack stayed dead. Root cause verified firsthand: (1) no Windows auto-login, so an unattended boot never reaches a user session; (2) Docker Desktop AutoStart=False, so even logging in by hand didn't start the engine. Docker Desktop's engine requires an interactive session, so both had to be fixed.

## Decision
Keep the existing Docker Desktop stack (no risky migration mid-outage) and make unattended reboot self-healing via three layers:
1. Windows auto-login (Sysinternals Autologon, LSA secret), so an unattended boot reaches the admin user's desktop.
2. Docker Desktop AutoStart=True plus a login item, so the engine starts in that session.
3. The OnPrem-StackWatchdog scheduled task (at-logon + every 5 min, runs as the admin user/highest), launches Docker Desktop if down, waits for the engine, starts/repairs the port-5678 container (auto-discovered), and health-checks n8n `/healthz`, restarting on failure. Self-heals crashes too, not just reboots.
Supporting hardening: container restart policy `unless-stopped` (already set), never-sleep on AC, hibernate + Fast Startup disabled, com.docker.service Automatic, Tailscale already a proper auto-start service. Remote-admin channel established: OpenSSH Server (key auth over Tailscale) replaces the prior RustDesk-only/no-SSH state.

## Consequences
- Easier: full remote administration over Tailscale SSH (no more base64-paste-via-RustDesk dance); unattended recovery from reboot AND crash; audit-logged watchdog ticks.
- Accepted tradeoff: auto-login means anyone with physical access gets an unlocked desktop on boot. The box is in a controlled office, remote access is Tailscale-only + key-based, credential stored encrypted (LSA secret, not plaintext). Physical-security threat model is now explicitly weaker in exchange for availability.
- Committed to Docker Desktop as the runtime until the headless-dockerd migration (the alternative above) is done, which would remove the auto-login requirement.
- One manual step remains: BIOS "Restore on AC Power Loss = Power On" cannot be set from the OS and needs someone at the machine. It only matters if the original shutoff was a power blip, and it should go in alongside a UPS.
