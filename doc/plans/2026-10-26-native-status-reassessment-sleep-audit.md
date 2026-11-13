# Native status reassessment sleep audit

Parent: governed-review response recovery, draft #17702 at `be6ca6151b`.
This audit starts the next reason in the recurring-server migration stack.
Parent #17702 has passing checks and Greptile 5/5 at that head; it remains unmerged.

Current summary: [worker contract](../idle-native-status-reassessment.md).
Entries below preserve chronological checkpoints, including earlier incomplete
states and failures; the latest checkpoints supersede their progress status.

## Obligation and ownership

After a native result is assessed, changed durable facts can require a new status
assessment and decision. The current native-finalization reconciler discovers
that change by revisiting committed runs, including its rotating settled-history
page. Response publication and pending-effect delivery have separate owners in
the preceding slices. Workspace/result settlement and retained session cleanup
remain separate duties and must not disappear with this migration.

The existing reassessment block has three activation conditions:

- A work product was created or updated after the selected assessment. The
  classifier must actually establish newly satisfied criteria and verification
  before this condition changes task disposition.
- The authoritative task status/version differs from the previous assessment,
  after accounting for the selected decision's projected version and preserve
  semantics. A superseding decision can make the old run ineligible.
- The selected automatic review has been retired. Reassessment then checks the
  latest contract, current task/run, pending child completion, dependencies,
  governance and any later workspace-finalization barrier.

These are triggers for the same append-only status reassessment operation.
Keep classification and status arbitration with native runtime. Keep task locks,
version comparison, current authority and effect creation in the status-decision
committer. Do not put evidence parsing or policy branches in startup or the shared
scheduler. Do not use the combined reconciler as a worker callback: that would
also run unrelated response, workspace and retention work.

## Existing facts and guards

The coordinator binds run, task, selected result, assessment and decision. The
assessment retains prior task status/version/decision and its input digest. The
result and contract are selected by matching company/task/run identities. The
committer appends the new decision and guards concurrent task changes. A
NativeStatusRaceError currently defers to later reconciliation; the new worker
must retain or receive the corresponding wake instead of silently losing it.

The outer candidate scan respects next_attempt_at and live finalization leases.
The extracted owner must recheck these under its transaction/claim boundary;
a stale scheduler entry cannot bypass a newly acquired lease or delayed retry.
The worker must distinguish dormant changed evidence that is still insufficient
from retryable I/O or contention. Existing durable rows remain truth; no new queue
table is justified by this timer migration.

## Producer audit to complete

Work-product writers found in current source:

- work-products.ts: create, update, primary replacement, batch import and removal.
  Current notifications cover pull-request retention/approval work only.
- issues.ts: attachment work-product insertion.
- routes/issues.ts: trusted-source promotion changes an existing product and
  inserts its promoted product inside an owned transaction.
- native-runtime/chat-attachment-reuse.ts and native-runner-file-handoff.ts:
  direct metadata/title updates on existing products.

The classifier reads more than work products: case handoffs, accepted/rejected
control-plane run events, linked approvals, resolved interactions and attachments.
Determine which mutations activate existing reassessment behavior and preserve
that contract. Do not assume that work-product notifications cover all evidence
or introduce inferred completion merely because a source row changed.

Also audit task status/version producers; decision/effect settlement; automatic
review retirement; latest-contract changes; workspace barrier settlement; child
completion; dependency/blocker changes; agent/task authority and process claims.
Use the existing mutation/transaction owners. Reuse task/run-scoped notification
boundaries where their semantics match. Broad configuration changes may justify
broader scopes; ordinary writes must not reload every company run.

## Acceptance before periodic removal

- Extract and exercise the actual reassessment owner without invoking other
  native recovery duties. Preserve fresh finalization and explicit recovery.
- Reproduce each missing producer wake before wiring it. Cover alternate writers,
  nested outer commit/rollback and relevant uncertainty settlement.
- Verify superseding decisions, changed versions, current contract, ownership,
  governance, pending children and workspace barriers with real DB state.
- Prove no duplicate decisions/effects under competing recovery and producer
  changes during a sweep. A rejected or no-longer-current assessment cannot
  authorize completion.
- Prove no recurring SQL for configured-idle and retained settled history,
  including changed but insufficient evidence. Verify genuine deadlines,
  failures, startup/resume, drain and shutdown.
- Measure selected-history and outstanding-backlog discovery before wiring it.
  Bound individual queries and support interruption; disclose total reconstruction
  cost and retain exact scope on ordinary changes.
- Register through existing maintenance lifecycle, disable only this periodic
  duty, run relevant consumers and required checks, then obtain latest-head CI
  and review acceptance on its own stacked PR.

This is an audit, not an implemented migration. No polling entrance is removed
by this document. No Cloud alarm coverage or host sleep eligibility changes.


## Owner extraction checkpoint

The status-authority corpus passes all 94 cases before extraction on a fresh
PostgreSQL database. Reassessment now lives in native-status-reassessment.ts;
its pure arbitration policy lives in native-reconciliation-status.ts. Existing
imports through the reconciler remain compatible. The combined reconciler
delegates to the extracted owner and retains all periodic behavior for now.
It avoids the legacy review-response lookup when that repair is disabled.

The extracted owner distinguishes unchanged, superseded, deferred and committed
outcomes. Operational errors still propagate; the existing status-race behavior
remains deferred. All 94 status-authority cases and 187 governed-response cases
pass after extraction, as does server typecheck. Evidence: /tmp/sleep50-baseline.log,
/tmp/sleep50-extract-corpus.log, /tmp/sleep50-extract-responses.log and
/tmp/sleep50-extract-types.log. Each corpus run uses a fresh database because its
company prefixes persist beyond the suite.

The scheduler entry point is not ready yet. The status committer locks the
coordinator before the task and publishes activity after its own transaction.
Wrapping it in a new outer transaction would publish before that outer commit;
do not do that. Add any scheduled source/lease/deadline guard at the committer's
existing transaction boundary, and exercise competing source/claim changes there.
The new worker must reload source facts and preserve deferred races/retries; it
must not treat an extracted snapshot-based helper as fresh scheduling authority.
Producer notifications, discovery cost, lifecycle tests and periodic removal
remain outstanding. No slice 50 PR has been published.

## Scheduled commit guard

Scheduled reassessment now opts into a source guard inside the existing status
committer transaction. After coordinator/task locking it compares the selected
phase/result/assessment/decision, respects a future retry and live or unknown
lease, locks and checks native run ownership, and defers while the old decision
has pending or failed effects. Explicit callers retain their existing behavior.
The lock order remains coordinator, task, then run. Publications still occur only
after the committer's transaction commits.

The first seven-case reproduction had five behavioral failures and two invalid
fixtures: clearing the assessment/result without clearing dependent references
violated schema constraints before reaching the committer. Corrected fixtures
plus pending-effect and ownership races failed all nine before the guard: eight
incorrect commits and one attempted commit rejected by the result constraint.
After the guard, all 103 status-authority corpus cases and server typecheck pass.
Every deferred case preserves the competing state and successfully commits once
that state is released. Logs: /tmp/sleep50-guard-before.log,
/tmp/sleep50-guard-before2.log, /tmp/sleep50-guard-after.log,
/tmp/sleep50-guard-types.log; statuses are saved beside the test logs.

This is not worker acceptance. Candidate selection, dormant-versus-retry outcome
handling, producer coverage, lifecycle/cost tests and periodic removal remain.
No slice 50 PR has been published and no additional polling has been removed.

## Scoped worker and first producer

A local, not-yet-registered worker now discovers the three existing activation
conditions with company/task/run/agent scopes and 100-row keyset pages. Candidate
SQL excludes superseded decisions, held native ownership, unknown finalization
leases and old pending effects. It is discovery, not mutation authority: check
reloads the source and the committer still applies the locked guard. Future retry
and live lease deadlines retain their maximum. A commit race requests a retry;
unchanged evidence or a dormant review prerequisite does not keep recurring work
scheduled. The shared scoped-deadline helper owns coalescing, fairness, admission
and retry bookkeeping. No new queue table is added.

Nine initial discovery/owner tests pass for retired reviews, changed evidence,
authoritative task changes, future retries/leases, insufficient evidence,
ownership exclusions and pre-aborted discovery. A tenth regression exposed a
newly saved five-second deadline being pushed out to generic 30-second backoff.
The worker now returns that saved future deadline exactly; backoff applies only
when the source is still immediately eligible after a commit race. The complete
113-case status corpus and server types pass. Evidence:
/tmp/sleep50-worker-first.log, /tmp/sleep50-deadline-before.log,
/tmp/sleep50-worker-after.log and /tmp/sleep50-worker-after-types.log.

An isolated lifecycle test reproduced a real missed wake: after the worker went
quiet, automatic review retirement left the task in review. Retirement now
signals the exact task/run inside its existing transaction, before changing the
card. The common native-finalization signal also includes reassessment, retaining
its supplied scope. All three lifecycle tests pass: real retirement after idle,
first retirement during drain followed by resume, and a saved future retry across
shutdown/restart without early dispatch. Driver-level SQL capture verifies no SQL
across two former polling minutes after completion or while drain is paused.
The existing governed-response suite passes all 187 cases after the shared
notification change. Logs: /tmp/sleep50-lifecycle-before.log,
/tmp/sleep50-lifecycle-after.log, /tmp/sleep50-lifecycle-types.log and
/tmp/sleep50-worker-responses.log.

Initial read-only query measurement reused slice 49's 10,000 cloned history rows.
Those copies share a task and their decisions are superseded for reassessment;
this is not proof of 10,000 independently selected current assessments or an
outstanding reassessment backlog. Startup returned 62 candidates from other
retained history in one query (305 ms cold wall time; warm EXPLAIN execution about
47 ms). Company/task scopes returned none in 34/20 ms, exact run in 2.6 ms.
Plans and logs: /tmp/sleep50-query-{startup,company,issue,run}.plan and
/tmp/sleep50-query-plan.log. Selected-current history, backlog cost and cancellation
between pages still need measurement before enabling the worker.

Remaining work is substantial: work-product and alternate writers, task changes,
classifier inputs while a retired review is dormant, current-contract/workspace/
governance and ownership transitions, further transaction/lifecycle cases,
startup registration and periodic removal. Existing retirement prerequisite reads
precede the committer; audit their serialization with producer owners before
claiming concurrent authority coverage. In particular, completion-contract
creation uses its own advisory lock rather than the status committer's issue
lock. This checkpoint is not a claim that every business-fact race is covered.
The existing periodic reassessment path remains active and slice 50 has no PR.

Final current-source local rerun passes 116 tests across the status corpus and
isolated worker lifecycle files (/tmp/sleep50-final-local.log). Together with the
187 governed-response cases this is 303 distinct passing cases, not whole-workspace
or remote PR acceptance. The last server typecheck also passes.

## Work-product and task producer checkpoint

Six real writer regressions failed before notifications: artifact update, create,
primary replacement, import, attachment creation, and nested transaction commit.
Their existing write transactions now signal task-scoped reassessment before the
mutation. Import coalesces its scopes per task. Updates signal both old and new
scope if their supported patch moves a product. Removal also signals its old task.
Attachment creation signals before asset/attachment/product writes, including
attachment evidence without a registered run. Native file handoff and attachment
reuse call that service inside their tool-authority transaction; their subsequent
same-transaction title/metadata edits share its outer settlement. Those fields
are not classifier evidence, so no second recovery wrapper was added there.
The low-trust promotion route signals inside its own atomic source/product write.
A real HTTP promotion now also proves completion through the registered worker.

Three further regressions failed for task status changes, assignment changes,
and reasserting blocked state. The task mutation owner now signals relevant
status/version, execution, assignment and blocker writes. The regression checks
that the new assessment reflects the task's actual version and does not overwrite
the board's status. The nested work-product case verifies no decision before the
outer commit, no decision after rollback, then successful reassessment after a
later commit. All paths return to driver-observed SQL quiet.

Final owner lifecycle tests pass all 13 cases, including the real promotion route,
and server types pass. Evidence: /tmp/sleep50-products-before.log (six failures),
/tmp/sleep50-products-after.log (nine passes), /tmp/sleep50-tasks-before.log
(three failures), /tmp/sleep50-tasks-after.log (12 passes), and
/tmp/sleep50-products-final.log (13 passes) plus its final typecheck log.

Affected consumers pass 79 cases across five files: work products, attachment
routes, low-trust HTTP routes, attachment reuse, and runner task attachments.
The first combined run passed 53 but failed two suites during embedded PostgreSQL
bootstrap, leaving 26 cases unrun. Those suites now accept validated dedicated
external test database URLs and explicitly close their clients. Their 26 cases
then pass on separate PostgreSQL databases. Low-trust route tests use their own
dedicated database because teardown deletes shared tables. Preserve the initial
failure in /tmp/sleep50-consumers.log and the successful rerun in
/tmp/sleep50-attachment-consumers-after.log. This is 79 passing consumer cases
across the two runs, not a green initial run or a whole-workspace result.

Master was refreshed and remains 1fbbef45a8. The stack has not been reconciled
onto it yet. The worker remains unregistered and periodic reassessment remains.
Remaining producer coverage includes approval/interaction and run-event evidence,
case handoffs, native ownership and run-status transitions, completion-contract
changes and workspace-finalization barriers. Workspace recovery writes a separate
workspace_finalize success receipt; snapshot-only rows are not that barrier.
Continue the concurrent authority audit, independent-current-history/backlog cost,
lifecycle/failure evidence, startup/periodic wiring and full PR acceptance.


## Approval evidence producer checkpoint

Approval references are classified from the current approval status and its
company/task link. A product can have changed after the selected assessment
while that approval is still pending or unlinked. The worker correctly goes
quiet with insufficient evidence, but must inspect that same candidate when
an approval is resolved or linked later. This does not add a new reassessment
condition: the existing changed-product predicate must still be satisfied.

The existing `notifyApprovalWork` boundary now sends the same task scopes to
native reassessment as to governed review responses, before the approval/link
write. It already resolves linked task IDs for status changes and accepts
explicit task scopes for link/unlink and bulk link. No new transaction wrapper,
company scan, table, or provider policy was introduced. Unlinked approval creation
has no task to reassess; the subsequent link owns activation. The production
writer audit also found budget approval resolution and gateway formal-approval
linking use this boundary with the appropriate scope. Company deletion removes
the records rather than creating a surviving reassessment obligation.

Four real PostgreSQL regressions failed before the notification: approval
resolution, single link, bulk link, and an approval inside a caller-owned outer
transaction. With the notification they pass, including no premature decision
before outer commit, no decision after rollback, and driver-observed SQL quiet
before activation and after settlement. The full lifecycle file now passes 17
cases. Existing approval service and route-idempotency consumers pass another
19 cases (36 total in the combined run). Server typecheck passes.

Evidence: `/tmp/sleep50-approval-before.log` and `.status` (four failures),
`/tmp/sleep50-approval-after.log` and `.status` (36 passes), and
`/tmp/sleep50-approval-types.log` and `.status` (pass). The before and after runs
used separate freshly migrated PostgreSQL test databases. This is local producer
acceptance, not full slice or remote PR acceptance.

Interaction evidence remains next: confirmation/question paths signal through
chat milestones, while other interaction outcomes signal governed review response
directly. Their common activation boundary must cover reassessment without teaching
the scheduler interaction policy or coupling it to a review-specific worker.
Several interaction mutations also lack either signal and require fact-level
audit before the old polling path can be removed. Run evidence, ownership,
completion contracts, workspace barriers, concurrent authority, discovery cost,
and startup registration remain outstanding as listed above.


## Interaction evidence producer checkpoint

The interaction classifier reads status and result outcome, not just terminal
status. Real response regressions reproduced missed wakes for confirmation,
checkbox confirmation, question answers, completed item verdicts, and partial
item verdicts. The first checkbox fixture used `items`/`checkedItemIds` rather
than the real `options`/`selectedOptionIds` contract; after correcting it, that
case also reproduced the missed wake before production changes.

`notifyNativeReviewState` is a small fan-out boundary for the two consumers of
changed review facts: governed response recovery and status reassessment. It
preserves their existing task/run/company scopes and delegates all discovery,
classification and authority to the owning workers. Approval, interaction,
chat-milestone, satisfied-connection and OAuth completion/rejection producers
reuse that boundary in their existing transactions. It does not add database
queries or a transaction wrapper at these call sites; the existing shared intent
registration still owns its normal transaction-tracking cost.

Confirmation/question paths already use the milestone boundary; other interaction
outcomes use the new shared review-state boundary directly. Connection-intent
creation/supersession signals before insert in its existing transaction. Generic
non-question/non-confirmation creation signals reassessment before insert.
Partial item verdicts need reassessment even though governed response recovery
still waits for completion: their persisted `outcome: resolved` is already
accepted by the evidence classifier. This migration preserves that existing
classification policy rather than silently changing it while removing polling.

Direct-writer audit: secret proposals, tool-action review, gateway outcome
projection, conversation promotion, and obsolete-policy review retirement already
signal milestones. Automatic completion retirement and native status commits
already signal reassessment/finalization. Confirmation comment enrichment shares
its outer transaction with ordinary service resolution. Ownership-change connection
expiry is called only through issueService's owned transaction. OAuth callback
acceptance/rejection and satisfied-connection retirement now use the shared helper.
Payload-only connection-phase updates, consumed-action stamps, retry annotations
on already accepted confirmations, and dismissal attention fields do not change
the classifier's status/outcome facts. Native response materialization uses the
existing finalization boundary. Authorization-start's reopening/creation path
and native superseded-review caller ownership still need final audit; do not infer
complete producer coverage from this checkpoint.

All 22 reassessment lifecycle cases pass, with driver-observed SQL quiet before
and after real response activation. Server typecheck passes. Existing interaction
service, tool-access/OAuth, and satisfied-connection suites pass 625 cases across
three separate freshly migrated PostgreSQL databases. Evidence:
`/tmp/sleep50-interaction-before.log` (four missed-wake failures and one invalid
fixture), `/tmp/sleep50-interaction-checkbox-before.log` (corrected missed-wake
failure), `/tmp/sleep50-interaction-after.log` and `.status` (22 passes),
`/tmp/sleep50-interaction-types.log` and `.status` (pass), and
`/tmp/sleep50-interaction-consumers.log` and `.status` (625 passes).

The milestone fan-out also reaches existing run-status producers, but that is not
proof that all native ownership/run-event writers are covered. Workspace barrier
producers, remaining run/contract/case-handoff facts, concurrent authority guards,
current-history/backlog query cost, startup registration and remote PR acceptance
remain incomplete. Periodic reassessment is deliberately still enabled.


## Workspace finalization barrier producer checkpoint

The retired-review path defers when the latest `workspace_finalize` record has
not succeeded. It deliberately leaves no recovery timer for an in-progress or
failed barrier, so the actual producer must reactivate it when that fact changes.
Two PostgreSQL regressions reproduced missing reactivation through the normal
workspace-operation recorder: failure followed by a later successful export,
and a successful write inside a caller-owned transaction.

The recorder now routes its initial state insert, successful settlement and failed
settlement through one local state-write boundary. Only `workspace_finalize`
operations with a run binding register reassessment intent; other phases retain
their existing writes. The added transaction contains only the state write and
notification. Log I/O, the provider callback, and progress/lease updates remain
outside it. Existing caller-owned transactions retain outer commit semantics.
The success test keeps the real callback suspended while the worker goes SQL
quiet, then completes it and observes task completion. The transaction test
proves no decision before outer commit, no decision after rollback, and successful
activation after a later commit.

The separate retained-workspace recovery success receipt now signals in its
existing transaction before the receipt insert and generation update. A test
runs real retained recovery with temporary files and verifies that the delivered
notification's reader observes a committed `workspace_finalize: succeeded` row.
The historical unsafe-export path already had the common finalization signal;
it now registers that intent before its barrier insert rather than afterward.
Snapshot and copy-only records use other phases and do not satisfy this barrier.
Runtime-control orphan reconciliation operates on action-stamped controls; normal
native workspace finalization uses its own ownership metadata instead.

All 24 worker lifecycle cases pass, and server typecheck passes. The workspace
operation reconciliation, retained workspace recovery and native status arbiter
corpus suites pass 170 cases across three fresh PostgreSQL databases. The two
workspace suites now accept dedicated, validated external test database URLs;
restart tests reuse that URL, and clients close before fixture teardown. This
uses the known-working local PostgreSQL installation because embedded bootstrap
failed in earlier acceptance attempts; no product database is used.

Evidence: `/tmp/sleep50-workspace-before.log` and `.status` (two failures),
`/tmp/sleep50-workspace-after.log` and `.status` (24 passes),
`/tmp/sleep50-workspace-consumers.log` and `.status` (170 passes), and
`/tmp/sleep50-workspace-final-types.log` and `.status` (pass). All launched
commands at this checkpoint reached terminal status. These are local checks,
not remote PR acceptance or evidence of host suspension.

Next: finish run-event/case-handoff, completion-contract, ownership and remaining
interaction producer audit; then verify commit-time business authority, discovery
cost/backlog behavior, lifecycle wiring and remote PR gates. Current scheduled
commit guards fence coordinator/run ownership and source selection, but the
retired-review business-fact checks still run before the commit transaction.
The old periodic reassessment remains enabled until this full slice is ready.


## Authoritative run-event producer checkpoint

Event references may become accepted/rejected only when a persisted PRP event
has `sourceKind: control_plane` and the corresponding evidence verdict. The
classifier now exposes that existing pure verdict interpretation to the append
boundary, including its existing whitespace normalization. The append boundary
registers a run-scoped reassessment signal before the event write for native
runs. It does not look up a task context or scan evidence consumers to append
an event. Non-verdict events retain the ordinary atomic single-statement path;
runner-authored claims do not activate reassessment.

The writer audit found three insertion paths. The native coordinator store accepts
only `sourceKind: runner` and rejects control-plane events, so its append path
cannot produce an authoritative verdict and needs no added signal. Scheduled
retry cancellation inserts ordinary lifecycle diagnostics without PRP evidence.
The shared append path owns the supported control-plane verdict writes. Event
rows are otherwise immutable in production; agent/company deletion owns removal
of their run history rather than producing new evidence for surviving runs.

Four real-append regressions failed before the fix: ordinary append, native-source
append, outer transaction commit, and authoritative evidence after ordinary/runner
logs. The repaired tests observe task completion, outer rollback/commit fencing,
no reassessment signal for ordinary or runner-authored logs, replay idempotency,
and driver-observed SQL quiet. All 28 lifecycle cases and six existing atomic
append cases pass. The atomic tests still prove the one-statement ordinary-log
path and preserve binding/concurrency behavior.

The initial combined run failed three sequencing cases during embedded PostgreSQL
bootstrap, before assertions. They now accept a validated dedicated external test
database URL, clean only their own company fixture between cases, and close both
clients. All three then pass, including concurrent retry receipt deduplication,
concurrent event allocation, and conflicting replay without cursor drift. Final
server typecheck passes. This is 37 distinct passing cases across the runs, not
a successful initial combined run.

Evidence: `/tmp/sleep50-events-before.log` and `.status` (four failures),
`/tmp/sleep50-events-after.log` and `.status` (34 passes, three bootstrap failures),
`/tmp/sleep50-events-sequence.log` and `.status` (three passes), and
`/tmp/sleep50-events-final-types.log` and `.status` (pass). All test handles at
this checkpoint are terminal. Case-handoff creation/cancellation, remaining
contract/ownership/authority producers and the full acceptance tasks listed above
remain outstanding; the old periodic reassessment path is still enabled.

## Scheduled retired-review authority checkpoint

Two commit-boundary regressions reproduce unsafe completion: after reassessment
reads a succeeded run, a competing writer can change its outcome to failed or
bind the task to a different run without changing the task's status version.
Both previously committed a `done` decision. The scheduled source contract now
identifies retired automatic-review reassessment, and the existing status
committer rechecks run success and task execution ownership under its existing
coordinator/task/run locks. It adds no outer transaction, lock order, provider
call, or database query. Explicit legacy reconciliation remains unchanged.

The two regressions assert that the competing state survives, no new decision
commits, and reassessment succeeds once the original authority is restored.
All 115 status-corpus cases pass. The combined corpus/lifecycle run initially
finished with 142 passes and one failed lifecycle assertion: retained test
history needs multiple startup batches, so the first registered wake can be the
next batch rather than the target's future retry. The retry test now waits for
startup batches to settle while asserting that the target stays in review,
then verifies the exact saved deadline before and after restart. All 28 lifecycle
cases pass against that same retained-history database; final server types pass.
This is 143 distinct passing cases across runs, not a green initial combined run.

Evidence: `/tmp/sleep50-authority-before.log` and `.status` (two failures),
`/tmp/sleep50-authority-after.log` and `.status` (115 corpus passes and 27/28
lifecycle passes), `/tmp/sleep50-authority-lifecycle.log` and `.status` (28 passes),
and `/tmp/sleep50-authority-final-types.log` and `.status` (pass). All launched
handles reached terminal status. No remote acceptance or host sleep is claimed.

Producer audit notes for the next checkpoint:

- Handoff evidence is accepted for every persisted non-cancelled state. Delivery,
  completion, leases and retries do not change that classification. Agent-created
  handoffs require the source run to be running and own the task; their generated
  UUID is returned after creation. Board requests can use the current execution
  binding. Do not add wake traffic to every handoff lease renewal.
- Task mutation cancellations are in the issue transaction, which also signals
  reassessment. Direct handoff cancellation, delivery cancellation, and run-control
  cancellation still require their own transaction/activation audit; no complete
  handoff producer-coverage claim is made here.
- Superseded external-review withdrawal is called by the status committer inside
  its decision transaction, which already signals native finalization and chat
  milestones. OAuth authorization-start separately reopens/creates a pending
  confirmation; its interaction writes remain to be audited.
- The evidence classifier checks target-agent existence, not invokable status.
  Do not add status-change fanout based only on the name of that check.
- Completion-contract creation is serialized with the per-company/task advisory
  lock in `ensureNativeCompletionContract`. Checking the latest revision before
  the commit transaction is still insufficient. Audit its callers' lock order
  before extending the scheduled commit guard.

Latest-contract, workspace-barrier, governance, dependency and other business-fact
races remain open, along with remaining producers, query cost/backlog proof,
startup wiring, periodic removal, publication and PR gates. The full original
stack scope, older unresolved gates and master reconciliation remain outstanding.

## Completion-contract serialization checkpoint

The completion-contract writer is `ensureNativeCompletionContract`. Production
callers are native run preparation and heartbeat runtime selection; both select
or ensure the contract before their later run-state mutation. The writer owns a
per-company/task advisory transaction lock, and revisions are append-only. The
scheduled retired-review commit now calls the owner's
`lockCurrentNativeCompletionContract` before taking coordinator/task/run row
locks. The helper tries that same advisory lock without waiting and verifies the
expected contract is still the latest revision. A busy writer or replaced
contract returns the existing reassessment race outcome. The lock remains held
through the status transaction. Explicit legacy reconciliation is unchanged.

This order matters: inserting a contract acquires a foreign-key lock on its task.
Trying to lock the task before recognizing an in-flight contract writer can wait
behind that writer. The before-fix tests reproduced a stale `done` decision after
a newer contract committed, and a 30-second timeout while a real contract writer
held an uncommitted revision. The concurrency fixture now also applies a two-second
statement timeout to the status transaction so a future blocking regression can
unwind and release its competing writer rather than waiting for suite timeout.
The writer uses the real service inside a caller-owned transaction; it is rolled
back only after reassessment has returned its expected retry outcome.

The updated tests prove no status decision commits against either race, a newer
committed contract leaves the old result dormant on subsequent inspection, a
rolled-back revision leaves no row, and restoring the original authoritative
contract allows completion. The contract key is factored privately in its owning
module so the writer and guard cannot diverge. No scheduler-specific SQL lock key
or provider policy is introduced into shared scheduling.

All 117 status-corpus and 28 worker lifecycle cases pass in one combined run
(145 total), including the retained-history startup deadline regression. Server
typecheck passes. Evidence: `/tmp/sleep50-contract-before.log` and `.status`
(stale-completion failure and writer timeout), `/tmp/sleep50-contract-after.log`
and `.status` (145 passes), `/tmp/sleep50-contract-types.log` and `.status`
(pass). All commands have terminal status.

Workspace-barrier and governance/dependency races, remaining producer coverage,
query-cost/backlog proof, startup registration, periodic removal and full PR
acceptance remain outstanding. The existing native workspace finalization owner
already has a separate physical/durable ownership protocol; audit and reuse that
boundary before adding any barrier fence. No slice 50 PR, merge, deployed sleep
or completion of the overall stack is claimed by this checkpoint.

## Workspace-barrier commit checkpoint

Three regressions reproduced stale `done` decisions after the selected workspace
barrier changed to failed, after a newer running finalization operation committed,
and while another transaction held an uncommitted failure update to the selected
barrier. The scheduled retired-review guard now reads the latest finalization
barrier inside the existing status transaction and takes `FOR SHARE NOWAIT` on
that row. Non-success or lock contention yields the existing retryable race
outcome. A subsequent settled failed/running barrier is dormant until a producer
changes it. Missing-barrier semantics remain unchanged from the legacy path.

The transaction already holds `FOR UPDATE` on the task and native run. New
`workspace_operations` rows reference the run through its foreign key, so inserts
cannot commit past those locks; the latest-row share lock additionally fences
status updates/deletion on an existing barrier. NOWAIT avoids waiting behind a
writer that could need a row already held by the status transaction. The ordinary
workspace recorder and recovery receipt producers remain unchanged by this fix;
no advisory namespace, provider call, or recurring probe was added.

All 120 status-corpus and 28 lifecycle tests pass together (148 total), with server
types passing. The race tests preserve the competing state, assert no new status
decision, verify dormancy for a persisted failed/running barrier, and verify
completion after the original successful barrier is restored. The concurrent
writer rolls back only after recovery returns; its two-second statement timeout
bounds a future blocking regression. Existing lifecycle cases still exercise the
real recorder's failed/successful receipts and outer commit/rollback behavior.
Evidence: `/tmp/sleep50-barrier-before.log` and `.status` (three failures),
`/tmp/sleep50-barrier-after.log` and `.status` (148 passes), and
`/tmp/sleep50-barrier-types.log` and `.status` (pass). All handles are terminal.

Physical workspace ownership is distinct from this receipt check. The existing
native owner uses an advisory lock plus a durable run-profile token, removes only
its own token after the action joins, and retains the token if cleanup cannot be
confirmed. Its admission/release interaction with reassessment still needs audit;
this checkpoint does not assert that a succeeded receipt alone proves physical
ownership released. Governance/dependency facts, remaining producers, discovery
cost, startup/periodic migration and remote acceptance remain open, as does the
full original stack scope.

## Physical workspace ownership checkpoint

Four regressions reproduced completion while physical workspace authority was
still outstanding: a live owner at startup, an unverified persisted owner at
startup, a real owner acquired after reassessment's read, and an owner receipt
written after that read. Scheduled retired-review reassessment now treats a
persisted owner as dormant. At commit it tries the existing physical-finalization
advisory lock before acquiring row locks, then rechecks owner presence on the
locked run. This closes the lock-before-receipt acquisition window as well as
retained ownership after a disconnected lock connection. The lock/presence
helpers remain with native workspace ownership/recovery; no provider policy is
added to scheduling. Explicit legacy reassessment remains unchanged.

With only those guards installed, the real-owner lifecycle test reproduced a
second gap: the task stayed in review after the owner released. Normal release
now registers reassessment intent in a short transaction before removing only
its own token. Physical work, assertion of ownership and joining the copyback
callback remain outside that transaction. Failed/uncertain cleanup retains the
existing durable owner and joined-token behavior. Verified operator recovery
registers the same run/task signal in its existing transaction before removing
the verified owner. Its physical-lock check now uses the same owner's helper.
The source audit found these two removal paths; reconstruction preserves the
owner field rather than clearing it.

The real-owner lifecycle test proves task preservation and driver-observed worker
SQL quiet while ownership remains, reactivation after release, and quiet after
completion. A separate unverified-owner case proves no completion or recurring
worker query despite a successful workspace receipt. Commit-race tests preserve
competing ownership and complete only after it is released/restored. The existing
verified-recovery test additionally reads the run from the reassessment callback
and sees the committed released profile, with the coordinator unchanged.

All 122 status-corpus, 30 reassessment lifecycle and 65 workspace finalization
consumer cases pass together (217 total), and server typecheck passes. Existing
consumers cover live ownership, disconnected lock sessions, retained joined-owner
receipts, orphan copyback children, verified stop/replay, and current-task fencing.
The workspace suite now accepts a validated dedicated external test database URL,
uses it for restart/competing clients, and closes its primary client on teardown.
It ran in its own fresh database: its connection-termination tests must not share
a database with another suite. No production database or provider was used.

Evidence: `/tmp/sleep50-physical-before.log` and `.status` (four failures),
`/tmp/sleep50-physical-guard.log` and `.status` (release missed wake after guard),
`/tmp/sleep50-physical-after.log` and `.status` (217 passes), and
`/tmp/sleep50-physical-types.log` and `.status` (pass). All handles are terminal.
Governance/dependency races, remaining producer audits, discovery cost/backlog,
startup registration/periodic removal and remote acceptance remain open. No PR
or merge is claimed for slice 50, and the full original stack remains incomplete.

## Governance commit checkpoint

Seven regressions reproduced stale completion after a pending execution-policy
hold, a newly linked pending approval, a reopened approval, a new pending
interaction, and uncommitted changes to an approval, interaction or question's
human-direction history. Reassessment's selected retired-review source now carries
the governance gate used by its policy decision. The committer rechecks that gate
under its existing task/run locks and rejects a changed kind/identity.

`lockNativeGovernanceSources` belongs to the governance service. It share-locks
all existing interactions on the task, linked approval rows and approval-link
rows, and comments when the task has ordinary questions. It deliberately includes
resolved rows, since reopening them can introduce a new gate. Question history
depends on human comments, including deletion/trust fields, so locking only the
question row would be insufficient. Every added source lock uses NOWAIT to avoid
waiting behind a writer that may need the already-held task/run locks. New linked
rows are fenced by their task foreign keys. A pending issue-owned execution stage
is already protected by the task lock and takes priority without locking the
lower-priority source rows. Existing governance policy and ordinary callers of
`pendingNativeGovernance` are unchanged.

The tests assert that no decision commits against changed or uncommitted facts,
the task remains in review, and completion succeeds after the gate is removed or
the competing writer rolls back. The concurrent writers have a two-second
statement bound on the recovery transaction so a future blocking regression can
unwind. All 129 status-corpus and 30 lifecycle tests pass together (159 total).
The question-history fixture was subsequently strengthened to use a valid question
payload; that case passes again and final server typecheck passes.

Evidence: `/tmp/sleep50-governance-before.log` and `.status` (seven failures),
`/tmp/sleep50-governance-after.log` and `.status` (159 passes),
`/tmp/sleep50-governance-question.log` and `.status` (one focused pass), and
`/tmp/sleep50-governance-final-types.log` and `.status` (pass). All handles are
terminal. These guards run only for actual scheduled retired-review reassessment,
not during idle discovery. Their task-history lock/query cost must be included in
the remaining cost audit; a passing functional test does not establish that cost.

Dependency/readiness and remaining selected-authority/evidence races, remaining
producers (including handoffs and OAuth reopening), discovery/backlog costs,
startup wiring, periodic removal and complete PR gates remain outstanding. No
slice 50 PR or merge is claimed; the original full stack scope remains open.


## Dependency readiness commit guard (2026-10-26)

Seven real database races reproduced unsafe completion: a new blocker relation,
a reopened blocker, an uncommitted blocker status writer, a newly recorded
unattributed workspace operation, a changed finalize receipt, an uncommitted
receipt update, and an uncommitted unattributed operation insert. Before the
repair all seven committed a status decision despite stale dependency readiness.
Evidence: /tmp/sleep50-dependencies-before.log and .status (exit 1).

Dependency semantics remain in issueService.getDependencyReadiness. Its opt-in
lockSources mode requires an existing transaction holding the dependent task
FOR UPDATE. It locks relation/blocker rows FOR UPDATE NOWAIT, then relevant
execution workspaces FOR UPDATE NOWAIT and their existing operation rows FOR
SHARE NOWAIT. The workspace lock fences new operations through the existing FK,
including operations without an issue attribution. Ordinary readiness consumers
retain their previous query and locking behavior. The attributed/unattributed
operation selection and later successful finalization rules are unchanged.

The scheduled retired-review commit compares the readiness boolean used by the
policy with this locked read; contention or a changed predicate defers through
the existing NativeStatusRaceError retry. It does not create a queue/table or
introduce an independent timer. Locks only cover the current task's prerequisites
and relevant workspaces. History-dependent locking cost still needs measurement
as part of the outstanding discovery/commit cost audit.

Initial combined verification passed 135 corpus cases (including all seven new
races), but an older effect-state assertion compared unordered SQL results and
failed when physical row order changed. Both reads now order by effect ordinal.
The lifecycle suite also failed before setup because the invocation used an
incorrect external DB variable and fell back to broken embedded PostgreSQL.
These failures remain in /tmp/sleep50-dependencies-after.log/.status; neither was
counted as passing. The dependency consumer selection passed 15 cases, and the
initial typecheck passed. The consumer suite now supports the standard validated
dedicated external test database contract and closes its pool.

Final verification (all commands terminal):
- /tmp/sleep50-dependencies-final.log/.status: 136 status corpus plus 30 worker
  lifecycle cases, all 166 passing. Fresh corpus DB and retained lifecycle history.
- /tmp/sleep50-dependencies-consumers-final.log/.status: all 15 existing dependency
  readiness/blocker consumer cases passing; other suites deliberately not selected.
- /tmp/sleep50-dependencies-final-types.log/.status: server typecheck passing.

The seven regressions also restore or roll back the competing state and prove
that reassessment can subsequently complete. Remaining authority/evidence races,
producer coverage (including handoffs and OAuth reopening), task-history/backlog
cost, startup wiring, periodic removal and remote PR acceptance remain open.
No new PR or merge, and no whole-instance sleep claim.


## Evidence freshness at status commit (2026-10-26)

All seven before-fix regressions committed stale completion when supporting
work-product review, approval, interaction, attachment, event, or case-handoff
state changed after classification and before commit. The work-product case also
holds a real uncommitted rejection until recovery returns, then rolls it back.
/tmp/sleep50-evidence-before.log/.status records seven failed assertions (exit 1),
not fixture/bootstrap failures.

The assessment owner now exposes lockCurrentNativeWorkAssessmentEvidence. It
loads the exact persisted reassessment with its bound contract/result, then calls
the existing classifier with opt-in source locking. Classification rules remain
in evidence-classifier.ts, including reference parsing, accepted/rejected policy,
question/approval outcomes and attention-target existence. The scheduled committer
only compares the resulting normalized assessment and handles contention through
its existing race/retry outcome. Both retired-review and other scheduled
reassessment paths use this guard. Ordinary classification retains its original
unlocked behavior. No extra transaction encloses the committer/publication path.

The classifier acquires SHARE NOWAIT on the referenced evidence rows and existing
attention target agents. The already-held task/run locks fence new task/run-bound
records through their existing FKs; the reference cache still deduplicates repeat
criterion/verification references. The assessment/contract/result records are
also share-locked. This protects mutable acceptance state and evidence deletion,
rather than assuming all durable evidence is immutable. Missing arbitrary agent
IDs have no row to lock; supported agent-creation identity/producer behavior and
other authority fields remain part of the outstanding producer audit. This is
not a blanket proof for independent SQL writers.

The added read cost is one exact assessment/contract/result query plus the normal
classifier's distinct-reference and attention-target queries. It runs only for
an actual scheduled decision commit, not on idle history. Quantitative history,
backlog and full transaction cost acceptance remains outstanding; no performance
claim is inferred from the narrow regression runtime.

After repair all 143 status-corpus, 30 worker-lifecycle and four classifier
consumer tests pass (177 total), as does server typecheck. The seven regressions
also restore/roll back evidence and prove subsequent completion. Evidence:
/tmp/sleep50-evidence-after.log/.status and /tmp/sleep50-evidence-types.log/.status,
both exit 0; all launched commands are terminal. Ordinary classifier consumer
cases still run without a locking API in their fake query builder.

Remaining: producer/authority coverage, query/history/backlog cost, startup
integration, removal of this periodic duty, PR publication and remote acceptance.
The full recurring-work stack and its older unresolved gates remain open.


## OAuth authorization-start producer checkpoint (2026-10-26)

The direct OAuth authorization-start owner creates a confirmation or reopens its
previous accepted/rejected card by idempotency key. That bypassed the interaction
service's native-review notifications. Three real tool-access service regressions
(creation, reopening, outer rollback) reproduced absent settled notifications:
/tmp/sleep50-oauth-before.log/.status, three failed assertions, exit 1.

The existing card lookup/mutation and OAuth-state interaction link now share a
short database transaction. It awaits notifyNativeReviewState before writing,
with company/task scope. The shared hook wakes both governed review response and
status reassessment; consumers still select only actionable durable state.
Provider discovery, client setup and authorization remain outside the new short
transaction. Browser/user flows that do not create an agent authorization card
keep their existing path. Caller-owned transactions retain their outer boundary.
No provider-specific logic moved into recovery or scheduler code.

All 472 tool-access consumer cases pass, including the new real nested-transaction
tests. They assert the inside/outside card states, no pre-commit notification,
one settlement notification per consumer, and rollback retaining the prior card
and no OAuth state. Rollback settlement releases the intent for reconciliation;
it is not represented as a committed card. All 30 reassessment lifecycle cases
pass against retained history, and server typecheck passes. Evidence (all terminal):
/tmp/sleep50-oauth-after.log/.status, /tmp/sleep50-oauth-lifecycle.log/.status and
/tmp/sleep50-oauth-types.log/.status, all exit 0; 502 distinct tests in this checkpoint.

A fresh origin/master fetch still resolves to
1fbbef45a8d399771add7a27a04b12f3a20e264c. No source changed during acceptance.

Additional handoff audit evidence: direct operator cancellation flows through
cancelPendingCaseHandoffsForIssue; run-control/task cancellation uses
heartbeat/case-handoff-lifecycle; delivery can cancel a fenced claim in its own
settlement transaction. The classifier accepts all persisted non-cancelled
handoff states. Those delivery/lease transitions are not independently positive
evidence triggers, so do not fan out every lease renewal. Creation assigns its
UUID inside the owning transaction. The previous checkpoint now fences stale
handoff evidence at commit. Complete activation/quiet-state proof for the
remaining handoff/authority paths is still outstanding; no blanket producer-
coverage claim is made from this search.

Remaining acceptance continues to include producer/authority audit, discovery
and commit costs, backlog and lifecycle coverage, startup registration, periodic
removal, PR publication and exact-head remote gates. The full original stack
scope and older unresolved gates remain active.


## Selected-history, backlog and commit cost checkpoint (2026-10-26)

The earlier same-task/superseded-decision benchmark did not establish discovery
cost for selected current history. A dedicated PostgreSQL 17 database now holds
10,000 separate task/run/contract/result/assessment/decision/product bindings.
Every task initially selects its own completed decision; accepted products predate
the assessment. This is distinct from 10,000 obsolete decisions on one task.
Fixture: /tmp/sleep50-scale-fixture.sql and .log/.status; database
paperclip_sleep50_scale_20261026_test (snapshot of the completed corpus database,
plus a separate synthetic company). All fixture inserts and measurements are
local disposable test data, never deployed/customer data.

At source 51f305f1d1 with the new backlog regression pending:
- Startup discovery: 98.7 ms, three queries, 246 candidates from the original
  corpus fixtures. None of the 10,000 completed synthetic tasks was a candidate.
- Synthetic company: zero candidates, one query, 34.8 ms (warm EXPLAIN execution
  33.5 ms); exact task/run scopes: one query each, about 1.8/2.1 ms.
- Changing all synthetic tasks' authoritative status creates 10,000 actual
  reassessment candidates. Reconstruction: 101 keyset queries, 1.56 seconds,
  approximately 2.05 MB serialized entries. This is total startup/backlog cost,
  not a constant-space claim; the coordinator retains outstanding entries.
- Drain after two pages stops at two queries; an already-aborted request makes
  zero queries. Interruption is between pages, not cancellation of an active SQL.
- First/last backlog entries both commit real reassessments, disappear from
  scoped discovery, and do not replay: 37/36 SQL statements, about 32/15 ms.

Evidence: /tmp/sleep50-scale-measure.mts, .log/.status (exit 0), and
/tmp/sleep50-scale-{startup,company,issue,run}.plan. No new index was justified by
this selected-history measurement. It is local PostgreSQL evidence, not a remote
network latency or fleet savings claim.

A second fixture exercises retired-review reassessment with 10,000 resolved
interactions, 10,000 comments, 10,000 linked approved approvals, 1,000 completed
prerequisites sharing a workspace, and 10,000 successful workspace operations.
One historical question forces the comment source-lock path too. Scoped discovery
is one query/about 5.9 ms; complete guarded reassessment uses 83 SQL statements
(including nine NOWAIT queries), takes about 126 ms, completes the task, and then
returns zero candidates. Source locks are scoped to this task and its referenced
prerequisites/workspaces; work grows with that history. The measurement does not
assert that a remote database round trip has the same cost.

Two failed benchmark attempts are retained. The first manually assigned version
2 while a status-update trigger advanced the actual version to 4, so it measured
the stale-status path and failed the intended completion assertion. A repair that
rewound that already-processed fixture then reused its existing append-only
assessment and hit status_decisions_company_assessment_uq. Neither failure was
waived or changed in production code. A fresh untouched task with the actual
trigger-generated version exercised the intended retired-review path. Evidence:
/tmp/sleep50-task-history-measure.log/.status and
/tmp/sleep50-task-history-final.log/.status (failures), fixture/repair logs under
/tmp/sleep50-task-history-*, and /tmp/sleep50-task-history-fresh.log/.status (exit 0).

The permanent lifecycle suite now seeds 103 actual retired-review obligations,
verifies full discovery, one-page stop on admission loss, zero-query abort,
coordinator dispatch across batches, exactly one additional decision per task,
no rediscovery, and SQL quiet after settlement. All 31 lifecycle cases pass against
retained history, and server typecheck passes:
/tmp/sleep50-scale-lifecycle.log/.status and /tmp/sleep50-scale-types.log/.status.
All handles are terminal. Startup registration/periodic removal, remaining
producer/authority audit and remote acceptance still remain; the full stack
objective and its earlier unresolved gates are not complete.


## Startup integration and periodic ownership, 2026-10-26

The worker now registers through heartbeat under enabled maintenance, with the
same warm-standby, idle-drain and stopped gates as its sibling owners. The shared
coordinator owns shutdown and restart reconstruction. The periodic orphan reaper
passes `skipNativeStatusReassessment`; explicit/manual and one-time startup
recovery retain the existing reassessment entry point.

The old reassessment call also supplied a superseded-decision early return before
workspace recovery. Removing the whole call without preserving that guard would
allow obsolete history into unrelated recovery. The reassessment owner now shares
that pure authority predicate and exposes a narrow guard for the periodic path.
It makes no queries for the usual matching-decision case, and reads only selected
decision/assessment authority when IDs differ; it does not classify evidence or
create assessments. Independent workspace settlement and committed result replay
remain owned by finalization recovery. Reassessment's dormant outcome no longer
implicitly suppresses those separate duties in the periodic path; their own
ownership and physical-resource guards remain applicable.

Before the wiring change, the new regressions failed because periodic recovery
completed the task itself and startup never registered the worker. Historical
supersession was verified with the new option both enabled and disabled. Evidence:
`/tmp/sleep50-startup-before.log/.status` (two failures, four passing selected cases).
After the repair, all 246 corpus/startup/lifecycle cases pass and server typecheck
passes: `/tmp/sleep50-startup-after.log/.status` and
`/tmp/sleep50-startup-types.log/.status`. The existing native finalization and
retained cleanup consumer suite passes all 32 cases in a dedicated database:
`/tmp/sleep50-startup-consumers.log/.status`. All command handles are terminal.

This integrates only reassessment ownership. The aggregate orphan/finalization
sweep still runs for the other listed duties, so this is not whole-process SQL
quiet or host suspension. Remaining producer/authority audit, final acceptance,
publication and remote PR gates remain open, along with the older stack findings
and every remaining recurring-server obligation. No merge occurred.


## Producer closeout and PR validation checkpoint

The final source audit distinguishes reactivation from negative evidence. Handoff
creation uses a fresh identity in its transaction; delivery/renewal/completion
preserve accepted evidence. Cancellation can only revoke it and is locked by the
scheduled evidence guard. Existing task cancellation/assignment writers signal
through the task boundary. No permanent lease-renewal wake was introduced.
Target-agent existence affects attention validation, not criterion/verification
acceptance, so lifecycle status changes do not activate the three reassessment
predicates. Arbitrary missing identities have no row lock; the worker contract
states this limit rather than claiming a general identity-insertion fence.
Child completion remains a fresh-turn obligation enforced at status commit.
Latest-contract creation can invalidate an old result, not make it eligible again.
The only dormant retired-review prerequisites that can be restored in normal
operation are current run/task authority and workspace settlement/ownership;
their real transaction producers and lifecycle tests are recorded above.

At 0337779e6d, workspace typecheck and build pass, in addition to the 278 selected
integration/consumer tests. Evidence: /tmp/sleep50-workspace-types.log/.status and
/tmp/sleep50-build.log/.status. All handles are terminal. Fresh origin/master is
still 1fbbef45a8d399771add7a27a04b12f3a20e264c; the PR base remains slice 49.
No duplicate reassessment PR was found; related automatic-review migrations are
#17679 and #17680. Full-stack master reconciliation remains separate unfinished
work; the PR is not represented as a direct-master diff.

A direct disposable embedded initdb probe explains earlier full-suite failures:
FATAL could not create semaphores, No space left on device (semget), before tests.
/tmp/sleep50-pg-init-probe.log/.status preserves the failure. Read-only IPC/process
inspection found a candidate orphan group, but automatic approval review rejected
its removal because it changes shared OS resources and PID checks can race.
Explicit approval for those exact IDs is pending; no cleanup was executed. This
blocks local embedded-database acceptance, not dedicated PostgreSQL validation or
remote PR validation. The full goal is still incomplete and no merge is authorized.


## Review repair: direct claim release

Draft #17709 at 91a6c14170 passed all 52 CI checks but Greptile scored 4/5 and
identified a missing adminForceRelease wake (discussion 4376190896). This invalidates
the preceding producer-closeout claim for direct task-claim writers. The ordinary
task update method did not cover their separate transactions.

Six real regressions fail before repair: operator force-release, ordinary release,
terminal execution cleanup, terminal checkout cleanup, the queue's actual release
adapter, and outer force-release commit after rollback. Each starts with a retired
review dormant behind a different execution owner. The missing notification leaves
it untouched after that owner is released. /tmp/sleep50-release-before.log/.status
retains all six failures.

The release owners now await task-scoped reassessment intent before their existing
writes. The audit also covers queued-comment release, watchdog settlement, legacy
and native recovery, safe replacement, tree restoration and stale-lock cleanup.
Existing run-dispatch and queue branches that already notify task-wide milestones
retain that common hook. Case-handoff release already delegates to issueService
update. Rare member-archive bulk reassignment signals its company. No database
transaction wrappers, recurring retries or provider logic are added.

The first repaired run passed 36/37 cases. Ordinary release deliberately clears
the assignee, which advances task authority; the worker correctly appended a
preserve decision instead of completing the task. The test now requires that
preserved status, cleared assignee and exactly one additional decision. The initial
incorrect completion expectation remains recorded in /tmp/sleep50-release-after.log.
All 37 lifecycle cases now pass, including outer rollback/commit and SQL quiet.

Affected consumer suites pass: queue 25, queued comments 5, execution control 5,
safe replacement 59, access 18; native executor/restart, legacy recovery and tree
unit selection 829 pass with 15 known embedded-DB cases excluded. Thus 978 distinct
selected cases pass after repair. This is not full local-suite acceptance. Server
typecheck passes. Evidence: /tmp/sleep50-release-final.log/.status,
/tmp/sleep50-release-{queue,queued_comment,control,safe,access,runtime,types}.log
and .status. All launched command handles are terminal. Fresh-head remote CI and
review remain required. The full stack and its earlier unresolved gates remain open.


## Current master and landed parent qualification (2026-10-29)

Parent #17702 merged from exact reviewed head
`902817c46675d71fb17324683f39b9a39d6135e0` as
`79ce86630a79dad65e3b753c13e3d49e22bbca2f` with all 57 checks clean and
Greptile 5/5. No Ponytail review was present, which the authorized merge policy
allows. The normal parent merge retains 12661 parent/unrelated tree entries and
35 owned entries exactly. Twenty-one overlapping paths retain Git's automatic
three-way result. Five original conflicts are reviewed explicitly: scoped wake
fanout, conversation/session source locks, the extracted reassessment block,
and the unsafe-workspace omission-barrier notification. The complete held-child
tree is unchanged when reconciling the parent's actual squash ancestry.

The current parent's required quality-review policy also moves with the
reassessment owner. A required review is a business gate, not an operational
failure. Two real regressions exercise this on retired-review reassessment and
on committed work-product approval. Each optional control passes before repair;
each required case instead retains retries, reports repeated
`required_quality_review_incomplete` exceptions and reaches the unchanged
15-second limit. Porting the retired-review policy fixes the first path.
Reading the current task's quality policy for all completion-producing
reassessments fixes the evidence path too. Both required cases now record the
intended in-progress decision and become SQL quiet; neither bypasses the review.
The same assertions and time limits are retained.

Two more real SQL regressions cover dormant reassessment after three coarse
company-only milestone/finalization hints. A controlled negative baseline removes
only the ordinary issue/run guards; it reproduces nonzero response-history
reconstruction. Restoring the guards byte for byte passes the same cases with
zero reconstruction queries. Routine wake paths now remain scoped across all
three workers; the explicit company authority boundary still wakes genuine global
changes. Actual coalesced input and concurrent Photon recovery exercise all three
queues. Ten active Photon assertions produce zero hints/SELECTs per worker;
three concurrent attention assertions produce one wake/SELECT, then return quiet.
Paperclip callbacks and PostgreSQL are real; external Photon transport is mocked.

Broad source `9fddb3f0b1157df32b64fb1f22e9d6e9624470e8` passes **2731
distinct cases across 28 complete files**, with no skipped cases: 2458 across
27 producer/owner/authority/workspace/quality files in 394.43 seconds, then all
273 governed-response cases in 53.74 seconds. Nineteen dedicated PostgreSQL 17
fixtures migrate through 0413. Eighteen embedded-only fixture invocations use
the existing startRecoveryPostgres external-host helper, preserving a fresh
owned database per call and normal cleanup. All 22 temporary import adaptations
restore exactly and all 28 captured source hashes match. This qualifies external
PostgreSQL behavior, not embedded bootstrap on this semaphore-exhausted host.

The later evidence-trigger fix changes only the reassessment owner and adds its
two regressions. Final runtime source
`5ea3b0fd016bf7e63ba82a7044825a46a0cd2082` passes **1211 distinct cases in
five complete affected files** in 108.23 seconds: 43 worker cases, 145 status
corpus cases, 32 finalization-recovery cases, 968 native-session cases and 23
quality-review cases. Four dedicated fresh 0413 databases plus the quality
suite's own fresh helper fixture use PostgreSQL 17. Its one temporary import
restores exactly; all five hashes match. The other 27 broad-run test files are
unchanged. These results keep their separate source scopes; overlapping cases
are not cumulatively counted or described as a fresh complete 2731-case rerun.

Database build, production server types/build, module boundaries and full-SHA
migration order pass. Fourteen added comments in six files were removed with
identical nontrivia token streams and no directives removed. The final added-
comment check is empty. The database tree is identical to the landed parent:
no migration, snapshot generation or queue table is introduced here.

Earlier failures remain part of the record, including the two quality retry
loops, the controlled scope negatives, and inherited historical host/fixture
limitations. The local evidence-trigger runner reused an earlier composition-tree
metadata field; its addendum identifies the precise 9fddb production baseline
and before/after owner hashes without altering outcomes or test hashes. The first
actual-squash proof attempt lacked the newly created Git object; fetching the
object and rerunning establishes exact parent/tree identity before mutation.
No application failure was classified as infrastructure from a successful retry.

This is targeted local acceptance, not a full repository-suite or deployed-sleep
claim. Fresh exact-head CI, Greptile 5/5, and resolution of actionable reviews
remain required before merging this PR. Other workspace/session/cleanup duties
and Cloud sleep eligibility remain separate.
