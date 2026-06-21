# Cloudflare Workflows for Recovery Orchestration — Phase 1 Design Spec

> Status: APPROVED design (brainstorm). Next: implementation plan via writing-plans.
> Date: 2026-06-21
> Author: paul + Claude (subagent-driven brainstorm)

## Summary

Adopt **Cloudflare Workflows** as the durable orchestration substrate for paperclip's
dispatch concerns (durability/crash-recovery, long-running waits, retry/backoff offload,
and ultimately moving dispatch off the always-on Node server). This is a **phased,
strangler-fig migration**. This spec covers **Phase 1 only**: prove the model on one
bounded vertical slice — the **issue-recovery action lifecycle** — using **Approach A
(thin orchestrator + server-as-API, shadow mode)**.

The enterprise end-state is **Approach B (edge-native: Workflows access state directly,
server out of the orchestration hot path)**, reached *via* A — not built directly,
because building B first means debugging Workflow semantics, edge↔Postgres access, and
dual-writer cutover simultaneously. Approach C (Durable-Object-owned state async-synced to
Postgres) is **rejected** as a dual-source-of-truth anti-pattern.

## Goals (Phase 1)

- Prove Cloudflare Workflows' durable semantics on **real** paperclip work: durable steps,
  platform retries, durable `sleep`-based timers, and external-event cancellation.
- Replace the recovery subsystem's **blind full-table poll loop** with **one durable
  per-action Workflow instance** that owns its own timer.
- Do so with **near-zero blast radius**: default **observational shadow** mode beside the
  existing loop; opt-in **authority** per company behind a feature flag.
- Establish the reusable plumbing (CF Worker package, internal server API, local test
  harness) that later phases build on.

## Non-goals (Phase 1)

- Edge-native DB access (Approach B) — documented as Phase 2 destination, not built here.
- Behavioral *improvements* to recovery: today there is no `maxAttempts` cap, no real
  `escalated` state transition, and no auto-resolution when the source issue is actually
  fixed. **Phase 1 faithfully mirrors current behavior** and deliberately does NOT add
  these. They are banked as **Phase 1.5** (see Future Phases).
- Migrating any other dispatch concern (full heartbeat run, routines, approvals).
- The `agents` package / `AgentWorkflow` (WebSocket/Agent-state broadcast) — not needed for
  headless background orchestration.

## Background: how recovery works today (verified)

Research: `.superpowers/sdd/rd-recovery-lifecycle.md`.

- **Table** `issue_recovery_actions` has states `active | escalated | resolved | cancelled`.
  In practice only `active → active → resolved` occur; `escalated`/`cancelled` are defined
  but never written. `maxAttempts` is always `null`.
- **Persistence layer** `server/src/services/issue-recovery-actions.ts`:
  `upsertSourceScoped` (insert or attemptCount++), `resolveActiveForIssue` (→ resolved/
  cancelled + outcome), `getActiveForIssue`/`listActiveForIssues` (reads). An in-process
  mutex `runExclusiveUpsert` serializes upserts **within one process only**; the DB unique
  constraints (`issue_recovery_actions_active_source_uq`, `…_active_fingerprint_uq`) are the
  only cross-instance guard, with a `MAX_UPSERT_RETRIES=3` retry loop.
- **Scheduler**: a `setInterval(…, heartbeatSchedulerIntervalMs)` in `server/src/index.ts`
  (~line 745) runs `reconcileStrandedAssignedIssues()` every tick — a **full table scan**
  of `todo`/`in_progress` issues with a non-null assignee. **No `timeoutAt` gating**; every
  tick re-evaluates all candidates. The natural limiter is that once the source issue moves
  to `blocked`/`done`/`cancelled` it drops out of the scan.
- **An "attempt"** = `escalateStrandedAssignedIssue()` (`recovery/service.ts:~2178`):
  upserts the action (attemptCount++), sets the source issue → `blocked`, posts a system
  comment (first attempt only), and `enqueueWakeup(ownerAgentId, { reason:
  "source_scoped_recovery_action", idempotencyKey:
  "source_scoped_recovery_action:{actionId}:{attemptCount}" })`. If no owner exists, no
  wakeup fires and a board-escalation comment is left for a human.
- **Resolution** is explicit: `resolveActiveForIssue` via API, or automatic only for the
  watchdog `false_positive` case (`foldSourceResolvedStaleRun`).

**Consequence:** "port the recovery lifecycle to a Workflow" really means *"replace the
full-table poll-scan cadence with one durable per-action instance that sleeps between
attempts."* The rich retry/escalation machinery imagined up front does not exist to port —
so Phase 1 is smaller and should mirror today's behavior exactly.

## Background: Cloudflare Workflows facts (verified)

Research: `.superpowers/sdd/rd-cloudflare-workflows.md`.

- **Trigger from Node**: yes — REST API `POST /accounts/{acct}/workflows/{name}/instances`
  with optional `instance_id` + `params`, OR a Worker binding `env.WF.create({ id, params })`.
  No `agents` package required.
- **Custom/deterministic instance id**: yes; creating with an existing id **throws** within
  its retention window → pattern is catch + `get(id)`.
- **Durable sleep**: `step.sleep(name, duration)` / `step.sleepUntil(name, timestamp)`; max
  single sleep 365 days; sleeps do not count toward the step cap (1,024 free / 10k–25k paid);
  retention after completion 3 days free / 30 days paid; no hard workflow-lifetime ceiling.
- **`step.do`**: exactly-once on success (result cached by step name; never re-run on
  restart); retries `{ limit, delay, backoff }` (default limit 5); per-attempt timeout 10m
  (max 30m); throw `NonRetryableError` to stop retrying.
- **External events**: `step.waitForEvent` + send-event-to-instance for cancellation /
  early-resolve signals.
- **Plain Workflows vs `AgentWorkflow`**: `AgentWorkflow` only adds WebSocket broadcast /
  Agent RPC / Agent lifecycle callbacks. For headless background orchestration use **plain
  Workflows**.
- **Local testing**: `@cloudflare/vitest-pool-workers` — deterministic; sleeps resolve
  immediately, mock step results/errors, mock `waitForEvent`, `waitForStepResult()` /
  `waitForStatus()` assertions. (`wrangler dev` also supports local Workflows.)
- **Ambiguous/unconfirmed**: REST status code for duplicate id; no "fast-forward to T"
  test API (sleeps just resolve instantly); miniflare support unconfirmed.

## Architecture (Phase 1 — Approach A)

A new Cloudflare **Worker** package hosts a **plain Workflow** `RecoveryWorkflow`. One
instance per active recovery action, **`instance_id = recoveryActionId`** (idempotent
start). The Node server starts the instance (REST API or binding) when an action is first
created. The Workflow owns only the **orchestration position** (which attempt, sleeping
until when); the **server remains the single Postgres writer** and reuses existing recovery
logic via a small authenticated internal API. A **per-company feature flag** (mirroring the
model-policy env→DB flag+fallback already in the codebase) selects **observational shadow**
vs **authority**.

```
 recovery engine (server)                Cloudflare                    server internal API
 ─────────────────────────               ──────────                    ───────────────────
 upsertSourceScoped (new action)
        │ start instance (id=actionId) ──► RecoveryWorkflow.run()
        │                                   loop while active:
        │                                     step.do("attempt-N") ───► POST /internal/recovery/:id/attempt?mode=dry|active
        │                                     step.sleep(intervalMs)        (wraps escalateStrandedAssignedIssue / read)
        │                                   exit on not-active / event
 resolveActiveForIssue ── sendEvent ────►  step.waitForEvent (cancel)
```

### Component units (each one responsibility, well-defined interface)

1. **CF Worker package** `packages/cloudflare/recovery-workflow/` (mirror the layout of the
   existing `packages/plugins/sandbox-providers/cloudflare` worker):
   - `wrangler.jsonc` — declares the `RECOVERY_WORKFLOW` workflow binding + `class_name`,
     compatibility flags, internal-API base URL + secret env.
   - `src/recovery-workflow.ts` — the `WorkflowEntrypoint` with `run(event, step)`: the
     attempt/sleep loop, idempotent step names, `waitForEvent` cancellation.
   - `src/internal-client.ts` — typed client for the server internal API.
   - tests via `@cloudflare/vitest-pool-workers`.
2. **Server internal route** `server/src/routes/internal-recovery.ts` — the 3 endpoints
   behind an internal-auth guard (service-to-service secret; company-scoped):
   - `POST /internal/recovery/:actionId/attempt?mode=dry|active` — idempotent on
     `attemptNumber`; returns `{ status, attemptCount, active: boolean, nextIntervalMs }`.
   - `GET  /internal/recovery/:actionId` — current state.
   - `POST /internal/recovery/:actionId/resolve` and `/escalate`.
3. **Server attempt adapter** (thin service) — wraps existing fns at the identified seam:
   `getActiveForIssue` (read), `escalateStrandedAssignedIssue` (the attempt), and
   `resolveActiveForIssue` (resolve). Adds a **dry-run mode** that runs the read/decision
   parts WITHOUT the writes (the write/decision split is the main implementation cost — see
   Risks).
4. **Trigger hook** — at `upsertSourceScoped` (new active action), start/ensure the Workflow
   instance (catch-duplicate→get). Behind the feature flag.
5. **Link table** `recovery_workflow_links(action_id, instance_id, mode, created_at)` — a
   **side table** (NOT new columns on the drift-prone `issue_recovery_actions`) mapping
   action → instance + mode. (Heed the repo's Drizzle snapshot drift: after `db:generate`,
   trim the migration to only this table.)
6. **Config** — internal-API base URL + shared secret; CF account/workflow binding;
   per-company flag. **Phase 1 uses an env-var allowlist** `PAPERCLIP_RECOVERY_WORKFLOW_COMPANIES`
   (comma-separated company ids; empty ⇒ all-shadow). Env keeps Phase 1 dependency-free and
   needs no UI; a DB-backed flag (like model policies) can come with Phase 1.5 if runtime
   editing is wanted.

## Lifecycle & data flow

**Shadow mode (default).** The existing poll loop stays authoritative and performs the real
attempts. The Workflow runs in parallel, calling `attempt?mode=dry` — which returns
*"is the action still active? / what would the attempt do? / next interval"* with **no side
effects** — and records its decisions for diffing against the live loop. Source of truth
stays Postgres; the Workflow owns only the durable timer/position.

**Authority mode (flag on, per company).** The poll loop **skips flagged companies**; the
Workflow's attempt endpoint runs `mode=active` (invokes `escalateStrandedAssignedIssue`).
Exactly one path acts per company, preserving single-writer.

**Loop logic (`RecoveryWorkflow.run`):**
1. Read action state (from `event.payload` + `GET /internal/recovery/:id`).
2. While `active`: `step.do("attempt-{n}")` → call attempt endpoint (mode per flag); if the
   response says not-active → break; else `step.sleep("wait-{n}", nextIntervalMs)`.
3. Race the loop against `step.waitForEvent("cancel")` — server sends a cancel/resolve event
   when the action resolves out-of-band.
4. Terminal: instance completes (action resolved/dropped).

`nextIntervalMs` mirrors today's `heartbeatSchedulerIntervalMs` cadence (faithful behavior).

## Error handling

- **Step failures** → platform retries (bounded `{ limit, delay, backoff }`). Genuinely
  terminal conditions throw `NonRetryableError`.
- **Server API unavailable** → step retries/backoff; in shadow there is **zero harm** (poll
  loop authoritative). In authority mode, sustained failure surfaces via workflow status /
  alerting; an operational fallback is to clear the company flag (poll loop resumes).
- **Attempt idempotency** — the server dedupes on `(actionId, attemptNumber)` so a retried
  step never double-acts.
- **Upsert conflicts** — treated as **retryable** (the in-process mutex is inert across
  instances; the DB unique constraint is the real guard).
- **Duplicate instance start** — catch + `get(instanceId)` (idempotent trigger).
- **Cancellation/early resolve** — `sendEvent` to the instance; the loop also self-exits when
  an attempt reports not-active.

## Testing strategy

- **Workflow logic** (`@cloudflare/vitest-pool-workers`): attempt→sleep→exit sequence;
  idempotent step replay; `maxAttempts`-style exit via not-active response; cancellation via
  injected `waitForEvent`; instant-sleep determinism.
- **Server internal API** (vitest, mocked services like the existing route tests): dry vs
  active behavior, idempotency on `attemptNumber`, auth rejection, resolve/escalate.
- **Adapter dry-run**: asserts the read/decision path runs and performs **no writes**
  (spy the write fns).
- **Coexistence**: flag-off ⇒ existing recovery tests unchanged (no behavior change).
- **Shadow diff harness**: compares Workflow decisions vs the live loop over recorded
  scenarios — the acceptance signal before granting authority.

## Risks & mitigations

1. **Write/decision split in `escalateStrandedAssignedIssue`** (it currently reads + writes
   atomically). Dry-run mode needs the decision/read parts factored from the writes —
   the main implementation cost. Mitigation: extract a pure `planAttempt()` that both
   dry-run and active call; active then performs the writes. Keep the refactor surgical.
2. **Drizzle snapshot drift** (known repo debt): `db:generate` bundles already-migrated
   tables. Mitigation: trim the generated migration to only `recovery_workflow_links`,
   keep the regenerated snapshot. (See the project memory on this.)
3. **Two writers during authority cutover.** Mitigation: the poll loop must hard-skip
   flagged companies; the flag is the single switch; never both.
4. **No test "fast-forward" for sleeps.** Mitigation: vitest-pool-workers resolves sleeps
   instantly — assert ordering/counts, not wall-clock.
5. **Operational surface** (CF account, secrets, deploy). Mitigation: reuse the existing CF
   footprint/account from the sandbox bridge; secret via env; document deploy in the plan.

## Future phases (out of scope here)

- **Phase 1.5** — behavioral improvements once the platform is trusted: real `maxAttempts`
  cap, genuine `escalated` state transition, auto-resolution detection.
- **Phase 2 (→ Approach B, enterprise end-state)** — move reads/writes to the edge (Neon
  serverless HTTP driver if paperclip's Postgres is Neon — the connected Neon tooling
  suggests so — else Hyperdrive), retiring the server from the orchestration hot path.
- **Phase 3+** — extend the proven pattern to other dispatch concerns (heartbeat runs,
  routines, approval gates).

## Acceptance criteria (Phase 1)

- A deployable CF Worker hosting `RecoveryWorkflow`; instances started by the server with
  `instance_id = actionId`.
- Server internal API (dry/active, auth, idempotent) + the dry-run adapter.
- `recovery_workflow_links` table + trimmed migration.
- Per-company flag; flag-off is a strict no-op (existing tests green).
- Workflow + API + adapter tests pass locally (vitest-pool-workers + server vitest).
- Shadow diff harness demonstrates Workflow decisions match the live loop on recorded
  scenarios.
