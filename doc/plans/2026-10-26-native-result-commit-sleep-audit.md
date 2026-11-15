# Accepted native result commits: sleep audit

Date: 2026-10-26. Slice 53 starts at `d5c540b1c0df9aba35262ba121c651806bbca161`,
parent [#17734](https://github.com/paperclipai/paperclip/pull/17734). The branch is
`codex/sleep-53-native-result-commit`. This is one duty from the
[recurring-server inventory](2026-10-24-recurring-server-sleep-stack.md).

## Problem and bounded change

The aggregate orphan recovery pass can finish three different obligations:

1. Commit an accepted native result after successful workspace finalization.
2. Repair the run projection and consequences of an already committed decision.
3. Release runtime resources and settle the agent after finalization.

This slice moves only the first duty to transaction signals and concrete saved
deadlines. The native finalizer remains the authority for claiming, classifying,
arbitrating and committing results. The new worker does not arbitrate statuses or
implement provider behavior. No table, migration, provider loop or external API
is added. Committed projections and resource settlement remain in existing
recovery until their own durable pending predicates and producers are migrated.

The current default branch was refreshed during this work. Inspected master is
`49bd7a4ba6` and contains subsequent native finalization/recovery changes,
including #17525, #17531, #17614, #17641 and #17665. Full-stack integration with
master and repeat verification remain acceptance work; this branch keeps its
requested stack parent rather than silently dropping or rewriting prior slices.

## Trigger, durable truth and quiet predicate

`nativeResultCommitWork` reads the existing coordinator, accepted result,
heartbeat run, issue and successful workspace operation. All joins bind company,
issue and run. Eligibility requires:

- native runtime and accepted result;
- coordinator phase other than `committed` or `terminal_failure`;
- no held native runner ownership and no pending native status effects;
- at least one successful scoped `workspace_finalize` receipt.

A later stale failure receipt does not invalidate an earlier successful receipt.
The shared pending-effect worker owns pending effect delivery. This worker waits
quietly until that owner publishes settlement. A workspace receipt proves the
copy-back barrier; it does not prove that runtime cleanup finished.

Discovery reads narrow candidate fields in keyset pages of 100. Execution reads
the run profile only when a candidate is due. There is no recurring scan for
empty work or retained committed/terminal history. Discovery still costs SQL at
startup and after notifications. No large-fleet query benchmark is claimed.

The next deadline is the later of saved `nextAttemptAt` and a held lease's saved
expiry. Inspection does not advance either date. A missing lease expiry follows
the existing finalizer claim contract; it is not evidence of physical process
termination. If an invocation leaves a concrete eligible result without a saved
future deadline, only that unfinished result retains a 30-second fallback.

## Producers and transaction ownership

Signals use the existing DB intent/outer-commit protocol. Each write registers
and awaits its intent before the write. Durable rows remain truth; notifications
are scoped hints. Savepoint release does not dispatch before outer commit.
Rollback does not create work. Ambiguous outcomes remain owned by shared DB work
signals rather than worker-local counters or new recovery tables.

| Producer | Boundary and purpose |
| --- | --- |
| `PaperclipControlPlanePort.completeRun` | Signal before the first accepted-result insert. Covers result arriving after an existing workspace barrier. |
| `NativeRunCoordinatorStore.completeRun` | Same contract for the PRP coordinator's independent accepted-result writer. Terminal-event reconciliation delegates here. |
| Workspace operation recorder | Signal before workspace-finalization receipt writes, including the successful barrier arriving after the accepted result. |
| Direct workspace recovery | Signal the repaired successful receipt in the same transaction. |
| `notifyNativeFinalizationWork` | Existing fanout now covers this duty: status decision, effect settlement, saved failure/retry, native execution release and other finalization transitions. |
| Initial finalizer/store claim | First-result lease writes now signal even when no decision exists. Claims with a decision use the existing fanout. |
| Workspace ownership clear/recovery | Signal the affected run when durable ownership changes. This does not grant physical ownership to the commit worker. |
| Issue mutation | Relevant status, binding, assignment and dependency changes reconstruct scoped candidates. |
| Instance execution setting | Worktree execution activation publishes a global reconstruction signal. |
| Native retry cancellation | Signal before changing the retry coordinator to terminal failure so its saved wake is cancelled immediately after commit. |

The startup/restart recovery path for provider adoption selects resultless runs;
it does not create accepted-result work. The stopped-before-first-turn terminal
write likewise requires a null result ID. Those writes cannot enter this worker's
candidate set. Normal accepted-result execution release already uses the shared
finalization fanout.

The supported producer model remains the application's instrumented writes in
one owning server process. Independent SQL writers and cross-process mutations
without supported ingress are not covered by a process-local notification.
Startup reconstructs durable work. This slice does not add a cross-replica bus.

## Claim and lifecycle boundaries

The public finalizer gains optional `onlyWhenDue`. Under the existing coordinator
row lock it rejects a future retry before acquiring a lease or charging an
attempt. A typed deferral distinguishes a live lease or moved retry from an
execution failure. Existing callers retain immediate behavior unless they opt in.
The worker rereads durable state after deferral, commit or recorded failure.

The worker reuses `registerScopedDeadlineWork` and the delivery coordinator for
coalescing, serialized execution, scheduled deadlines, retained dirty scopes,
drain/resume and shutdown. It processes one candidate at a time. It introduces no
separate timer or event bus. Heartbeat is only the lifecycle/policy facade.

Public registration checks task drain and the existing restore/worktree execution
suppression policy. A drain keeps its wake for resume. Suppression does not launch
recovery or keep querying. Worktree activation reconstructs from durable records.
Server registration remains under `heartbeatSchedulerEnabled` and the existing
warm-standby/shutdown gates. Coordinator shutdown joins in-flight work; startup
reconstructs any additional work committed while shutdown began.

The periodic orphan pass sets `skipNativeResultCommit`. The reconciler skips
uncommitted result execution only. Its committed projection and resource paths
remain enabled. Direct/manual callers retain default behavior. In particular,
`phase=committed` cannot be treated as proof that every consequence is settled:
the status decision and run projection occur in separate transactions.

## Verification and preserved failures

The real-DB worker suite has 20 passing cases. Together with 76 startup cases,
the focused command passes **96 tests**. It covers:

- no work and retained committed history with zero recurring SQL after settlement;
- both real accepted-result producers, barrier before and after the result;
- caller-owned outer commit and rollback for both writers;
- startup reconstruction and a successful barrier followed by stale failure;
- future retry and lease deadlines without early attempt charges;
- a retry moved between candidate discovery and the atomic claim;
- a real finalizer status-commit failpoint, rolled-back decision and saved retry;
- real pending-effect settlement waking accepted-result commit;
- first work during drain and subsequent resume;
- public restore/worktree suppression and real settings activation;
- shutdown joining active execution and restart recovering later work;
- real native cancellation disarming an existing retry;
- committed projection remaining covered by the existing reconciler.

The projection test commits without projecting and then calls the existing
reconciler. It proves the retained recovery boundary, not a deployed crash test.
Shared transaction uncertainty behavior is inherited from its existing tests;
this slice does not claim a new network-fault qualification.

Preserved failures:

- Initial producer regressions: six failures and four passes. Missing signals
  prevented the first result, later barrier, outer commit and drain/resume from
  reactivating the worker. Wiring the real producer transactions made all ten pass.
- Cancellation regression: the test timed out at 15 seconds waiting for the
  cancelled ten-minute deadline to clear. The cancellation transaction had no
  signal. Adding its awaited pre-write signal makes that case and all 96 focused
  cases pass. The failed command remains evidence; it is not counted as a pass.

Logs for this local session: `/tmp/sleep53-producer-red.log`,
`/tmp/sleep53-producer-green.log`, `/tmp/sleep53-cancellation-red.log`, and
`/tmp/sleep53-cancellation-green.log`. Initial server typechecking passed before
the cancellation follow-up. Broader affected suites, final full commands, remote
checks and review are still pending at this checkpoint.

## Limits and follow-up

This is worker quiet, not host suspension. Cloud alarm coverage, admission fencing,
idle-sleep safety and resource blockers are unchanged. No database-suspension,
deployed-wake or fleet-savings claim is made. The aggregate orphan scan still has
other duties and still performs queries.

Next distinct duties include committed run projection/consequences and native
resource settlement. Keep uncertainty visible until each has an owning pending
contract. The prior eight-worker suppression audit, older stack gate failures,
full-stack master propagation and every remaining inventory duty remain open.
No merge is authorized by this task.

## Startup readiness follow-up (2026-10-27)

The initial result-commit sweep can wait on a finalization lock. Registration now
tracks its readiness promise through the existing heartbeat shutdown owner instead
of awaiting it before HTTP startup completes. The delivery coordinator still owns
worker cancellation; no independent subscription or timer is introduced. A held
worker regression failed on the old wiring, then passed with HTTP ready, subsequent
recovery registered, and shutdown waiting until the held work settles. All 80
startup tests pass before and after integrating pinned master
`8548173fc9efdc0fa07644fb92dcc0b6851a95e5`; production server types pass at the
integrated revision. These lifecycle checks do not establish deployed host sleep.

## Current parent integration and routine-hint regression (2026-10-29)

This slice now incorporates parent #17734 at
`7df5c9c44ea9e171be3c61b4430d3727b10f3337` through a normal merge. A
batched tree comparison preserves 1,203 parent-only entries, nine owned-only
entries, 11,520 identical entries and 12 automatic shared merges. The sole
manual conflict adds result-commit notification inside the existing ordinary
issue/run scope guard. Explicit company settings and dedicated result-state
notifications retain their existing scopes. The entire package tree matches
the parent, including combined Runner profile 80 and all historical fixtures.

Six added comments in three files were removed with identical nontrivia
TypeScript token streams; no directive was removed. This includes the readiness
repair already present in the prior branch: result recovery's first `ready`
promise is owned by the existing idle/shutdown tracker. It does not block HTTP
readiness. Its held-callback startup regression remains in the complete startup
suite. The earlier Greptile 4/5 on commit `656f6722be1aedf3d52b7f853956e15838204278`
reported that blocking await; it is historical failure evidence, not an unresolved
finding to waive. The subsequent Greptile service error is not a review pass.
A fresh review on the final published head is still required.

The new real-database regression submits three routine company-only finalization
hints to an idle result worker. A controlled baseline moves only result fanout
outside the guard and leaves all other parent guards intact. The worker issues
three candidate SELECTs, so the zero-query assertion fails. Restoring production
bytes passes the same assertion. The real workspace recorder and accepted-result
writer then produce exactly one committed decision and return to quiet. The
red phase fails one selected case in 7.35 seconds; green passes it in 6.66 seconds.
Twenty cases outside the pattern are not included in that focused count. Both
phases use fresh dedicated PostgreSQL 17 databases and restore the production
helper byte-for-byte. No test assertion or timeout is relaxed.

### Complete current-source acceptance

Source `2af88fa55f961a74340880240019f6cd31e21bf1` passes **2,429 distinct
cases in 18 complete files**, with no skips in those files. The 16-file main
command passes 1,746 cases in 277.97 seconds. Process recovery passes 410 in
162.42 seconds. External-chat response passes 273 in 53.41 seconds. This includes
all 21 result-worker cases and 82 startup cases, including held recovery,
nonblocking readiness and shutdown joins. Production server typechecking, build,
module boundaries, migration order and the source identity check pass.

Fifteen dedicated PostgreSQL 17 databases use the unchanged migration 413 schema.
Embedded-only invocations use the existing fresh-per-call recovery helper. All
temporary imports are restored byte-for-byte and every selected test hash matches
after completion. No assertion or timeout is relaxed. The readiness thread was
resolved after matching its existing remote fix to the passing complete startup
suite. No old review score or service error is treated as current acceptance.

Parent #17734 merged as `a019d00a393b57f531afe8dd8ab0b8a1820d1c4c`, after
57 clean current-head checks and Greptile 5/5. Its complete reviewed tree equals
the landed squash. Normal merge `998239b019defe52e7b5d64f884de4e871ccd736`
adopts that ancestry with this child's complete tested tree unchanged. This
slice can now target master; fresh exact-head CI and review remain required.

The unchanged parent package tree retains its profile 80 acceptance: 130 passing
installation/compatibility/transport cases, 22 installed ACPX/Grok contract cases
and 26 native-provider Rust cases. One existing opt-in closed Pi snapshot case
was skipped because its distribution root was unset. This does not qualify a
live Pi installation. Earlier failed commands remain in the record. No full local
repository suite, live provider qualification, deployed suspension, expanded Cloud
wake coverage or measured savings is claimed.
