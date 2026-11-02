# Inbound wake notices: sleep migration audit

Parent: #17639 at `34df8b0d0116a14d414a70d29f64a16c5672a335`.
Branch: `codex/sleep-30-inbound-wake-notices`.
Status: owner/producer audit in progress. Production still polls this duty.

## One reason and its adjacent owners

This slice owns the safe pre-run notices for admitted inbound chat messages:
queued, not started, and removed. The existing owner is
`chat-channels/inbound/wakeup-notices.ts`. These are projections of admission
receipts, not a second scheduler for executing the admitted task.

`chat-channels.ts::processPublicationMaintenance` calls the notice scan on every
chat maintenance pass. The explicit/manual `processPendingPublications` API also
calls it when maintenance is enabled. Production queued-publication delivery
already has a maintenance-free path, which should stay independent.

The current `enqueueInboundWakeupPublications` first invokes
`enqueueFailedChatRetryPublications`. That projects failed-run retry receipts,
with a separate authorization contract in `failed-run-retry.ts`. Separate this
adjacent reason rather than claiming both migrated by moving a compound call.
Terminal confirmation actions, interaction continuations, and GitHub maintenance
are additional separate reasons and remain pending.

## Durable contract

Existing `chat_actions`, `agent_wakeup_requests`, `chat_deliveries`, source
comments, publications and message links own the obligation. No new table is
needed. A normal inbound action must be processed or failed and have the exact
admission receipt. A coalesced receipt must resolve to a matching canonical owner.
Queued requires deferred execution without a run; a failed/cancelled/skipped
receipt must not be presented as a queue wait.

A not-started/removed follow-up can retire only the exact previously visible
queued notice. The published provider message ID and outbound message link are
part of that proof. Deleting one coalesced source must not erase a surviving
batch's response. Promotion, questions, selected final answers and replacement
provider lanes retain precedence. Text remains the existing closed phrases:
no input text, internal scheduler failure, queue position, ETA or model content.

`currentInboundWakeNotice` owns current issue, endpoint, identity and receipt
checks. It takes the existing nonblocking locks to avoid inversion with ingress
and scheduling. Preserve this authorization at projection and again at delivery.
A denied candidate is settled until a relevant mutation; lock contention is
unresolved work and needs a retry. The current catch treats both as zero inserted,
so a count-only return is insufficient once the permanent poll disappears.

## Selector and lifecycle work required

The current owner stores a process-global Date/UUID cursor between bounded calls.
That cursor belongs neither to a company nor to an issue and loses PostgreSQL
microsecond precision. Do not reuse it as a scoped worker cursor. Use stable SQL
precision and a complete per-pass continuation, advance past suppressed rows,
and preserve a concrete obligation when a page or lock remains unfinished.

Use the existing scoped-deadline worker. Startup reconstructs saved work; scoped
commits refresh only matching work; empty or settled history disarms. Retry only
contention, failed reconciliation and unfinished batches. Changes during a pass,
first writes during drain, failed startup, resume and shutdown require the same
shared lifecycle contract as earlier slices.

## Producer audit: do not remove the poll yet

- `inbound/wakeups.ts` settles actual accepted actions. It signals lifecycle
  projection for processed actions, but failed actions can also change notices.
  Preserve the distinction between durable admission and a callback returning.
- `heartbeat/queue.ts` creates deferred receipts, coalesces requests, promotes
  owners and changes terminal receipt status. Existing milestone signals cover
  some run transitions, not every receipt-only mutation. Inspect the existing
  writer transaction owners before adding a notification contract.
- `execution-wait.ts` can persist skipped admission without creating a run.
  Determine which transitions can create or retire an eligible notice.
- `issue-tree-control.ts` cancels queued/deferred receipts without runs.
  Its current notification is for terminal workspace cleanup, not these notices.
- `chat-channels/slack/session-stop.ts` can cancel a queued receipt. A signal for
  the stop-action worker is not automatically a notice wake.
- `companies.ts` cancels queued/deferred/claimed receipts during company state
  changes. Preserve company visibility and disablement behavior.
- Source-comment removal and later receipt promotion can retire a visible notice;
  audit `issues.ts`, message lifecycle owners and queued-comment control paths.
- Publication success/message-link persistence can make a retirement eligible.
  The existing issue-scoped publication notification is a possible shared
  invalidation boundary; ordinary lease/claim bookkeeping must remain narrow.
- Endpoint, connection, resource, identity, membership and task visibility can
  restore authority. Reuse the existing eligibility contract only after checking
  these notice predicates; lifecycle projection coverage is not proof by itself.
- Remaining production receipt writers include heartbeat run control/lifecycle,
  retries, recovery, task retry, human-directed work, native status decisions,
  continuations and provider-capacity retry. Classify supported notice-producing
  paths explicitly. A search hit alone is neither coverage nor a required wake.

Notifications must precede the write and follow the existing outer transaction.
Do not create an external call or a recovery object at every route. Do not wake
for unchanged health checks or claim renewal. Process-local signals retain the
single active writer model; external writers require their own integration.

## Acceptance

Existing integration fixtures `deferredChatQueueFixture` and its pre-run FIFO
cases exercise coalescing, restart, successor reuse, exact final/question lanes,
revoked reach, source deletion, identity/session changes, canonical owner IDs,
and receipt-lock contention. Establish that baseline, then add real-producer
worker tests with no manual projection call or periodic backstop.

New cases must prove configured-idle/history quiet, first durable admission,
outer commit/rollback, receipt-only cancellation, source removal after promotion,
visible-queue receipt ordering, restoration of authority, suppressed full pages,
scoping/fairness, lock retries, drain/resume, concurrent changes and shutdown.
Do not turn queued work into periodic notice polling after its notice is saved.

This audit changes no runtime behavior or Cloud eligibility. Exact implementation,
producer coverage and acceptance remain required before a migration PR is ready.

## Groundwork evidence

The existing 22 FIFO/notice integration cases pass in
`/tmp/sleep30-inbound-notice-baseline.log`. A new regression then reproduces the
cursor defect: 50 authority-rejected actions share a PostgreSQL microsecond
timestamp before one valid admitted action; two bounded passes both return zero.
Evidence: `/tmp/sleep30-notice-cursor-before.log`.

Preserving the timestamp as PostgreSQL text repairs that defect without changing
eligibility or batching. All 23 notice cases pass in
`/tmp/sleep30-notice-cursor-fixed.log` on a fresh isolated external PostgreSQL
fixture database. Production typecheck passes in
`/tmp/sleep30-cursor-typecheck.log`. The new test deletes its artificial candidates
so they cannot starve later tests. Scoped worker ownership and complete producer
coverage remain unimplemented; this is groundwork, not a polling-removal claim.

## Scoped owner and first producers (2026-10-25)

Parent notification repair `3447973f6f` is merged into this local branch.
The owner now exposes scoped candidate reconstruction and normal-notice-only
reconciliation. Each scoped pass has its own microsecond-precise keyset cursor,
advances past suppressed pages, and reports actual lock contention separately
from settled authorization denial. The manual API retains its bounded cursor
and combined failed-run retry behavior. The new scoped-deadline worker is
implemented but **not yet wired into production startup**; the periodic backstop
remains until all producer and lifecycle coverage is complete.

The existing lifecycle/authority notification boundary now also invalidates
normal inbound notices. Real chat admission wakes the worker after a quiet
startup, and settled/published history becomes quiet again. Removing that
notification makes the acceptance case fail (no queued publication), proving
the case exercises the producer rather than a manual scan.

Task-tree cancellation and source-comment tombstoning each reproduced a missed
retirement wake. Tree cancellation now registers intent inside its transaction;
caller-owned transactions retain outer commit/rollback semantics. Tombstoning
reads and locks the still-live comment's company/task binding before registering
intent and updating it; already deleted/missing comments remain no-ops. These
changes preserve existing notice text and current authorization. Tests deliver
the queued publication with maintenance disabled, perform real service mutations
inside a rolled-back outer transaction and then a committed transaction, and
observe the existing provider message being edited once. Two minutes of fake
idle time cause no further root select/transaction calls.

29 scoped/manual/admission/retirement integration cases passed in
`/tmp/sleep30-notice-producer-acceptance.log`. Producer regression evidence:
`/tmp/sleep30-notice-worker-before-producer.log`,
`/tmp/sleep30-notice-tree-cancel-before.log`, and
`/tmp/sleep30-notice-source-removal-before.log`. Initial worker-test failures
were missing `canRun` in its coordinator fixture and a wait that checked only
the timer while a sweep was still running; the corrected wait also requires
idle-work settlement. These fixture failures are not production defects.
Server typecheck passed in `/tmp/sleep30-notice-producer-typecheck.log`.

Still required: remaining receipt/cancellation writers (including budget, agent,
company and Slack stop paths), admission-failure settlement, authority changes
not already covered by shared notifications, batching/scoping/lifecycle tests,
production registration, and removal of only this duty from the maintenance
loop. Fresh PR creation and all checks remain outstanding for slice 30.

## Receipt audit refinement (in progress)

Do not mechanically notify every `agent_wakeup_requests` write. The normal
notice predicate requires an exact `inbound_wakeup` action, matching durable
receipt/canonical owner, and current source/destination authority. A first queued
notice requires an unadmitted deferred owner. A not-started retirement requires
both receipt and owner to have no run. Removed-source retirement instead requires
the exact visible queued message and a soft-deleted source; it can remain eligible
after surviving coalesced input promotes.

- First durable chat receipt insertion is followed by the existing
  `inbound/wakeups.ts` processed-action settlement, now carrying notice intent.
  Failed action settlement is still an explicit gap to address. Do not assume
  the earlier admission transaction alone establishes a processed action.
- `execution-wait.ts` increments counters on an already-skipped receipt or
  inserts a new skipped receipt. The counter update does not change notice
  eligibility; first-admission terminal settlement belongs to the action owner.
- `heartbeat/queue.ts` periodic `updatedAt` touches (queued-comment interrupt and
  stranded-queue inspection) and `run-control.ts` retry cursor touches must not
  wake notice reconciliation. `executionWait` explanatory-message-only updates
  do not change the closed notice text or eligibility.
- `explicit-native-continuation.ts` and `fresh-workspace-continuation.ts` change
  the task-retry workspace strategy only; no notice wake follows from that field.
- `human-directed-work.ts::retainBacklogHumanAssignment` inserts a completed
  board-provenance receipt, not a deferred inbound-chat admission.
- `setWakeupStatus` call sites found in heartbeat queue/control/completion,
  recovery and retries operate on a run's receipt. Recheck any exceptional
  run-less caller before adding a broad signal: a receipt with a run cannot
  produce not-started, and source tombstoning owns removed-source activation.
- Explicit cancellation paths still needing integration/tests include
  `run-control.ts::cancelPendingWakeupsForBudgetScope`, `cancelPendingWakeupsForAgentsInternal`, company archive cascade,
  Slack session stop, and queue replay paths that decline an unadmitted receipt.
- `issues.ts` reassignment cancels user receipts in the issue-update transaction;
  it currently signals lifecycle only for unhide, so that signal is not coverage
  of reassignment. Current-authority restoration and mutation ordering need an
  explicit test.
- Dot/Muse follow-up consumption changes deferred receipt payloads and can bind
  them to an already-running turn. Audit their provider-lane precedence rather
  than emitting a false not-started notice for consumed input.
- Task-retry and failed-run-retry generations have separate notice policy. Check
  whether normal inbound receipts may reference their canonical owners before
  deciding which writes belong to this reason or the next failed-retry slice.

The full chat integration suite was launched at local branch `c579148977` on a
fresh `paperclip_sleep30_full_chat_20261025_test` database, with output at
`/tmp/sleep30-full-chat-acceptance.log`; its result must be read before claiming
acceptance. Typecheck after merging the second parent repair passed in
`/tmp/sleep30-after-parent-typecheck.log`.

## Producer and lifecycle completion (2026-10-25)

The full chat suite at `c579148977` finished successfully: 1,458 tests in
`/tmp/sleep30-full-chat-acceptance.log`. This was the baseline before the
cancellation and privacy changes below, not acceptance of later edits.

Real service regressions reproduced stale visible queue notices after agent
cancellation, budget cancellation, and company archival. Signals now belong to
those owners' transactions, as well as Slack Stop and deferred queue cancellation
and failure. Agent cancellation now rechecks pending status and absence of a run
at update time, so it cannot cancel a receipt promoted after candidate selection.
Caller-owned transactions preserve outer commit and rollback. Company lifecycle
intentionally owns its root transaction; its test respects that contract.

Task status/assignment changes and privacy changes can restore eligibility.
Task privacy can affect descendants, so it invalidates the company scope. Explicit
task grants and private-project membership use their existing persistence owners;
the project-member helper owns a small transaction that also nests under callers.
Project visibility changes use the existing project transaction. Shared chat
identity, endpoint, resource and membership signals already cover the other
current-authority predicates. Ordinary health refreshes and receipt cursor touches
do not signal this worker. Run-bound settlement and Dot/Muse consumption do not
create a not-started notice; their existing response/progress owners retain that
policy. Failed-run retry notices remain a separate owner.

Failed inbound-action settlement and repaired delivery acceptance now invalidate
normal notices when a valid durable request exists. Preparing actions whose
underlying deliveries were rejected cannot satisfy the notice predicate and do
not acquire a notice obligation. Publication completion already signals the task
inside the transaction that saves the provider receipt and message link. A new
race test holds provider I/O, removes the source, observes the notice worker
settle before the receipt exists, and proves that the eventual receipt commit
reactivates the removed-source edit.

The app now registers `chatInboundWakeNoticeWork` with the existing coordinator.
`processPublicationMaintenance` retains only the separate failed-run retry notice
pass, plus its other unmigrated duties. The explicit/manual combined
`enqueueInboundWakeupPublications` API remains available.

Focused acceptance at the current source passes 42 cases in
`/tmp/sleep30-wired-acceptance.log`. These include actual admission after idle,
scoped/manual cursor pagination, denied history, receipt-lock contention,
transaction rollback and commit, queue rejection/failure, agent/budget/company
cancellation, privacy restoration through task grants and project membership,
signed Slack Stop, late provider receipt, restart deduplication, writes after
shutdown, first write and failed selection during drain, and a commit arriving
while an empty selection returns. Quiet assertions observe root SQL entry points
after advancing fake time by two minutes. The lifecycle tests do not prove host
or database suspension, and no Cloud sleep-safety blocker is relaxed.

Preserved failures and fixture corrections:
- `/tmp/sleep30-cancellation-before.log`: agent cancellation missed its wake;
  an attempted agent reassignment fixture was rejected by the existing external
  channel binding rule. The unsupported fixture was removed, not bypassed.
- `/tmp/sleep30-budget-company-before.log`: budget cancellation missed its wake;
  company lifecycle correctly rejected a caller transaction. The root-company
  reproduction in `/tmp/sleep30-company-root-before.log` then showed its missing
  wake. All five initial retirement cases passed after the repair.
- `/tmp/sleep30-notice-privacy-before.log`: opening a private task did not wake
  its saved notice. The repair passes. Initial grant tests used an unlinked
  external principal as a user; corrected fixtures establish a linked board user
  through the normal chat setup before admission.
- The first signed Stop fixture had an invalid Slack channel ID and a verifying,
  rather than qualified active, endpoint. Correcting both makes the signed event
  reach cancellation. `/tmp/sleep30-signed-stop-qualified.log` passes.

Workspace typecheck/build, full acceptance after startup wiring, PR publication,
and latest-head CI/review are still required before this slice is ready.


The first workspace-wide typecheck and build at `d4f7426bb4` found a missing
required limit in the newly separated failed-retry maintenance call (TS2554).
The corrected call passes 50, preserving the old combined wrapper's default.
The full chat run at that revision was deliberately interrupted (exit 130) after
this compiler evidence; it is not acceptance. Its log remains at
`/tmp/sleep30-wired-full-chat.log`. Fresh verification is required after repair.


## Bounded candidate passes after review

At `87f5c827b0`, workspace typecheck and build passed, and the full chat plus
startup-gate selection passed all 1,486 tests in
`/tmp/sleep30-final-full-chat.log`. CI subsequently passed every code gate;
Greptile found a real fairness defect (comment 4371894496): the reconciliation
limit counted inserted notices rather than candidates authorized, so a denied
history could monopolize one pass.

The new regression fails before repair in `/tmp/sleep30-fairness-before.log`:
a requested 50-candidate pass opens more than 50 candidate transactions. The
repair returns a precise continuation cursor after at most the requested page
size. The notice worker retains that cursor between scheduler passes. It also
retains contention from earlier pages and, after reaching the end, revisits it
from the beginning rather than silently discarding locked work. A committed
scope invalidation reconstructs the entry with a fresh cursor; no shared
scheduler or authorization policy changes are needed.

All 44 selected integration cases pass in
`/tmp/sleep30-fairness-acceptance.log`, including a 150-row denied backlog,
an unrelated task completing between bounded passes, contention on the first
page surviving a later page, and a real privacy-restoration write while a page
is in flight. The latter revisits the formerly denied prefix, publishes exactly
once, and then performs no root SQL for two minutes of fake idle time. Manual
pagination remains separate and retains PostgreSQL microsecond precision.
Server typecheck passed after the cursor contract change. Full latest-head
remote checks and review must be revalidated after pushing the repair.

The next owner audit must explicitly trace ordinary receipts coalesced into a
failed-run retry receipt: `findExistingDeferredWake` does not itself exclude a
retry owner. `allowRunCoalescing: false` on the retry's own admission is not
proof that a later ordinary admission cannot select it. In particular, inspect
the retry authorization-denial write before assuming it can only affect retry
notices. This is an open producer-audit question, not a verified exemption.


## Current-parent baseline and producer follow-up (October 28)

The existing slice is prepared with a normal merge of the verified cancellation
parent `09c0b8dc92f589d0a3c53716581e43863a0bb819`. Its original published head is
`ca8f2d17c64fc7cecff4526817d1ac6e1d479ff4`, with own base
`fffc8d0c46fbbeb3da4a23a36e638fefd3b8fe3d`. All original added/removed lines and
remaining diff context are preserved. Differences in the patch representation
are blob IDs, line coordinates, and one inherited decision-target import that
was renamed in the current parent. The automatic merge is clean; the renamed
import and every unrelated parent path are retained.

The existing-patch baseline passes **190 distinct selected cases**: all 142
cancellation, app-wiring, admission-application and queued-comment application
cases across four complete suites, plus 48 real chat cases selected for inbound
notices/FIFO/deferred-admission behavior. The other 1,598 chat cases were skipped,
not passed. Server typechecking, build, and module boundaries pass. Logs and
zero-status receipts are in `/tmp/sleep30-current-parent-*`; the exact selected
commands and isolated fixtures are in
`/tmp/sleep30-current-parent-baseline-command.json`.

This is baseline evidence, not a ready-to-merge claim. The mixed ordinary/retry
receipt producer question above remains open in this checkpoint. Source tracing
confirms that a later ordinary admission can select an existing retry-owned
deferred receipt: the reader has no retry-owner exclusion, and disabling
coalescing on the retry's own request does not exclude later ordinary requests.
The following failed-retry slice already adds ordinary-notice notifications to
retry authorization/admission and conditional denial retirement. Determine which
minimal writer coverage must move into this owner before publication; verify its
transaction behavior rather than claiming those receipts cannot be shared.
Final producer disposition, updated acceptance, actual landed-parent integration,
and fresh exact-head remote gates remain required. No complete local repository
matrix, live provider, host/database suspension, or savings claim is made.


## Shared retry-receipt producer gap resolved (October 28)

The current preparation adopts verified cancellation parent
`60ba892ae9fc5faaf8cd0833694b4a66c13323c3`. Its complete original inbound-notice
baseline patch remains identical through that parent update. The following
producer repair closes the explicitly open question above before this owner
is published.

`findExistingDeferredWake` can select a deferred retry receipt for a later
ordinary admission with matching task, conversation, and actor. The retry's own
`allowRunCoalescing: false` controls its initial admission, not that later read.
Ordinary receipt resolution follows `coalescedIntoWakeupRequestId` to its owner;
owner retirement can therefore change an ordinary notice. Do not exempt retry
writers merely because their initial admission disables coalescing.

Two already-implemented writer fixes are moved forward from the following
failed-retry slice (#17649, source `b47169855cc712e029df7e5c4c34f7b6fa04b9d4`):

- The durable retry authorization callback registers ordinary-notice work after
  validation and before its caller writes the receipt. This keeps the contract
  central for both real heartbeat admission and supported callback-owned writes.
- Retry authorization denial retires the exact unadmitted receipt in a transaction
  that registers its company/task notice intent before the existing guarded update.
  Pending-status, absent-run, and request-correlation conditions are preserved.

No new worker, table, scheduler, polling fallback, or per-caller recovery wrapper
is added. These production hunks match the already-existing following slice.
Its remaining failed-retry projection and lifecycle/lease producers keep their
separate ownership. Ordinary notice authorization does not read native lease or
coordinator retry eligibility, so those later predicates are not copied here.

Two new real producer regressions fail before repair and pass afterward:

1. A supported callback authorizes and writes a real deferred retry receipt in
   its own transaction. There was no notice intent before the write. The fixed
   callback emits intent before the write and settlement after outer commit.
2. Real heartbeat admission creates the retry receipt. After actual retry receipt
   reconciliation, denial reaches its conditional retirement. A second PostgreSQL
   transaction holds that receipt row: the fixed writer emits exact company/task
   intent while the outside connection still sees deferred status, remains unsettled
   while blocked, then publishes settlement only after the failed-status write commits.

These verify actual producers and transaction timing. They do not claim a complete
mixed ordinary/retry ingress walkthrough; the admission reader, receipt resolver,
scoped consumer tests, and the shared owner writes establish the audited boundary.
The first lock fixture acquired the row too early and blocked admission itself;
that invalid before-fix attempt is preserved at
`/tmp/sleep30-retry-owner-red.log`. The corrected missing-intent failure is
`/tmp/sleep30-retry-owner-actual-red.log`. The callback failure is
`/tmp/sleep30-retry-admission-red.log`; both pass together in
`/tmp/sleep30-retry-producers-green.log`.

Moving the callback contract also exposes the existing budget-refusal test mock's
root `request.authorize(db)` call. The real writer passes its transaction. The
local still-budget-blocked case failed with no skipped receipt and a contended
retry classification (`/tmp/sleep30-retry-budget-red.log`). Its correction is the
same transaction fixture fix already present in #17649: authorize and persist
inside one transaction. All requester, comment, skipped-status, and budget checks
remain; production budget behavior is unchanged. The reusable deferred-retry
fixture is copied from that following slice for the two new producer cases.
When reconciling #17649, retain one identical helper and do not duplicate it.

### Final current-parent acceptance

**264 distinct selected cases pass**, with separate newly created PostgreSQL
fixtures for reconstruction, broader retries, and cancellation consumers:

- **142 complete consumer cases** across cancellation/run control, app admission
  wiring, wake admission use cases, and queued-comment admission use cases.
- **50 selected ordinary-notice cases**, including both new producer regressions;
  the other 1,598 chat cases were skipped.
- **72 different retry cases**, covering the full newer-input budget-hold family,
  current GitHub Retry, and persisted Retry authority loss; the other 1,576 chat
  cases were skipped. These selected names do not overlap the 50-case group.

Server typechecking, build, and module-boundary checks pass. The tests under
`src/__tests__` were executed separately from production typechecking. The exact
commands, fixtures, logs, and zero exit receipts are in
`/tmp/sleep30-final-acceptance-command.json` and `/tmp/sleep30-final-*`.
`/tmp/sleep30-final-tested-source-sha256.json` records the 20 owned source/test
hashes held stable throughout the final validation.

The earlier 190-case baseline and older full-suite counts retain their stated
revision scope and are not added to 264. This completes the named producer audit
for this owner; actual landed-parent reconciliation and fresh exact-head CI/review
remain publication and merge gates. There is no full local repository matrix,
live provider tenant, external-alarm, physical suspension, or savings claim.


### Acceptance on actual landed master

The final normal ancestry merge is `875a6ee8d211cba7f0499aace7fcea7f6880c4a2`,
based on actual master `b14e1ecaf85ce6eafa05125f1b539e3ac7f32022`, after
cancellation #17895 merged. The complete 22-path notice patch is binary-identical
across that integration and all 58 unrelated master paths are preserved.

Master added agent YAML configuration/shared types, bounded upgrade admission,
and runner human-input contracts. Patch identity alone does not establish their
combined runtime behavior. Updated shared dependencies, server typechecking,
build, and module boundaries pass. The same **264 distinct cases** then pass
again on this actual combined revision: 142 complete consumer cases, 50 selected
notice cases, and 72 separate retry/budget cases, using new isolated databases.
The selected skipped counts remain 1,598 and 1,576 respectively. These repeated
runs do not represent 528 different tests.

Exact commands, revision, and actual fixtures are in
`/tmp/sleep30-landed-acceptance-command.json`; logs and zero exit receipts are
`/tmp/sleep30-landed-{shared-build,types,build,boundaries,consumers,notices,retries}.*`.
All 20 owned source/test hashes remain unchanged from the recorded acceptance
manifest. The only subsequent publication edit adds this documentation. Fresh
remote current-head CI and review remain required before protected merge.


### Review repair: discover scopes without rereading action pages

Greptile's current-head 5/5 summary also contained a valid P2:
[discovery rereads denied history](https://github.com/paperclipai/paperclip/pull/17647#discussion_r4386889825).
A task notification already contains its scope, but discovery reread every page
of denied actions before bounded authorization could begin. Company/startup
selection likewise transferred all candidate actions merely to deduplicate tasks.

Task notifications now return their supplied scope without SQL. The subsequent
bounded reconciliation remains responsible for checking current candidates and
authority, including an already exhausted scope. Company and startup discovery
use one SQL DISTINCT projection of company/task identifiers. The same candidate
query supplies both discovery and bounded selection, preserving its owner,
company, UUID, source-removal, and publication predicates. Broad discovery may
still inspect candidate history within PostgreSQL; this is not a constant-cost
query or a new recurring scan.

Three real PostgreSQL regressions seed 250 denied candidates and a second company.
They fail before the fix (two discovery queries instead of zero/one), then pass:
zero discovery queries/rows for task hints, one query with only distinct scope
rows for company/startup. The existing exhausted-history assertions now exercise
company discovery; task hints deliberately need no database existence check.
Cancellation, projection budgets and precise cursor behavior remain unchanged.

The revised matrix passes **267 distinct cases**: 142 complete consumer cases,
53 selected ordinary-notice cases (1,598 skipped), and 72 separate retry cases
(1,579 skipped). Fresh isolated databases keep retained obligations independent.
Server typechecking, build, and module boundaries pass. Exact commands/fixtures
are in `/tmp/sleep30-discovery-final-acceptance-command.json`; before/after evidence
is `/tmp/sleep30-discovery-{red,green}.log`, and acceptance logs/status receipts
are `/tmp/sleep30-discovery-final-{consumers,notices,retries}.*`.
The earlier 264-case acceptance retains its original revision scope. None of
these runs establishes full local repository acceptance or deployed sleep.


### Review repair: restore ordinary Retry input in its notifying transaction

The fresh review of `661f2f6da8c6c22cdcc25edccd57502ee6fa8c4b` reports
[restored input stays silent](https://github.com/paperclipai/paperclip/pull/17647#discussion_r4404007181),
P1/4 out of 5. Earlier retry admission and denial notifications do not cover
`releaseUnadmittedTaskRetryInput`: reconciliation invokes this owner after the
failed action settles, and its separate transaction restores coalesced ordinary
receipts to deferred status. A consumed earlier wake cannot cover that later
commit. The earlier writer audit missed this restoration transaction.

The restoration owner now awaits the existing company/task notice intent after
its action/issue/receipt guards and before updating the ordinary receipts. The
same transaction restores input and retires its unadmitted task Retry intent.
No guard, source authority, table, scheduler or per-caller wrapper is added.

The causal regression seeds an unadmitted failed Retry owner and uses the real
input-claim transaction on supported ordinary chat input. It starts the actual
notice coordinator, consumes an earlier committed scope wake, and observes no
notice and two virtual minutes without select/transaction calls. Calling the
real release owner then exposes the restored row. Before the fix, the test fails
because this transaction emitted no intent. After the fix, intent/settlement and
the queued publication appear, and the coordinator settles without a deadline.
This is real PostgreSQL producer/consumer boundary proof with seeded durable
Retry-refusal state, not a complete public Retry request failure walkthrough.
The separate existing GitHub Retry compatibility cases exercise supported flows.

Current restoration acceptance passes **126 distinct selected cases**: 54
ordinary-notice/FIFO/producer cases (1,598 skipped) and 72 separate retry/budget
cases (1,580 skipped), using fresh independent databases. Server typechecking,
build and module boundaries pass. The prior 267-case discovery matrix retains
its original revision scope; unchanged complete consumer suites are not counted
as freshly rerun for this two-line producer hook.
Commands/fixtures: `/tmp/sleep30-restore-input-final-acceptance-command.json`.
The valid missing-intent failure remains in `/tmp/sleep30-restore-input-red.log`;
final results/exit receipts are `/tmp/sleep30-restore-input-final-{notices,retries}.*`
and `/tmp/sleep30-restore-input-{types,build,boundaries}.*`.
Fresh current-head remote CI and Greptile 5/5 remain mandatory. No full local
repository acceptance, live provider wake or physical suspension is claimed.


### Reconcile durable comment writes on current master

After the restoration repair earned exact-head Greptile 5/5, master landed
#17960 at `d30c8f42b842327ee1c18c41a2efd6ba623da5cd`. Its 62 changed paths
include durable comment receipts and task-before-comment mutation locking.
The normal merge `1720b685d9d5fb9cb4377223fdaa0a9fae2aff9c` resolves two conflicts:
both route imports remain; soft deletion takes the upstream task lock before
our source-comment row lock and awaited notice intent. Receipt completion and
task deletion therefore retain their common lock order.

Both branches' complete added/removed patches are preserved in both directions;
only diff blob hashes/hunk metadata are excluded from the comparison. All
non-overlap upstream blobs and deleted paths match master exactly. This is not
a claim of full-context or binary identity for the two overlapping files.
`/tmp/sleep30-durable-comment-master-composition-proof.json` records the proof,
including the corrected check for an upstream-deleted UI hook.

Combined revision acceptance passes **202 distinct cases**: all 148 cases in
three durable receipt/reopen/wakeup suites, including the real embedded
PostgreSQL receipt concurrency suite, plus 54 notice/FIFO/producer cases on a
fresh external PostgreSQL fixture (1,598 skipped). Server typechecking, build
and module boundaries pass. Logs/exit receipts use
`/tmp/sleep30-durable-comment-{receipt-acceptance,notices,types,build,boundaries}.*`.
The earlier 126-case restoration and 267-case discovery records retain their
original revision scopes. A following documentation-only commit leaves the
21 owned server source/test hashes unchanged, as recorded in
`/tmp/sleep30-durable-comment-tested-source-sha256.json`.

The earlier `661f2f6da8` CI run also failed the existing voice report reconstruction
quiet assertion after 105 fetches (one late transaction). All 15 voice lifecycle
cases pass unchanged on a fresh local database. No assertion or production code
was relaxed and no CI retry was used. This is not a proven root cause; the full
current-head CI must pass. The original failure and local result remain in
`/tmp/sleep30-discovery-ci-server3-direct.log` and `/tmp/sleep30-voice-ci-baseline.log`.
Fresh CI and review are required for the final publication, including when an
older head already earned 5/5. No deployed sleep claim is added.
