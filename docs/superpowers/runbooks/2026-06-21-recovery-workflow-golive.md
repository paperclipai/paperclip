# Recovery Workflow — Go-Live Runbook (Phase 1)

> Deploy + shadow-validate + cut over the Cloudflare-Workflow recovery orchestration.
> Requires Cloudflare account access, `wrangler login`, and secrets. **Human-run** —
> Phase 1 Tasks 1–7 are built/tested; this is the live wiring + rollout.

Spec: `docs/superpowers/specs/2026-06-21-cloudflare-workflows-recovery-design.md`
Plan: `docs/superpowers/plans/2026-06-21-cloudflare-workflows-recovery.md`

## What's already built (Tasks 1–7)
- `recovery_workflow_links` table (+ `shadow_decisions` jsonb) — migrations 0088, 0089.
- Server attempt adapter (dry/active), internal recovery API at `/internal/recovery/...` (x-internal-secret), per-company flag, CF-REST trigger, poll-loop skip, shadow recorder + differ.
- CF Worker package `@paperclipai/recovery-workflow` with `RecoveryWorkflow` (durable attempt/sleep loop + internal client).

## ✅ Go-live prerequisites — NOW WIRED (commit 21e3309)

The three code prerequisites that previously blocked a safe rollout are **done**:
1. **Trigger wired.** `onActionCreated` is threaded through the dispatcher chain (`heartbeatService → recoveryService → issueRecoveryActionService`); on a new recovery action it starts a Workflow instance **in the company's mode** via `recoveryWorkflowTrigger.ensureInstance(...)`. Constructed **only** when the CF env vars are present — no config ⇒ strict no-op.
2. **Single shared heartbeat.** The primary dispatcher `heartbeatService` is now created once (before `createApp`) and its `.wakeup` is threaded into the internal recovery API. The second instance is gone, so the active-mode concurrent-run guard is consistent.
3. **`shadow-diff` route added.** `GET /internal/recovery/:actionId/shadow-diff` (x-internal-secret) returns the diff of recorded shadow decisions vs the live action state.

**Two-mode rollout is now expressible** (off → shadow → active), so you can validate in shadow before authority — see Secrets & config.

## Secrets & config

Server env:
- `PAPERCLIP_INTERNAL_API_SECRET` — shared secret; the Worker sends it as `x-internal-secret`.
- `PAPERCLIP_RECOVERY_WORKFLOW_SHADOW_COMPANIES` — comma-separated company ids in **shadow** mode: a Workflow runs in **dry** mode (no writes) and records decisions, while the **poll loop stays authoritative** (no behavior change). Safe to enable first.
- `PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES` — comma-separated company ids granted **authority** (active): the poll loop **skips** them and the Workflow drives real attempts. `active` takes precedence if an id is in both lists.
- Cloudflare for the trigger (all three required to activate the trigger; absent ⇒ no workflows started):
  - `PAPERCLIP_CF_ACCOUNT_ID`
  - `PAPERCLIP_CF_API_TOKEN` (Workflows edit permission)
  - `PAPERCLIP_CF_RECOVERY_WORKFLOW_NAME` (e.g. `recovery-workflow`)

Worker env (`wrangler secret put` / vars):
- `INTERNAL_API_BASE_URL` — base URL the Worker uses to reach the server's `/internal/recovery/...`. **Must be reachable from Cloudflare's network.**
  - **Public server:** use its public HTTPS URL directly.
  - **Private server:** stand up a **Cloudflare Tunnel** (`cloudflared`) to expose just the `/internal/recovery/*` path (the x-internal-secret guard is the auth boundary), and point `INTERNAL_API_BASE_URL` at the tunnel hostname.
- `INTERNAL_API_SECRET` — same value as `PAPERCLIP_INTERNAL_API_SECRET`.

## Deploy

```bash
# 1. Run DB migrations (adds recovery_workflow_links + shadow_decisions)
pnpm --filter @paperclipai/db migrate   # or your standard migrate command

# 2. Deploy the Worker
cd packages/recovery-workflow
wrangler login
wrangler secret put INTERNAL_API_SECRET   # paste the shared secret
# set INTERNAL_API_BASE_URL in wrangler.jsonc vars (or as a secret/var)
wrangler deploy

# 3. Deploy the server with the new env vars (secret + CF creds), allowlist still EMPTY
```

## Smoke test (shadow first — safe, no behavior change)

1. Confirm the server `/internal/recovery/...` endpoints are reachable from Cloudflare with the secret (a manual curl with `x-internal-secret` should 200; without it, 401).
2. With BOTH lists empty, trigger a real stranded-issue recovery for a test company. Confirm the legacy poll loop still handles it (no behavior change).
3. Add the test company to `PAPERCLIP_RECOVERY_WORKFLOW_SHADOW_COMPANIES` and restart. On the next recovery action, a Workflow instance should start (`wrangler workflows instances list recovery-workflow`), call `attempt?mode=dry` on cadence (NO writes), and populate `recovery_workflow_links.shadow_decisions`. The **poll loop still drives the real recovery** (the company is NOT skipped in shadow), so behavior is unchanged.
4. Hit `GET /internal/recovery/:actionId/shadow-diff` (with `x-internal-secret`) — confirm the workflow's observed lifecycle agrees with the live action's actual state. **This agreement is the acceptance signal.** (Fidelity limit: owner/wake decisions are not compared — see spec.)

## Cut over to authority (one company at a time)

1. Once shadow agreement looks clean, MOVE the company from the shadow list to `PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES` (active) and restart. (`active` takes precedence, but moving it keeps the lists clean.)
2. Verify the poll loop now SKIPS that company (`reconcileStrandedAssignedIssues`) and the Workflow drives attempts in `active` mode (real `escalateStrandedAssignedIssue` → wakeups).
3. Watch for redundant/missed wakeups; confirm recovery actions resolve as before.
4. Roll out to more companies gradually.

## Rollback

- **Authority → shadow:** move the company back to the shadow list (poll loop resumes authority immediately; workflow reverts to dry).
- **Full off:** empty both lists, restart (pure legacy poll loop). The Worker can keep running harmlessly; or remove the CF env vars so the trigger stops starting instances.

## Phase 2+ (out of scope)
- Approach B (edge-native: Workflows access state directly via Neon serverless HTTP driver / Hyperdrive, server out of the hot path).
- Phase 1.5 behavioral improvements: real `maxAttempts` cap, genuine `escalated` state, auto-resolution detection.
