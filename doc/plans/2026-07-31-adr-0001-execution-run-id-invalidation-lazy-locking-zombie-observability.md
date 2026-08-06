# ADR-0001: Invalidation of executionRunId in dead runs, lazy locking and zombie observability

Date: 2026-07-31

Status: Accepted (board-travado ViraUp: Clean Architecture + structured logging). Implementation owned by the Vir-291 `[Infra]` child; this document records the architectural decision only.

Source issues:

- Parent: VIR-291 (root-cause confirmed by CTO: `executionRunId` migrated to a terminal run during `process_lost_retry` → 409 cascade).
- Architect child: VIR-309 (this document).
- Infra child: execution of Fix A / Fix B-light / Fix D-obs.
- Code-comment references also cite VIR-295 and VIR-296 alongside VIR-291; this ADR is the single design rationale referenced by all three trees (`ADR-0001 (VIR-295 / VIR-296)`).

Related (out of scope, not reopened): VIR-262, VIR-270.

## Context

Paperclip serializes per-issue execution ownership on two columns of `issues`:

- `checkoutRunId` — the heartbeat run that currently holds the issue's checkout lock (set on `POST /api/issues/:id/checkout`, cleared on release/finalize).
- `executionRunId` — the run that owns the issue's active execution surface; every mutating route (`PATCH /issues/:id`, `POST /:id/comments`, `PUT /:id/attachments`, `…/documents/:key`, `…/checklist/release`, etc.) is gated through `issues.assertCheckoutOwner` (issues.ts:7254) which resolves ownership and throws `conflict("Issue run ownership conflict", …)` (HTTP 409) when no adoptable owner can be derived.

The `executionRunId` column is the "real" lock. `checkoutRunId` is the per-checkout handle. When they disagree or drift toward a finalized/missing run, every downstream mutation wedges on 409.

### The bug

When a heartbeat run was lost (`process_lost`), `enqueueProcessLossRetry` (heartbeat.ts:8707) scheduled a retry run and, in the same enqueue transaction, **migrated `issues.executionRunId` to the brand-new retry run id** before the retry had ever been checked out. This created a **zombie window**:

1. The retry run is enrolled as `queued` (status `queued`, never `running`).
2. `issues.executionRunId` now points at that retry run id.
3. If the retry dies before its first checkout (process loss of the scheduler, pod restart, agent uninvokable, retry budget exhausted, etc.), the retry run itself goes terminal while `issues.executionRunId` still names it.
4. The issue is now pointing at a **terminal run** as its execution owner.

At that point:

- `assertCheckoutOwner` (issues.ts:7254) calls `clearExecutionRunIfTerminal` + `clearCheckoutRunIfTerminal` as a self-heal, but those narrow per-issue helpers only fire when the referenced run is verifiably terminal. The 409 path (issues.ts:7376-7395) fires when the resolve cascade (`resolveSameRunOwnership` → `canAdoptUnownedCheckout` → `adoptStaleCheckoutRun`) cannot find an adoptable owner for the actor's `actorRunId`.
- `POST /api/issues/:id/comments` happened to pass because the comment route bypasses `assertCheckoutOwner` for append-only writes — comments do not require execution ownership, only issue visibility.
- `PATCH /api/issues/:id`, `PUT /api/attachments`, `PUT …/documents/:key`, `PATCH …/checklist/release`, and similar ownership-gated routes all hit `assertCheckoutOwner` and were rejected with **409 "Issue run ownership conflict"**. The active run could not mutate its own issue because the issue's execution lock was stuck on a dead run id.

The `releaseIssueExecutionAndPromote` finalizer (heartbeat.ts:14540) clears orphaned `executionRunId`/`checkoutRunId` columns across every sibling that still points at the finalizing run (heartbeat.ts:14625-14648), and the periodic `sweepStaleIssueLocks` (recovery/service.ts:5300) is the last-resort backstop. But the time-to-first-clear between "retry died" and "reaper swept the lock" was the zombie window during which the active run wedged on 409.

### Why migration at enqueue was wrong

Migrating `executionRunId` at enqueue time turns a **queue scheduling** concern into an **ownership transfer**. The retry run does not yet own anything — it has not run a single line of agent code, has not asserted checkout, and may never become `running`. Giving it the execution lock speculatively violated the invariant "the run that owns the issue's execution surface is the run that is actually executing it."

This is a Clean Architecture (ports & adapters) leak: the enqueue adapter (scheduling concern) was mutating the application-state port (`issues.executionRunId` ownership) without an owning use-case having committed to the new run. The fix returns ownership transfer to the **checkout** use-case (`issues.checkout`, issues.ts:7057), which is the single place authorized to claim execution ownership for a run.

### Structured-logging requirement

ViraUp board-travado padrão requires that failure paths log enough to diagnose them. Before this fix, the sweep cleared zombie locks defensively but did not say so: there was no structured `WARN` for the zombie condition. Dashboards could not distinguish "no zombies" from "zombies silently cleared." The decision therefore adds a dedicated observability signal before cleanup.

## Decision

Three coupled changes, accepted as a single decision (Fix A + Fix B-light + Fix D-obs). The dirty changeset on `master` already implements all three; this ADR records the decision and the design contract.

### Fix A — Lazy locking: stamp `executionRunId` at claim, not at enqueue

`executionRunId` is written to the issue row only when a run actually claims the run as `running`.

- Implementation: `heartbeat.executeOrRecover` claims the run (`heartbeatRuns.status: queued → running`) and then stamps `issues.executionRunId = claimed.id` guarded by `where executionRunId is null or executionRunId = claimed.id` and `where assignee_agent_id = claimed.agent_id` (heartbeat.ts:10887-10912).
- The guard is **idempotent**: re-stamping the same run is a no-op; a concurrent adoption elsewhere is preserved because `where` only matches when the row's current owner is null-or-self.
- `source_scoped_recovery_action` wakeup runs are excluded (heartbeat.ts:10892) because those recovery runs intentionally do not take execution ownership of the context issue.

### Fix B-light — Do not migrate `executionRunId` on retry; clear only `checkoutRunId`

`enqueueProcessLossRetry` stops migrating `issues.executionRunId` to the new retry run at enqueue time.

- Implementation (heartbeat.ts:8813-8844): the enqueue transaction only clears `issues.checkoutRunId = null` (and refreshes `executionAgentNameKey`/`executionLockedAt`) and **only when the row still points at the finalized run being reaped** (`where issues.executionRunId = run.id`). A concurrent adoption is therefore not clobbered.
- `executionRunId` keeps pointing at the now-terminal finalized run until either:
  - the retry's first real checkout reclaims it via `issues.checkout` (issues.ts:7105 sets `executionRunId = checkoutRunId` under `or(executionRunId is null, executionRunId = checkoutRunId)`), or
  - `releaseIssueExecutionAndPromote` (heartbeat.ts:14625-14635) clears it during the run's finalize path (which already treats `executionRunId=null`/terminal), or
  - the periodic `sweepStaleIssueLocks` backstop clears it.

This removes the zombie window at its source: a retry that never runs never receives the execution lock, so its death leaves no zombie.

### Fix D-obs — `WARN zombie_executionRunId_detected` before cleanup

`recovery.sweepStaleIssueLocks` (recovery/service.ts:5300) now emits a structured `WARN` log per zombie reference **before** the cleanup `UPDATE`, plus a summary `WARN` with the count (recovery/service.ts:5347-5455).

- Log event name: `zombie_executionRunId_detected` (per-issue) and `zombie_executionRunId_count` (summary), with fields `issueId`, `runId`, `runStatus`, `companyId`, `source: "recovery.sweepStaleIssueLocks"` (recovery/service.ts:5371-5381, 5446-5454).
- The periodic heartbeat tick in `index.ts` (index.ts:1157-1167) reads the returned `zombieRefs` and emits a top-level `WARN` so dashboards/feed summaries can alert on a non-zero zombie count without scraping per-issue logs.
- The WARN is emitted **before** the cleanup so it is captured even if the cleanup `UPDATE` races a concurrent adoption and clears nothing.

## Alternatives considered

### Alternative 1: Migrate `executionRunId` at enqueue but make the retry's death immediately clear it
- **Pros**: No new lazy-locking path; minimal change to `enqueueProcessLossRetry`.
- **Cons**: Pushes the cleanup responsibility onto every retry-finalize path (timed out, cancelled, budget exhausted, uninvokable). Each terminal transition would have to remember to clear `executionRunId` on the context issue; misses are exactly the bug class we are fixing.
- **Why not**: It keeps the speculative ownership transfer that caused the bug. Lazy locking removes the class by construction, not by vigilance.

### Alternative 2: Reclaim the execution lock inside `assertCheckoutOwner` instead of checkout
- **Pros**: One chokepoint ownership function; any route could self-heal on demand.
- **Cons**: `assertCheckoutOwner` is on the hot path of every mutation. Promoting it from "assert + adopt unowned/stale checkout" to "speculatively rewrite `executionRunId`" mixes validation with state mutation, broadens 409 risk surfaces, and re-introduces a speculative write — same smell as the original bug, on a busier code path.
- **Why not**: Ownership transfer belongs to the run-transition use case (`checkout`/`releaseIssueExecutionAndPromote`), not to the validation getter. Keep Clean Architecture layering: assert verifies, claim mutates.

### Alternative 3: Drop the `executionRunId` column and derive ownership purely from `checkoutRunId`
- **Pros**: One column, simpler model.
- **Cons**: `checkoutRunId` is the per-checkout handle and intentionally can be `null` between checkouts (e.g. `deferred_issue_execution` wait, paused holds, runs touching the issue without claiming checkout). `executionRunId` is the durable owner pointer that survives a checkout-release-and-rerun cycle. Conflating them breaks deferred-wake promotion (`releaseIssueExecutionAndPromote` uses `executionRunId` to find sibling issues still referencing the finalizing run) and weakens multi-issue lock cleanup (heartbeat.ts:14558-14648).
- **Why not**: The two columns model different lifetimes. Removing one to dodge one bug would create many.

### Alternative 4: Eagerly sweep zombies on every mutation request instead of periodic
- **Pros** Near-zero zombie lifetime; no observable 409 window.
- **Cons**: Every `assertCheckoutOwner` call would run a `select … where execution_run_id in (…)` against `heartbeat_runs`, adding a round trip to the hottest write path. The periodic sweeper already converges; the real 409 driver was the enqueue-time migration (fixed by Fix B-light), not the sweep cadence.
- **Why not**: Cost-to-benefit is poor. Lazy locking already removes the steady-state zombie; the sweep remains a backstop for orphans, with Fix D-obs giving visibility into backstop hits.

## Consequences

### Positive
- Eliminates the zombie window at its source: a retry run that dies before checkout leaves no zombie `executionRunId`. 409 cascades on the context issue disappear for the process-loss retry class.
- Ownership transfer is owned by a single use case (`checkout`) — Clean Architecture: the scheduling adapter no longer mutates the application-ownership port.
- The lazy-stamp guard is idempotent and concurrency-safe: re-stamp is a no-op; a concurrent adoption by a different run/issue combination is preserved by the `where` clause.
- Dashboards now have a first-class `zombie_executionRunId_detected` / `zombie_executionRunId_count` signal to alert on backstop sweep hits, satisfying the ViraUp structured-logging requirement that failure paths be diagnosable from logs alone.
- The two-column clear in `releaseIssueExecutionAndPromote` is already split (heartbeat.ts:14614-14648) so a future change reintroducing enqueue-time migration cannot silently clobber — defense in depth documented in code comments.

### Negative
- There is a small observable window between the run becoming `running` (claim) and the issue's `executionRunId` being stamped (heartbeat.ts:10887). During that window the issue's `executionRunId` may be `null` (first checkout) or point at the previous finalized run (retry path). This is acceptable and strictly better than the prior zombie: any mutation in that window either goes through `assertCheckoutOwner`'s adoption paths (`canAdoptUnownedCheckout` / `adoptStaleCheckoutRun`), or is rejected and retries on the next tick — and crucially the prior finalized run is verifiably terminal so `clearExecutionRunIfTerminal` self-heals it.
- Observability for the zombie condition only exists for the periodic sweeper path. If a future code path creates zombies outside the sweep cadence, the WARN will lag behind actual occurrence. Mitigated by the summary WARN on the scheduled tick (index.ts:1157) and by the requirement that all `releaseIssueExecutionAndPromote` calls clear `executionRunId` symmetrically.
- Multi-issue lock semantics (a run holding execution locks on several sibling issues via `contextSnapshot.issueId`) are unchanged; Fix A only re-timestamps the single claimed context issue. Orphan siblings are still resolved by the existing bulk clear in `releaseIssueExecutionAndPromote`. The ADR explicitly does not change that contract.

### Risks
- **Hypothesis 1 — adapter child pid**: The CTO root-cause notes that the original `process_lost` could involve an adapter child process outliving the heartbeat run record. This decision does **not** fix that hypothesis directly; it contains the blast radius via composition (lazy locking + non-migration + zombie observability). If Hypothesis 1 recurs, a separate ADR addressing adapter lifecycle/reaping is required. The mitigation status stays "mitigated by composition, not fixed at source." Tracked under VIR-291 follow-ups, not here.
- **Retro-fit risk on dirty master**: The dirty changeset on `master` ships all three fixes together. A partial revert (e.g. revert Fix A only) re-opens the zombie class partially. Code comments at each checkpoint reference `ADR-0001 Fix A/B-light/D-obs (VIR-296)` so reviewers can verify the trio stays coupled.
- **Future "migrate at enqueue" reintroduction**: A future engineer might want to migrate `executionRunId` at enqueue for scheduling convenience. The split UPDATE + comments in `releaseIssueExecutionAndPromote` (heartbeat.ts:14614-14623) are meant to make that regression visible in review. This ADR is the durable rationale.

## Clean Architecture & logging conformance (ViraUp board-travado)

This decision is consistent with the ViraUp engineering standard (board-travado):

- **Clean Architecture / clean-mode (ports & adapters)**. The execution-ownership column is an application-state port owned by the `issues` service (`checkout`, `assertCheckoutOwner`, `releaseIssueExecutionAndPromote`). The scheduling adapter (`enqueueProcessLossRetry`, `executeOrRecover` run-transition) previously reached across the layer boundary to mutate that port speculatively. The fix returns ownership mutation to the `checkout` use-case and to the run-finalize use-case, leaving the scheduler to schedule and the finalizer to finalize — each on its own side of the hexagonal seam. Lazy locking is precisely this: an adapter transition writes the port only when it has committed to the new owner, not when it merely queued the possibility of one.
- **Structured logging (web + mobile)**. Level is `warn` (a recoverable self-heal, not an error). Event names are stable strings (`zombie_executionRunId_detected`, `zombie_executionRunId_count`) so dashboards and alerts can key on them. Correlation ids are carried per-entity: `issueId`, `runId`, `companyId`. No secrets/tokens/PII are logged — only run/issue/company ids and run lifecycle status. Failure paths (the sweep, the finalize clear) now log the failure (zombie reference) and the recovery (lock cleared) at `warn` level; the next operator on call can diagnose a wedged 409 from the logs without reproducing the race. The platform's logger is **pino** (`server/src/middleware/logger.ts:32`, JSON structured, with `pino-http` and redaction paths backed by `HTTP_LOG_REDACT_PATHS` — see `server/src/__tests__/http-log-redaction.test.ts`); the zombie WARNs use the same logger in canonical pino object-first form (`logger.warn({ event, issueId, … }, "message")`) and inherit the platform's redaction guarantees for any future structured fields that might carry header/request data.

## Code checkpoints (rastreabilidade)

All references are against `C:\Users\etava\Music\OpenClaude\paperclip` at the time of writing on the dirty `master` changeset. Line numbers are illustrative of the current file state and will shift; identifiers (`ADR-0001 Fix A/B-light/D-obs`, `zombie_executionRunId_detected`, `sweepStaleIssueLocks`) are the durable anchors.

| Decision | File | Anchor |
| --- | --- | --- |
| Fix A — lazy locking, stamp `executionRunId` at claim | `server/src/services/heartbeat.ts` | `:10887` "Fix A (lazy locking): stamp executionRunId now that the run is actually running" |
| Fix B-light — do not migrate `executionRunId` on retry, clear only `checkoutRunId` | `server/src/services/heartbeat.ts` | `:8814` "ADR-0001 Fix B-light (VIR-296): do NOT migrate `executionRunId` to the retry run at enqueue time" |
| Fix D-obs — per-issue zombie `WARN` before cleanup | `server/src/services/recovery/service.ts` | `:5347` / `:5373` (`event: "zombie_executionRunId_detected"`), `zombieRefs` accumulator at `:5308` |
| Fix D-obs — periodic-tick summary `WARN` | `server/src/index.ts` | `:1157` "ADR-0001 Fix D-obs (VIR-296): explicit zombie WARN on the periodic tick" |
| Claim use-case that reclaims the execution lock | `server/src/services/issues.ts` | `:7057` `checkout` (sets `executionRunId = checkoutRunId` under `or(executionRunId is null, eq(executionRunId, checkoutRunId))`) |
| Ownership gate that previously 409'd on the zombie | `server/src/services/issues.ts` | `:7254` `assertCheckoutOwner`, throws `conflict("Issue run ownership conflict", …)` at `:7376`/`:7387` |
| Fix A companion — `markRunFailedProcessLost` injection used by the ownership self-heal | `server/src/services/issues.ts` | `:3814` / `:3819` ("ADR-0001 (VIR-295 / VIR-296)"), `:3858` "ADR-0001 Fix A — detect a heartbeat run whose DB row still claims" |
| Fix A companion — run-handle registry rationale for relaxing the ownership guard | `server/src/services/run-handle-registry.ts` | `:7` "executionRunId window documented in ADR-0001 (VIR-295 / VIR-296)", `:101` "ownership path can relax its guard (ADR-0001 Fix A)" |
| Bulk sibling-clear of orphan columns (split UPDATE) | `server/src/services/heartbeat.ts` | `:14625` (execution clear) and `:14640` (checkout clear) inside `releaseIssueExecutionAndPromote` (`:14540`), with the ADR-0001 rationale comment at `:14614-14623` |

## Out of scope

- Implementation work — owned by the `[Infra]` sibling child of VIR-291.
- Reopening product VIR-262 / VIR-270.
- A direct fix for Hypothesis 1 (adapter child pid lifecycle). Mitigated by composition here; a dedicated adapter ADR is the right venue if it recurs.
