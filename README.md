# Email-to-CRM

An on-premises AI pipeline that turns forwarded emails into clean CRM contacts. Staff forward an email to one intake mailbox; a few minutes later the contact is in the CRM and a confirmation lands in their inbox with a one-click undo. Nobody retypes a signature block, and no email content ever leaves your own network.

## What it does

- **Time.** A forwarded email is the whole workflow. Name, email, phone numbers, company, title, country, and contact type are extracted, checked, and upserted into Zoho without anyone opening the CRM.
- **Privacy.** Email bodies are parsed by language models running on a mini-PC inside your LAN. The only outbound traffic is the structured contact record going to Zoho and the confirmation email going back to the sender.
- **Safety.** Every run is logged to a CSV and a spreadsheet before Zoho is touched. Every confirmation email carries a signed undo link that reverses the CRM write for 24 hours.
- **Predictability.** When something cannot be extracted with confidence, the pipeline says so in the confirmation rather than guessing. When Zoho is unreachable, the contact is still logged and the sender still gets a confirmation that says exactly what happened.

## Pipeline

```
Outlook intake mailbox
  -> Map Outlook to Standard Format      normalize Graph payload, detect self-sent
  -> Email Parser                        strip quoted history, isolate signature blocks,
                                         separate the forwarder's instruction from the body
  -> Chunk Splitter                      split long bodies into model-sized chunks
  -> AI Micro-Extract (local LLM)        pull raw contact fragments per chunk
  -> AI Identity Resolver (local LLM)    merge fragments into distinct people
  -> Validate & Enrich                   deterministic checks: completeness, phone
                                         normalization, domain-derived company names,
                                         type assignment from the forwarder's note
  -> Validate Contact Type               drop ghost contacts, recipient-list leaks,
                                         your own staff, out-of-office bots
  -> Format for CSV / Save to CSV        local audit trail written first
  -> Append Developer Log / Zoho Log     spreadsheet rows for the team
  -> Refresh Zoho Token -> Prepare Upsert -> Upsert Contact -> Fetch Zoho Contact
  -> Prepare Confirmation Email          per-contact cards, warnings, signed undo link
  -> Send Confirmation
```

Extraction is split across two small local models on purpose. A single "read this email and give me JSON" prompt drifted on long forwards with several signatures; splitting into micro-extraction per chunk and a separate identity-resolution pass made the output stable enough that the deterministic layer could do the rest. Everything after the models is plain JavaScript with no probabilistic behavior, so a bad result can always be traced to a specific rule.

## Why on-prem and local models

The design requirement is that email correspondence is never sent to a third-party AI service. The stack is n8n and Ollama in Docker on a Windows mini-PC on the office LAN. Models are pulled once and run on CPU. The trade-off is throughput (a long forward takes a minute or two rather than seconds), which is acceptable for a mailbox that receives tens of emails a day, not thousands. Remote administration goes through a private overlay network; nothing on the box is exposed to the public internet.

## Graceful failure

- **Model returns garbage.** The parser tolerates malformed JSON, fenced code blocks, and empty responses; the run continues with whatever fragments survived, and the confirmation flags the contact as incomplete.
- **Nothing extractable.** The sender receives a "no contact found" confirmation with the reason (image-only body, auto-reply, forwarded newsletter).
- **Zoho token refresh fails or the API is down.** The CSV and spreadsheet rows are already written; the confirmation states that Zoho was skipped so the record can be entered by hand.
- **Attachment too large.** A size ceiling stops oversized PDFs from stalling the run; the confirmation says the attachment was not read.
- **Machine reboots or a container dies.** A scheduled watchdog restarts the Docker stack and a hardening script keeps the box from sleeping, auto-updating mid-run, or coming back without the tunnel.

## Undo

Each confirmation email includes a link containing the Zoho record id, the action taken (create or update), a timestamp, and an HMAC signature computed with a secret that lives only in the n8n environment. The webhook that receives the link verifies the signature and the 24-hour window before reversing the write. Links cannot be forged or replayed after expiry.

## Repository map

| Path | What it is |
|---|---|
| `workflows/production-workflow.json` | The n8n workflow: Outlook trigger through Zoho upsert and confirmation. Importable as-is; secrets are read from environment variables. |
| `workflows/test-workflow.json` | Same pipeline behind a webhook with Zoho stubbed, used to replay captured emails during regression testing. |
| `src/nodes/Parse_AI_Response.js` | The single-stage extraction node from the earlier pipeline generation: JSON repair, signature scanning, phone and name heuristics, anti-drop guards. The largest piece of deterministic logic in the system. |
| `src/nodes/Validate_Contact_Type.js` | Ghost-contact and recipient-list filtering, staff exclusion, contact-type assignment against a configurable picklist. |
| `src/nodes/Prepare_Zoho_Fetch.js` | Builds one fetch per successful upsert so multi-contact confirmations show the right record. |
| `src/nodes/Detect_Image_Primary.js` | Detects image-only bodies (business-card photos) so they can be routed or flagged instead of returning nothing. |
| `src/stages/stage2_parse_identity_response.js` | Parses the identity-resolver model output into contact records. |
| `src/stages/stage3_validate_and_enrich.js` | The deterministic validation and enrichment stage. |
| `infra/onprem-windows/` | PowerShell hardening and watchdog scripts for the mini-PC, plus their runbook. |
| `docker-compose.yml`, `.env.example` | Container stack and the environment variables the workflow expects. |

Two generations of the extraction logic are included: the single-stage node in `src/nodes/` that ran in production first, and the multi-stage decomposition in `workflows/` and `src/stages/` that replaced one large prompt with two small ones plus a deterministic layer.

## Deploying

1. Start n8n and Ollama (see `docker-compose.yml`), pull the two models referenced in the workflow's HTTP Request nodes.
2. Create n8n credentials for the Outlook mailbox and the Excel workbook; the workflow references them by name.
3. Set the environment variables listed in `.env.example` on the n8n container. `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` and `UNDO_SECRET` are required; `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` lets Code nodes read them.
4. Import `workflows/production-workflow.json`, attach the credentials, and activate it.
5. On Windows, register `infra/onprem-windows/stack-watchdog.ps1` as a Scheduled Task and run `harden.ps1` once as administrator.

## Configuring for your organization

Each Code node carries its own constants (n8n Code nodes cannot share imports). Before deploying, set:

- `OWN_DOMAINS`, the intake mailbox address, and the staff-exclusion lists, so your own people and signatures are never extracted as contacts.
- `VALID_TYPES` and the alias table in Validate Contact Type, to match your CRM's contact-type picklist.
- The `[CRM]` confirmation subject tag, if you want a different one (the self-sent filter in Map Outlook to Standard Format matches it).

## Provenance

Generalized from a production deployment. Run history, audit logs, replay harnesses, and the regression fixtures built from real forwarded emails stay private. Secrets were never part of the design: Zoho OAuth values and the undo-signing key are read from environment variables. Names, domains, phone numbers, hostnames, and the original contact-type taxonomy were replaced with placeholders.

Built by Mika Sibinkic (Null Systems), with Claude used as a pair programmer for node code, regression tooling, and this export.
