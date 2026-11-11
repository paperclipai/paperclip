# Native accepted-response presentation recovery

Status: worker, producers, and startup/periodic integration implemented; full local and remote acceptance pending.
Branch: `codex/sleep-48-native-response-presentation`.
Parent: [#17690](https://github.com/paperclipai/paperclip/pull/17690),
`56c3601ea605b333141e86e0a810ed790fb6ce48`.

## Reason for work

A native run can have an accepted, committed result but no saved public reply.
The finalization reconciler calls `repairCommittedNativeChatResponse` before
skipping superseded status decisions. A later task decision must not erase an
already accepted, still-authorized response. This work neither re-executes the
provider nor changes issue disposition. It is separate from governed-review
presentation, evidence reassessment, and result/workspace settlement.

The current helper covers three variants of the same accepted-response duty:
a saved same-agent/monitor continuation summary, an internal task's exact final
assistant message, and an authorized external response-wake summary. Governed
review responses are explicitly excluded and retain their own stricter owner.
Do not merge the review response migration into this slice merely because both
helpers live in the finalizer.

## Existing authority and mutation boundary

`repairCommittedNativeChatResponse` locks issue, run, and coordinator in that
order. It requires native runtime; succeeded, failed, or timed_out with finishedAt;
a committed coordinator with result/assessment/decision and a null leaseOwner.
It refuses to replace a selected comment, including a deleted selected answer.
It checks the accepted result's digest using either the coordinator format or
the older authenticated control-plane format, retaining its bounded journal
source lookup. It excludes externalChatReviewPresentation decisions.

A lease that expired but still has an owner is not permission to publish: the
helper requires actual release. Do not reuse the pending-effects lease rule.
The outer periodic candidate query additionally respects saved nextAttemptAt.
A future worker must preserve that fence where applicable and wake on release.

Internal completion needs an exact final assistant event for the accepted turn,
current internal-write authorization, and permission to create a new completion
comment. Continuation summaries check provider-owned interactions. External
response-wake summaries require the live registered chat authority, exact durable
source provenance, and current presentation authorization. The chat owner validates
source edits/deletion, membership, endpoint state/generation, consumed failure
lanes, and ambiguous delivery. None of this policy belongs in a generic scheduler.

The comment and presentationDecision are written in the same transaction, through
the existing comment/publication owner. Notification follows durable commit.
Recovery must not revive private provider narration, duplicate a target, publish
under another source, or reinterpret the saved result using new task settings.

## Contract gap to resolve before retiring polling

The helper currently returns false for several distinct outcomes: already settled,
structurally ineligible, authority unavailable/revoked, and transient SQL/lock or
materialization failure. It logs most errors then returns false. A worker cannot
use that boolean as a pending-work predicate: dropping false loses retryable
responses, while retrying every false rescans ineligible history indefinitely.

Keep the current boolean caller contract where needed, but expose the smallest
owner-level result/error contract that distinguishes dormant history from concrete
retry debt. Do not translate all authorization failures into retry forever. The
registered authority lives in durable-chat-wakeup.ts and is installed by
chat-channels/failed-run-retry.ts. Missing registration and later registration need
an explicit lifecycle wake path, separate from committed database mutations.

Audit and test the candidate predicate before introducing a worker. Startup scans
must filter selected answers, irrelevant result kinds, review-owned responses,
and other passive history. Full authorization stays in the locked owner; SQL
prefiltering is not a new publication authorization mechanism. Measure actual query
plans with substantial completed history before claiming bounded discovery.

## Producer audit still required

- Native coordinator decision commit, persisted-attention replay, and ownership
  release; result/assessment/decision binding changes.
- Run terminalization and accepted-turn event persistence, including late journal
  arrival and direct recovery writers. Avoid waking on every unrelated progress
  event merely because it shares the journal.
- Presentation selection/materialization and existing-comment suppression. A
  deleted selected answer remains settled rather than becoming repair debt.
- Issue conversation/context changes and skipIssueComment behavior.
- Exact chat source, action/admission, publication, endpoint generation/status,
  principal/membership, continuation provenance, and ambiguous-delivery resolution.
  Separate mutations that only revoke work from supported reactivation paths.
- Live chat-authority registration/replacement/shutdown; subscription ownership.
- Startup, first write during drain, retry during drain, resume, and shutdown.

Use existing durable records, scoped transaction signals, and the shared scheduler.
No new response queue table or permissive publication fallback is justified.
Independent SQL/multi-process writes remain outside the existing local signal
contract unless explicitly integrated; preserve the documented limitation.

## Baseline evidence

On the unchanged parent source, a fresh external PostgreSQL selection passed
33 accepted-response cases in chat-channels.integration.test.ts. The remaining
1,551 cases in that file were not selected, not claimed passed. The selection
covers duplicate/concurrent repair, source/authority changes, digest changes,
private disposition, cross-company/run binding, live heartbeat fences, the older
port-bound digest, GitHub internal prose/attachments, failure-lane replacement,
provider-dispatch reauthorization, selected/deleted answers, and contention.
Log: `/tmp/sleep48-chat-baseline.log`. Database:
`paperclip_sleep48_chat_baseline_20261025_test`.

The monitor-continuation and control-plane-port suites currently require embedded
PostgreSQL directly. Qualify a validated external-test path if needed before using
their results on this host; do not count skipped or initialization-failed suites.
No sleep or migrated-worker behavior is established by this baseline.

## Initial owner-contract change

`recoverCommittedNativeChatResponse` now exposes the existing transaction and
returns false for settled/ineligible/authorization-denied state, while propagating
operational failures. The existing `repairCommittedNativeChatResponse` wrapper
retains logging and false-on-error behavior for current callers. Authority checks,
lock order, target materialization, and commit signaling remain in the same owner.
The commit signal itself contains subscriber errors, so the wrapper does not hide
a previously propagated publication error.

The same 33-case real-PostgreSQL selection passes after this change, with added
assertions that the new entry point rejects under actual source-action lock
contention and returns false for the existing authorization/binding fences. The
server typecheck passes (`/tmp/sleep48-contract-typecheck.log`). Worker discovery,
producer notifications, startup wiring, and periodic removal are not implemented.

## Existing notification boundary to reuse

The current `notifyChatRunMilestones` boundary already covers 102 production call
sites and fans out lineage/authority changes to native progress, inbound notices,
confirmations, and GitHub work. Its scope is company plus optional issue because
source changes can authorize descendants. Audit its coverage for this duty before
adding caller wrappers. It already reaches status-decision settlement and run
projection, but raw coordinator-store/session release and accepted-turn journal
writers need individual inspection. Reuse is not proof that all producers exist.


## Local worker and locked scheduling fences

The local worker now discovers exact run/coordinator/result/decision bindings,
filters selected answers and structurally irrelevant results, and dispatches
through `recoverCommittedNativeChatResponse`. It does not own publication policy.
`onlyWhenDue` rechecks the saved retry and outstanding status effects while the
existing coordinator lock is held. Existing explicit callers retain their old
behavior. A future retry is retained even if it becomes due between the locked
check and the follow-up read; its next attempt is immediate rather than discarded.

Operational errors remain retryable through the shared coordinator. A structurally
eligible but unauthorized row becomes dormant until an eligibility mutation or
live authority registration invalidates its scope. Selected comments, including
deleted selections, remain excluded. No provider rerun or new work table is added.

The existing milestone notification boundary now includes the response topic.
Hints explicitly select company and issue IDs: structural TypeScript callers may
pass larger objects, so serializing the whole argument is not safe. The first
integration run exposed that mistake as circular-object serialization during
status materialization; it was corrected before the passing runs below.

Two narrow lifecycle capabilities support the new consumer:

- `registerScopedDeadlineWork.invalidate` marks reconstruction dirty before waking.
  A plain wake is insufficient after a prior dormant result removed its entry.
  Existing consumers keep the same registration and scheduling behavior.
- The committed-response authority owner exposes registration notifications.
  Registering/replacing the actual chat service reactivates dormant responses.
  The worker's `stop` removes this subscription; the delivery coordinator still
  owns worker cancellation and awaiting in-flight work. Repeated unsubscription
  cannot delete a later listener set. The authority remains scoped to the exact Db.

No startup registration or periodic skip is wired yet. The old recovery path is
still present. Full producer coverage, internal/continuation variants, recovery
failure/drain tests, and repeated large-scope mutation cost remain acceptance work.
Current discovery pages by run ID but reconstructs all matching pages in one
load; its resource bound under a large unresolved/dormant backlog needs proof
before activation. Do not describe the worker as a completed migration yet.

## Query-plan and migration evidence

The actual discovery query was captured from the driver. On a disposable database
with 10,000 additional selected runs, results, assessments, decisions, and
coordinators, it initially scanned completed history (22.656 ms). A partial
unpresented-run index alone still chose the wrong join order (16.532 ms).
Expression statistics for the selected-comment predicate allowed PostgreSQL to
start from the one unpresented run (0.091 ms).

Generated migration `0404_futuristic_earthquake.sql` creates the partial index
concurrently, adds idempotent expression statistics, and analyzes the table.
The existing top-level migration runner owns concurrent-index replay/repair.
Snapshot retention contains exactly 0396–0400. Fresh migration, journal replay,
direct SQL replay, ready/valid index flags, and statistics presence passed.

Rechecking the actual migration's objects (after removing experimental objects)
used the driver's real global, company, and issue-scoped queries. Global discovery
found one candidate in 0.078 ms; history-only company/issue scopes returned none
in 0.024/0.019 ms without sequential scans. These are query-plan fixtures, not
latency or fleet-sleep claims. Large unselected ineligible histories and repeated
configuration signals still need separate qualification.

Evidence: `/tmp/sleep48-query.json`, `/tmp/sleep48-query-plan.sql`,
`/tmp/sleep48-query-plan.log`, `/tmp/sleep48-query-statistics.log`,
`/tmp/sleep48-production-plan.log`, `/tmp/sleep48-migration-verify.log`.

## Current verification and preserved failures

The expanded final selection passed 45 cases in two files: 33 existing accepted-
response cases, ten new worker/owner cases, and two authority lifecycle cases.
The 1,551 unselected chat cases are not claimed passed. Server typecheck passed.
The worker cases establish startup recovery, selected-history quiet over former
poll periods, real chat-service authority restoration, outer commit/rollback,
first notification during drain, SQL-free drain waiting, resume, saved future
retry, pending/failed status-effect ordering, and an elapsed-deadline race.

The elapsed-deadline test failed before its fix: the worker returned null even
though the locked owner had deferred the response. It now retains the due entry
and the next attempt publishes exactly once. Log:
`/tmp/sleep48-elapsed-deadline-before.log`.

Earlier worker runs exposed the hint serialization defect (nine fixture failures),
then two test-observation mistakes. A timer created before fake-time installation
was not advanced by the fake clock; the test now installs time before registration.
A null next deadline can occur while a sweep is in flight; commit assertions now
wait for the persisted publication, zero tracked activity, and no next deadline
jointly. The original logs remain `/tmp/sleep48-worker-tests.log`,
`/tmp/sleep48-worker-tests-v2.log`, `/tmp/sleep48-drain-isolated.log`, and
`/tmp/sleep48-worker-tests-v3.log`. The corrected initial selection passed eleven
cases in `/tmp/sleep48-worker-tests-v4.log`; the final expanded result is
`/tmp/sleep48-acceptance-v2.log` with server types in
`/tmp/sleep48-acceptance-typecheck-v2.log`.

No slice 48 PR, full workspace acceptance, remote CI/review, or provider sleep
qualification is claimed by these local results. The earlier stack gates and
remaining recurring-server duties are unchanged.

## Producer integration and lifecycle evidence

The existing pending-effect notification boundary is now named
`notifyNativeFinalizationWork` and wakes both consumers. Its existing coordinator
claim/retry, effect settlement, persisted-attention replay, retained-session release,
and recovery callers retain transaction ownership. No new wrappers are threaded
through those callers. Response discovery now accepts exact run and agent scopes.

Both journal writers notify for accepted-result evidence and normalized completed
final assistant messages, after source/deduplication checks and before persistence.
Deltas, tool completions, and analysis messages do not activate response recovery.
The port's late accepted-result journal test and the internal final-message test
exercise these existing writers. Monitor continuation recovery is also exercised
through the worker, without another accepted result or provider execution.

Agent availability was a real missing producer: the recovery owner rejects a
paused agent, but resuming that agent did not invalidate dormant responses. A
real resume regression failed before the fix. Lifecycle now exposes a narrow
`beforeStatusChange` integration callback, invoked inside its existing transaction
before the compatibility status write. The service supplies response policy only
for a transition from non-invokable to invokable, scoped to that agent. Lifecycle
still owns status transitions and the transaction; its existing resource-event
callback retains its semantics. With no response worker registered, this adds only
the existing notification protocol, not an independent worker or provider call.
The complete lifecycle suite exercises existing consumers of the new contract.

Failed-chat retry admission also notifies response recovery when its source action
becomes processed. This can establish the ancestry proof after a very fast child
run has already finished. Five real admission scenarios verify that the response
consumer observes the committed action and the exact issue scope: commit, retry,
startup, stale claim, and rollback. An assignment-reactivation experiment instead
hit the existing prohibition on changing a channel-bound task's agent; that
unsupported fixture was removed without relaxing the guard.

Validation across these runs covers 175 distinct cases: 59 response/authority and
retry-admission cases, 58 lifecycle cases, 21 monitor-continuation cases, and 37
control-plane-port cases. Server typechecking passes. These are selected suites,
not a claim that the entire repository suite or remote PR checks passed.

- `/tmp/sleep48-producers-rerun.log`: port 37/37, continuation 20/20, server types.
- `/tmp/sleep48-producer-acceptance.log`: lifecycle 58/58, expanded continuation
  21/21, response/authority 53 selected, server types.
- `/tmp/sleep48-acceptance-v5.log`: combined response/authority/admission 59 passed;
  1,546 unrelated cases not selected. Types in
  `/tmp/sleep48-acceptance-typecheck-v5.log`.
- Real action-row contention now verifies retry retention through drain, zero
  passive SQL while paused, and eventual single publication after resume.

Failures remain recorded. The first external-port run had 36 passes and one
observer connection using the absent embedded database; the observer now uses the
validated external URL. The resume regression and invalid reassignment experiment
are in `/tmp/sleep48-eligibility-before.log`. A test-only observer initially omitted
its required retry interval and produced finite-deadline warnings; corrected in
`/tmp/sleep48-retry-producer-v2.log`. The combined v4 run exposed a global fault
injection targeting another retained fixture (13 transactions, not one). The v5
run uses an actual lock on the tested response's source instead of assuming global
candidate order; all 59 cases pass with that stronger fault boundary.

## Unpresented-backlog measurement

A disposable clone of the earlier plan fixture has 10,008 structurally eligible,
unpresented candidates. The actual worker loader took 2,980 ms and 101 queries for
global reconstruction; 10,001 candidates in one company took 2,828 ms; the exact
run took 1.73 ms and one query. Agent reconstruction for that company's 10,001
candidates took 2,826 ms. Serialized entries occupy about 2.05 MB. The drain gate
stopped discovery after two pages. Evidence:
`/tmp/sleep48-unpresented-backlog.mts` and `.log`.

This measures discovery, not authorization or publication throughput: the cloned
rows do not establish valid independent publication authority. Each SQL page is
bounded to 100 rows, but total reconstruction memory/time still scales with the
unpresented backlog. Ordinary finalization and journal notifications are run-scoped;
agent resume is agent-scoped; actual authority/configuration changes may reconstruct
a larger scope. Health-only configuration signals do not invalidate this worker.
Do not describe total reconstruction as constant-cost or claim fleet qualification.

Startup/shutdown integration, removal of this duty's periodic call, final producer
coverage review, full PR verification, and publication remain outstanding. The old
backstop is still present. Master was refreshed to `6bdcb70244`; the full stack
still needs reconciliation and its earlier failing/review gates remain open.


## Startup integration, 2026-10-26

The heartbeat facade now registers this worker with the existing task-drain gate.
Enabled maintenance awaits reconstruction during startup. Shutdown and listener
close release its live-authority subscription; coordinator shutdown retains
ownership of cancellation and in-flight work.

The periodic orphan-recovery caller now passes `skipNativeResponsePresentation`.
The reconciler skips its direct repair call and passes the same option into
canonical finalizer replay. The finalizer skips only its already-committed response
repair in that mode. Fresh finalization still delivers immediately. Explicit
recovery and startup recovery keep their default behavior. Governed-review
presentation and other native finalization duties remain separate.

All 66 startup tests pass, including disabled maintenance and close subscription
registration. Two real PostgreSQL regressions verify that both periodic entry
points leave the response unmaterialized, and the worker then creates exactly one
publication from the accepted result. Log: `/tmp/sleep48-wiring-tests.log`.
Workspace typecheck passes (`/tmp/sleep48-full-typecheck.log`). The full local suite
is still running and has reported embedded PostgreSQL initialization failures;
its final result and build status remain pending. No full-suite or remote check
acceptance is claimed at this checkpoint.


## Review repair and current verification, 2026-10-26

Published draft #17696 at `79bf36cbf8`. Greptile found a real precision gap:
`writeRunStatus` still sent a company-only milestone hint. Every unrelated run
status could reconstruct dormant response history. Three real-PostgreSQL cases
(native binding, legacy context binding, and taskless run) failed before repair
(`/tmp/sleep48-scope-before.log`).

The milestone contract now accepts an optional run identity. Status producers
supply the task when bound and the exact run otherwise. The response fanout
prefers task scope over run scope, because lineage changes can authorize other
runs on that task. Known run claim/release and completion producers also preserve
an exact-run fallback. Existing company configuration invalidations remain broad.
No new durable rows or caller recovery wrappers are introduced.

All 34 heartbeat lifecycle tests pass after repair. Two real worker regressions
retain a dormant eligible response, send unrelated task/run wakes, and observe
one actual candidate SQL query at the postgres.js debug boundary, without
rechecking the dormant row. The outer-commit/rollback cases additionally send a
different run identity within the same task and retain task-level recovery.
An initial test mistakenly counted Drizzle subquery builder construction as a
second SQL statement; driver-level observation corrected the measurement.

The response/authority/admission selection now passes all 63 cases
(`/tmp/sleep48-scope-acceptance.log`). Server typechecking and the workspace build
pass (`/tmp/sleep48-scope-typecheck-v3.log`, `/tmp/sleep48-scope-build.log`).
The previous full workspace typecheck passed at `79bf36cbf8`. The full local
Vitest run was explicitly stopped after repeated embedded PostgreSQL bootstrap
failures; `/tmp/sleep48-full-tests.log` preserves those failures. It is not a
full-suite pass. Focused database acceptance uses the validated external
PostgreSQL path and isolated disposable test databases.

Remote CI at `79bf36cbf8` also exposed a late-journal test that assumed worker
startup drains all candidates in one batch. It now waits for actual settlement,
as the shared worker deliberately processes fair batches. The workspaces-b job
hit a five-second sandbox staging test timeout; E2E shard five received a runner
shutdown signal. These failures remain recorded in `/tmp/sleep48-ci-chat3.log`,
`/tmp/sleep48-ci-workspaces-b.log`, and `/tmp/sleep48-ci-e2e5.log`. Fresh-head CI and
review are required after the repair; no failing gate is waived.


## Full-history test repair, 2026-10-26

At `c4beddad1e`, fresh Greptile review is 5/5 and the scope thread is resolved.
Remote CI passed 51 contexts but failed the chat shard and its aggregate gate:
a second startup assertion assumed `worker.ready` drained every fair batch.
The full local chat file finished with 1,595 passing and seven failing tests
(`/tmp/sleep48-chat-full.log`); all seven were in the newly added worker tests.

The larger run exposed two related observation errors: startup can have another
batch scheduled, and `nextWakeAt() === null` can be transient while a batch runs.
The latter caused query instrumentation to count unfinished startup checks and
an outcome assertion to run before its response had been materialized. An early
future-deadline test failure then left its fixture's real deadline for later tests.

Worker startup/settlement assertions now require both zero active work and the
expected next deadline. This changes test observation, not scheduler behavior or
batch limits. All 18 affected cases pass against the retained history database
from the full 1,602-case run (`/tmp/sleep48-settlement-history.log`), including
single-query unrelated wakes, future deadlines, and coordinator retry release.
The full-run failure remains recorded; fresh remote CI is still required.


## Current migration 0412 integration and complete acceptance

The original response-presentation patch is integrated with the validated current
native-effect parent. The complete owned runtime/schema changes are preserved,
including fourteen files with combined upstream edits and 10,401 unchanged
unrelated upstream source files. The control-plane fixture conflict retains its
dedicated external database path and the current recovery-helper fallback; all
upstream conformance cases and owned assertions remain. Both audit histories
are retained.

Only this slice's unlanded migration artifacts were deferred before integration.
`pnpm db:generate` generated `0412_tearful_squadron_supreme.sql`. The generated
index definition was checked against the original index before restoring all
three original statements byte for byte: concurrent idempotent index creation,
selection statistics, and ANALYZE. No original tuning statement is dropped. All
prior executable SQL, journal entries and retained snapshot bytes are unchanged.
Five snapshots 0408 through 0412 remain; the concurrent allowlist includes 0412.

Source `9feec170ef8174011fc3c5d3d6d76f0a0f39fea0` passes **4171 distinct cases
in 29 complete files**, without skips: 2313 owner/producer/consumer cases in
221.96 seconds, 59 safe-replacement cases in 29.10 seconds, and all 1799
assembled chat integration cases in 769.87 seconds. This includes the complete
GitHub workflow, accepted-response worker lifecycle, authenticated late evidence,
outer commit/rollback, contention, authority registration, agent resume, startup,
retry, drain/resume, and unrelated retained-history isolation. Per-file counts:

| Complete file | Passing cases |
| --- | ---: |
| src/__tests__/chat-channels.integration.test.ts | 1799 |
| src/__tests__/committed-chat-response-authority.test.ts | 7 |
| src/__tests__/issue-recovery-actions.test.ts | 89 |
| src/__tests__/native-finalization-recovery.test.ts | 32 |
| src/__tests__/native-interaction-bridge.test.ts | 7 |
| src/__tests__/native-status-arbiter-corpus.test.ts | 94 |
| src/__tests__/native-workspace-sync.test.ts | 10 |
| src/__tests__/recovery-stale-issue-lock-sweep.test.ts | 40 |
| src/__tests__/server-startup-feedback-export.test.ts | 69 |
| src/__tests__/slack-conversation-lifecycle.test.ts | 41 |
| src/modules/run-dispatch/adapters/postgres.test.ts | 69 |
| src/modules/wake-queue/adapters/postgres.test.ts | 93 |
| src/modules/wake-queue/adapters/queued-comment-postgres.test.ts | 5 |
| src/services/chat-monitor-continuation.test.ts | 21 |
| src/services/execution-control-reconciliation.test.ts | 10 |
| src/services/explicit-native-continuation.test.ts | 335 |
| src/services/heartbeat/queue.test.ts | 32 |
| src/services/heartbeat/recovery.test.ts | 45 |
| src/services/heartbeat/run-control.test.ts | 51 |
| src/services/heartbeat/run-lifecycle.test.ts | 34 |
| src/services/heartbeat/upgrade-readiness.test.ts | 7 |
| src/services/legacy-execution-recovery.test.ts | 15 |
| src/services/native-runtime/native-restart-recovery.test.ts | 25 |
| src/services/native-runtime/native-run-finalizer-telemetry.test.ts | 29 |
| src/services/native-runtime/native-safe-replacement.test.ts | 59 |
| src/services/native-runtime/native-session-executor.test.ts | 968 |
| src/services/native-runtime/native-workspace-export-retry.test.ts | 80 |
| src/services/native-runtime/native-workspace-reconstruction.test.ts | 50 |
| src/services/native-runtime/paperclip-control-plane-port.test.ts | 55 |

The complete 94-case status-authority corpus also passes again on the same
database in 16.68 seconds. It is not double-counted. Three retained PSC/OUT and
sentinel company rows remain unchanged, and each invocation uses distinct
UUID-derived fixture prefixes. Twenty-four separate fresh PostgreSQL 17
databases migrate through 0412 before setup. Four embedded-only fixture imports
temporarily use their own external database on this IPC-exhausted host, then
restore byte for byte. All assertions and timing limits remain unchanged. This
is qualified external-database acceptance, not an unmodified embedded CI run.

Actual database build, server types/build, module boundaries and exact-head
migration order pass. A populated 0411-to0412 upgrade preserves all 410 prior
migration receipts and all 38 companies, appends exactly one receipt, and adds
none on replay. The partial index is valid and ready on both fresh and upgraded
databases; the existing selection statistic is present. Earlier failed runs
above retain their historical scopes and explanations. The current complete
chat run passes, rather than substituting a focused retry for the full suite.

Normal merge `1c019b48c98cd8273aa3b7e3cf95433a369b9531` adopts published native-effect
parent `5bb5ddacd3d1e6817de4825b283c6e92f85bd124` and actual unsafe-export ancestry.
All complete server, package, UI and test trees remain identical to the accepted
source. Publication remains held until #17690 lands and its actual squash
ancestry is reconciled. Fresh published-head CI and exact-head Greptile 5/5
remain required. These checks do not establish deployed suspension, external
Cloud alarm delivery or fleet savings.


## Actual native-effect prerequisite ancestry

Native-effect prerequisite #17690 merged as
`a8a038e659c50c1c5e3ce532d13072a29a5cf951`, reviewed at
`5bb5ddacd3d1e6817de4825b283c6e92f85bd124`. Its entire squash tree equals
the reviewed parent already adopted by this child. The normal ancestry merge
automatically restored the removed pending-effect notification module. The
whole-tree identity check rejected that composition; its deletion was restored
before publication. All accepted source, including the complete 0412 database
tree and all 29 test files, remains byte-identical. The following edit records
the ancestry proof. The 4171-case acceptance keeps its original source scope;
fresh published-head CI and exact-head Greptile 5/5 are required.


## 2026-10-29 review repair: routine hints cannot invalidate a company

Superagent review of `a5648c92f4601fb72cec26b9ff2e99e40d502042` identified a
real P2: coalesced inbound messages used a company-only milestone hint, and
the new response fanout reconstructed every unpresented response in that
company. Pending-effect settlement also used a company-only finalization hint.
The current-head scan required action, so the branch was not merged. Greptile
rated that head 5/5 but conditioned readiness on the later #17702 scoped
pending-effect fix. That fix is included here; this slice no longer requires
its later dependent PR to be independently correct.

The repair keeps routine milestones and finalization hints from entering the
response queue without an issue or run. Real coalescing names its already-known
active run. Pending-effect settlement names the affected issue, covering older
decisions on that issue. Retry promotion/cancellation retain their known run
when older context omits an issue. Existing pending-effect and chat consumers
keep their previous serialized hints; only response reconstruction is narrowed.

Genuine company-wide authority changes remain supported through one explicit
`notifyChatCompanyAuthorityChange` boundary. Sixteen existing mutation hooks in
nine owning files use it: membership and board-claim restoration, Cloud actor
membership repair, GitHub/Slack identity and sponsor changes, endpoint policy,
resource enablement and connection configuration. They keep their original
change predicates and transaction owners. Two issue-scoped resource/publication
hooks remain issue-scoped. No transaction wrappers, queue tables, polling or
new persisted bookkeeping are introduced. Dynamic milestone producers carry
issue-bound interaction rows or typed recovery inputs.

The ordinary coalescing regression first fails on the actual PostgreSQL writer:
its settled hint has only the company instead of the active run. Two receiver
regressions each issue three routine company hints against dormant response
history and observe **12 response-history SELECTs**. Both must observe zero.
A positive test restores suspended membership through the actual access owner
and delivers the waiting response once; it passes before and after the repair.
The unchanged four focused assertions pass after the fix. Assertion time limits
are unchanged. These tests measure real driver SQL and persisted producer work.

Repair source `2fc8b0614aaf9ac7337045de4ced7325f95edc45` passes **1821 distinct
server cases**: 1496 in 13 complete suites in 110.63 seconds, and 325 selected
chat cases in 278.99 seconds. The chat selection includes the complete GitHub
workflow, accepted-response lifecycle, the new regressions, and real post-close
authority restoration. Another 1477 chat cases are outside the name pattern;
the complete 1802-case file is not claimed for this repair run. Counts:

| File | Passing cases |
| --- | ---: |
| src/__tests__/access-service.test.ts | 18 |
| src/__tests__/auth-session-route.test.ts | 12 |
| src/__tests__/board-claim.test.ts | 3 |
| src/__tests__/chat-channels.integration.test.ts (focused) | 325 |
| src/__tests__/committed-chat-response-authority.test.ts | 7 |
| src/__tests__/native-finalization-recovery.test.ts | 32 |
| src/__tests__/native-status-arbiter-corpus.test.ts | 94 |
| src/__tests__/server-startup-feedback-export.test.ts | 69 |
| src/modules/run-dispatch/adapters/postgres.test.ts | 69 |
| src/modules/wake-queue/adapters/postgres.test.ts | 94 |
| src/modules/wake-queue/application/use-cases.test.ts | 67 |
| src/services/heartbeat/run-lifecycle.test.ts | 34 |
| src/services/native-runtime/native-run-finalizer-telemetry.test.ts | 29 |
| src/services/native-runtime/native-session-executor.test.ts | 968 |

Eleven dedicated fresh PostgreSQL 17 databases migrate through unchanged 0412.
The wake-queue fixture's embedded-only import temporarily uses its own external
database and restores byte for byte. All 14 selected source files match their
pre-run hashes. Actual database build, server types/build, module boundaries
and full-SHA migration order pass. The earlier 4171-case full baseline keeps
its original pre-repair source scope; it is not represented as this repair run.

Master independently advanced to `522c653d562a41ecad64561d35457cb99ecf6cd6`
with #18126's Pi archive-download retry fix. Normal merge
`2a535bc61259ef99387369e8b32498f774e5ba2c` preserves both complete binary patches.
All accepted server, database, UI, test and CLI trees remain identical; only
the three independently changed runner installer/manifest files are added.
All 13 installer tests pass in 200.18 milliseconds, including stalled-header
and stalled-body cancellation. Combined server types/build, boundaries and
migration order pass. No unrelated upstream source is discarded.

Explicit global authority invalidation and startup still reconstruct their
company's owed candidates with existing 100-row discovery pages and fair
execution batches. Discovery retains linear time and memory; it is not a
constant-cost global operation. The prior 10,001-candidate profile remains
relevant to those genuine global obligations. This repair removes ordinary
inbound traffic's ability to request that global reconstruction and prevents
unscoped routine traffic from rebuilding dormant response history. It does not waive an actual review
failure or establish deployed sleep, Cloud wake delivery or fleet savings.
Fresh published-head CI, Greptile 5/5 and a clean security scan remain required.


A second publication guard detected master #18128 at
`e8b78cce5bb557b086bee9ca930eeaab1d09b244`. Normal merge
`06d55ca9f872f7e7794680335811b496942be034` retains its three test-only file changes.
Both complete owned and upstream binary patches are preserved. An isolated Git
index projects only the owned audit onto the original repair source to prove
this equality; it does not rewrite branch history or include master changes
as owned edits. All 14 repair test hashes and the entire package tree remain
unchanged. The changed HTTPS backfill case passes on a fresh 0412 PostgreSQL
fixture in 7.62 seconds; 178 other workspace cases are outside that focused
selection. Its embedded-only fixture import restores byte for byte. Combined
server types/build, boundaries and migration order pass again. The independent
browser fixture changes are preserved exactly; no local browser run is claimed.

### Recorded presentation and structural eligibility repair

The exact published head `ae75e21bd5aa5841b66f0d3f421181cdcfa9a3be`
received Greptile 5/5, a clean security scan, and passing CI. Its completed
Ponytail 4/5 verdict nevertheless required two correctness fixes. That actual
failing verdict was honored; no review timeout or numeric score waived it.
The review also found a missing fresh-commit skip guard, which is repaired here.

A recorded non-create presentation decision (`none`, `reuse`, or another explicit
non-create value) now excludes both discovery and locked recovery. A string
selected comment ID still fences recovery, including deleted comments. The
`skipIssueComment` policy applies to all recovery branches. Missing legacy
presentation metadata and explicit `create` with a null comment ID remain owed
work and can recover once. No per-worker table or transaction wrapper is added.

Discovery joins the owning company/issue and applies the cheap durable guards
before taking recovery locks: done results belong to succeeded non-conversation
runs; response waits have empty attention requests and usable summary/key;
monitor and same-agent continuations require succeeded runs and their accepted
reason codes. Digest integrity, current publication authority, provider-owned
interactions, final-message selection and other owner checks remain under the
existing transaction. These predicates narrow structural candidates; they do not
claim to establish authorization or replace late-evidence and authority-change
notifications. Fresh finalization now honors `skipNativeResponsePresentation`
as the already-committed path does.

The final corrected regression source is unchanged between the red and green
runs. The published baseline fails eight behavioral assertions and passes the
three positive genuine-answer cases. Repair source
`892f36e5f66ba1af123034936a7160c64c3ab883` passes all eleven. Recorded none/reuse
produce no new comments or publications and keep their decision. Five families
of structurally ineligible retained rows produce zero issue/run/finalization
`FOR UPDATE` queries across three issue-scoped notifications each. Those selector
fixtures deliberately vary durable payload fields; integrity and authorization
remain separate recovery requirements. Genuine missing, legacy and create-null
presentations still publish once. A genuinely uncommitted accepted run proves
that periodic finalization leaves presentation to the worker.

Earlier material failures remain in the verification record: an incomplete
conversation identity fixture, a duplicate variable declaration, a remaining
stale variable reference and its downstream retry contamination, a test that
accidentally used the matching continuation reason, and a missing fixture import.
The fixture was corrected to exercise the actual incompatible reason; assertions
and time limits were not weakened. The final red comparison restores the exact
published production files temporarily and verifies byte-exact restoration of
the repair afterward. These were explained local setup/implementation failures,
not inferred infrastructure faults.

Repair source passes **1489 distinct cases**: 1139 across six complete consumer
suites in 81.02 seconds, plus 350 selected chat integration cases in 297.68s.
The remaining 1463 chat cases are outside the name pattern; the full 1813-case
file is not claimed for this repair. The eleven new regressions are included
in the selected count, not added again. The six complete files cover 968 native
session cases, 79 response-summary cases, 21 monitor-continuation cases, 29 native
finalizer cases, 32 finalization-recovery cases and 10 workspace-sync cases.

No executable migration, schema, prior history, index/statistics statement or
snapshot changes in this repair. Five fresh PostgreSQL 17 fixtures migrate
through 0412; no embedded fixture adaptation is needed for these suites. All
selected test hashes match the captured source. Database build, server
types/build, module boundaries and full-SHA migration ordering pass. Actual host
sleep, external wake and fleet cost savings remain unqualified. A newly published
head still requires fresh exact-head Greptile 5/5, passing CI and no actionable
review findings before merge.
