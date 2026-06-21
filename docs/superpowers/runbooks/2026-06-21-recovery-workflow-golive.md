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

## ⚠️ Go-live prerequisites — DO THESE FIRST (tracked during build)

1. **Wire the trigger in production.** The `onActionCreated` hook (Task 4) is built + tested but NOT yet connected at the `issueRecoveryActionService` construction site. Until it is, adding a company to the allowlist will make the **poll loop skip it with no workflow taking over → recovery actions dropped.** Wire `onActionCreated` to construct `recoveryWorkflowTrigger({...}).ensureInstance(...)` (gated by `isRecoveryWorkflowEnabled`) before enabling ANY company.

2. **Fix the second-heartbeat-instance guard (active mode).** `app.ts` currently constructs a *second* `heartbeatService` instance solely to get `enqueueWakeup` for the internal recovery API. Its in-memory `activeRunExecutions` guard is empty, so active-mode escalations could bypass the primary instance's concurrent-run guard (worst case: a redundant, idempotency-keyed wakeup). Before enabling **active** mode, thread the **primary dispatcher's** `heartbeat.wakeup` (from `index.ts`, created ~line 699) into `createApp` opts and pass it to `internalRecoveryRoutes`, removing the second instance. (Note: `createApp` runs before the dispatcher today — either reorder so the primary heartbeat is built first, or pass a late-bound `() => heartbeat.wakeup` provider.)

3. **(Optional) Expose `diffShadow`.** `diffShadow` is built + tested but has no route. Add `GET /internal/recovery/:actionId/shadow-diff` (body `{ liveActual }`) calling it, to inspect agreement during shadow validation. Otherwise call it from an ops script.

## Secrets & config

Server env:
- `PAPERCLIP_INTERNAL_API_SECRET` — shared secret; the Worker sends it as `x-internal-secret`.
- `PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES` — comma-separated company ids granted **authority** (poll loop skips them; workflow drives them). **Leave EMPTY until prereqs 1–2 are done.**
- Cloudflare for the trigger: account id, API token (Workflows edit), workflow name `recovery-workflow`.

Worker env (`wrangler secret put` / vars):
- `INTERNAL_API_BASE_URL` — public base URL the Worker uses to reach the server's `/internal/recovery/...` (must be reachable from Cloudflare; a tunnel if the server is private).
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

## Smoke test (shadow first)

1. Confirm the server `/internal/recovery/...` endpoints are reachable from Cloudflare with the secret (a manual curl with `x-internal-secret` should 200; without it, 401).
2. With the allowlist EMPTY, trigger a real stranded-issue recovery for a test company. Confirm the legacy poll loop still handles it (no behavior change).
3. Enable SHADOW for the test company (once the trigger is wired): a Workflow instance should start (`wrangler workflows instances list recovery-workflow`), call `attempt?mode=dry` on cadence, and `recordShadowDecision` should populate `recovery_workflow_links.shadow_decisions`.
4. Run `diffShadow` (route or ops script) for that action — confirm the workflow's observed lifecycle agrees with the live action's actual state. **This agreement is the acceptance signal.** (Fidelity limit: owner/wake decisions are not compared — see spec.)

## Cut over to authority (one company at a time)

1. After prereqs 1–2 are done and shadow agreement looks clean, add ONE test company to `PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES` and restart the server.
2. Verify the poll loop now SKIPS that company (`reconcileStrandedAssignedIssues`) and the Workflow drives attempts in `active` mode (real `escalateStrandedAssignedIssue` → wakeups).
3. Watch for redundant/missed wakeups; confirm recovery actions resolve as before.
4. Roll out to more companies gradually. **Rollback = remove the company from the allowlist and restart** (poll loop resumes authority for it immediately).

## Rollback

- Per-company: remove from `PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES`, restart server.
- Full: empty the allowlist (back to pure legacy poll loop). The Worker can keep running harmlessly in shadow; or disable the trigger wiring.

## Phase 2+ (out of scope)
- Approach B (edge-native: Workflows access state directly via Neon serverless HTTP driver / Hyperdrive, server out of the hot path).
- Phase 1.5 behavioral improvements: real `maxAttempts` cap, genuine `escalated` state, auto-resolution detection.
