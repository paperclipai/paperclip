# Cancelled native workspace preservation

Date: 2026-10-25; current integration: 2026-10-29. Parent: stopped instruction
collection PR #17674 at `d176d731f083c7edd2ede688cb901d1e66d8f1d8`.
The original draft parent was `6dc58115cdebb988a63bb45dce4521f5bb5013f6`.

## One reason and its owner

A native run can acknowledge user Stop while its prepared workspace still needs
a durable file-recovery hold. The periodic orphan reaper previously scanned for
these cancellations on every pass. This slice migrates that discovery to the
existing transaction signals, delivery coordinator and scoped deadline worker.
It adds no table and no independent timer.

The owner remains `native-runtime/native-failed-workspace-recovery.ts`.
`preserveNativeFailedWorkspace` retains the task/coordinator/run lock order,
source identity checks, original lease pinning, no-replay recovery card and
activity record. It performs database work only. The stop-only cleanup owner
still owns provider teardown. Recording a file hold does not prove termination
and never grants permission to destroy the allocation or replay the run.

This is not only historical data migration. Current foreground cancellation
tries retention before lease release. If it loses a task lock or database write,
it leaves the source active and needs the same retry mechanism.

## Obligation, discovery and completion

Discovery reads native cancelled runs whose prepared workspace reference and
acknowledged cancellation suggest unfinished preservation. It excludes a valid
existing workspace-recovery receipt paired with a recognized restore-failure
code. A schema marker alone is insufficient to declare preservation complete.
The owner then validates the full existing acknowledgement: same run, company,
native issue, user actor, run-only scope, cancellation reason and audit IDs.
A missing native issue, invalid reference, foreign receipt or admitted
workspace-less execution creates no preservation entry.

Discovery pages 100 rows at a time by run ID, reads the fields needed for these
checks, and retains only IDs/company IDs/deadlines in the scheduler. Fair batches
attempt at most five entries. Cost scales with actual candidates, including
unusual prepared history that must be classified; it is not constant time.

The new pending predicate is deliberately separate from immediate dispatch
eligibility. A valid cancelled prepared workspace can still owe preservation
while a controller owns its coordinator or stop-only proof is not ready. Those
rows remain scheduled instead of depending on another global scan to discover
when they become actionable. Accepted results belong to native finalization;
this worker does not take over their workspace obligation. The audited runtime
writers do not erase an accepted coordinator result ID to create this duty.

A check rereads the run and exact company/native-issue coordinator. It delegates
only at terminal_failure, without a coordinator owner or accepted result, and
when a lease meets the prior scan's status/policy eligibility. The retention
owner rereads under its locks and verifies the exact reference lease, provider
allocation, workspace and remote directory. Recovery requires the current run
still be cancelled with the exact acknowledgement and the coordinator still be
terminal_failure. These extra checks close stale-discovery races without
changing the foreground preterminal API.

After delegation, the worker rereads the durable run receipt. A valid recorded
hold, finalized reference or removed obligation disarms it. Actual unfinished
preservation retains a 30-second retry, including missing proof, missing source
or a still-owned coordinator. Database/owner failures use the shared bounded
failure backoff and do not starve other companies. These are retries for known
file debt, not probes of idle configuration. Retry timing is process-local;
restart reconstructs the durable obligation and tries it again. No unrelated
native-finalizer business deadline is overwritten.

## Producer and shared-boundary audit

Cancellation acknowledgement, terminal status and workspace preparation can be
separate transactions. All three must reactivate the worker. Signals register
before the relevant write and settle with the existing outer transaction.

| Producer | Boundary |
| --- | --- |
| Heartbeat run lifecycle | Existing run-status transaction, scoped to company/run |
| Heartbeat queue, run dispatch, queued-comment and watchdog adapters | Existing terminal-write transaction, scoped to the affected run |
| Native finalizer, restart, finalization reconciliation, session failure and status-decision committer | Existing terminal projection transaction |
| Native cancellation acknowledgement | Existing audit/acknowledgement transaction before resultJson is updated |
| Native workspace reference | Existing locked reference transaction; includes preparation and finalization |
| Execution-control and task recovery | Existing eligible-run terminal-write transaction |
| Agent/company deletion | Company-scoped invalidation before cascades |
| Worktree execution settings | Global invalidation in the existing settings transaction |

The status signals can cause a scoped inspection even if that run has no relevant
workspace. They add no recurring work. The existing transaction identity is
shared across topics; no provider/file call is wrapped in a new transaction.
Notifications and receipt interpretation stay with their respective owners.

Coordinator ownership and lease proof changes do not need another broad polling
lane or new global signal: the run's explicit file debt is already registered
and retains its retry until it can be pinned. The retention recorder does not
signal its own partial failure back into immediate discovery, which would reset
the retry and recreate a tight loop. The due check observes its successful
receipt. Foreground completion may be noticed on that already-known retry.

The supported writer model remains one process with instrumented writes.
Independent SQL writers and additional replicas require explicit integration.
Admitted execution binding is immutable; a different workspace contract belongs
to another admitted run. Do not infer coverage for arbitrary metadata rewrites.

## Lifecycle, compatibility and index

The heartbeat facade retains worktree-execution and task-drain admission.
Startup is registered only when heartbeat maintenance is enabled. The existing
startup/manual preservation entry point remains available; periodic reaping skips
only this migrated duty. Drain/standby retain changes without passive SQL.
Shutdown joins admitted owner transactions and removes the registration.

Current migration 0409 adds a partial index (the original draft used 0397) on (id, company_id) using the same coarse
pending predicate. It excludes the recorded completed-preservation history.
It is concurrent, replay-safe, registered in the existing nontransactional
migration runner, and accompanied by the five newest generated snapshots.

## Verification

The unchanged owner baseline passed 48 tests before implementation. The first
worker/startup selection passed 114 tests. Adding stale-acknowledgement, phase,
status and pagination cases raised that selection to 118 passing tests. Final
negative binding selection passed all 120 owner/startup tests (64 owner and 56 startup). Together with the 209 consumer cases, this gives 329 passing tests with no skips.

Seven affected consumer suites passed 209 tests: Stop/run control, run dispatch,
queued comments, heartbeat queue/recovery, native finalizer and workspace sync.
These tests use real PostgreSQL where persistence matters and controlled runtime
or filesystem fixtures for external effects. Workspace typecheck and build
passed; final server types passed after the binding cases.

Worker cases cover active/completed/workspace-less quiet, the real run-status
producer, outer rollback/commit, restart, drain/standby, another coordinator
owner, late exact stop-only proof, failed owner transactions, shutdown joining,
103 pending sources, stale candidate races and malformed bindings. Assertions
include lease policies, durable recovery receipts, recovery-card count, preserved
task/run state, no idle SQL and no remaining deadline.

Fresh migration application, runner replay, direct SQL replay and migration
numbering/safety checks passed. A rolled-back query-plan fixture added 10,000
completed rows plus one pending row. Discovery used the partial index, returned
one row with two shared buffer hits plus one local seed-table hit, and took
0.012 ms locally. This is index-selection evidence, not production latency.

One test typecheck failed because an invokability mock widened literal true to
boolean. The mock now retains its literal type; the subsequent workspace check
passed. The first negative binding selection had 119 passing tests and one fixture failure: it attempted to clear a run issue binding while a coordinator still referenced it. PostgreSQL correctly rejected that state with 23503. The fixture now deletes its coordinator before clearing the binding, preserving the foreign key. The fresh final selection passed all 120 tests. Logs are retained at `/tmp/sleep43-owners-v4.log` and `/tmp/sleep43-owners-v5.log`. No failed selection was discarded. All test databases are disposable PostgreSQL 17 instances on this host;
this host's embedded harness was already proven unavailable in the parent slice.

Exact-head remote CI and review remain required. This slice does not establish
Cloud alarm coverage, host/database suspension or fleet savings, and it does
not finish other native finalization/recovery duties.


## Current parent integration and acceptance (2026-10-29)

The existing slice adopts the updated stopped-collection parent by normal merge.
The initial automatic proof rejected three source overlaps, rather than choosing
a side. The resolved heartbeat facade retains both upgrade-readiness and worker
registration imports. The recovery owner retains the upstream narrow projected
input and plugin-task fence, with this slice's `requireCancelledStop` option and
locked-row acknowledgement check. Both the exact original worker test block and
the exact upstream superseded-retry test block are retained. Unrelated upstream
blobs are preserved. A cached-diff whitespace warning belonged to an unchanged
upstream routine-status file; the owned diff against the current parent is clean.

Earlier source `8deb3941850e4c07744caceaccf30ad0f53abefd` passes **1472 cases across 16 complete files,
with no skips**. The owner passes 84 cases, including the preserved superseded-
retry coverage. Fifteen consumer files pass 1388 cases, including the complete
968-case native session executor. Per-file counts follow:

| Complete file | Passing cases |
| --- | ---: |
| src/services/native-runtime/native-failed-workspace-recovery.test.ts | 84 |
| src/services/native-runtime/native-session-executor.test.ts | 968 |
| src/services/heartbeat/run-control.test.ts | 51 |
| src/services/heartbeat/run-lifecycle.test.ts | 31 |
| src/services/heartbeat/queue.test.ts | 32 |
| src/modules/run-dispatch/adapters/postgres.test.ts | 69 |
| src/services/heartbeat/recovery.test.ts | 45 |
| src/services/native-runtime/native-run-finalizer-telemetry.test.ts | 29 |
| src/__tests__/server-startup-feedback-export.test.ts | 59 |
| src/__tests__/native-finalization-recovery.test.ts | 32 |
| src/services/execution-control-reconciliation.test.ts | 10 |
| src/modules/wake-queue/adapters/queued-comment-postgres.test.ts | 5 |
| src/__tests__/native-workspace-sync.test.ts | 10 |
| src/services/heartbeat/upgrade-readiness.test.ts | 7 |
| src/services/native-runtime/native-restart-recovery.test.ts | 25 |
| src/services/legacy-execution-recovery.test.ts | 15 |

Eleven distinct fresh PostgreSQL databases were created and migrated before
the fixtures. The preservation owner and native-session suite have different
databases despite sharing the same environment-variable name. This avoids
interpreting shared fixture cleanup as a product failure. Database build, server
typecheck/build, module boundaries, target migration order, and all eleven fresh
0407 migrations pass. Existing embedded fixtures remain real.

Only this slice's unpublished 0401 artifacts were deferred before adopting parent
history, then generated through `pnpm db:generate` as `0407_flaky_blob.sql`.
The concurrent idempotent index SQL is byte-identical to the original. All prior
SQL and journal entries and retained parent snapshots are unchanged; five newest
snapshots 0403-0407 remain. The historical snapshot overlap uses exact parent
bytes. No new code comments are added relative to the current parent.

A populated 0406 database upgrades to 0407 with all 405 prior receipts identical
and exactly one appended. Replay appends none. The preservation index is valid
and ready on both fresh and upgraded databases. These checks establish combined
worker, ownership and migration behavior, not deployed host/database suspension
or external wake delivery. Actual landed parent ancestry and fresh published-head
review and CI remain required. Prior failures above retain their original scope.


## Current stopped-collection parent and migration409 acceptance

Only this slice's unlanded 0407 migration artifacts were deferred before the
normal merge of published parent `d176d731f083c7edd2ede688cb901d1e66d8f1d8`.
The merge has no conflicts. All original runtime and schema edits remain
identical, and every unrelated upstream blob is preserved. This includes the
new quality-review boundary, bounded retry cancellation, and independent
sidebar fix. The migration directory and client matched the exact parent
before generation. The first path preflight used rename detection and failed
before mutation; explicit no-renames verifies the five expected artifacts.

`pnpm db:generate` produced `0409_uneven_zuras.sql`. Its concurrent, replay-safe
index SQL is byte-identical to the original. All prior SQL, journal entries and
retained snapshot bytes remain unchanged. The newest five snapshots are 0405
through 0409. No new code comments are added.

Source `21b46a8e4293ca670235117458b984493a181759` passes all **1472 cases in
16 complete files**, without skips: the 84-case owner in 14.93 seconds and
1388 consumer cases in 133.46 seconds. This includes the full 968-case native
session suite and existing Stop, restart, dispatch, workspace-sync and
upgrade-readiness consumers. Twelve separate fresh PostgreSQL 17 databases
migrated through 0409 isolate destructive fixtures. The embedded-only lifecycle
fixture temporarily uses its own external database on this IPC-exhausted host
and is restored byte for byte. Assertions and timing limits stay unchanged.
This is qualified external-database acceptance, not an unmodified embedded CI
run. Actual database build, server types/build, boundaries and exact-head
migration-order checks pass.

A populated 0408-to0409 upgrade preserves all 407 prior migration receipts and
all 38 companies, appends exactly one receipt and adds none on replay. The
preservation index is valid and ready on fresh and upgraded databases.

Publication remains held until the parent actually merges. An explicit-base
planning probe predicts squash-ancestry conflicts; it is not an actual merge
proof. Its first sandboxed attempt could not write Git objects and was not
valid evidence. The checked successful probe records the expected conflicts.
The actual landed-parent ancestry must be reconciled and complete owned and
unrelated upstream changes proved again before publication. Fresh current-head
CI and reviews remain required. Earlier failures and qualifications stay recorded.
These tests do not establish deployed host/database suspension or Cloud wakes.


## Actual stopped-collection squash ancestry

Parent #17674 merged as `82529741418e138d9d623bf13d2fa22c1ff79d36`. Its
entire tree equals reviewed parent `d176d731f083c7edd2ede688cb901d1e66d8f1d8`,
which is already an ancestor of the accepted child. Normal merge
`28536423228b67541503872da6bd98b9b4c5dfef` resolves the inspected duplicate
squash-ancestry conflicts. Its entire resulting tree equals the accepted child.
Complete server, package, test and UI trees remain identical to the 1472-case
source, including the whole 0409 database tree. No assertions or timing limits
change. Fresh published-head CI and reviews remain required before merge.
