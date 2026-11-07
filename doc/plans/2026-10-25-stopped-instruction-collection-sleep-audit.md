# Stopped instruction collection

Date: 2026-10-25. Parent: directory cleanup PR #17671 at
`854244092a993b621ab8efd2ca9f80a0e3b0b9d4`.

## Obligation and owner

The orphan reaper previously rediscovered stopped instruction copies on every
maintenance pass. This slice migrates that one reason to committed signals and
saved retry deadlines. Captured candidate commits (#17670) and post-save
physical release (#17671) remain separate workers. No new table is needed.

The instruction working-copy service owns eligibility, reconstruction and
collection scheduling. The directory service still owns directory locks,
materialization identity, warm handoff, stop proof and physical operations.
Native and legacy run owners emit a normalized company/run signal before their
status writes. They do not inspect instruction receipts or perform file work.
Startup only wires the existing coordinator and scheduler.

## Existing durable predicate

A copy is eligible when its same-company run is terminal (succeeded, failed,
cancelled, timed_out or interrupted), its receipt has no retainedByRunId key,
and either:

- It has fewer than three collection attempts and is prepared,
  pending_collection, unchanged_turn, warm_saved, or an agent-files.v1 copy in
  preparing state.
- It is an unavailable remote agent-files.v1 copy without processStoppedAt.
  This existing cleanup-proof branch is not subject to the collection cap.

Active prepared copies and retained warm owners are excluded. Exhausted or
completed copy history is passive. Terminal run status is eligibility for
inspection, not proof that the provider has stopped.

Startup loads scalar run IDs, company IDs and nextAttemptAt in keyset pages of
100. The shared worker keeps outstanding IDs and selects fair batches of 20.
Each due check rereads eligibility, honors a later saved deadline, and reserves
30 seconds through the existing copy CAS before I/O. The claim also verifies
that the same-company run is still terminal. A resumed run cannot be collected
merely because it was in an earlier discovery result.

The existing collection owner then applies its rules:

- Interrupted directory preparation can be discarded because launch requires
  prepared state first.
- Local collection requires saved stop proof or a valid server-authored native
  stop event, including its existing launch-order validation.
- Remote collection retains exact lease and termination checks. Unknown ownership
  stays pending. Recovery never starts a replacement environment to fetch files.
- Failed capture retains candidate/error state and the existing attempt limit.
- Captured bytes hand off to the existing commit owner. Directory cleanup keeps
  its own receipt and owner.

The worker rereads durable state after the attempt. Settled entries disarm;
unresolved entries retain their saved future deadline. A failure or unresolved
entry without a future deadline uses the shared bounded error backoff. Later
stop evidence is covered by the already-pending retry; it needs no recurring
scan of unrelated process events or environment leases.

## Producer audit and transaction ownership

Copy writes alone are insufficient. Run terminalization creates eligibility
without changing the copy row. The audit inspected run inserts/updates as well
as both instruction-copy owners.

| Producer family | Integration |
| --- | --- |
| Common instruction-copy patch | Signal changes into, within and out of potential collection work, inside the short existing transaction |
| Legacy copy preparation | Signal before the preparing insert; stage files outside the new short transaction |
| Directory preparation and warm successor insert | Signal in a short insert transaction; preserve insertion before the agent-row handoff lock |
| Directory adoption | Signal prior and successor scopes inside the existing handoff transaction |
| Heartbeat run lifecycle and legacy terminalization | Signal exact company/run inside existing status transaction |
| Heartbeat queue and run-dispatch adapter | Signal cancellation, supersession and other terminal writes inside their existing transactions |
| Queued-comment adapter and active-run watchdog | Signal exact terminalized run in the existing transaction |
| Execution-control and task recovery | Signal after candidate eligibility checks, before terminal write |
| Native finalizer, restart recovery and finalization reconciler | Signal terminal projection and terminal recovery writes in their owning transactions |
| Native session executor and status-decision committer | Signal verified terminal failure/cancellation; retain unverified-ownership behavior |
| Agent/company deletion | Invalidate company scope before cascades |
| Worktree execution policy | Signal globally through the existing settings transaction |

Metadata-only run writes do not create eligibility. A reset to running is
rechecked before execution; the subsequent terminal transition signals again.
Deletion of an unsuccessful directory reservation cannot create new collection
work. An already-known entry is invalidated at its next scheduled check.

Signals join existing outer transaction settlement, including nested writes and
ambiguous commit outcomes. No filesystem/provider call is wrapped in a new
transaction. Signal handling can inspect the exact run even if it has no copy;
this is bounded producer-time work, not recurring empty discovery. The supported
model is one process with instrumented writers. Independent SQL writers and
additional replicas still need explicit integration.

## Lifecycle and index

The heartbeat facade retains task-drain and worktree-execution admission.
Committed changes during drain/standby remain pending without passive SQL.
Startup/resume reconstructs existing debt. Shutdown joins admitted work and
retires subscriptions and deadlines. Manual/startup recoverStopped remains
available; only the migrated periodic caller skips it.

Migration `0408_short_red_skull.sql` adds the concurrent, replay-safe partial collection index on
(run_id, company_id). Its predicate excludes ineligible copy history; terminal
run eligibility remains a same-company join. The migration is registered with
the existing nontransactional runner and retains snapshots 0404 through 0408.
The original draft used 0396; later regeneration history remains recorded below.
Memory and startup cost scale with actual pending copy candidates, including
active candidates filtered by the run join; this is not a constant-cost claim.

## Verification and preserved failures

- 269 tests passed across instruction copies, startup wiring, run dispatch,
  queued-comment dispatch, heartbeat queue/recovery, execution-control recovery,
  and native finalization recovery. No tests were skipped in this selection.
- The instruction suite has 45 cases, including 12 stopped-worker cases. These
  cover quiet active/history states, real terminalization without a copy write,
  nested rollback/commit, restart, drain/standby, saved deadlines, delayed stop
  evidence, resumed-run claim races, 103 candidates, a failed claim, and shutdown
  during a save. Filesystem and PostgreSQL effects are exercised together.
- The directory owner suite passed all 101 cases after updating the existing
  stale-collector race injector to intercept the actual transaction boundary.
- Workspace typecheck and build passed.
- Native session/restart/reconciler tests passed 814 cases. Fifteen embedded-only
  remote warm ownership cases were filtered out locally. Native finalizer tests
  initially skipped all 27 cases because embedded PostgreSQL was unavailable;
  the suite now accepts a dedicated external URL and passed all 29 cases,
  including two real terminal-projection notification cases. These skips are
  not counted as passes. Full CI must exercise the embedded-only fixtures.
- Fresh migration application, migration-runner replay, direct index replay and
  migration numbering/safety checks passed.
- A rolled-back PostgreSQL fixture added 10,000 completed-history rows and one
  pending terminal copy. The plan used the partial collection index and run PK
  join, returned one row, and used 12 buffer hits (0.026 ms local execution).
  Dead index entries existed in this transaction. This is evidence of index
  selection, not a production latency or one-index-tuple claim.

The first broad run passed 187 tests and failed one existing directory race
test: its direct-update spy no longer injected adoption after the mutation moved
into a transaction. The repaired test injects at that transaction and retains
its original ownership, untouched-file, attempt and stop-proof assertions. The
subsequent instruction/directory run passed 143 tests. The later eight-suite run
includes three additional collection lifecycle tests and passed 269 tests.

A first added native-finalizer notification test passed 27 cases and failed one:
it expected a collection wake for a metadata-only finalizer failure. That API
only writes terminal run status when projectRunStatus is enabled. The final test
separates both cases: metadata-only failure leaves the run running and emits no
collection signal; terminal projection emits the signal. All 29 finalizer cases
then passed on a fresh database. No production behavior was weakened.

The embedded PostgreSQL support probe failed before suite startup on this host.
Tests used fresh disposable PostgreSQL 17 databases through the existing
validated external-test-database helper. Native finalization, native finalizer and execution-control
suites now accept opt-in dedicated URLs; normal embedded CI remains unchanged.
The failed harness log and all prior test logs remain available locally.

Full remote CI and review are required for this PR's exact head. This slice does
not establish Cloud alarm coverage, deployed database/host suspension, fleet
savings, or completion of the remaining orphan-reaper migrations.


## Current parent and complete-file acceptance (2026-10-28)

Current source `28037085a01306e8e06ce8ffeacc112d781bf1fd` passes **1469 cases
across 14 complete files**, no skips, in 142.21 seconds. The selection uses no
case-name filter and includes the complete native session executor and restart
recovery suites. The earlier filtered or skipped results remain recorded above.

| Complete file | Passing cases |
| --- | ---: |
| src/services/native-runtime/native-session-executor.test.ts | 968 |
| src/__tests__/agent-directory-working-copies.test.ts | 101 |
| src/services/heartbeat/run-lifecycle.test.ts | 31 |
| src/services/heartbeat/queue.test.ts | 32 |
| src/__tests__/agent-instruction-working-copies.test.ts | 50 |
| src/modules/run-dispatch/adapters/postgres.test.ts | 69 |
| src/services/heartbeat/recovery.test.ts | 45 |
| src/__tests__/server-startup-feedback-export.test.ts | 57 |
| src/services/native-runtime/native-run-finalizer-telemetry.test.ts | 29 |
| src/__tests__/native-finalization-recovery.test.ts | 32 |
| src/services/execution-control-reconciliation.test.ts | 10 |
| src/modules/wake-queue/adapters/queued-comment-postgres.test.ts | 5 |
| src/services/native-runtime/native-restart-recovery.test.ts | 25 |
| src/services/legacy-execution-recovery.test.ts | 15 |

Ten distinct fresh PostgreSQL databases were created and migrated before
fixture setup, covering the filesystem, recovery, dispatch, queue, execution
control and native finalization boundaries. The preserved embedded fixtures
within the selected files were exercised as supported; no suite was replaced
with a mock to count a pass. Database build, server typecheck/build, module
boundaries, target migration order, and all ten fresh migrations pass.

Only this slice's unpublished 0400 migration artifacts were deferred before a
normal merge of the current directory-cleanup parent. The original concurrent,
idempotent collection index SQL was regenerated through `pnpm db:generate` as
`0406_gigantic_sunfire.sql`, with identical SQL bytes. All prior SQL, journal
entries, and retained snapshot bytes remain unchanged; five snapshots 0402-0406
remain. The historical snapshot merge conflict used exact parent bytes.
Original domain/schema edits and unrelated upstream changes are preserved.

A populated parent database upgraded 0405 to 0406, preserving all 404 old
migration receipts and appending exactly one. Replay appends none. The collection
index is valid and ready on both fresh and upgraded databases. This is local
worker, producer and migration evidence; deployed host/database suspension and
external Cloud wake coverage are separate. Actual landed parent ancestry and
fresh current-head CI and reviews are still required before merge.


## Reviewed parent and comment compliance

The latest prepared directory-cleanup parent carries the published captured-save
review correction. A normal merge changes parent audits and comment text only;
every changed code file retains an identical non-comment TypeScript token stream
and the complete database source tree remains unchanged. Four newly added
comment lines in this slice's instruction-copy owner are removed under
CONTRIBUTING.md. The staging/terminal-proof and fair-page explanations remain
in this audit. No guard, query, assertion or deadline changes. The 1469-case
acceptance retains its original scope; final actual-parent ancestry, current
head CI and reviews are still required before publication and merge.

## Current parent, migration408 and complete native-runtime acceptance

The current directory-cleanup parent carries the new Coordinator/Runner behavior,
bounded retry cancellation and actual landed instruction-recovery ancestry. Only
this slice's unlanded 0406 artifacts were deferred before the normal merge. The
two native finalization source conflicts were import-only: both the collection
notification and required-quality-review imports remain. Complete original
runtime/schema edits and every unrelated upstream blob are preserved. The
migration tree and client matched the exact parent before generation.

The original concurrent, idempotent index SQL was generated as
`0408_short_red_skull.sql`. All earlier executable SQL, prior journal entries,
and retained snapshot bytes remain unchanged. The five snapshots are
0404 through 0408. No new code comments were added relative to the parent.

Source `cb2818a8f46ef961f744977a258f0e9042e31a42` passes all **1469 cases in
fourteen complete files**, without skips, in 141.69 seconds. This includes the
full 968-case native-session suite and the collection, directory, startup,
recovery, dispatch, queued-comment, execution-control, finalization and lifecycle
consumers. Eleven separate fresh PostgreSQL 17 databases migrated through 0408
isolate destructive fixtures. The embedded-only lifecycle fixture temporarily
uses its own external database on this IPC-exhausted host, then is restored byte
for byte. All assertions and original timing limits stay unchanged. This is
qualified external-database acceptance, not an unmodified embedded CI run.
Actual database build, server types/build, boundaries and exact-current migration
order pass with commands selected by name.

A populated 0407-to0408 upgrade preserves every one of the 406 prior migration
receipts and all 38 companies, adds exactly one receipt, and adds none on replay.
The collection index is valid and ready on upgraded and fresh databases.

Adopting published parent `210fcb1215a3b5e5ed84e420ddb73ab5952d9365` changes
only parent documentation and ancestry. Integration
`a4dfd30786f30f755273c86515c17644c4f15471` preserves complete server, package,
UI and test trees from the accepted source, including the whole 0408 database
tree. It also records the actual 0406 squash ancestry. The parent directory PR
still must merge, then its actual 0407 squash ancestry must be reconciled before
this slice publishes. Old draft review scores and local acceptance do not prove
current-head remote gates or deployed sleep. All earlier failures stay recorded.


## Landed directory parent and independent UI preservation

Directory cleanup landed as `267842fc3c6e6542deed8a1bcc2c78bec8df7862`.
Its server, package and test trees match reviewed parent `210fcb1215a3b5e5ed84e420ddb73ab5952d9365`.
Master also contains the independent sidebar popover fix from #18117 in three UI
paths. A normal merge uses the proven combination of both complete patches.
It preserves every owned stopped-collection edit and every upstream UI blob.
The resulting server, package and test trees remain identical to the accepted
1469-case source. The whole 0408 database tree remains unchanged.

Integration `c3a2ad6bdf` records the actual landed-parent ancestry. All 36 tests
in the complete sidebar account-menu file pass on the combined tree in 2.02
seconds. Existing React act warnings are present. No timing limits, backend
assertions or runtime behavior changed for this ancestry reconciliation. Fresh
CI and exact-current-head reviews must still pass before merge.
