# Committed native recovery notices: sleep audit

Date: 2026-10-26. Slice 55 starts at
`f98e6b5b57558c78ba111170ab3d8d19ff667827`,
[parent #17752](https://github.com/paperclipai/paperclip/pull/17752).
Branch: `codex/sleep-55-native-recovery-notices`. The full scope remains in the
[recurring-server migration ledger](2026-10-24-recurring-server-sleep-stack.md).

## One obligation and its owner

A native finalization may commit while its recovery notice remains active. The
old periodic finalizer replay called `resolveCommittedFinalizationRecovery` to
resolve that notice. This slice extracts that duty into `native-recovery-notices`
and schedules it from committed changes. The recovery-action service still owns
the actual resolution write and its existing notifications. Other watchdogs,
external conversation settlement, Muse reconciliation and physical resource
settlement are separate obligations.

The existing `issue_recovery_actions` rows are durable truth. No new table,
per-feature timer or provider branch is introduced. Direct/manual finalizer calls
retain notice resolution by default. The periodic path passes a narrow
`skipNativeRecoveryNotices` flag; all its other completion/resource behavior
remains enabled. A real reconciler test verifies the resource-settlement callback
still runs when notice resolution is delegated.

## Pending predicate and quiet states

A candidate binds company, issue and run across the native coordinator, heartbeat
run and issue. The coordinator must be committed and have a result. Discovery
excludes held runner ownership, pending status effects and unfinished run
projection. A correlated notice lookup requires:

- The same company, source issue and `evidence.runId`.
- Kind `active_run_watchdog` and status `active` or `escalated`.
- `wakePolicy.kind = resume_native_run`, or the existing special cause
  `native_workspace_finalization_owner_unverified`.

An exhausted owner-verification notice can still need resolution even after its
retry policy is cleared. Unrelated notices, uncommitted runs, resolved history,
and otherwise idle configuration do not arm a recurring scan. Discovery reads
IDs in keyset pages of 100 and the shared worker executes company-fair batches of
25. Real resolution failures retain shared per-entry backoff, starting at 30
seconds and bounded at five minutes. A successful attempt with remaining work
retains a scoped 30-second retry. Startup reconstructs durable unfinished notices.

The owner first checks for a matching notice to avoid taking lifecycle locks on
the normal already-settled path. That read is an optimization, not authority.
Actual resolution locks coordinator, issue, run, then matching actions, following
native recovery's existing order. It rechecks the current committed coordinator,
run binding and physical ownership. The background caller also checks effect and
projection settlement under those locks. The existing action service performs
the resolution inside that transaction.

## Why the action must be read again

`upsertSourceScoped` can reuse an active action ID and change its run, cause,
fingerprint or policy. Resolving a captured ID alone can erase a newer incident.
The owner selects matching actions only after acquiring lifecycle locks and locks
them before calling the resolution service. The regression holds the run row lock,
starts resolution, changes the notice through the real upsert service, and then
releases the lock. The new notice stays active. A separate four-writer regression
observes exactly one recovery-action UPDATE.

## Producer and boundary audit

| Producer | Wake contract |
| --- | --- |
| Recovery-action insert, supersession, in-place update and budget exhaustion | Scoped notice hint before the existing transaction write. This includes changes to kind or wake policy alone, not just run/cause changes. |
| Recovery-action resolution | Signal only after a matching pending row is found and before the write. An empty resolution call must not wake this worker. |
| Native decision/finalization and pending-effect settlement | Existing finalization notification fanout now includes notices. The committed transaction remains authoritative. |
| Run projection and heartbeat lifecycle status writers | Scoped signal before the write; finishing projection or releasing an ownership hold can make a notice actionable. |
| Relevant issue changes | Existing issue transaction sends an issue-scoped hint. |
| Worktree execution activation | Global reconstruction hint through the existing settings transaction. |
| Recovery route reopening a resolved action | Explicit issue-scoped hint in the reopening transaction. |

`native-workspace-export-retry` already uses the finalization fanout when it changes
the action to `resume_native_run`; its coordinator becomes `result_accepted`, so
notice resolution waits for the later commit. Native workspace owner recovery
likewise queues result finalization; the subsequent commit supplies the activation.

Other direct action writers were reviewed. Legacy execution admission and
historical backfill create different causes without a native-resume policy.
Backfill, system recovery, workspace owner progress and queue continuation writes
preserve the top-level run/cause/kind/status eligibility while adding evidence.
The wake-queue adapter adds failure-block evidence. Explicit continuation creates
resolved authorization receipts or resolves previous actions. Safe replacement,
workspace reconstruction/export recovery and execution-recovery resolution remove
active obligations. Their existing queued candidate is rechecked and disarmed;
they cannot create new eligible notice work. Recovery-service monitor/deadline and
board-disposition writes do not introduce the matching native policy. New eligible
notice creation remains with the instrumented action service.

All producer hints use the existing database intent and outer transaction protocol.
Nested savepoint release is not commit. Unknown outcomes stay with that shared
protocol. Process-local signals cover instrumented writers in this process;
independent SQL writers and replicas without supported ingress are not newly
supported. No database LISTEN connection is added.

The notification boundary explicitly copies only company, issue and run IDs. A
structurally compatible caller can carry additional internal fields; serializing
its entire object is not safe. A real finalization regression exposed this during
implementation when a caller's database object caused circular JSON serialization.
The corrected hint uses the same narrow payload contract as adjacent workers.

## Lifecycle and verification

Public heartbeat registration preserves task drain, restore and worktree execution
suppression. Settings activation reconstructs work. The coordinator retains a
first write during drain and a failed retry through drain/restart, stops future
subscription work on shutdown and joins active resolution. A new startup discovers
notices written while stopped.

At this checkpoint, **102 tests pass**: 22 new worker/owner cases and 80 startup
cases. Coverage includes startup, zero idle SQL, resolved history, real first and
late producers, outer commit/rollback, finalizer commit, policy/kind-only changes,
supersession, escalated owner notices, concurrent resolution, action reuse while
waiting for a real row lock, no-op resolution, pending effects, projection,
ownership release, suppression/activation, drain/retry/restart, shutdown and
retained periodic resource settlement.

Preserved failures:

- Before producer wiring, six tests produced three failures: late notice, outer
  commit and later finalizer commit did not wake the worker. The other three passed.
- The first wiring run failed all six notice tests while all 80 startup cases
  passed. A stronger fixture assertion exposed `side_effect_planning_failed` with
  circular JSON serialization. The hint now copies its three supported IDs. All
  initial and expanded cases pass with the real finalizer.

Local logs: `/tmp/sleep55-initial-red.log`, `/tmp/sleep55-producers-green.log`
(the failed intermediate run), `/tmp/sleep55-producer-diagnostic.log`,
`/tmp/sleep55-lifecycle.log` (96 passes), and `/tmp/sleep55-final-lifecycle.log`
(102 passes). Six complete affected suites also pass: 340 cases across native finalization
recovery, finalizer telemetry, recovery actions, the status arbiter corpus,
result-commit work and run projection. Total: **442 passing local cases**.
Workspace typechecking passes. Evidence is in `/tmp/sleep55-affected.log` and
`/tmp/sleep55-types.log`. Build, publication and exact-head CI/review remain
pending at this checkpoint. The full local suite is not claimed: this host's
embedded PostgreSQL startup previously exhausted semaphore capacity. No further
shared OS cleanup was performed; fresh-host CI is required for full acceptance.

## Remaining work

Master was refreshed; `origin/master` was subsequently observed at `125ddcabe5`.
Full-stack integration of later master changes and fresh gates remains required.
The older failed gates and eight-worker restore/worktree suppression audit remain
open. All other duties in the ledger remain in scope. This establishes worker
behavior, not deployed database suspension, host sleep or fleet savings. The stack
is unmerged, and this request does not authorize merging it.

## Reply and notice contention repair

The committed-response owner previously locked issue, run, then coordinator.
Notice resolution, status arbitration, and physical workspace recovery lock
coordinator, issue, then run. Concurrent reply and notice repair could therefore
deadlock even though both were authorized to settle the same committed result.
The reply owner now acquires and validates its exact committed, unleased
coordinator first, then retains its existing issue/run and presentation checks.
No publication authority, completion policy, retry cadence, or transaction scope
is broadened. The change belongs with this notice worker because introducing
that concurrent owner exposed the conflicting order.

The regression uses a real committed Telegram reply, real notice creation, and
the real resolution/publication owners. It holds the notice transaction at its
first coordinator lock, observes the reply's actual PostgreSQL blocking state,
then continues notice resolution with a bounded local lock timeout. Before the
fix PostgreSQL rejected reply recovery with `40P01` (deadlock detected). After
the fix both operations commit, the notice resolves, and exactly one accepted
comment/publication exists; replay publishes nothing.

The focused regression passed, followed by 73 selected committed/accepted-response
chat cases (1,570 unrelated chat cases filtered out) and all 141 cases in the
notice, finalizer telemetry, startup, and response-authority suites. Logs:
`/tmp/sleep55-lock-order-{red,green,chat,consumers}.log`. This is 214 distinct
passing cases across five files, not a full chat-file or full repository test
run. Integrated typecheck, build, and fresh remote checks remain required.

## Projection fixture follow-through after the lock-order repair

The coordinator-first response-recovery guard exposed stale projection fixtures.
Thirteen cases inserted a native run without a committed finalization record.
Recovery correctly stopped before loading that run, so the expected measured
projection was absent. The failure reproduced locally against a new disposable
PostgreSQL database: 13 failures and four passes, matching the CI failures on
later stack branches.

The fixture now uses the existing accepted-result and finalization setup. It
retains a future retry while comparing narrow and full-row reads, so both paths
observe the same state without publishing between comparisons. The selected
answer guard, typed context flags, non-object result evidence, payload byte
limits, unchanged-row assertions, company/issue scope checks, and separate real
publication comparison remain. All 17 cases now pass; server typechecking also
passes. The existing external-test-database convention permits a real database
replay without requiring another embedded PostgreSQL instance. No production
lock, recovery eligibility, retry policy, or projection was weakened.

## Startup readiness follow-up (2026-10-27)

A held recovery-notice sweep reproduced HTTP startup waiting for task locks.
Registration now tracks its readiness promise through the existing heartbeat
shutdown owner instead of awaiting it on the readiness path. The coordinator
continues to own worker cancellation. The regression proves HTTP readiness and
subsequent registration proceed while shutdown waits for the held work. All 86
startup cases pass on the master-integrated branch; no timer or persistence is
added. Full integrated typechecking and head-specific CI remain separate gates.

## Current parent integration and routine-hint regression (2026-10-29)

This slice incorporates parent #17752 at
`a49a2dac13b0e1c19da5d3d6b435c781703b1c0b` through a normal merge. A
batched tree comparison preserves 1,209 parent-only entries, eight owned-only
entries, 11,524 identical entries and 12 automatic shared merges. Two manual
paths remain explicit: ordinary notice fanout is inside the existing issue/run
guard; the chat test's leading import conflict retains all four independent
imports and removes only the three marker lines. Every other automatically
merged byte in that test remains intact before comment removal. The complete
package tree matches parent profile 80, including all historical identities.

Thirteen added comment objects in five files were removed with identical nontrivia
TypeScript token streams. No directive was removed. Notice settlement retains
coordinator, issue, run and action lock ordering; exact current incident matching;
existing action-resolution side effects; and the separate status/effect/resource
owners. A discovered action ID alone is not authority to resolve a later incident.

The new real-database regression submits three routine company-only finalization
hints after startup becomes quiet. A controlled baseline moves only notice fanout
outside the guard and keeps every other parent guard. It issues three candidate
SELECTs and fails the zero-query assertion. Restoring production bytes passes the
same assertion. The real notice writer then creates and resolves an action for a
committed run, returns outcome `restored`, and settles back to quiet. Red fails one
selected case in 7.46 seconds; green passes that same case. Twenty-two cases outside
the focused pattern are not counted as passing there. Both phases use fresh
dedicated PostgreSQL 17 databases and restore the production helper exactly.

The complete main command passes 1,873 cases in 21 files in 309.69 seconds, with
no skips. Process recovery and external-chat response run in separate database
phases. The giant chat integration file is intentionally a focused selection,
including the real reply/notice row-lock regression and related provider and
current-authority cases; unselected chat cases do not constitute acceptance.
All test assertions and timeouts are unchanged.

### Complete current-source acceptance

Source `730e00a7b007a36d188ca0a328ef050d3a25d1ee` passes **2,556 cases
in 23 complete files**, with no skips in those files. The main command passes
1,873 cases in 21 files in 309.69 seconds. Process recovery passes 410 in 163.54
seconds; external-chat response passes 273 in 53.48 seconds. A separate focused
chat selection passes 18 cases in 13.44 seconds, including the actual reply/notice
row-lock race, Slack/Telegram recovery, current-authority refusals, canonical
response binding and internal GitHub navigation. The other 1,796 cases in that
chat file remain unselected. Total selected passing cases: 2,574. This is not full
chat-suite or repository acceptance.

The complete files include all 23 notice-worker cases, 17 presentation/ownership
read cases and 88 startup cases. Production server typechecking, build, module
boundaries, migration order and the source identity check pass. Twenty dedicated
PostgreSQL 17 databases use the unchanged migration 413 schema. Embedded-only
calls use existing fresh-per-call recovery fixtures. Every temporary import is
restored byte-for-byte and all 24 selected file hashes match after completion.
No assertion or timeout is relaxed. The focused scope green takes 6.69 seconds;
the intended failing unscoped baseline is not counted as acceptance.

Parent #17752 merged as `50fe32684d2d4e1db129e3c1bb455571344a0c09`, after
57 clean current-head checks and Greptile 5/5. Its complete reviewed tree equals
the actual squash. Normal merge `a0f2b3f4348b078219a53d8cc135c84202ba505e`
adopts that ancestry with this child's entire tested tree unchanged. This slice
can now target master. Fresh exact-head CI and review remain separate gates.

The unchanged package tree retains parent profile 80 acceptance: 130 passing
installation/compatibility/transport cases, 22 installed ACPX/Grok contract cases
and 26 native-provider Rust cases. One existing opt-in closed Pi snapshot case
was skipped because its distribution root was unset. This does not qualify a live
Pi installation. Earlier failures in this audit retain their revision and
subsequent disposition. No deployed sleep, expanded Cloud alarm coverage or
measured savings is claimed.
