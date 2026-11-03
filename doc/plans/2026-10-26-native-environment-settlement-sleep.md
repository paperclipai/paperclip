# Native environment settlement without idle polling

## Scope and owner

Slice 58 of the recurring-server sleep stack. Parent: slice 57, PR #17793,
`be8f3284c2c8a05903f2eca000ad86d046780fec`. This slice moves only the environment
lease portion of native finalization recovery out of the recurring run reaper.
Runtime-service release, agent status projection, workspace descriptor cleanup,
active-transport replay, and the remaining reaper duties stay separate.

The prior `settleRecoveredNativeWorkspace` callback did three jobs whenever the
native finalizer replayed committed results. Even historical runs with no leases
caused environment discovery and stop-receipt reads. The callback still serves
live/manual recovery. Periodic replay now delegates its environment portion to
one shared-coordinator worker. The other two callbacks retain their behavior.

`run-control.releaseEnvironmentLeasesForRun` owns terminal resource policy and
warm-session stop checks. `environment-runtime.releaseRunLeases` owns exact lease
and provider operations. The worker invokes those owners; it does not interpret
provider receipts, select another provider, infer a stopped process from a terminal
status, or implement teardown. The release predicate is extracted without changing
its existing states. No schema, migration, independent timer, or job table is added.

## Existing truth and deadlines

A candidate has all of the following:

- A native run bound to the same company and issue as its finalization.
- An accepted result bound to that exact run, company, issue, and finalization.
- A terminal run status. Running/unknown execution ownership is excluded.
- Either a committed finalization, or an exhausted workspace-finalization failure
  identified by its existing `workspaceFinalizeAttempt` receipt.
- At least one lease still accepted by the release owner: active; a stop/export
  handoff in `pending_cleanup`; or failed retained cleanup when the recorded
  disposition calls for destruction.

Released/expired/failed lease history and retained success do not keep this
worker scheduled. An unrelated pending-cleanup row belongs to the existing
cleanup worker. A retained failed lease does not earn destruction when the native
run's recorded disposition calls for retention. Disposition still comes from the
saved native workspace reference and export-retry evidence. Failed-turn warm
retention is normalized by the existing run-control owner.

Stop/export handoffs keep the existing saved cleanup claim/retry deadline and
five-minute spacing. An attempted release that leaves real debt keeps a
30-second minimum retry. Exceptions use the shared coordinator's bounded backoff.
A release call returning successfully does not prove success: the existing API
logs per-lease failures. The worker re-reads lease truth before disarming.

Discovery is paginated by run ID. Scoped hints are coalesced and fair dispatch
uses the existing scoped deadline worker. Current run status is checked again
before an automatic release; the original release owner retains its own guards.

## Producer and transaction audit

| Producer | Existing boundary / new hint |
| --- | --- |
| Accepted result, committed finalization, workspace failure | Existing `notifyNativeFinalizationWork` fanout |
| Run projection and metadata repair | Projection's owning transaction before its write |
| Terminal run lifecycle | Existing lifecycle transaction before status changes |
| Finalizer's direct projection path | Existing finalizer transaction |
| Restart/control recovery terminal writers | Existing terminal-write transactions |
| Lease acquisition and same-run reacquisition | Acquisition transaction; the simple insert now has the same transaction boundary |
| Lease release, cleanup handoff, metadata update, retry receipt | Existing environment-cleanup notification boundary |
| Worktree execution setting | Existing settings transaction, global reactivation hint |
| Startup/restart | Reconstruct from existing records without requiring a remembered hint |

Hints serialize only the company/run/issue identifiers. They are awaited before
writes, and the shared database signal protocol owns outer transactions,
savepoints, rollback, and uncertain commit outcomes. No per-call recovery counter
is threaded through routes. No private Muse contract is used for environment work.
The supported writer model remains the server's instrumented writers. Independent
SQL writers or unrelated replicas do not acquire a new ingress guarantee here.

Warm-session or workspace guards can defer an attempt. While the exact lease
still needs release, its scoped retry remains. A completed lease, changed owner,
or a no-longer-terminal run removes the entry on reconciliation. Concrete retry
work may still prevent host sleep; that is not idle-history polling.

## Lifecycle and boundaries

Startup registration uses the heartbeat facade's restore/worktree suppression
and task-drain checks. The app also gates warm standby, shutdown, and scheduler
enablement. Shared coordinator admission preserves dirty scopes across drain,
coalesces writes during execution, and joins worker shutdown. Settings changes
reactivate work that was suppressed rather than leaving a passive scan running.

The environment-cleanup fanout is a shared change because lease writes can create
or discharge native settlement debt. With no eligible native run, it produces
one empty reconciliation and no recurring work. The generic cleanup worker,
provider claim fences, workspace preservation, retained-session cleanup, and
remote stop acknowledgment retain their owners.

## Verification record

- 17 new real-PostgreSQL lifecycle cases pass through the public heartbeat facade,
  real native result/finalizer writers, and the existing environment runtime.
  Controlled local-driver operations stand in for provider effects.
- Cases cover empty/retained history, first acquisition after finalization,
  finalizer-produced release, restart, outer commit/rollback, swallowed release
  failures, writes during an active release, drain/resume with zero SQL,
  running/unverified owners, exact company scope, pending cleanup deadlines,
  worktree/restore suppression, settings reactivation, keep-running retention,
  exhausted workspace failure, and partial periodic delegation.
- The combined run passed 127 tests: 17 new cases, 28 existing native notice and
  finalizer integration cases, and 82 startup cases.
- 85 existing run-control, heartbeat recovery, and environment-cleanup tests also
  pass. The affected total is 212. Final workspace checks are recorded in the PR.
- The first test setup failed because migrations already create the unique local
  environment. The fixture now uses that existing environment. The subsequent
  lifecycle runs passed; no production change was made to bypass the constraint.

The dedicated test databases use the existing local PostgreSQL server. No further
OS semaphore cleanup was performed. The full local suite still requires its
previously recorded environment capacity constraints to be resolved; CI supplies
full-suite acceptance. A green targeted run does not close the whole stack.

## Remaining acceptance and limitations

Remote checks, Greptile review, full-stack master propagation, and older stack
review/gate debts remain separately tracked. The latest observed `origin/master`
was `8c702d59dbc45ea5d491379b11b4883c17caebab`; this slice stays on its stacked
parent. No merge authority is assumed.

No deployed provider teardown, database suspension, external Cloud alarm coverage,
or fleet cost reduction is claimed. Future deadlines still need their existing
external-wake/blocker contract before a host can sleep. The next distinct duties
in this callback are runtime-service lease settlement and agent terminal-status
projection; descriptor filesystem cleanup is another separate owner.

## Review repair: per-lease deadlines and notification-safe retries

Greptile's first review found two valid gaps at `7126f8e394`:

1. One active lease made the whole run immediately due, and the existing batch
   release then also attempted a second lease with a future cleanup deadline.
2. A notification reload rebuilt active debt at deadline zero and erased the
   worker's 30-second retry floor. Unrelated lease changes could cause one-second
   retries of the same failed release.

Both defects reproduced before the repair. The mixed-lease test observed an
unexpected stop attempt. The notification test observed four release attempts
where one was expected.

The background release capability now passes `respectCleanupDeadlines` through
run-control and the orchestrator to the existing environment runtime. The runtime
filters each lease by the shared deadline expression and rechecks that expression
at a stop-only claim. A stop intent prepared by this very call may make its first
attempt immediately, fenced by its fresh attempt identity and zero saved retry.
Manual/live release retains its prior default behavior.

The worker retains a per-run in-memory retry floor across scope reloads. The saved
cleanup deadline remains authoritative and can change; the map retains only the
last attempt's minimum spacing. Entries are removed once their scoped debt no
longer exists. Restart reconstructs durable lease truth as before. No new
persistence or framework-wide scheduler semantics were added for this repair.

## Review repair: readiness during physical cleanup

The environment-settlement registration awaited its initial worker pass. A saved
stop handoff from exhausted workspace finalization can be eligible here while
excluded from the earlier startup scan, so a slow provider release could block
HTTP readiness and registration of later workers.

Startup now registers the worker and tracks its ready promise with the existing
heartbeat work owner instead of awaiting physical cleanup inline. The delivery
coordinator still owns the worker, and drain/shutdown still join the same work.
The held-cleanup readiness/shutdown test is shared with retained-session cleanup;
its environment-settlement case failed before the fix. All 84 startup cases and
20 real-database environment-settlement lifecycle cases pass, as do workspace
typechecking and the full build. Full local test:run remains unqualified for the
previously recorded embedded-PostgreSQL capacity reason; remote checks remain
required. No provider resource debt was dropped and no deployed-sleep claim is made.

## Narrow cleanup candidate reads

Review finding `PRRT_kwDORclPyM6wgKt1` correctly identified broad JSON reads in
the candidate selector. Startup, notification reload, and the checks before and
after settlement selected complete `runnerProfileJson` and `resultJson` values,
although disposition needs only `nativeWorkspaceSync` and `workspaceExportRetry`.
The selector now projects those two nested values in SQL, preserving nulls and
the existing disposition contract. The actual settlement callback already uses
`getRunWorkspaceSettlement`, whose SQL has the same narrow projection; it was
inspected and did not require another change. No provider policy, retry deadline,
lease predicate, notification, or stored run record changes.

A real PostgreSQL regression seeds four finalized runs with large unrelated saved
inputs/output plus destroy, keep-running, stop-and-retain, and invalid workspace
references. Candidate discovery and the checks before/after a controlled release
returned 7,208,692 response-value bytes before the fix and failed the 16 KiB bound.
The same test now passes that bound, still selects only explicit destruction for
a failed retained lease, preserves the conservative invalid-reference fallback,
and verifies that the saved input/output remains intact. All 21 cases in the
complete environment-settlement lifecycle suite pass, including actual release,
keep-running retention, export retries, per-lease deadlines, restart, outer
transactions, drain, and shutdown. Logs: `/tmp/sleep-environment-projection-red.log`
and `/tmp/sleep-environment-projection-green.log` with matching status files.

The capture measures returned values at the postgres-js boundary, before Drizzle
decoding. It does not measure wire bytes or PostgreSQL storage/CPU savings: JSON
extraction still runs in PostgreSQL. This is evidence of reduced response payload
and application decoding work, not deployed suspension or fleet-cost savings.
Workspace verification and fresh PR checks remain separate gates.

## Scoped lease-write notifications (2026-10-27)

The shared cleanup fanout originally sent a global native-settlement hint for
all lease updates. A controlled six-run backlog reproduced seven full inventory
discoveries: startup plus one after every successful release. Each discovery also
recomputed remaining run deadlines. This was unnecessary database activity during
real work, even though the worker eventually became quiet.

The existing cleanup helpers now accept the native worker's existing company/run
scope. Lease writers pass identity from their own lease/run records. Release,
bulk run release, cleanup claims and receipts, export recovery, stopped-sandbox
handoffs, recovery cleanup, plugin task failure, and harness/workspace metadata
writes preserve the same transaction and intent-before-write contract. ID-only
metadata updates read and lock the two scope columns within their transaction;
other reads/returns that already fetch the lease include those scalar columns.
No caller receives a new lifecycle object or manual recovery wrapper.

The generic environment-cleanup and historical-cleanup topics retain their prior
contracts. Startup and broad custom-image cleanup changes still allow global
native discovery because they have no single run scope. Lease writes no longer
cause cross-company global reloads. The worker, deadlines, cleanup authority,
provider operations, and supported process-local writer model are unchanged.

Evidence:
- Baseline backlog regression failed with seven unscoped discoveries instead of
  one. With scoped writes, the same real finalizer/lease/runtime path discovers
  globally once, releases all six leases, and returns to zero SQL/network work.
- A real nested metadata write produces no discovery before outer commit, wakes
  only its run after commit, and produces no discovery after outer rollback.
- Seven selected suites completed with 203 passing cases and 60 embedded-only
  cases skipped. This includes native settlement, export retry, workspace
  recovery, plugin task contracts, and workspace-sync unit coverage.
- Initial typechecking caught an attempt to access a run ID on the plugin cleanup
  API's deliberately narrow lease input. The existing update now returns that
  scalar field instead. Final server typechecking passes; the plugin task suite
  then passes all 32 cases (four embedded driver cases remain skipped).

These local checks do not establish full CI or deployed suspension. The pending
whole-stack checks, remaining review findings, and unmigrated recurring duties
remain open.

## Current master integration and native lease quiet proof (2026-10-29)

Accepted production source `9596fa022b57feea026c4728c80bdc36037b804f` contains reviewed parent `305014b030d6c5eb891c70bc57036f4192d4fdad`.
That parent merged as `829f9e7eafe57588d214697efca336b35aecf45d`. A normal merge adopts the actual squash
after proving complete parent-tree identity. The complete accepted child tree
stays unchanged. Only this audit follows that source in the publication.

Composition preserves 1,218 parent-only paths, 14 owned-only paths, 11,516
identical paths, and 17 shared automatic merge results. The only manual
resolution adds environment settlement inside the existing ordinary issue/run
guard in native finalization notifications. Packages equal the parent byte for
byte, including current Copilot profile 80 and its historical profile fixtures.
No package or live provider qualification is added by this slice.

The new database regression exposes the quiet-path requirement. Moving only
the new environment notification outside the issue/run guard makes three
routine company-only finalization hints perform three environment candidate
SELECTs. That controlled baseline fails the quiet assertion. With the guard
retained, the same test passes with zero candidate SELECTs. It then commits real
native work, creates an eligible lease through the owning service, observes
physical release, and returns to quiet. The test hash is identical across the
controlled red/green pair, and the temporary production edit restores exactly.
No assertion or timeout changes. Real lease, run, and settings writers retain
their scoped or global notifications.

Acceptance covers 4,172 distinct passing cases in 64 complete server test
files, plus 20 targeted chat cases (4,192 selected cases total). The main
62-file command reports 3,440 passes and 49 skips. All skips belong to the two
Stop/control-read files: their indirect shared fixture has its own supported
PAPERCLIP_RUN_CONTROL_TEST_DATABASE_URL override. The initial live log showed
43 Stop skips; the final report includes another six read cases. Both complete
files then pass on separate fresh databases: 51 control cases and six read
cases. Their eight already-passing pure cases are counted once. This closes
the coverage gap without counting skipped tests as passing.

Separate process recovery passes 410, and review response passes 273.
The targeted chat selection passes 20 committed-response and GitHub idle cases;
1,794 other chat cases are outside the local selection. The complete
Photon file is part of the main batch. Coverage also includes lease release,
retention, environment runtime and drivers, workspace sync, native execution,
Stop, startup readiness, queue, goals, interactions, monitor and status workers.

All 65 selected test files restore to their exact committed hashes after fixture
imports. The follow-up also hashes the indirect run-control fixture helper.
Fixtures use 39 prepared fresh PostgreSQL 17 databases, plus fresh per-call
helper databases. There are 412 migration journal entries through index/tag
0413_tired_kronos; the final tag number is not an entry count. Database build,
server production typecheck/build, module boundaries, migration order, and
Copilot identity pass.

Failure and scope accounting remains explicit. The unscoped baseline fails as
expected. The original 49 skipped cases are recorded and completed as above.
Earlier parent handoff timeout and chat-idle failure records remain in their
own audits. Latest-head CI, security, and exact-head Greptile 5/5 remain separate
merge requirements. There is no full local repository or full chat-suite claim,
no live provider qualification, and no deployed sleep, database suspension,
external alarm coverage, or cost claim. The writer model remains supported
in-process producers. Existing Cloud sleep blockers remain.
