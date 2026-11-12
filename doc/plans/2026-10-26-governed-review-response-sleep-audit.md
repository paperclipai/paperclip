# Governed-review response recovery: sleep migration audit

Status: raw owner contract and initial worker verified; producer wiring and periodic removal remain incomplete.
Inspected parent: `fad35f2d7a` (slice 48, draft PR #17696).

## One reason for work

A native run can commit a successful response while the task remains in review
under an earlier server-created completion-review gate. Its saved response and
selected files still need one authorized comment/publication. Current periodic
native finalization reconciliation repairs that presentation even when no source
changes. This slice owns only that owed presentation, not review resolution,
status reassessment, provider execution, or pending status-effect delivery.

The durable sources already exist: native_run_finalizations, native_run_results,
work_assessments, status_decisions, heartbeat_runs, and the original
issue_thread_interactions review gate. No new queue table is needed.

## Existing owner and contracts

- `native-chat-review-presentation.ts` owns proof preparation, restoration,
  current authorization, contention handling, and the materialized receipt.
- `native-run-finalizer.ts` owns `materializeCommittedReviewResponse` and
  `repairCommittedNativeReviewResponse`. The former currently catches operational
  failures and returns no outcome. A scheduled consumer needs a narrow raw
  outcome/error contract; retain current behavior for existing foreground callers.
- `issues.ts` addComment owns the issue transaction, nonblocking reauthorization,
  selected-file attachment, comment deduplication, and publication intent.
  Recovery must continue through it, never insert a parallel comment/outbox path.
- `native-finalization-reconciler.ts` repairs governed presentation before the
  superseded-status early return. A later task decision must not erase an older,
  still-authorized response. The already-committed branch of `finalizeNativeRun`
  also restores/materializes it; periodic migration must address both entrances.
- Fresh finalization still presents immediately. Explicit/startup recovery retains
  its behavior unless the scheduler owns that call explicitly.

Receipt semantics: `hasMaterializedNativeReviewResponse` recognizes an agent
comment for the exact company/task/run with the presentation authorization reason
and matching current decision proof. Soft-deleted comments remain receipts.
Restoration already avoids rewriting identical metadata or signaling another
wake. Preserve those properties.

## Current authority that must remain in the owner

Authorization checks committed coordinator/result/assessment/decision bindings;
applied governed_response_waiting decision; successful run without held native
ownership; in_review task assigned to the same agent; unchanged response context;
agent not paused/terminated/pending approval; and current external destination
and principal authority. Runtime health status error alone does not revoke an
already completed response.

The proof requires an accepted yielded response_wake result and matching server
assessment, successful terminal evidence, no attention requests, and a nonempty
summary/idempotency key. Its prior pending review gate must be server-created,
older than this run, from another source run, correctly bound to the native
completion-review revision and delivered bind_reviewer effect. The hashes bind
semantic result, gate policy, context, and summary. Competing pending interactions,
pending/revision_requested linked approvals, or a run-owned provider prompt can
prevent presentation. These checks are publication authority, not scheduler policy.

## Planned worker boundary

Use the existing scoped deadline helper and delivery coordinator. Discover only
structurally eligible committed governed responses without a materialized receipt;
revalidate exact durable state and current authorization through the owner before
presentation. Failed I/O/contention retains retry ownership. Settled or currently
unauthorized rows become dormant until a relevant source change. Preserve saved
coordinator retry deadlines, active claims, drain/resume, and shutdown.

Before implementation, establish the scheduled owner guard under its existing
lock: a previously discovered row must not bypass a newly acquired finalization
claim or a moved-later retry deadline. Keep issue/coordinator/run lock ordering
compatible with addComment's nonblocking recheck. Do not conflate authorization
denial with operational errors. Preserve deleted receipts and idempotent replay.

Measure discovery with selected history and a large unpresented backlog. Slice
48 showed why per-page limits do not make a company-wide reconstruction cheap.
Normal run writes must retain task/run scope; broad reloads are reserved for
changes whose authority can actually affect the broader scope.

## Producer audit still required before retiring the backstop

Already identified reusable boundaries:

- Finalization/result/decision/effect settlement: native-finalization-notifications
  and the existing milestone boundary. Existing review proof restoration signals
  only a real metadata change.
- Run status, ownership release, task status/assignment, conversation lineage,
  endpoint/principal configuration, publication outcomes, and agent resume:
  inspect existing milestone/finalization producers and extend one owning boundary
  per dependency. Do not scatter caller recovery wrappers.
- Publication changes already use notifyChatPublicationWork with task scope only
  when prompt authority or delivery outcome changes; transport lease bookkeeping
  intentionally does not invalidate presentation.

Concrete gaps found in this audit:

- `writeApprovalChange` currently signals approval retention and queue seeding,
  not governed-response recovery. Resolving or unlinking a competing linked
  approval can make an existing proof eligible. Audit approve/reject/revise,
  resubmit, link/unlink, bulk linking, retention, and alternative writers. Prefer
  an approval identity/task scope over company-wide reconstruction.
- The proof rejects *any* competing pending interaction, while current milestone
  notifications often apply only to questions and confirmations. Resolving a
  connection intent or another kind may restore eligibility. Inventory common
  interaction mutation owners and direct cleanup/recovery writers before choosing
  a notification hook; do not assume confirmation coverage is sufficient.
- Run-owned prompt publication states can retain or release the response slot.
  Confirm every relevant publication transition reaches the existing task-scoped
  publication boundary.

This is not a completed producer audit. Other supported writers and late authority
restoration must be traced before removing periodic governed-review repair.

## Acceptance requirements

Reuse the genuine native review fixture in chat-channels.integration.test.ts,
which creates the server review through native finalization and records selected
files. Establish a baseline before editing the owner. Cover:

- Startup reconstructs a missing response and creates one comment/publication with
  the selected files; duplicate/concurrent recovery is idempotent.
- Existing and soft-deleted receipts produce no recurring SQL; unchanged proof
  restoration does not repeatedly rewrite or wake itself.
- Task-wide lineage, late producer commits, and outer transaction rollback/commit
  retain their existing authority boundaries.
- Actual approval resolution/unlink and competing-interaction settlement reactivate
  dormant work without restart. Unrelated run/task mutations do not reload it.
- Agent/principal/endpoint revocation or changed gate blocks publication; supported
  restoration reactivates it. Transport reauthorization still blocks stale files.
- Saved future deadlines, moved deadlines, claims, real lock contention, operational
  retry, first wake during drain, failure before drain, resume, and shutdown retain
  concrete recovery obligations without passive SQL.
- Both periodic entrances defer only this duty; fresh finalization and other
  recovery reasons retain their behavior.

No deployment, database suspension, Cloud alarm coverage, or cost-savings claim
follows from this migration. The full original stack remains in scope.

## Owner-contract checkpoint

The scheduled entry point holds the issue transaction, checks the coordinator
claim and actual retry deadline under lock, restores the proof through its owner,
and publishes through addComment in that same transaction. Operational errors
propagate to the worker; existing foreground callers retain their logging contract.
The scoped worker reconstructs existing coordinators and excludes materialized
receipts, including deleted comments. No startup registration or periodic removal
has happened yet.

The unchanged owner baseline passed 156 cases. The first expanded run passed
164 of 165; the new principal-revocation fixture incorrectly wrote a nonexistent
principal status field, also caught by typechecking. Using the existing company
membership suspension path repaired the fixture. The complete expanded suite now
passes all 165 cases and server typecheck passes. Evidence:
`/tmp/sleep49-baseline.log`, `/tmp/sleep49-contract-tests.log`,
`/tmp/sleep49-contract-tests-v2.log`, `/tmp/sleep49-contract-typecheck-v3.log`,
and `/tmp/sleep49-contract-v2.status`. The cases exercise concurrency, late claim/
deadline races, real authorization-lock contention and rollback, revoked authority,
startup reconstruction, deleted receipts, and actual quiet SQL after settlement.

The producer audit, query-cost measurements, startup/periodic wiring, remaining
lifecycle acceptance, full verification and remote gates are still outstanding.

## Approval producer checkpoint

Approval resolution, cancellation, revision/resubmission, link/unlink and bulk
link now pass their existing approval/task identity through writeApprovalChange.
The notification owner finds linked tasks before the mutation and registers only
those task scopes. Budget resolution supplies its approval identity inside the
existing accounting transaction. Creation without a task link and company-wide
retention notifications retain their previous behavior and do not reload response
history. No additional transaction wrapper or approval execution policy was added.
All production approval updates/deletes were inventoried; company deletion leaves
no surviving response obligation. Tool-gateway's separate link insertion still
needs its explicit task scope during the remaining producer pass.

Four real-producer regressions (approve, reject, cancel, unlink) failed before
wiring and passed afterward. Two further cases exercise nested cancel/unlink
with outer rollback/commit and measure no governed-response candidate SQL for an
unrelated approval. All 171 owner cases pass. In the combined run two older
approval unit cases failed because their ordered stub consumed an approval row
for the new issue_approvals read. The stub now distinguishes that table and returns
no links. Existing consumers pass 19 approval service/route cases, five budget
cases, 25 queue-seeding cases, and 21 retention cases. Server typecheck passes.
Logs: /tmp/sleep49-approval-before.log, /tmp/sleep49-approval-after.log,
/tmp/sleep49-approval-full.log, /tmp/sleep49-approval-unit.log,
/tmp/sleep49-budgets.log, /tmp/sleep49-approval-queue.log,
/tmp/sleep49-approval-retention.log, /tmp/sleep49-approval-final-types.log.

Remaining interaction gaps include connection-intent resolution/expiry, generic
interaction administrative settlement, satisfied-connection cleanup, and OAuth
confirmation callbacks/denials. Some existing milestone hooks cover only question
and confirmation kinds. Payload-only updates that leave a competing card pending
do not reactivate a response. Task ownership changes already carry task invalidation,
but direct cleanup writers must be individually accounted for. The polling backstop
is retained until this audit and the remaining acceptance requirements are complete.

## Lifecycle and finalization notification checkpoint

A real agent-resume regression failed before wiring and passes afterward. The
existing lifecycle pre-status-write hook now signals this worker when an agent
becomes invokable. Existing task/run milestones and finalization writes also
fan out to the new topic. The finalization scope accepts an optional issueId so
issue-wide pending-effect settlement can target its affected task instead of
reloading all governed responses in the company. Existing pending-effect delivery
retains its previous topic semantics. The tool gateway's separate approval link
insertion now supplies its known issue identity.

All 172 owner cases pass, plus 58 agent lifecycle, 72 milestone and 32 native
finalization consumer cases. Server typecheck passes. Evidence is in
/tmp/sleep49-agent-before.log (reproduced failure),
/tmp/sleep49-lifecycle-full.log, /tmp/sleep49-lifecycle-types.log,
/tmp/sleep49-agent-consumers.log, /tmp/sleep49-milestone-consumers.log,
/tmp/sleep49-finalization-consumers.log and their status files.

Further producer audit findings, not completed migration claims:

- Main interaction service: suggest-task accept/reject, item-verdict completion,
  connection-intent resolve, administrative cancel/withdraw/skip and comment
  supersession can release a competing pending interaction. Several existing
  milestone hooks cover only ask_user_questions/request_confirmation. Checkbox
  confirmation resolution and other kinds need their own governed-response wake
  without unnecessarily broadening unrelated workers. Some item-verdict comment
  expiry writes do not currently own a transaction.
- Direct interaction writers: satisfied-connection cleanup and OAuth confirmation
  acceptance/denial need coverage. OAuth connection-intent retry-phase changes
  leave the interaction pending and cannot by themselves restore presentation.
  Dismissal also leaves status pending; confirm the owning predicate before
  introducing a wake for it.
- Existing agent-conversation reset, tool-action review, obsolete policy review,
  automatic completion review and native decision commits already emit task
  milestones/finalization signals. Verify every alternate branch before marking
  those writer groups covered.
- Issue service currently signals response availability on task status/assignment
  changes, but that boundary only targets GitHub response queues. Governed-response
  task status/assignment/execution-state restoration still needs explicit coverage.
- Coordinator claim/retry notifications now reach the worker, but add a real-store
  release test; synthetic late claim/deadline owner tests alone do not prove that
  producer path. Current authority registration and all publication transitions
  also remain part of the producer audit.

The worker remains unregistered and periodic repair is unchanged. These commits
are checkpoints, not PR readiness or whole-instance sleep acceptance.

## Interaction and task-authority checkpoint

Five real interaction producer cases failed before wiring: skip, withdrawal,
rejecting suggestions, completing item verdicts and declining a connection intent.
They now pass through task-scoped notifications before the existing transaction's
write. Checkbox and administrative settlement use the same narrow topic when
the existing question/confirmation milestone fanout does not apply. Comment
supersession of item verdicts now owns its notification and row mutation together;
connection-intent ownership expiry receives its caller's issue transaction.

Task status restoration and OAuth denial also reproduced missed wakes. Task-scoped
response-availability changes now reach governed-response recovery. Direct and
Cloud OAuth confirmation acceptance and automatic satisfied-connection retirement
notify the affected task before their writes. OAuth terminal denial owns the
signal and card mutation in one transaction; connection-intent retry phase changes
remain pending and do not wake this worker. Existing policy remains authoritative:
the attempted task-assignment restoration was rejected because externally bound
tasks cannot be reassigned through issueService. Its test now verifies that
restriction rather than bypassing it. Endpoint/identity configuration already
uses the company milestone boundary for supported authority restoration.

Current evidence: all 180 owner cases pass, including OAuth outer rollback/commit,
plus 106 interaction service, nine telemetry, 50 satisfied-connection, and 84
generic MCP/OAuth cases. Server typecheck passes. The first interaction consumer
run skipped the nine telemetry cases because embedded PostgreSQL was unavailable;
they now run through the standard validated external-database test option and pass.
The satisfied-connection suite initially passed 49/50: its one-connection-pool
fixture still used temp.connectionString after enabling external DB mode. That
fixture now uses the selected URL and all 50 pass. The first OAuth typecheck caught
nullable interactionId captured by a transaction callback; binding the checked ID
locally repaired it without changing policy. Preserved evidence:
/tmp/sleep49-interactions-before.log, /tmp/sleep49-interactions-after.log,
/tmp/sleep49-interactions-consumers.log, /tmp/sleep49-authority-before.log,
/tmp/sleep49-authority-after.log, /tmp/sleep49-authority-types.log,
/tmp/sleep49-telemetry-consumers.log, /tmp/sleep49-satisfied-consumers.log,
/tmp/sleep49-satisfied-consumers-v2.log, /tmp/sleep49-oauth.log,
/tmp/sleep49-authority-final.log and /tmp/sleep49-authority-final-types.log.

Further audit: change-consent consumes already accepted metadata and cannot clear
a competing pending card. Confirmation-from-comment delegates resolution to the
covered interaction service. Native interaction audit records change summaries
only. Superseded native review retirement commits with a task-scoped native status
decision. Tool-review projection and secret-proposal settlement already signal
task milestones. Board claim and trusted-header membership restoration also
signal existing company milestones; compatibility membership backfill is agent
only. No new global live-authority registration dependency was found in governed
review authorization, which reads its durable binding/principal/destination proof.

Still inspect execution-state-only transitions (pending policy state can block a
response without changing task status), prove real coordinator lease/retry release,
and finish candidate query-cost/lifecycle/wiring acceptance. The worker remains
unregistered and both periodic entrances remain intact.


## Policy release and discovery-cost checkpoint

A pending execution policy can block presentation without changing task status.
The regression failed before the issue mutation boundary signaled pending-to-clear
transitions. All 182 owner cases now pass, including a real coordinator claim and
retry release; server types pass. Evidence: /tmp/sleep49-policy-before.log,
/tmp/sleep49-policy-after.log and /tmp/sleep49-policy-types.log.

Discovery was measured against 10,000 cloned, already-presented governed response
rows plus retained test history. The clones preserve relational selection shape;
they are not valid authorization proofs and are never used to test publication.
Initial startup/company reconstruction took about 3,000 ms: receipt lookup scanned
roughly 4,795 unrelated comments per candidate. A company-first receipt index and
expression statistics did not reliably fix startup's plan. A run-first partial
receipt index alone reduced measured startup to 45 ms, company/task discovery to
33–35 ms and exact-run discovery to 1.5 ms. No expression statistics are retained.
The generated migration builds that index concurrently and preserves deleted
comments as receipts. These are local query measurements, not host sleep evidence.
Logs: /tmp/sleep49-query-plan.log, /tmp/sleep49-query-index-plan.log,
/tmp/sleep49-query-stats-plan.log, /tmp/sleep49-query-run-index-plan.log,
/tmp/sleep49-query-run-only-plan.log. The first root-level tsx invocation failed
because tsx is a server-package dependency; the corrected command uses its owner.

Full outstanding-backlog cost, lifecycle coverage, startup registration and both
periodic entrance removals remain required before PR acceptance.


## Startup integration and lifecycle acceptance

The worker now registers with enabled heartbeat maintenance and uses its existing
instance/task-drain gates. The shared coordinator owns notification teardown and
shutdown. Both periodic repair entrances defer to this worker: direct reconciler
repair and already-committed finalizer replay. Fresh finalization and explicit
recovery keep their behavior. Three regression cases failed before this wiring
(two periodic entrances and enabled startup registration); all now pass.

The combined owner/startup selection passes all 255 cases. Actual SQL capture
shows no passive SQL during idle drain or after shutdown. Real approval cancellation
reactivates dormant work through drain; endpoint-lock contention retains a retry
that succeeds after resume; a real coordinator retry survives shutdown and is
reconstructed without early publication. One initial drain test mixed a real timer
with a subsequently installed fake clock. Installing the clock before coordinator
creation repaired the fixture; all three new lifecycle cases then passed.
Evidence: /tmp/sleep49-drain.log, /tmp/sleep49-drain-v2.log,
/tmp/sleep49-wiring-before.log, /tmp/sleep49-wiring-after.log.

Workspace typecheck and build pass. Migration generation and safety checks pass.
The first migration application exposed the missing top-level migration allowlist
entry; after registration, fresh application, invalid concurrent-index repair,
concurrent migrator replay and no-op replay all pass. Evidence:
/tmp/sleep49-migration-apply.log, /tmp/sleep49-migration-apply-v2.log,
/tmp/sleep49-migration-replay.log, /tmp/sleep49-workspace-types.log,
/tmp/sleep49-build.log. The five newest schema snapshots are retained.

The synthetic 10,000-item unpresented cohort requires 101 candidate queries,
about 2.25 seconds and 2.05 MB of serialized entries. Discovery checks admission
and cancellation between pages: the drain experiment stops after two queries;
an already aborted signal executes none. This remains proportional startup or
legitimate broad-authority reconstruction, not a bounded total-memory claim.
Normal writes retain task/run/agent scope. Synthetic proof copies establish
selection cost only; genuine owner fixtures establish publication authority.
Evidence: /tmp/sleep49-backlog.log.

Full local tests are running. Remote CI/review, earlier stack findings and master
reconciliation remain open. No merge or whole-instance sleep is claimed.

## Concurrent approval links and resolution

Review finding `PRRT_kwDORclPyM6wgKOl` identified a missed-wake race in the
approval producer. Resolution could discover no links, a concurrent link could
commit and wake recovery while the approval was still pending, and resolution
could then commit without any task-scoped notification. Parking pending responses
without polling makes that ordering observable as an indefinitely missing reply.

The existing approval notification owner now locks the company-scoped approval
row `FOR UPDATE` before discovering linked tasks. Existing `issue_approvals`
foreign-key checks hold `KEY SHARE` on that same row until their outer transaction
settles. If linking wins, resolution waits and then discovers the committed link.
If resolution wins, linking waits and its own task wake observes the committed
decision. Both cases use the existing transaction signal and durable records.
There is no new table, timer, wrapper at each caller, or company-wide discovery.
This adds one primary-key lookup/row lock to approval-identity mutations; task-only
link notifications and unlinked approval creation keep their existing cost.

The writer audit covers single/bulk issue linking and the gateway's separate
formal-approval link insertion, all using the existing immediate foreign key.
Approval decisions, cancellation, revision/resubmission, and budget resolution
already supply the approval identity through this owner. Hire decisions retain
company-before-approval ordering; budget decisions retain their accounting
transaction. Unlink carries the removed task identity explicitly. The lock stays
owned by the outer transaction, and errors retain rollback/normal error handling.
This contract uses the application's read-committed write transactions and
integrated writer notifications; independent SQL writers remain unsupported.
Changing or deferring the link foreign key requires revisiting this contract.

Four real PostgreSQL regressions force both transaction orderings for single and
bulk link APIs. They observe task-scoped settled notifications by reading the
committed approval/link state. A controlled table lock pauses resolution after
its link discovery without replacing either service or database. Before the fix,
both resolver-first cases observed only `pending`; both linker-first cases passed.
After the fix all four see a wake with `approved`. Six existing cases additionally
prove actual worker publication after approve/reject/cancel/unlink and nested
rollback/outer-commit behavior. All 286 tests across six complete affected suites
passed, including budgets, queue seeding, retention and approval API consumers;
server typechecking passed. Evidence: `/tmp/sleep-approval-links-{red,green}.log`,
`/tmp/sleep-approval-links-owning-tests.log`, and
`/tmp/sleep-approval-links-root-types.log` with matching status files. Integrated
stack verification and fresh remote acceptance are still required. This is a
producer-correctness fix, not deployed host-sleep qualification.

## Status replay and response recovery lock order (2026-10-27)

Review found that scheduled response recovery locked the issue before restoring
presentation under the finalization coordinator lock. Status commitment and
replay acquire those locks in the opposite order. Concurrent operations could
therefore deadlock even though each isolated path passed its tests.

Recovery now acquires the scoped coordinator row before the issue. Its existing
presentation owner still rechecks the accepted decision, result, assessment,
claim, retry deadline and current authority. This changes no durable schema or
polling behavior. The extra primary-key lock query occurs only for actual work.

The regression holds a real coordinator lock, starts response recovery, observes
PostgreSQL reporting that recovery is blocked, then calls the actual status
committer inside the owning transaction. Before the fix that replay fails with
55P03 while locking the issue. After the fix replay completes, recovery publishes
one response after the transaction ends, and repeated recovery produces no second
response. The nine targeted authority/concurrency/deadline cases and all 270
cases in the complete external-chat wait suite pass. Server typechecking passes;
an initial test-only persisted-JSON type assertion error was corrected separately.
Latest-head CI and integration with downstream changes remain required.


## Current 0413 integration and governed-review acceptance

The current accepted-response parent is integrated through a normal merge.
Nineteen owned source files preserve their original bytes; ten files combine
original and upstream edits automatically. All 10,580 unrelated upstream source
files remain unchanged. Four reviewed conflicts combine the owned approval
scope with the current async transaction writer, retain explicit tool-review
producer notifications instead of restoring removed shared fanout, and preserve
the source conversation/session-generation authority locks before the new
review hint and row mutation. The real approval-link concurrency and status
replay paths are exercised below. Newly added code comments were removed with
nontrivia token identity proof; no behavior was removed.

Only the owned unlanded migration artifacts were deferred. `pnpm db:generate`
produced `0413_tired_kronos.sql`; its original concurrent index statement remains
byte-identical. Prior executable SQL, journal entries and retained snapshot
bytes are unchanged. Five snapshots 0409 through 0413 remain. Actual database
build, server types/build, module boundaries, exact-head migration order and
no-new-code-comments checks pass.

Tested source `320146c29489bb1f7308422981fa946b6a3d3368` passes **2828 distinct
cases across 37 complete files and one focused chat file**. The main selection
passes 2399 cases in 272.11 seconds; safe replacement passes 59 in 26.04
seconds; all 270 governed external-chat wait cases pass in 53.07 seconds; the
complete CLI company import/export E2E passes its real child-server journey in
13.31 seconds. The focused chat selection passes 39 in 40.41 seconds; 1760
other chat cases are outside its name pattern and are not claimed. The main
invocation initially skips two approval files (60 cases) because their external
database variables were omitted. A targeted add-on supplies their own fresh
databases and passes all 60 cases in 26.20 seconds, without repeating the
already-passing suites. The original skipped output remains retained. Counts:

| File | Passing cases |
| --- | ---: |
| cli/src/__tests__/company-import-export-e2e.test.ts | 1 |
| server/src/__tests__/approval-queue-seeding-work.test.ts | 28 |
| server/src/__tests__/approval-retention-work.test.ts | 32 |
| server/src/__tests__/approvals-service.test.ts | 8 |
| server/src/__tests__/chat-channels.integration.test.ts (focused) | 39 |
| server/src/__tests__/committed-chat-response-authority.test.ts | 7 |
| server/src/__tests__/issue-recovery-actions.test.ts | 89 |
| server/src/__tests__/issue-thread-interactions-telemetry.test.ts | 9 |
| server/src/__tests__/native-finalization-recovery.test.ts | 32 |
| server/src/__tests__/native-interaction-bridge.test.ts | 7 |
| server/src/__tests__/native-status-arbiter-corpus.test.ts | 94 |
| server/src/__tests__/native-workspace-sync.test.ts | 10 |
| server/src/__tests__/recovery-stale-issue-lock-sweep.test.ts | 40 |
| server/src/__tests__/satisfied-connection-intents.test.ts | 52 |
| server/src/__tests__/server-startup-feedback-export.test.ts | 71 |
| server/src/__tests__/slack-conversation-lifecycle.test.ts | 41 |
| server/src/__tests__/tool-access-oauth-protocol.integration.test.ts | 2 |
| server/src/modules/run-dispatch/adapters/postgres.test.ts | 69 |
| server/src/modules/wake-queue/adapters/postgres.test.ts | 93 |
| server/src/modules/wake-queue/adapters/queued-comment-postgres.test.ts | 5 |
| server/src/services/chat-monitor-continuation.test.ts | 21 |
| server/src/services/execution-control-reconciliation.test.ts | 10 |
| server/src/services/explicit-native-continuation.test.ts | 335 |
| server/src/services/heartbeat/queue.test.ts | 32 |
| server/src/services/heartbeat/recovery.test.ts | 45 |
| server/src/services/heartbeat/run-control.test.ts | 51 |
| server/src/services/heartbeat/run-lifecycle.test.ts | 34 |
| server/src/services/heartbeat/upgrade-readiness.test.ts | 7 |
| server/src/services/issue-thread-interactions.test.ts | 13 |
| server/src/services/legacy-execution-recovery.test.ts | 15 |
| server/src/services/native-runtime/external-chat-wait.integration.test.ts | 270 |
| server/src/services/native-runtime/native-restart-recovery.test.ts | 25 |
| server/src/services/native-runtime/native-run-finalizer-telemetry.test.ts | 29 |
| server/src/services/native-runtime/native-safe-replacement.test.ts | 59 |
| server/src/services/native-runtime/native-session-executor.test.ts | 968 |
| server/src/services/native-runtime/native-workspace-export-retry.test.ts | 80 |
| server/src/services/native-runtime/native-workspace-reconstruction.test.ts | 50 |
| server/src/services/native-runtime/paperclip-control-plane-port.test.ts | 55 |

The complete 94-case status-authority corpus also passes again on the same
database. The repeat is not double-counted. Retained PSC/OUT/sentinel rows
remain unchanged and each run uses distinct fixture prefixes. Thirty-one
separate fresh PostgreSQL 17 databases migrate through 0413. Five main
embedded-only fixture imports and the CLI fixture import temporarily use
their own external databases on this IPC-exhausted host, then restore byte
for byte. Assertions and timing limits remain unchanged. This qualifies
external-database behavior; it does not reproduce embedded CI locally.

Validation started at `2b7f491641f22fb7577859681f8b632117113c8d`. The CLI
comment cleanup was already present when pre-run source hashes were captured
but was omitted from that commit's server/database-only staging. Committing
those exact bytes as `320146c29489bb1f7308422981fa946b6a3d3368` changed no working
source during validation. All 38 selected committed files match the pre-run
hashes after fixture restoration. The comment cleanup has token identity proof.

A populated 0412-to0413 upgrade preserves all 411 prior receipts and all
38 companies, appends exactly one receipt, and adds none on replay. The
receipt index is valid and ready on fresh and upgraded databases. The
preexisting response-selection statistic is retained. Earlier failed checks
and restricted retries above keep their original scope. The first local
composition bookkeeping check omitted the unstaged CLI comment cleanup; the
aligned source proof now passes. No functional failure is reclassified by it.

The published response-presentation prerequisite is adopted without changing
any accepted complete core tree. Publication stays held until #17696 lands
and actual squash ancestry is reconciled. Fresh published-head CI and
exact-head Greptile 5/5 remain required. These checks do not establish deployed
suspension, external Cloud alarm delivery or fleet savings.


### Scoped wake repair after the published parent review

Source `2341714720b5c273f0ce011b48345af0ef39227f` inherits the published
parent `ef6cb73777f0c31e3622d23d039d702b2fc08263` through a normal merge.
Both response queues now require an issue or run on ordinary milestone and
finalization notifications. The explicit company authority boundary invalidates
both workers globally, preserving actual membership/configuration restoration.
The real coalesced-input producer test covers both queues after outer commit.
Existing pending-effects and older chat queue payloads remain unchanged.

The exact three new governed-response regressions first reproduce two failures
for repeated coarse hints while actual membership restoration passes. The same
source and assertion limits pass after repair: repeated coarse hints do not
reconstruct dormant governed response history, and actual membership restoration
still publishes once. Source qualifies **2053 distinct passing cases**: 1703
in 15 complete files and 350 selected chat cases. The complete files include
all 273 governed response cases, 95 wake-queue adapter cases, 968 native-session
cases, authority/lifecycle/approval consumers, and inherited monitor/finalizer
coverage. Another 1463 chat cases are outside the selection; the complete
1813-case chat file is not claimed for this repair. The three regressions and
two coalescing cases are included, not added again.

Fourteen complete consumer files pass 1430 cases in 123.59 seconds; all 273
governed-response cases pass in 53.97 seconds; focused chat passes 350 in
301.76 seconds. Thirteen dedicated PostgreSQL 17 fixtures migrate through
0413. Only the embedded-only wake-queue import temporarily selects its own
external fixture and restores byte for byte. All 16 captured test hashes match.
Database build, server types/build, module boundaries and full-SHA migration
order pass. No assertion or time-limit changes qualify the repair.

The composition proof retains 12646 parent/unrelated tree entries exactly,
36 owned entries exactly and one identical shared change. Only two notification
files need manual scope resolutions; the third overlap, the native finalizer,
preserves the exact parent hunk bodies automatically. The database tree is
identical to the previously qualified 0413 source; no SQL, executable history,
journal or snapshot is regenerated. Earlier 2828-case acceptance and populated
upgrade/replay evidence retain their earlier source scope. The remote PR remains
held until its parent merges and fresh current-head CI and reviews pass.


### Landed parent, Photon boundary and independent master contract

Parent #17696 merged as `ec3b558277be5488c92e9b388e25300826caee89`
from exact reviewed head `ef6cb73777f0c31e3622d23d039d702b2fc08263`,
with 58 clean checks, Greptile 5/5 and unconditional Ponytail 5/5. The normal
ancestry reconciliation proves whole parent/squash tree equality and preserves
the complete held child tree, including the owned scope repair.

A later security warning claimed Photon ownership assertions caused a global
response reconstruction on every event. The existing callback already reads the
endpoint under a row lock, requires attention status and transitions it to active
or verifying before commit. The real published callback test disproved the claim:
ten active assertions cause zero response hints and zero candidate SELECTs;
three concurrent attention assertions cause exactly one hint and one SELECT,
then return to quiet. The finding was resolved with that evidence and its
current-head security check became successful. No production change was needed.
The regression is retained here and covers both response workers with real
Paperclip callbacks and PostgreSQL; the external Photon transport is mocked.
The complete 22-case Photon file passes on this combined source. An earlier
single-worker 21-case acceptance retains its own parent source scope.

Master independently added the runtime activity contract in #18129 at
`80a2b9284bf189e93ca4313085814548f48b8dc8`. Its 32 changed paths have no
intersection with the owned sleep patch. A normal merge preserves both complete
binary patches. The inherited contract changes event validation, redaction and
UI event classification; it does not change this worker or its durable predicate.

Combined source `586f5674cd9798b33cd22437255e0480b5726d20` passes
**1297 distinct cases**: 1093 across five complete server files in 96.03 seconds
(968 native-session, 22 Photon and 103 inherited contract cases), 185 in five
complete runner files in 1.55 seconds, 14 Node protocol-contract cases in
1614.48 milliseconds and five UI registry cases. These results are separate
from the earlier 2053-case source; overlapping cases are not cumulatively counted.
The three dedicated fresh 0413 fixtures and the live-event helper's own fresh
database use PostgreSQL 17, with no source adaptations. All twelve new-context
source hashes and all sixteen earlier scoped-qualification hashes match.
Database build, server types/build, module boundaries, full-SHA migration order
and generated TypeScript/Rust profile checks pass. The Runner vendor rebuild
completes successfully for the new inherited inputs. No deployment or live
external-provider qualification is claimed.

The database tree remains identical to the qualified 0413 source. The populated
upgrade evidence therefore retains its unchanged executable migration bytes;
no new migration or snapshot generation was necessary. Before publication,
the original owned patch and independent master patch are checked again as
complete binary diffs, including the retained Photon test and this audit.
Fresh exact-head CI, Greptile 5/5 and actionable review resolution remain merge
gates for this PR.
