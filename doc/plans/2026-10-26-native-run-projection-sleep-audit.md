# Committed native run projection: sleep audit

Date: 2026-10-26. Slice 54 starts at `1fc2e8c5b61173203abbd50b1b03346abc629218`,
[parent #17748](https://github.com/paperclipai/paperclip/pull/17748).
Branch: `codex/sleep-54-native-run-projection`. This is one duty from the
[recurring-server stack](2026-10-24-recurring-server-sleep-stack.md).

## Obligation and boundary

A native status decision can commit before its heartbeat-run projection. A crash
between those transactions leaves a real repair obligation. The periodic native
reconciler previously revisited committed decisions to repair that state.

This slice moves the existing run projection repair to transaction wakes and
concrete failure retries. It does not move all committed completion work. External
conversation settlement, watchdog resolution, Muse reconciliation, workspace
metadata cleanup, environment/runtime release and agent settlement retain their
existing recovery paths. A successful workspace barrier or committed decision
proves none of those other obligations complete.

`native-run-projection.ts` owns the existing projection predicate and write. The
finalizer and the new worker use that same owner. The finalizer keeps its initial
metadata enrichment and status-decision authority. The worker neither arbitrates
an issue outcome nor invokes provider work. No new table or migration is needed.

The extracted `projectNativeTerminalRunStatus` function remains re-exported from
the finalizer so existing consumers retain their contract. Shared failure metadata
construction stays beside the projection owner and is reused by live finalization.
Heartbeat and server startup only wire lifecycle and execution policy.

## Durable truth and quiet condition

Candidates join the committed coordinator to its issue and heartbeat run. A
correlated existence predicate binds its accepted result by company, issue and
run IDs. The periodic candidate scan reuses this predicate for ordering. The accepted terminal state must
be succeeded, failed or cancelled. The worker excludes pending decision effects
and held native runner ownership.

The pending predicate is the existing repairable run mismatch: status, completion
time, native phase, finalization metadata or stale failure fields. The write and
discovery share that predicate. Existing terminal-state restrictions remain in
place, including the existing protection for an already-cancelled run. Retained
completed history is not work. The accepted result envelope remains immutable.

Discovery reads IDs in keyset pages of 100. It does not transfer full result or
run payloads. Due execution reads the small run fields needed by the projection
owner and only the accepted terminal-state scalar. The worker reuses shared
company-fair batches, coalesced dirty scopes and delivery scheduling. There is no
recurring query after an empty or settled result. No fleet-scale query benchmark
is claimed.

Projection failure leaves the same durable mismatch. Shared per-entry error
backoff starts at 30 seconds and is bounded at five minutes. This is recovery of
concrete unfinished work, not periodic discovery of an empty table. A restart
reconstructs the mismatch immediately; no business deadline is moved. A successful
check that still observes a mismatch retains a scoped 30-second retry.

## Producers and commit ownership

| Producer | Contract |
| --- | --- |
| Status decision commit | Existing `notifyNativeFinalizationWork` fanout now includes projection before the coordinator write. This covers the first committed decision and later reassessments. |
| Native interaction bridge | Its existing finalization fanout covers its independent decision/coordinator writes. |
| Pending-effect settlement | The existing finalization fanout wakes projection after the effect owner finishes. |
| Finalizer and projection writes | Register the scoped hint before changing the run. This reconciles any pending in-memory entry after live completion. |
| Heartbeat lifecycle status writer | Native run changes publish a scoped hint, including release of an ownership hold and status/metadata changes after commit. |
| Issue mutations | Relevant status, binding, assignment and dependency changes reconstruct the affected issue scope. |
| Worktree execution setting | Activation emits a global reconstruction hint. |

The coordinator store's result/claim/retry operations cannot independently create
a committed decision. Its existing finalization fanout covers changes to an
already-decided coordinator. Resultless restart and startup-stop writes cannot
create eligible committed projection work.

All hints use the existing DB intent and outer-transaction protocol. Awaited intent
registration precedes the relevant write. Nested savepoint release does not wake
the worker before outer commit. Rollback produces no work. Unknown transaction
outcomes remain the shared protocol's responsibility. Process-local signals cover
instrumented application writes in the owning server process; independent SQL
writers and replicas without supported ingress are not newly supported.

## Concurrency and authority

The live finalizer can commit its decision and pause before its run write. The
new recovery worker can then project first. Both projection paths now read current
run status, native phase and completion time under the run row lock before deciding
which terminal event is owed. A writer that arrives second does not announce the
same terminal transition again. Initial live projection preserves the completion
time when the current run already has that same terminal status.

Recovery projection rechecks committed coordinator/result identity and run binding
in its write predicate. Its background caller also requires settled status effects
at that boundary. A candidate snapshot does not authorize a write after these facts
change. The conditional update retains unrelated JSON diagnostics and saves cleared
execution failures as recovery evidence. Metadata-only repair does not emit another
terminal event. Leaving a pending native retry can still require the first terminal
failure report even when the stored status remains failed.

The real race regression inserts recovery after the real status decision commit
and before the live finalizer resumes. It initially observed two terminal emissions;
a fresh locked snapshot reduces that to one. Another regression supplied a stale
completion-time snapshot and initially overwrote the durable timestamp. The owner
now uses the locked row's timestamp. Concurrent recovery calls use the same guard.

## Lifecycle and periodic delegation

Public heartbeat registration uses the existing task-drain, restore and worktree
suppression policy. Suppressed workers do not repeatedly query. Real worktree
activation reconstructs saved work. The delivery coordinator retains changes made
during drain, retries unresolved work, and joins active execution on shutdown.
Startup reconstructs committed decisions whose run projection is still missing.

The periodic path sets `skipNativeRunProjection`; the finalizer receives the
narrow `skipCommittedRunProjection` option. This skips only the already-committed
projection call. It does not set the broader `projectRunStatus` flag false, because
that would also disable other completion effects. Default direct/manual calls and
new-result initial projection retain their behavior. The resource-settlement
callback still runs on the periodic path after projection completes. The candidate
scan uses the shared pending predicate to defer resource settlement while projection
is outstanding. Pending effects and reassessment retain their prior order. This
adds no separate per-candidate read. A real reconciler regression first observed
premature settlement, then passed after this guard.

## Verification and preserved failures

At this checkpoint, 20 worker/owner cases plus 78 startup cases pass: **98 tests**.
Six complete affected suites contribute another 302 passing cases: finalization
recovery, finalizer telemetry, status arbiter corpus, heartbeat lifecycle,
result-commit worker and heartbeat recovery. Total: **400 passing local cases**.
Workspace typechecking passes after the ordering guard. A workspace build passed
before that final guard; the final committed build and remote checks remain pending.
Coverage includes quiet startup and retained success/failure/cancellation history,
real status-decision activation, outer commit/rollback, live/recovery concurrency,
competing recovery calls, stale timestamps, metadata preservation, suppression and
real settings activation, drain/resume, failure/restart, shutdown and later work,
changed coordinator authority, real pending-effect settlement, the real lifecycle
status writer, and retained resource-settlement recovery.

Initial evidence is retained:

- Six initial regressions produced four failures and two passes. The missing
  producer signal broke normal and outer-commit activation. The live/recovery
  race emitted twice. A stale snapshot replaced a saved completion time.
- An intermediate scripted extraction introduced a syntax error; that command
  ran no tests. After correction, all six initial cases passed.
- Initial typechecking found the terminal mapper's wider return union included
  `running`. The validated accepted terminal scalar is now narrowed at its
  boundary; no active result is eligible for committed projection.

- The broader six-suite run passed 300 cases and failed two diagnostic-race
  cases. Their interception watched a full result JSON selection; projection now
  selects only the terminal scalar. Updating that interception restored the same
  concurrent-write assertion. The 29-case telemetry suite then passed in full.
- An intermediate rerun reused a database with a fixed `TLM` company prefix.
  Setup rejected the duplicate; 29 telemetry cases were skipped, not passed.
  Fresh dedicated databases passed all 65 telemetry/recovery cases.
- The new ordering regression failed because cleanup ran before delegated run
  projection. The shared-predicate guard fixes it; the 98 focused cases pass.

Local logs: `/tmp/sleep54-initial-red.log`, `/tmp/sleep54-initial-green.log`
(the syntax failure), `/tmp/sleep54-initial-green-fixed.log`,
`/tmp/sleep54-types.log`, and `/tmp/sleep54-lifecycle.log`.
Later evidence: `/tmp/sleep54-affected.log`, `/tmp/sleep54-ordering-red.log`,
`/tmp/sleep54-ordering-green.log` (98 passes plus the fixture setup failure),
`/tmp/sleep54-affected-fixed.log` (65 passes), and `/tmp/sleep54-final-types.log`.
The full local `pnpm test:run` was not attempted: this host's embedded PostgreSQL
cluster startup previously exhausted shared semaphore capacity. No further OS
resources were removed. Fresh-host CI must supply the full-suite gate. Publication,
final build, exact-head CI and review are required before acceptance.

## Remaining scope

Master was refreshed to `ad861a7f94`. The stack still needs propagation of later
master changes and fresh integration checks. Relevant native changes include
#17525/#17531 (narrow reads), #17614 (unchanged terminal notifications), and
#17641/#17665 (monitor proof). Keep both contracts when integrating; do not replace
their changes with an older finalizer block.

All other recurring duties, older failed stack gates and the earlier eight-worker
suppression audit remain open. Cloud alarm coverage, idle-sleep safety and durable
resource blockers are unchanged. This audit establishes worker behavior, not
measured database suspension, host wakeup or cost savings. No merge is authorized.

## Current parent integration and routine-hint regression (2026-10-29)

This slice incorporates parent #17748 at
`b2efdb2dbbbef5b2227ffa2bd2a9a6cfe3867fe2` through a normal merge. A
batched tree comparison preserves 1,208 parent-only entries, seven owned-only
entries, 11,524 identical entries and ten automatic shared merges. The sole
manual conflict adds run-projection fanout inside the existing ordinary issue/run
scope guard. Dedicated notifications and explicit settings activation retain their
contracts. The entire package tree matches parent profile 80, including all
historical identities. No provider profile is regenerated for this server change.

Twenty-four added comment objects in six files were removed with identical
nontrivia TypeScript token streams. No directive was removed. The projection
extraction retains the shared candidate predicate, exact run/result correlation,
atomic metadata preservation, terminal-event idempotency, original completion time,
and physical-owner evidence. Status decisions, external effects and resource
settlement remain with their existing owners.

The new real-database regression starts an idle projection worker and submits
three routine company-only finalization hints. A controlled baseline moves only
projection fanout outside the guard and keeps all other parent guards intact.
It produces three candidate SELECTs and fails the zero-query assertion. Restoring
the production helper passes the same assertion. A real accepted result and
committed decision then repair the run and emit exactly one terminal event before
returning to quiet. Red fails one selected case in 6.63 seconds; green passes it in
6.55 seconds. Twenty cases outside the focused pattern are not counted as passing
there. Both phases use fresh dedicated PostgreSQL 17 databases and restore the
production helper byte-for-byte. No assertion or timeout is relaxed.

Complete validation includes the result/physical-work consumers plus run lifecycle
and required quality review, because the projection is extracted from the live
finalizer. It retains the startup held-work regression and the real producer paths.
Current-head CI and fresh review remain separate publication and merge gates.

### Complete current-source acceptance

Source `a83b9449233a275176e637c765059f414305d7c1` passes **2,513 distinct
cases in 21 complete files**, with no skips in those files. The 19-file main
command passes 1,830 cases in 301.14 seconds. Process recovery passes 410 in
163.58 seconds; external-chat response passes 273 in 53.26 seconds. The selection
includes all 21 projection cases, 85 startup cases, required quality review,
heartbeat run lifecycle, both accepted-result producers, and physical-work
consumers. Production server typechecking, build, module boundaries, migration
order and the source identity check pass.

Seventeen dedicated PostgreSQL 17 databases use the unchanged migration 413 schema.
Embedded-only calls use existing fresh-per-call recovery fixtures. Every temporary
import is restored byte-for-byte and all 21 selected test hashes match after
completion. No assertion or timeout is relaxed. The controlled unscoped-hint
baseline remains an intended failing regression; it is not counted as acceptance.
Earlier failures in this audit retain their revision and disposition.

Parent #17748 merged as `28e38da7e6bdd6af4092dda56bc2be05bed47af5`, after
57 clean current-head checks and Greptile 5/5. Its complete reviewed tree equals
the actual squash. Normal merge `d4b46fd29cb23126d556cc3aeb883e6b41f1a8a5`
adopts that ancestry with this child's complete tested tree unchanged. This
slice can now target master; fresh exact-head CI and review remain required.

The unchanged package tree retains parent profile 80 acceptance: 130 passing
installation/compatibility/transport cases, 22 installed ACPX/Grok contract cases
and 26 native-provider Rust cases. One existing opt-in closed Pi snapshot case
was skipped because its distribution root was unset. This does not qualify a
live Pi installation. No full local repository suite, live provider qualification,
deployed sleep, expanded Cloud alarm coverage or measured savings is claimed.
