---
choice: On-prem Windows host unattended-reboot resilience, Windows auto-login + Docker Desktop autostart + self-healing watchdog task
tier: 2
status: accepted
alternatives_considered:
  - name: Move n8n/ollama off Docker Desktop to headless dockerd (WSL2 + systemd service, no interactive session required)
    reject_reason: A multi-hour migration of a running pipeline. It is the better long-term design because it removes the need for auto-login.
  - name: Registry AutoAdminLogon with plaintext DefaultPassword in HKLM
    reject_reason: Stores the Windows password in cleartext in the registry, readable by any admin. Sysinternals Autologon stores the credential as an encrypted LSA secret instead.
  - name: Rely on a person to log in after every reboot
    reject_reason: Any reboot outside working hours (power loss, a Windows Update restart) leaves the pipeline down until someone logs in.
corroborating_signals:
  - Docker Desktop's engine only starts inside an interactive user session, and its settings-store.json AutoStart defaults to false
  - Microsoft OpenSSH-on-Windows docs, administrators_authorized_keys strict-ACL requirement (Administrators+SYSTEM only) for admin key auth
  - Sysinternals Autologon (Microsoft-signed binary), LSA-secret credential storage
  - watchdog.log on a test host, Docker Desktop launch -> n8n healthz 200 in about 90s via the scheduled task, with no manual clicks
verification_probe: |
  Supervised cold reboot of the host with NO interactive login afterward.
  From the operator's machine over the private network, poll:
    curl -s -o /dev/null -w "%{http_code}" -H "X-N8N-API-KEY: $N8N_API_KEY" http://<HOST_IP>:5678/healthz
  Expect 200 within about 3 minutes, no human touch. The chain is proven if the box auto-logs-in the admin user,
  the at-logon watchdog fires, Docker Desktop starts, and the unless-stopped n8n container comes healthy.
rollback:
  steps:
    - "Autologon64.exe (GUI) -> Disable, or: reg delete HKLM Winlogon AutoAdminLogon/DefaultUserName/DefaultPassword"
    - "Unregister-ScheduledTask -TaskName OnPrem-StackWatchdog -Confirm:$false"
    - "Restore Docker settings-store.json from settings-store.backup.json (AutoStart=False)"
    - "Set-Service com.docker.service -StartupType Manual"
    - "powercfg /h on ; restore sleep timeouts from powercfg-sleep.backup.txt"
    - "Optional teardown of remote access: disable the sshd service and remove administrators_authorized_keys"
---

## Context
An on-prem Windows 11 Pro host runs the Email-to-CRM containers (n8n + ollama) under Docker Desktop. Out of the box, a reboot nobody attends leaves the stack down: (1) without Windows auto-login an unattended boot never reaches a user session, and (2) with Docker Desktop AutoStart=False even a manual login does not start the engine. Docker Desktop's engine requires an interactive session, so both have to be fixed.

## Decision
Keep Docker Desktop and make an unattended reboot self-healing with three layers:
1. Windows auto-login (Sysinternals Autologon, LSA secret), so an unattended boot reaches the admin user's desktop.
2. Docker Desktop AutoStart=True plus a login item, so the engine starts in that session.
3. The OnPrem-StackWatchdog scheduled task (at-logon + every 5 min, runs as the admin user with highest privileges). It launches Docker Desktop if down, waits for the engine, starts or repairs the port-5678 container (auto-discovered), and health-checks n8n `/healthz`, restarting on failure. It also heals crashes, not just reboots.
Supporting hardening: container restart policy `unless-stopped`, never-sleep on AC, hibernate + Fast Startup disabled, com.docker.service Automatic, the private-network VPN client as an auto-start service. Remote administration goes through OpenSSH Server with key auth over the private network.

## Consequences
- Easier: full remote administration over SSH; unattended recovery from reboot and crash; audit-logged watchdog ticks.
- Accepted tradeoff: auto-login means anyone with physical access gets an unlocked desktop on boot. Keep the box in a controlled location, limit remote access to the private network with key auth, and store the credential encrypted (LSA secret, not plaintext). Physical security is weaker in exchange for availability.
- Docker Desktop stays the runtime until a headless-dockerd migration (the first alternative) is done, which would remove the auto-login requirement.
- One manual step remains: BIOS "Restore on AC Power Loss = Power On" cannot be set from the OS and needs someone at the machine. It matters for power loss, and it belongs alongside a UPS.
