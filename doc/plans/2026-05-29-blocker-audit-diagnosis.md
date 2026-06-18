# DIAGNOSIS & REMEDIATION REPORT: "Close 15 Units in June 2026" Blocker Audit
**Date:** 2026-05-29  
**Author:** CEO Agent  
**Auditor Persona:** Executive Analyst & Project Coordinator  
**Target Goal:** "Close 15 Units in June 2026" (Goal ID: `fef88e1e-65be-4016-90c8-467d7de711b7`)

---

## 1. Executive Summary

To close 15 loan units in June 2026, the company relies on robust, real-time incoming and outgoing partner signals to prevent deal drop-offs, coordinate with referring agents, and publish targeted marketing materials. Currently, a series of critical and high-priority blocked issues in the Paperclip tracking system (running on port 3101) are halting progress on multiple fronts:

1. **iMessage signal ingestion (ROCAA-137)** is critically down (silent failure since April 24, 2026), meaning we have zero visibility into Ivan's primary messaging channel. This directly blocks **ROCAA-140** (VIP-aware transition campaign).
2. **WhatsApp signal ingestion (ROCAA-141)** is stalled waiting for human-side Meta Business manager setup and workspace decisions, blocking the live WhatsApp capture integration.
3. **CRM synchronization (ROCAA-175)** is thrashing on bidirectionality vs. sunset queueing decisions, blocking core database alignment for Grettel, Zunaira, Gerard, and Neo.
4. **Social media automation (ROCAA-107)** is offline due to a crashed Cloud Run NestJS container, blocking daily cadence publishing.
5. **Ingress webhook delivery (ROC-174)** is blocked by public-to-private networking issues between the Google Cloud-hosted n8n and the local Tailscale environment.

This report diagnoses the root cause of each issue, evaluates the system components, and lays out concrete, step-by-step resolution paths for our engineering and operations team.

---

## 2. Deep Dive: Issue Audits & Diagnostics

### Issue 1: ROCAA-137 (CRITICAL)
**Title:** `[DEV] URGENT: iMessage daemon stopped writing since April 2026 — diagnose`  
**Location on Mac:**  
- Daemon Source: `/home/dwizy/architect-os-93/daemons/imessage-watcher/` (or `~/architect-os/daemons/imessage-watcher/`)  
- launchd plist: `~/Library/LaunchAgents/com.architect.imessage.plist`  
- Log file: `~/Library/Logs/architect-os/imessage-watcher.log`  
- Blocklist Path: `~/.config/architect-os/blocked-contacts.json`  

#### Diagnostics & Analysis
1. **Mac-Only Constraint:** The iMessage watcher daemon polls macOS's `/Library/Messages/chat.db` database directly. It cannot be run or tested on the GCP Linux VM or Surface laptops.
2. **Silent Failure Mode:** In April 2026, the daemon captured 380 messages successfully. Since May 1, 2026, 0 messages have been captured.
3. **Core Guardrail:** The blocklist file `blocked-contacts.json` (managed by `block-loader.ts` loading from `~/.config/architect-os/blocked-contacts.json`) must **not** be deleted or wiped. It is a critical user-gated safety guardrail to avoid logging private contacts.
4. **Daemon Logic Vulnerabilities:**
   - **Flood Control Exit:** In `index.ts`, if a single polling cycle emits >20 messages or drops >100 messages, it triggers process exit (`process.exit(1)`) to let launchd's KeepAlive handle backoff throttling. If launchd's backoff threshold is exceeded, macOS will refuse to restart the daemon.
   - **Full Disk Access Revocation:** macOS periodically resets or revokes Full Disk Access permissions for command-line tools (Bun, Node, or terminal wrappers) during system updates, which immediately causes database read errors on `/Library/Messages/chat.db`.
   - **State File Corruption:** The daemon tracks ROWID progress via `daemons/imessage-watcher/.state`. If corrupted, it can crash during parsing.

#### Actionable Resolution Path (to be executed on Ivan's Mac)
1. **Status Checks:** Run the following terminal commands on the macOS host:
   ```bash
   launchctl list | grep architect
   ls -la ~/Library/Logs/architect-os/
   tail -100 ~/Library/Logs/architect-os/imessage-watcher.log
   ls -la ~/architect-os/daemons/imessage-watcher/.state
   ```
2. **Permission Check:** Open macOS *System Settings > Privacy & Security > Full Disk Access*. Ensure `Bun` and `Terminal` / `iTerm` are fully checked. If already checked, remove and re-add them.
3. **State Recovery:**
   - If `.state` is empty or corrupted, safely delete it and let the daemon initialize.
   - If the daemon has been rate-limited or stopped, re-initialize ROWID tracking to a known healthy ID from late April to perform a safe backfill.
4. **Reload launchd Agent:**
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.architect.imessage.plist
   launchctl load -w ~/Library/LaunchAgents/com.architect.imessage.plist
   ```
5. **Liveness Alerting Implementation:** Update `index.ts` or add a crontab watcher to check the timestamp of files in `vault/inbox/`. If no writes occur for >24h, execute a cURL command posting a notification to the Slack `#ops` lane.

---

### Issue 2: ROCAA-141 (HIGH)
**Title:** `[DEV] Ivan-action: WhatsApp Business 2500 Meta setup + MA-app workspace mount for ROCAA agents`  
**Blocks:** ROCAA-139 (WhatsApp Capture)

#### Diagnostics & Analysis
This ticket bridges the automated intake spec and live human assets. The development of WhatsApp capture (via `email-ai` gateway routing inbound SMS/WhatsApp) is currently blocked on:
1. **Meta Business Manager Setup:** Registering the phone number `+1-617-595-2500` under the verified business profile, establishing a Meta Developer App, granting `whatsapp_business_messaging` and `whatsapp_business_management` permissions, and minting a long-lived system token.
2. **File System Boundary Conflict:** The implementation files live in `~/Workspace/mortgagearchitect-ai/` which is outside the ROCAA agent workspace boundaries.

#### Actionable Resolution Path
1. **Meta App Credential Provisioning:** Ivan/operator must complete the Meta dashboard enrollment, copy the credentials, and store them securely in 1Password under the path `whatsapp-business-2500/`:
   - `WHATSAPP_VERIFY_TOKEN` (used for webhook handshake)
   - `META_APP_SECRET` (used for payload signature checks)
   - `WHATSAPP_BUSINESS_PHONE_NUMBER_ID` (target ID)
   - System User Access Token (long-lived)
2. **Workspace Mounting Decision:**
   - **Option 1 (Developer Agent Route):** Add a symlink or directory mount in the Paperclip tenant configuration to expose `/home/dwizy/Workspace/mortgagearchitect-ai/` into the ROCAA-Dev environment workspace.
   - **Option 2 (Spec-Only Route):** Authorize ROCAA agents to output structural specs to the vault (`vault/wiki/`), leaving the live deployment to the Trinity-side or main-thread orchestrator.
   - *Recommendation:* Proceed with **Option 2** to maintain strict boundary safety between the tenant codebase and core operations.

---

### Issue 3: ROCAA-175 (HIGH)
**Title:** `[DEV] Lock ROCAA-116 framing: GHL team-queue vs GHL-sunset backflow`  
**Parent Issue:** ROCAA-116 (Cube-GHL Sync)

#### Diagnostics & Analysis
1. **Ecosystem Contradiction:** ROCAA-116 attempts to implement bi-directional synchronization between Salesforce/Cube and GHL. However, this conflicts with the pending "GHL Sunset Plan."
2. **Pipeline ID Drift:** Option A references GHL "Launch 4" pipeline, but our verified 2026-05-24 pipeline inventory does *not* contain any pipeline matching that name or ID (`PUxanI42gRRuzwJ3IKum`).
3. **Audit Gate Mismatches:** The issue states that `vault/wiki/sops/Bulk-Mutation-SOP.md` (v1.1) and `vault/wiki/sops/Team-Deploy-Testing-Protocol.md` do not exist. However, our investigation confirms both files exist under `~/architect-os/vault/wiki/sops/` at version `v1.0`.

#### Actionable Resolution Path
1. **Confirm Framing Strategy:** Ivan must select Option B (Narrow GHL -> SF backflow). It is consistent with the Sunset Plan, significantly simplifies the sync engine, and mitigates mutation risk during the transition.
2. **Resolve SOP Versioning:**
   - Update `Bulk-Mutation-SOP.md` from v1.0 to v1.1. Add a direct section mapping the bulk dry-run requirements specifically for SF backflows.
   - Explicitly update the ticket references to recognize the local paths under `~/architect-os/vault/wiki/sops/`.
3. **Pipeline Discovery:** Run a cURL request against GHL's live endpoints to list active pipelines and obtain the correct ID:
   ```bash
   curl -s -H "Authorization: Bearer [REDACTED]" "https://services.leadconnectorhq.com/opportunities/pipelines"
   ```
   Correct the GHL pipeline ID baked into the ROCAA-116 ticket before unblocking the workflow.

---

### Issue 4: ROCAA-107 (HIGH)
**Title:** `[DEV] Postiz prod revive (NestJS API container + FB/IG OAuth) — unblocks live publish`  
**Blocks:** ROCAA-96 (Live Publish), ROCAA-98 (Content Handoff), ROCAA-99 (CMO Health)

#### Diagnostics & Analysis
1. **Container Crash:** The Postiz application runs inside Google Cloud Run. The Cloud Run service container starts, but the NestJS API server inside it fails to boot.
2. **Port Binding / Connection Failure:** Nginx acts as a reverse proxy inside the container and attempts to route traffic to `127.0.0.1:3000`. It fails with `connect() failed (111: Connection refused)` because NestJS crashed prior to binding to port 3000.
3. **Common Startup Blockers for NestJS:**
   - Unhandled database connection failures (Postgres/Redis connection strings).
   - Missing or mismatched environment secrets in Cloud Run setup.
   - Out-of-memory crashes on startup.

#### Actionable Resolution Path
1. **Inspect GCP Logs:** Run the following command using `gcloud` (or access the GCP Google Cloud Console):
   ```bash
   gcloud logging read "resource.type=cloud_run_revision AND resource.labels.service_name=postiz-api" --limit=100
   ```
2. **Address Crash Loop:**
   - Verify that database connection variables (`DATABASE_URL`, `REDIS_URL`) are correctly mapped as secrets and accessible by the container.
   - Adjust NestJS memory limits if OOM is detected.
3. **Build & Deploy:** Pull the latest stable changes from `feat/postiz-deploy-staging` and trigger a clean deploy:
   ```bash
   git checkout feat/postiz-deploy-staging
   # Trigger GCP Build/Deploy sequence
   ```
4. **Integration Audit:** Once the NestJS app successfully listens on port 3000, verify by executing:
   ```bash
   curl -s "https://publisher.rochomeloans.com/api/v1/integrations"
   ```
   If successful (200 OK), perform initial Meta FB/IG OAuth authentication via the web UI.

---

### Issue 5: ROC-174 (HIGH)
**Title:** `[OPS] Mint Cloudflare Tunnel creds for Paperclip ingress (paperclip.mortgagearchitect.net -> roclaw-new:3100)`  
**Blocks:** ROC-171 (Dispatcher drift)

#### Diagnostics & Analysis
1. **Ingress Obstacle:** n8n runs on a Google-managed public instance which is not part of the private Tailnet. It cannot reach `roclaw-new`'s private IP (`100.127.26.77:3100`) directly.
2. **Mismatched Webhook Targets:** Due to lack of external ingress, n8n webhook dispatches are timing out or failing. Setting up a secure Cloudflare Tunnel mapping a public DNS name to the local port is required.

#### Actionable Resolution Path
1. **Create Tunnel on Cloudflare Dashboard:** 
   - Log into Cloudflare Zero Trust Console.
   - Create a new Cloudflare Tunnel named `roc-paperclip`.
   - Add a Public Hostname rule: Map `paperclip.mortgagearchitect.net` to `http://localhost:3100` (or the corresponding Paperclip port on the local machine).
2. **Secure Token Minting:**
   - Retrieve the long-lived tunnel authentication token from the installation command.
   - Store this token in GCP Secret Manager under the `silver-pad-459411-e7` project as `CLOUDFLARED_TUNNEL_TOKEN_ROC_PAPERCLIP`.
3. **Service Account Permissions:** Grant the Secret Manager Secret Accessor role to:
   `188657647789-compute@developer.gserviceaccount.com`
4. **Deploy Tunnel Agent:**
   - Configure the systemd/launchd daemon for `cloudflared` on `roclaw-new` to load the token dynamically and connect.
   - Run `curl https://paperclip.mortgagearchitect.net/api/agents/me` to verify secure public-to-private routing is live and unblocks n8n webhooks.

---

## 3. Recommended Sequencing & Milestones

To resolve these blockers efficiently without developer resource starvation, we recommend the following order of execution:

```
[Milestone 1: Public Ingress & Webhooks]
   ├── Establish Cloudflare Tunnel (ROC-174)
   └── Unblocks n8n dispatcher sync (ROC-171)

[Milestone 2: Personal Channel Signal Recovery]
   ├── Diagnose iMessage daemon on Mac (ROCAA-137)
   ├── Grant Mac FDA permissions & re-initialize state
   └── Setup liveness alarms for backup observability

[Milestone 3: Database & Campaign Sync]
   ├── Lock GHL sync strategy to Option B (ROCAA-175)
   └── Establish WhatsApp token paths in 1Password (ROCAA-141)

[Milestone 4: Marketing Deployment]
   └── Repair NestJS production container in Cloud Run (ROCAA-107)
```

By completing **Milestone 1** and **Milestone 2** first, the operational team instantly recovers critical partner signals and hooks, which allows the automated agents to handle subsequent triage and analysis autonomously.
