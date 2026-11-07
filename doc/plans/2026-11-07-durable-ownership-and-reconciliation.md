# Durable ownership and reconciliation for restart safety

Status: draft for review, 2026-11-07
Evidence: the 2026-11-06/07 control-plane restart chaos campaign (plan: `doc/plans/2026-11-06-control-plane-restart-chaos.md`). It merged about 69 PRs, #19469 through #19807. The "RC-" IDs below are that campaign's signature IDs.

## Recommendation

Stop fixing restart bugs one crash window at a time. Add one shared ownership primitive, one write-ahead intent rule for outside effects, and one reconciler that brings every in-progress record to a terminal state. Then move the existing hand-built mechanisms onto it, one at a time. Gate it in CI with a deterministic crash-point suite, not with random chaos timing.

## Why: the campaign's bugs share one shape

A control-plane restart can land between any two durable writes. It leaves an in-progress record owned by a process that is now dead. That record might be a lease, a startup fence, a coordinator claim, a workspace operation, an accounting receipt, a reservation or a deferred wake. Each subsystem decided alone whether it was safe to continue, and none could prove the owner was dead. They fail closed, so the leftover record became a Retry, a company-wide hold, or a run that stays `running` forever.

| Class | Examples (ledger IDs) | Approximate PRs |
|---|---|---|
| A dead owner's fence or lease that only a TTL releases | RC-16/16b/16c, 29d, 39, 41, 42, 47, 50, 57, 62, 64 | 12 |
| Accounting completeness gates company admission | RC-05/06 family, including regressions RC-06k and RC-06m | 8 |
| Work intents (wakes, Retries, comments) end terminally on a temporary refusal | RC-37, 45, 58, s7532 | 4 |
| Retry budgets charged per restart, not per unit of work | RC-22/22b/22c, 40, 60 | 5 |
| Events from an earlier generation break the current turn | RC-15, 20/20b/20c, 33/33b, 59, 61 | 10 |

The repeated reinvention shows up in the code:
- 40 server files reference a boot id.
- About 25 implement process liveness (`isProcessAlive`, `isProcessGroupAlive`, `controllerProcessExited`, `proveLocalWorkspaceOwnerStopped`, and others).
- 15 or more `*ownership*` / `*owner*` modules each carry their own rules.

The accounting fixes regressed each other three times. Twice the cause was an inferred-evidence check that was subtly wrong: key presence counted as proof, and an empty map was not null (RC-06m).

## Invariants the design must guarantee

These become reconciler checks and crash-suite assertions. They should also be added to `doc/SPEC-implementation.md`.

1. **Owned:** every in-progress durable record carries an owner stamp and a generation.
2. **Settled:** a record whose owner is proven gone reaches a terminal state within a bounded time (target: one reconciler pass after boot). Proof is by identity, never by age.
3. **Admission is independent of cleanup:** admitting new work never waits on another run's cleanup or accounting completeness. Only real spend reaching a hard stop, an explicit pause, or an inactive company refuses work.
4. **Exactly-once intents:** an accepted work intent (assignment, comment, Retry, recovery) is delivered exactly once, unless the task is cancelled or a hard stop applies. A temporary refusal defers it and never ends it terminally.
5. **Work-based budgets:** a restart consumes run budget only when the resumed attempt started provider work and made no progress.
6. **Generation fencing:** every runner and provider event carries its generation and turn. Events from an earlier generation are recorded as history and never fail the current turn.
7. **Visible next action:** every non-terminal task has a next action, either automatic or a working control. "Waiting" with no owner is a violation.
8. **Fast turns:** TTFT and agent boot stay within their measured budgets. Restart safety work never adds waiting or file transfer before `turn.start` (see "Performance constraint" below).

## Performance constraint: a turn must start as fast as possible

When someone messages an agent, the reply has to start as fast as possible. Restart safety must not make turns slow. A turn that spends minutes moving files between the sandbox and the host before the model starts fails this design, however correct it is.

### What we measure

These are measured for every run and recorded in the run log. With an OTLP endpoint set, they are also emitted as spans on the existing `run.startup.step` / `paperclip.sandbox.startup.*` path in `packages/adapter-utils/src/acpx-engine/startup-timing.ts`. They are never sent to Telemetry (AGENTS.md §5.7).

| Metric | From | To |
|---|---|---|
| **Time to first token (TTFT)** | user message or wake accepted | first deliverable model text. This extends the existing `task.time_to_first_token` (`native-session-executor.ts`) back to the message timestamp. |
| Agent boot | run claimed | provider session ready to accept `turn.start` |
| Critical-path breakdown | | queue wait, admission, workspace preparation and staging, environment acquire, runner launch, session open/resume, `turn.start` to the provider's first event |
| Restart recovery latency | control plane ready | recovered run's next provider event, for reattach and resume separately |
| Turn tail | provider turn completed | run terminal and task updated, including copyback and sync-out |

Each metric is reported by adapter (Codex, Claude/ACPX, OpenCode) and environment (local, Daytona), for warm and cold starts, as p50/p95.

### Rules for this design

1. **Nothing new goes on the critical path.** Intent records, owner stamps and generation stamps are small single-row writes in the transaction the path already uses. The reconciler runs only in the background. It never adds a wait before `turn.start`.
2. **File transfer must not block the next turn.** A follow-up turn on a still-valid sandbox lease uses the workspace that is already there. Sync-out, checkpoints and copyback run after the turn or alongside it, and incrementally. They never run as a full round trip before the model starts. A restart with a live runner reattaches; it does not restage.
3. **Fixed waits become event-driven.** Each one the campaign found is a target:
   - RC-04: graceful drain waits the full 30 s;
   - RC-09: a cold OpenCode attach takes 31–38 s against a 30 s bound;
   - RC-36: `session.open` 30 s;
   - RC-20b: a late Codex turn start of about 27 s;
   - RC-27: a 5-minute orphan reaper.
4. **Phase 0 measures, then sets budgets.** It records a baseline for every metric above. Phase 1 sets p50/p95 budgets per adapter and environment. From then on, every phase's exit criteria include "no regression against the baseline". The on-demand crash-point suite and the chaos soak also report TTFT and restart recovery latency.

### Speed budgets (Phase 1)

Phase 1 sets these budgets from the local baseline in `2026-11-07-ttft-baseline.md`. Each budget is the baseline value times 1.2, rounded up to 0.5 s. The 20% headroom covers the small samples and the shared host of the baseline. Daytona and other remote environments get budgets after their own baseline.

A single run is checked against its p95 budget. When a run exceeds it, the run log gets one `run.performance.budget_exceeded` row (`doc/run-log-events.md`). The p50 budgets apply to aggregates: chaos waves, the baseline driver, and staging. Every later phase's exit criteria include "no regression against these budgets". The table lives in code at `server/src/services/native-runtime/native-speed-budgets.ts`.

Time to first token (s, p50 / p95):

| Adapter | Cold | Warm |
|---|---|---|
| claude | 16.5 / 30.0 | 9.5 / 28.5 |
| codex | 6.0 / 17.0 | 10.0 / 28.5 |
| opencode | 17.5 / 49.0 | 26.5 / 88.0 |

Agent boot (s, p50 / p95):

| Adapter | Cold | Warm |
|---|---|---|
| claude | 9.0 / 20.5 | 3.5 / 16.5 |
| codex | 2.5 / 7.0 | 5.0 / 16.5 |
| opencode | 12.0 / 37.0 | 22.0 / 65.5 |

Restart recovery latency, from `ready` to the recovered run's next provider event (s, p50 / p95). The source is the baseline's run 4, which has 2 samples per adapter and disposition, so the largest disposition row is used:

| Adapter | Budget |
|---|---|
| claude | 15.0 / 22.5 |
| codex | 6.5 / 8.0 |
| opencode | 25.5 / 38.5 |

These budgets measure the product default `lifecycleMode: per_turn`. Phase 1's TTFT work (runner and provider-session reuse, baseline finding 1) should lower them. Lower budgets go in the same table.

## Relationship to the zero-downtime upgrade work

Separate work moves the control plane toward zero-downtime upgrades on an ephemeral filesystem. PostgreSQL holds execution authority and durable protocol state. Object storage holds workspace archives, provider checkpoints, logs, traces and skill assets. Replacement servers reuse stable encryption and signing secrets. Most of the foundations are on master; #19830 is still open. Entry points:
- `server/src/services/ephemeral-server-contract.ts`
- `server/src/services/heartbeat/upgrade-readiness.ts`
- `server/src/services/native-runtime/native-runner-ownership.ts`
- `server/src/services/native-runtime/native-finalization-reconciler.ts`
- `server/src/services/native-runtime/native-harness-filesystem-independence.ts`
- in paperclip-cloud, `src/fleet/ephemeral-overlap.ts`

This plan builds on that work and must not fork it:

1. **The remote runner keeps running across a control-plane replacement.** The replacement server takes fenced ownership and reconciles durable checkpoints and results. It never starts a duplicate execution. So for remote runners, ownership moves by **fenced handoff** (lease and fence token), not by a process-liveness proof. A different host is never proof that an owner is dead. The `OwnerStamp` in section A records the fence token. `proveOwnerGone` applies only to local processes and to providers that give a platform proof.
2. **Graceful handoff and abrupt death are different paths.** Graceful replacement releases ownership explicitly. Abrupt death during a tool, result acceptance, finalization, or workspace export is recovered by proof or fence expiry. The crash-point suite covers both, including stale-owner fencing and duplicate result and accounting protection.
3. **Obligations stay separate.** Ownership, accepted results, workspace preservation and accounting are separate obligations. Each Phase 0 inventory row names exactly one of them, and settling one never settles another:
   - preserving files never marks a failed run successful;
   - preserving files never clears an unresolved export or recovery hold;
   - preserving files never grants provider-resume authority.

   WEB evidence receipts prove filesystem preservation, not successful remote recovery.
4. **Extend the existing pieces.** Section C extends `native-finalization-reconciler.ts`; it does not add a second loop. Section A starts from `native-runner-ownership.ts` and `controller-process-identity.ts`. Phase 0 includes the upgrade work's record kinds, and its owner reviews the inventory.
5. **External tool effects are not exactly-once.** The design guarantees exactly-once for Paperclip's own records (results, accounting, wakes). A tool's outside effect may run again after a crash. The agent checks before it repeats one; see #19804.
6. **Object storage must stay off the turn path.** Restoring an archive or checkpoint must not delay `turn.start` when a live workspace or runner exists. A cold restore that cannot be avoided counts against the time-to-first-token budget and is reported as its own step.

## Design

### A. One ownership primitive

Start from `server/src/services/controller-process-identity.ts`, which #19696 introduced. Today only `sandbox-creation-operations.ts`, `heartbeat/recovery.ts` and `environment-runtime.ts` (#19749) use it. #19713 (`native-dead-controller-result-lease.ts`) and #19717 (`native-workspace-owner-stop-proof.ts`) built their own proofs of the same fact in the same night.

- `OwnerStamp` = `{ host, pidNamespace, bootId, pid, processStartedAt, processGroupId?, generation, scope }`.
- One prover, `proveOwnerGone(stamp)`:
  - A local proof requires the same host and pid namespace, plus either a dead pid or a reused pid (checked against the start time), plus an empty or older process group.
  - A remote proof is delegated to the environment provider: lease termination, sandbox state, or a runner identity marker.
  - The prover returns `gone | alive | unprovable`. `unprovable` never releases a record.
- Every record kind in the inventory below stores an `OwnerStamp` when it enters an in-progress state.

### B. Write-ahead intents for outside effects

The rule: record an intent before the effect, and record the outcome after it. Recovery reads the intent log, not inferred evidence. Several kinds already do this and should share one shape and one settle path:
- `sandbox_creation_operations` (#18357, #19696)
- the runner's `startupAttempt` with `beforeSpawn` (#19784)
- the controller's `turn.start` journal (#19772)
- workspace operations (#19807)

Effects still to cover:
- copyback stop
- runner release/destroy, partly done in #19749
- reservation hold and release
- workspace staging

### C. One reconciler

A registry maps each ownable record kind to `{ listInProgress, settle(record, proof), invariantChecks }`. One loop runs at startup and every 30 s:
- For each in-progress record with an owner stamp that isn't the current boot, call `proveOwnerGone`. If the owner is gone, call `settle`. If the proof is unprovable, surface an operator action.
- Run the invariant checks (I1–I7). Each violation writes a `recovery.invariant_violation` activity and a run-log event with the record and the rule. The loop repairs a violation when a safe repair is registered.
- Keep the loop sleep-aware: no work when nothing is in progress (see the `sleep-aware-background-work` skill).

This replaces the per-subsystem startup sweeps gradually, by deleting each one once its kind moves onto the registry.

### D. Separate admission from accounting

- Admission reads per-run exposure only: reserved plus observed cost. Hard stops use settled or estimated spend.
- A run with unfinished accounting adds its bounded estimate to exposure. It never adds a company-wide gate.
- This finishes the direction of #19497 → #19724 → #19826 and removes the `waitingRunCount` gate, rather than narrowing it again.

### E. Work-intent outbox

- Wake requests get a closed set of terminal reasons: delivered, consumed by a later run, task cancelled, or hard stop. Every temporary refusal becomes `deferred` with a reason and a wake trigger.
- Any event that releases a hold (accounting settled, lock released, pause lifted) promotes deferred intents through one function. The reconciler covers any trigger that is missed.
- Consumption is recorded by the comment or intent ID on the run that delivered it. That gives exactly-once delivery: no drops (RC-37) and no double delivery (RC-53).

### F. Work-based attempt budgets

Charge an attempt only on a recorded outcome that proves provider work started. An intent alone is not that proof. Use the outcome records from B:

- **Not charged:**
  - a startup intent that is still marked `beforeSpawn`, because no process started;
  - a startup that was spawned but never admitted;
  - a `turn.start` that the provider did not accept.
- **Charged:** an attempt whose provider accepted a turn (the accepted `turn.start` outcome or `turn.started`), and which then made no progress before the next failure. Progress is defined as in #19720: completed work for that turn.

The rules from #19720 and #19747 then become one rule over these outcome records, instead of watermark heuristics. The on-demand crash-point suite asserts this at the pre-spawn and pre-accept crash points.

### G. Generation stamping

The runner stamps `generation` and `turnId` on every event. Driver and session code treat an older generation as history. #19718, #19722, #19772 and #19783 each special-cased one variant of this.

## Testing: enumerate crash points, don't sample them

- Add named crash points at each durable write boundary, for example `crashPoint("sandbox.create.after_provider_before_lease")`. In tests, an environment variable makes the process SIGKILL itself at the Nth hit. In production they compile to no-ops.
- An on-demand suite boots the stack once per crash point, runs one task per workload, restarts, and asserts invariants I1–I7. It runs locally or by manual CI dispatch, filtered to the crash points a change touches. It is not a required PR check.
- Keep the chaos harness as a soak test for timing interactions the enumeration misses. Its R1–R6 graders should map onto I1–I7.
- The random waves found 20 ms–1 s windows by luck. Enumeration finds them on purpose, and it finds the windows we haven't hit yet.

## Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| 0. Inventory and baseline | List every in-progress record kind: table, column, writer, current release rule, current proof. Start from the 43 ownership, lease, sweep and fence modules. Separately, instrument and record the TTFT, boot and restart-latency baseline per adapter and environment, and list everything on the critical path before `turn.start`. | An inventory doc reviewed, with each kind mapped to A–G. A baseline report with the slowest critical-path steps ranked. |
| 1. Primitive and observe-only reconciler | `OwnerStamp`, `proveOwnerGone`, registry, reconciler running invariant checks in report-only mode. No behavior change. | The invariant violation rate is measured in chaos waves and staging. |
| 2. Move kinds over | One PR per kind or small group. Each switches release to the shared path and deletes its bespoke code, with a crash-point test. | Bespoke liveness code removed; crash-point suite green per kind. |
| 3. Admission and outbox | D and E. These change the most user-visible behavior, so they wait until Phase 1 data exists. | No company-wide gate; zero terminal skips for temporary reasons. |
| 4. Budgets and generations | F and G. | One attempt-charge rule; no per-variant stale-event code. |
| 5. On-demand suite | The crash-point suite is runnable locally and by manual CI dispatch, filtered by crash point or record kind. The chaos soak stays available too. | The suite is green on the release candidate; chaos soak 500-pass streak target. |

## Risks

- **Failing open.** A wrong "owner gone" proof releases live work and can duplicate side effects. Mitigation: `unprovable` never releases; a different host never counts as proof; every settle path is compare-and-swap; crash-point tests cover live-owner counter-cases for every kind.
- **Remote proof.** Daytona and other providers vary. Mitigation: the provider plugin contract returns the same `gone | alive | unprovable`.
- **Reconciler cost and idle sleep.** Mitigation: an indexed in-progress query per kind; skip when no kind has in-progress rows.
- **Migration churn in hot files** (`heartbeat.ts`, `native-session-executor.ts`, `budgets.ts`). Mitigation: Phase 1 adds only new code. Each Phase 2 PR is narrow and follows `rules/heartbeat-execution-boundaries.mdc`.
- **Latency regression.** New writes or proofs creep onto the turn path. Mitigation: invariant 8, a TTFT and boot budget check in every phase's exit criteria, and a rule that proofs needing I/O (process listing, provider API calls) run in the reconciler, never before `turn.start`.
- **Telemetry boundary.** Invariant violations go to the run log and activity log, not to Telemetry (AGENTS.md §5.7).

## Decisions (Dotta, 2026-11-07)

1. **Remove the company-wide accounting gate entirely.** Phase 3 deletes the gate; it does not narrow it further. Admission reads per-run exposure and hard stops only. This is a product rule and goes into `doc/SPEC-implementation.md`.
2. **The crash-point suite runs on demand and is not a required PR check.** It is available as a local command and as a manual (`workflow_dispatch`) CI run that can target selected crash points or record kinds. Phase 5's exit criterion changes to "the suite is runnable on demand and green on the release candidate".
3. **Inventory ownership:** one owning agent, with parallel per-subsystem readers (see "Phase 0 ownership" below).
4. **Land the open restart PRs first:** #19727, #19826 and #19829 merge as they are. They shrink Phase 2.

## Phase 0 ownership

One agent owns the inventory end to end. That keeps one schema, one set of definitions for "in progress", "owner" and "proof", and one reviewer of cross-subsystem cases. The owner fans out reading to a few parallel readers, one per subsystem:
- native runtime and runner
- environments and sandboxes
- workspaces
- accounting and budgets
- wake queue and recovery

Each reader fills fixed columns for its modules: table and column, writer, in-progress states, current release rule, current liveness proof, and which invariant it touches. The owner merges the rows, resolves overlaps (one record released by two paths, or two proofs of the same fact), and maps each kind to A–G. Dotta reviews the finished inventory once before Phase 1.
