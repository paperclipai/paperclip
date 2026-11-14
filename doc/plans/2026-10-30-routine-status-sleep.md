# Routine execution status settlement

The Cloud routine status worker repairs a routine invocation when its linked
execution task and saved routine status disagree. The previous heartbeat callback
scanned every five minutes, even with no routines or only completed history.

## Ownership and trigger

`routine-run-status.ts` owns the projection, custody checks and repair transaction.
The worker loads actual mismatches in keyset pages of 50 at startup. It accepts issue hints from issue
creation, status/origin changes, checkout/release, routine issue association,
execution control writes, review state writes and subtree status restoration.
Bulk restoration registers each issue hint in the same transaction before its
grouped write. Restored history does not depend on an optional agent wake. It uses the existing
transaction-aware work notification protocol. An outer transaction owns the hint;
a savepoint release does not wake the repair worker before commit.

An execution must retain reciprocal task/invocation links in the same company
and belong to a routine in that company. This is the existing routine status
owner contract. Origin labels can change when a plugin declaration changes or
is removed; retained reciprocal links preserve historical execution custody. Repair
locks the routine and task and rechecks the linked invocation before writing.
Direct route hooks also lock the execution task and linked invocation in their
own transaction, nested under caller transactions when present. An older hook
cannot write after a newer task status has committed. It preserves skipped/coalesced history and unrelated dispatch failures. A task
that resumes clears an execution-task transient failure through the same owner
used by native completion and issue routes.

`activeIssue` remains derived from open tasks and live heartbeat runs. A terminal
heartbeat with an open task does not create a completion obligation. The worker
does not retry merely because a run is active or a routine exists.

## Lifecycle and writer contract

`registerScopedDeadlineWork` owns coalescing, fair batches, failure backoff, drain
and shutdown. A failed owner retries with bounded backoff. Successful settlement
removes that owner. Settled configuration, healthy active tasks and completed
history leave no recurring worker SQL. The existing Cloud and heartbeat scheduler
enablement gates remain in place. Ordinary routine scheduling is unchanged.

Supported app writers register `notifyRoutineExecutionStatus(tx, issueId)` before
their mutation. Common execution writers without an issue hint request debt reconstruction only
for their recorded company. Projection debt settles even when that company is
paused; company activity does not create or cancel this obligation. Backups and independent SQL import/repair tools must restore
before startup or call that same transaction contract; process-local hints do
not observe independent SQL or another process. No permanent listener or periodic
configured-routine scan is added.

The in-process retry deadline does not establish external Cloud wake coverage.
This change preserves the existing host sleep safety checks and does not claim
measured host or database suspension.

## Acceptance

Tests exercise ordinary issue writes and a real heartbeat lifecycle transition
against PostgreSQL with the production coordinator. Provider wakeup is simulated.
They inspect durable routine rows and the normal routine detail read separately.
Coverage includes empty/configured/history quiet periods, first producer,
terminal outcomes and reopen, legacy mismatch reconstruction, skipped/coalesced
custody, outer commit/rollback, retry/restart, drain/resume and standby/disable.
Focused worker tests exercise in-flight invalidations, retry isolation and stop.
