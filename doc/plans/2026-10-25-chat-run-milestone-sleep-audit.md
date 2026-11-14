# Chat run-milestone projection sleep audit

Baseline: Teams attempt recovery #17592 at f53ae3d6d2.
Branch: codex/sleep-28-chat-run-milestones.
Status: lifecycle worker registered in production; recurring lifecycle projection
removed. Selected local worker, authorization and assembled-app acceptance passes.
Final full-stack reconciliation, CI/review gates and older parent findings remain open.

## Current production disposition

The app registers `chatRunMilestoneWork` with its existing delivery coordinator.
The remaining periodic chat lane calls only `enqueueSafeNativeChatProgress` and
is named native progress in the coordinator and tests. The explicit/manual
combined reconciliation API remains available, with its original shared budget.
Publications created by the lifecycle worker notify the existing delivery owner.
The coordinator owns subscriptions, retained dirty scopes, retries and shutdown;
no independent timer or extra table is introduced. Cloud sleep proof is unchanged.

The audit's remaining alternatives were classified against actual reader fields:

| Alternate writer family | Disposition |
| --- | --- |
| Monitor semantic receipts | The real tool writes receipt plus monitor atomically before future admission; covered queue admission establishes the successor. |
| Retry scheduling in heartbeat/recovery/native replacement/capacity owners | Creates `scheduled_retry`, outside lifecycle selection. Covered promotion/claim introduces eligibility; coalescence counts and retry-strategy metadata do not supply lineage. |
| Native status dispatch and effect receipts | Existing issue-scoped signals cover original coalesced intent, dispatched wake/run binding and delivered effect. |
| Generic wake settlement | Ordinary queued→claimed/completed retains existing admission predicates; cancellation/skipping removes authority. Run status/queue producers already signal their corresponding run transition. No new general wake-count loop is needed. |
| Execution-wait, human-directed assignment and tree cancellation | Diagnostic skipped receipts have no run; human assignment has its distinct source; tree cancellation selects unclaimed null-run receipts. None creates an admitted monitor/interaction/native-status successor. |
| Task-retry, preserved-result and fresh-workspace receipts | Distinct task_retry/strategy metadata; actual successor run admission/finalization is covered. |
| Dot/Muse assignment follow-up receipts | Board conversation/issue-comment paths; they do not establish external lifecycle lineage merely by sharing an issue. |
| Slack Board reply bindings | Source issue.comment uses its own response path; it is excluded from lifecycle candidate sources. |
| GitHub configuration | The only configuration writer upserts; deletion is endpoint/company teardown rather than restoration. Upgrading disables automatic queued/working notices. Guest/sponsor changes can restore post-close authority and now signal before mutation in the existing locked transaction. |
| Initial local-board membership / agent compatibility backfill | Startup precedes worker reconstruction; agent-only memberships do not restore human authority. Live Cloud and board-claim human restoration now has signals. |

This table complements the real producer cases and chronological audit below;
it does not claim independent SQL writers or another replica are covered.
The source of truth remains existing rows and the original 24-hour run window.
Company hints are used only for broader configuration/authority operations;
issue hints cover lineage and its descendants. Settled projection does not retain
periodic discovery merely because history or configuration exists.

Latest local evidence:
- GitHub guest-setting transaction regression failed before its signal in
  /tmp/sleep28-github-config-before.log; the production owner now emits intent
  before mutation, settles after the outer commit, and stays silent for an
  unchanged settings save. Four real GitHub settings/guest/authorization cases
  pass in /tmp/sleep28-github-config-acceptance.log.
- All 159 cases in seven worker/lifecycle/identity/recovery/governed/resource,
  app-coordinator and startup suites pass in
  /tmp/sleep28-production-worker-acceptance.log. These include configured idle,
  retained history, first producer, outer rollback/commit, retry, restart,
  drain/resume and shutdown tests; not every case runs the full HTTP app.
- All 16 project-chat Playwright cases pass against a fresh assembled app at
  port 32658, database paperclip_sleep28_production_e2e_20261025_test.
  Log /tmp/sleep28-production-e2e.log; traces /tmp/sleep28-production-e2e-results.
  This includes split-handoff cancellation and experiment restoration, but local
  success does not resolve the observed remote cancellation deadlock.
- Server production typecheck passes in /tmp/sleep28-production-worker-typecheck.log.
  The compiler excludes tests. Server build passes in
  /tmp/sleep28-production-worker-build.log, and the four GitHub owner cases pass
  again after the endpoint-deletion race guard in /tmp/sleep28-github-config-final.log.
  No fleet suspension/cost result is claimed. Final remote gates remain required.

## Historical implementation checkpoints

The entries below preserve earlier incomplete states, failures and subsequent
repairs. Their statements that production still polls describe those checkpoints;
the current production disposition above supersedes them.

## Separate obligations discovered

The app's recurring chat coordinator invokes enqueueChatRunMilestones. The same
method also invokes enqueueSafeNativeChatProgress when the milestone batch does
not fill its limit. These are different reasons and must have separate migrations:

1. Coarse run lifecycle projection: queued, working, waiting for input, completed,
   failed. Existing heartbeat run state plus conversation/continuation lineage
   determines whether a safe milestone is owed. This is slice 28.
2. Native progress-event projection: admitted heartbeat_run_events and current
   run/presentation authority determine which safe progress update is publishable.
   Keep this as the next separate reason; do not silently remove its only sweep.

Both produce existing chat_publications and already notify publication delivery
before insert. No queue table should be introduced merely to migrate projection.
Existing publication identity is run/milestone/endpoint. Respect the existing
24-hour selection window until its semantics are explicitly audited.

## Existing owner and correctness constraints

server/src/services/chat-run-publications.ts owns lineage, source-authorized safe
text, final-comment suppression and GitHub owned-provider-interaction suppression.
Keep this policy there or in cohesive chat publication modules. Shared scheduler
and app wiring must not interpret run/provider payloads. This is projection, not
execution recovery; never dispatch another run to produce a missing notice.

A succeeded run is not eligible until its durable presentation decision exists.
Explicit authored final publications suppress generic completion. Answered
questions, direct interactions, issue monitors and task continuations each supply
lineage. Run state alone is therefore not a complete producer inventory. Audit
writes to those associations, presentation decisions, final publications,
conversation bindings and policy/authority changes before removing the backstop.

The current live-event fast path calls notifyPublications only while not draining
or in standby. It is not a durable commit protocol and can drop a first wake during
drain. Use supported transaction boundaries and the shared coordinator, preserve
outer commit/rollback and uncertain outcomes, and reconstruct existing debt on
startup. A zero inserted count can mean contention or suppression; it is not by
itself proof that no projection remains. Distinguish passive/suppressed history
from recoverable lock contention and dependency changes.

Current pagination uses JavaScript Date for run updated_at and native event
created_at cursors. Audit precision when preserving or replacing it; PostgreSQL
submillisecond values must not duplicate/skip candidates or pin a page. Preserve
company fairness, bounded work and existing publication deduplication.

## Required next investigation

- Enumerate every supported lifecycle/presentation/lineage producer and its
  existing notification/transaction owner. Inspect heartbeat boundary rules.
- Separate the combined function without changing the explicit/manual contract
  or losing native progress while its own migration is pending.
- Define an observable unfinished-work predicate and a scoped candidate loader;
  ordinary settled history must disarm. Avoid global scans for every run hint.
- Prove real normal completion, authored-final suppression, question/direct/monitor
  continuations, configuration changes, backlog fairness, contention retry,
  rollback, startup, drain/resume and shutdown. Keep external source authority.
- Keep current Cloud blockers and external alarm limits. Single active process
  through the owning DB client remains the supported signal model.

All earlier stack remote gates, #17490 E2E cancellation, #17580 unresolved cleanup
policy, and final master reconciliation remain required. No merge authority or
full-goal completion is implied by this audit.


## Projection boundary checkpoint

`enqueueChatRunLifecycleMilestones` now owns only coarse lifecycle projection.
`enqueueSafeNativeChatProgress` exposes the existing native progress owner.
The existing `enqueueChatRunMilestones` entry point still combines them with
lifecycle priority, the same 24-hour default window, and one capped insertion
budget. Production still calls that combined entry point. No periodic owner has
been removed prematurely; this checkpoint is not completion of slice 28.

The lifecycle cursor now carries PostgreSQL's timestamp text through a typed
`(updated_at, run_id, conversation_id)` tuple comparison. With 30 unauthorized
candidates at a submillisecond timestamp, the old Date cursor repeated a page
indefinitely, never reaching valid notices. The test caps candidate page reads
so reproducing the defect cannot leave an asynchronous SQL loop after a timeout.
Native progress has its own timestamp cursor; its precision audit belongs to
that next migration and is still required.

### Producer coverage still to implement

The current readers establish these dependencies. This table identifies signal
owners to audit; it does not claim those signals are already installed.

| Dependency | Owning paths and required wake |
| --- | --- |
| Run admission/status/issue binding/error code | `heartbeat/queue.ts`, `heartbeat/run-lifecycle.ts`, and native/legacy recovery writers. Existing `notifyExecutionRunWork` covers only some paths. Audit raw writes before adding milestone coverage. |
| Presentation decision and native result | `heartbeat/run-completion.ts`, native finalizers, and semantic receipt writers. Succeeded alone is insufficient: presentation may settle later. Source monitor receipts can authorize a successor without changing the successor row. |
| Question response claim and terminal receipt | `question-response-delivery.ts`: claim moves to delivering; `recordTerminal` owns a transaction that records target run/status. A late receipt can redirect an existing run's publication destination. Lease timestamp renewal is not a new presentation obligation. |
| Interaction state and source-run ownership | `issue-thread-interactions.ts`, plus recovery writers. Pending agent-authored questions suppress generic finals even before publication; resolved prompts can retain that suppression. |
| Published prompts, final comments, and close controls | Publication settlement and `issues.ts`. Published prompt receipts enable lineage; authored finals suppress generic completion; a published close requires fresh independently admitted sources before later presentation. Publication notifications must avoid a global scan feedback loop. |
| Inbound comment links and conversation binding | Ingress and conversation owners. The run's source string alone grants no authority. Endpoint assignment, publication mode, conversation state/issue and verified comment links matter. |
| Continuation wake/decision/effect receipts | `native-continuation-delivery.ts` reads applied status decisions, delivered continuation effects, the original wake and dispatched wake, plus responsible-user continuity. Audit their writers; a run notification before these commits is too early. |
| Monitor wake and source semantic receipt | `native-monitor-delivery.ts` requires an admitted monitor wake plus the source run's exact saved `set_task_monitor` receipt. Audit both writers, including late completion. |
| Board reply identity and provider configuration | `slackBoardReplyBindings`, endpoint configuration, and upgraded GitHub configuration affect selection. Scope configuration invalidation to its company/endpoints; preserve each provider's existing policy. |

`resolveChatOriginPublicationBindings` also follows arbitrarily long verified
lineage with cycle rejection. Changing an ancestor can affect a successor; a
strict run-ID-only invalidation is insufficient for all producer families.
Issue-scoped reconstruction is appropriate for lineage changes. Run-only hints
can be used only where the writer cannot affect descendants. Shared scheduling
must not decode provider context or implement this authorization graph.

The coarse projector currently waits on its writes and does not use skip-locked
selection. A zero insertion count may be an authoritative suppression or a
concurrent idempotent insert; database failures must retain retry. Native progress
has different lock/contention behavior and must not inherit that conclusion.

### Verification and failure record

- Initial owner split: nine selected PostgreSQL integration cases passed,
  including separate-owner/combined-budget checks and six provider/surface cases.
- First cursor reproduction incorrectly guarded every `db.select`, including
  legitimate authorization reads, and ran against retained earlier fixtures.
  Both precision variants failed that overly broad guard; this was not evidence
  of the production cursor defect. Log: `/tmp/sleep28-precision-before.log`.
- Corrected guard counts candidate-page reads. In a fresh database the millisecond
  case passed; the submillisecond case failed after 100 repeating pages. Log:
  `/tmp/sleep28-precision-clean-before.log`.
- After retaining PostgreSQL precision, ten selected integration cases passed in
  a fresh database. Log: `/tmp/sleep28-projection-fixed-tests.log`.
- Broader final selection: 31 integration cases passed (1,398 unselected),
  covering milestone authority, native progress, lock contention, question
  continuations and authored finals. Log: `/tmp/sleep28-projection-acceptance.log`.
  These overlap the earlier ten and are not additive.
- All 20 publication policy unit cases passed; server production typecheck passed.
  Logs: `/tmp/sleep28-publication-unit.log`, `/tmp/sleep28-server-typecheck.log`.
  Server typecheck excludes test files. No full-workspace acceptance or new PR
  readiness is claimed for this preparatory checkpoint.

Parent #17592 at `f53ae3d6d27c2642e7dfe647a2c0a9bbf2d582ac` now has passing
Actions/security/Greptile gates, no inline review findings, and a neutral
Paperclip Review result. Neutral is not a completed positive review. #17590 at
`e501d6c99d721d6428f8c490206417765c76f4f6` has passing gates with Paperclip Review
queued at inspection. #17586 also has a neutral Paperclip Review. Final review
acceptance remains separate. Refreshed master is `2e47c42fad`; stack reconciliation
remains required. No stack PR was merged.


## Scoped worker and initial producer checkpoint

`chat-run-milestone-work.ts` now reuses `registerScopedDeadlineWork`. Its loader
shares the lifecycle candidate selector with the explicit projector, retaining
all existing SQL eligibility fences and timestamp precision. It reconstructs
one entry per company/issue, with a bounded 100-publication projection batch.
A full batch remains immediately due; a short batch has exhausted the selector
and disarms, including currently suppressed lineage. Real selection/write
failures retain the shared retry backoff. The scheduler owns coalescing,
company fairness, first writes during drain, concurrent changes, and shutdown.
No new persistent queue or independent timer is introduced.

`notifyChatRunMilestones` carries only company/issue identity through the existing
outer-transaction protocol. Issue-scoped invalidation includes descendants;
company scope is available for broader configuration or lifecycle changes.
Unrelated issues/companies are not reconstructed for an issue hint.

Initial production integrations now await intent before writing:

- `heartbeat/run-lifecycle.ts::writeRunStatus`: both shared status transition
  callers signal the known company in their existing transaction. This is a
  conservative company hint; it is not proof that all raw run writes are covered.
- `heartbeat/run-completion.ts`: the late presentation-decision write now owns
  a short transaction and signals its issue (company fallback when unbound).
  Provider execution and presentation generation remain outside that transaction.
- `question-response-delivery.ts::recordTerminal`: the existing transaction
  signals the issue before recording the durable target run and outcome.

The production app still uses the combined periodic projector. The new worker
is exercised through actual coordinator registration in tests but is not yet
registered by `app.ts`; do not remove the sweep until the remaining producer
families in the table above are implemented. In particular: queue admission and
recovery writers, native finalization and semantic receipts, question claim/retry
transitions, interaction changes, publication settlement, conversation/endpoint
changes, and decision/wake ledger changes remain to be covered. The late legacy
presentation signal is implemented, but its own full completion integration
proof is still required. Current Cloud blockers and single-active-writer limits
remain unchanged.

### Worker and producer verification

15 real-PostgreSQL worker cases pass in
`/tmp/sleep28-worker-question-tests.log`. They cover configured idle/internal
runs/old history, startup and restart, first committed work, outer commit and
nested rollback, first wake during drain, issue/company isolation, suppressed
lineage reactivation, late presentation eligibility, 205 notices plus another
company, selection failure through drain, publication-write retry, a concurrent
commit during projection, shutdown, real cancellation and real question delivery.
Quiet assertions advance two minutes and observe zero DB selects/transactions.
The deadline test verifies no scans during the ten seconds before retry.

The two real producer proofs are causal, not just notification-spy assertions:

- Removing the actual `writeRunStatus` signal makes the cancellation test fail:
  the queued notice exists but the terminal notice is absent. Restoring it passes.
  Log: `/tmp/sleep28-cancellation-without-signal.log`.
- The question test creates and answers a real interaction, supplies a durable
  published prompt, and invokes the real delivery service. Its wake callback
  inserts the continuation without a milestone signal and proves no notice is
  projected yet. The terminal receipt then activates the worker. Removing that
  exact signal strands the notice and fails the assertion. Log:
  `/tmp/sleep28-question-without-signal.log`.

The 31-case existing chat integration selection passes after the selector
refactor and producer additions, including presentation authority and native
progress. Log: `/tmp/sleep28-scoped-acceptance.log`. Expected contention/retry
warnings occurred, with all assertions passing. Server production typecheck
passes in `/tmp/sleep28-producer-typecheck.log`. No full-workspace or PR gate
completion is claimed yet.

Preserved fixture failures:

1. `/tmp/sleep28-worker-tests.log`: all 11 initial cases failed setup because the
   fixture used provider name `slack` as connection transport. The schema requires
   `chat_sdk`; no production transport change was made.
2. `/tmp/sleep28-worker-fixed-tests.log`: ten passed; the same-company isolation
   fixture violated the application-name uniqueness constraint. Fixture names now
   include their identity.
3. `/tmp/sleep28-worker-producer-tests.log`: eleven passed; cancellation required
   a responsible-user membership, and teardown omitted its new run-event rows.
   Both are now represented/cleaned by the fixture.
4. `/tmp/sleep28-worker-producer-fixed-tests.log`: assertions reached cancellation
   projection, but default follow-on recovery admitted another execution and
   teardown deadlocked against it. The test now uses cancellation's existing
   `suppressImmediateRecovery` option to exercise Stop without starting successor
   execution. This does not change the default production recovery policy.
5. All 12 corrected cases passed in `/tmp/sleep28-worker-final-tests.log`; two
   concurrency/retry cases made 14 pass in `/tmp/sleep28-worker-expanded-tests.log`;
   the real question case brings the latest total to 15. These counts overlap.

This checkpoint is progress on slice 28, not a new independently complete reason
or a claim that milestone polling is retired. The original full PR-stack scope,
older unresolved CI/review findings, final master reconciliation and each PR's
latest-head acceptance remain required.


## Native finalization producer checkpoint

Native finalization now registers issue-scoped milestone intent in its existing
transactions before failure recording, committed terminal projection, and the
normal final run projection. All three committed-response repair branches signal
only after their authorization/no-op guards and immediately before comment and
presentation writes. The status arbiter, provider interpretation, and execution
policy remain with their native owners; the milestone signal carries only company
and issue identity.

Governed review-presentation restoration also signals an actual change. Previously
it rewrote identical metadata (including updated_at) on every accepted repair.
The owner now locks the run, compares the exact proposed JSON merge against the
current result, and returns successfully without a write or signal when unchanged.
It still returns true for an already valid projection: callers may need to
materialize the response even when its metadata is already present. Existing
coordinator/proof/digest/company checks remain before this decision.

Evidence at this checkpoint:

- The new real-finalizer regression failed before the signal: a persisted committed
  native cancellation projected its terminal run state but never generated the
  terminal chat notice. Log: `/tmp/sleep28-native-before.log`.
- After wiring, all 16 milestone-worker PostgreSQL cases pass. The new case calls
  the real finalizer without a manual milestone notification and verifies that
  replaying the settled finalization causes no deferred worker SQL. Its input is
  a seeded committed audit-only result; this is a recovery-producer proof, not a
  test of accepting provider results. Log: `/tmp/sleep28-native-worker.log`.
- The new governed-review repair test failed first because an unchanged repair
  advanced updated_at. Log: `/tmp/sleep28-review-before.log`.
- After repair, nine selected real PostgreSQL chat integration cases pass. They
  cover unchanged metadata, changed metadata intent before the write and settlement
  after commit, repeat repair, Slack/Telegram accepted-response recovery, canonical
  response recovery, already-selected/deleted answer protection, contention, and
  review authority changes. Expected contention is retained as retryable.
  Log: `/tmp/sleep28-native-recovery-tests.log` (1,421 cases not selected).
- Server production typecheck passes: `/tmp/sleep28-native-typecheck.log`.
  It excludes test files. No full-workspace or remote PR acceptance is claimed.

The periodic projector remains enabled. Next producer audit: status-decision
commit/replay and pending-effect delivery, then admission/recovery, interaction,
publication, conversation/configuration, and monitor/semantic-receipt writers
from the table above. Signals added here do not establish complete producer
coverage. The full original stack, unresolved earlier gates, and master
reconciliation remain required; no PR has been merged by this checkpoint.


## Native decision and effect-receipt checkpoint

`commitNativeStatusDecision` registers company/issue milestone intent after the
existing committed/replayed-decision exits, before inserting or applying a new
decision and its effects. `dispatchPendingNativeStatusEffects` registers intent
only when pending/failed effects exist and their targets have passed validation,
before their delivered receipt and run effect metadata are written. Both use the
existing owning transactions; no caller wrapper or new persistence is needed.
Pure committed replay and an empty pending-effect set remain unsignalled.

Why the effect receipt matters: `readNativeContinuationSource` requires the
applied decision, delivered same-agent continuation effect, original wake intent,
dispatched wake, and responsible-user continuity. A target run can already exist
while its missing delivered receipt prevents publication. A notification only at
run insertion cannot recover that later eligibility transition.

Two new PostgreSQL regressions failed before these integrations:
`/tmp/sleep28-native-effects-before.log`. One observed no milestone intent in the
real decision transaction; the other committed a real effect-delivery receipt but
still had no successor notice. After the repair all 18 milestone worker cases
pass (`/tmp/sleep28-native-effects-tests.log`). The new cases exercise the real
committer and effect dispatcher, outer-commit settlement, committed replay, late
lineage admission and quiet repeated recovery. The continuation is initially
suppressed even though its run and dispatch already exist, and becomes publishable
only after the real receipt producer runs. Fixtures preserve real foreign keys.

All nine selected native chat integration cases still pass after the committer
change (`/tmp/sleep28-native-effects-acceptance.log`); expected lock contention
remains retryable. Server production typecheck passes
(`/tmp/sleep28-native-effects-typecheck.log`). These are local checks, not full
workspace or PR acceptance, and do not include test-file typechecking.

Next concrete audit is heartbeat queue admission, coalescing, cancellation,
claim/release and wake-receipt writers in `heartbeat/queue.ts`, then the other
recovery writers. Some run mutations still use the root DB directly; place any
new transaction at the narrow mutation owner rather than wrapping execution or
provider I/O. Avoid signalling no-op periodic inspections and lease renewals.
Remaining interaction, publication, conversation/configuration, question
claim/retry, and monitor/semantic-receipt dependencies still require coverage.
The new worker is still not production-registered, and the periodic combined
projector remains until that audit and its real producer tests are complete.


## Queue admission, claim, release and coalescence checkpoint

The issue-bound admission transaction signals before inserting its run. Ordinary,
legacy-comment and queued-comment claims signal before changing run/wake state.
Queued-comment discard and committed chat-close cancellation branches also signal
before their terminal writes. The native review claim owner signals after its
review/ownership checks and before changing the run to running. No claim inspection
or admission-marker-only update gets a signal merely because it was inspected.

Drain release now selects and locks the still-running candidate in its existing
transaction, obtains its scope, then registers intent before releasing the run,
wake and issue lock. A repeated release after the run is queued returns without
an intent or update. The added selection follows the same run-first locking order
as the previous UPDATE; it is not a periodic discovery query.

The wake-queue PostgreSQL admission adapter owns coalesced run-context writes and
signals from that existing transaction. Its port carries company identity, so
this writer uses company-scoped reconstruction rather than adding feature fields
to the module contract or interpreting chat/provider payloads. The actual
conversation/lineage decision remains in the chat projection owner.

The fallback company-run admission/coalescing branch of `heartbeat/queue.ts` is
outside the issue-bound path and cannot create a chat milestone. It intentionally
has no new notification or wrapper. Any later task-binding writer still needs
its own signal. This is separate from claiming a historically bound run, for
which a missing context issue ID conservatively uses company scope.

Verification and failures:

- Initial claim fixtures incorrectly inserted a run before its referenced wake.
  Three failed on the real FK, while the drain-release missing-wake regression
  failed at its publication assertion. `/tmp/sleep28-queue-claim-before.log`.
  Fixing insertion and cleanup dependency order required no production change.
- With valid fixtures, all four claim/release regressions failed at the missing
  notice assertion before wiring: `/tmp/sleep28-queue-claim-corrected-before.log`.
  After repair all 22 then-current worker cases passed:
  `/tmp/sleep28-queue-claim-tests.log`.
- Real issue admission during a held execution drain and the actual PostgreSQL
  coalescing writer each reproduced a missing notice independently before their
  notification was added: `/tmp/sleep28-queue-admission-before.log` and
  `/tmp/sleep28-coalescing-before.log`.
- All 24 worker cases now pass: `/tmp/sleep28-queue-producers-tests.log`. Queue
  tests call the actual admission/claim/release implementations and database;
  dependency callbacks hold execution and prevent provider dispatch. The
  coalescing case exercises the actual adapter inside an outer transaction.
  These do not claim provider execution or a full native reviewer admission test.
- All 92 existing queue-module and wake-admission policy tests pass:
  `/tmp/sleep28-queue-module-tests.log`. The queue module now accepts the standard
  guarded external test URL through `PAPERCLIP_QUEUE_TEST_DATABASE_URL`; its
  destructive per-case fixture reset ran only on the new isolated database
  `paperclip_sleep28_queue_claim_20261025_test`. Embedded tests remain the default.
- Server production typecheck passes: `/tmp/sleep28-queue-producers-typecheck.log`.
  This excludes test files and is not workspace/PR acceptance.

Remaining queue producer audit is explicit: the general chat-control recovery
gate's terminal write, early case-handoff cancellation, stale retry/reassignment
cancellation, native status-wake dispatch receipts, deferred-run promotion in the
wake-queue adapter, queued-comment mutations and run-dispatch cancellation. The
native review claim signal also needs its dedicated real admission acceptance
case before final slice acceptance. Other recovery, interaction, presentation,
conversation/configuration, question claim/retry and monitor/semantic receipt
writers from the dependency table remain. Production still uses the periodic
combined projector; the new worker is not registered yet. No original inventory
or PR-stack acceptance requirement is removed by this checkpoint.


## Retry promotion and recovery admission checkpoint

The run-dispatch PostgreSQL adapter now signals before due-retry promotion,
suppressed-retry cancellation, and stale-run cancellation. Its existing locked
state/gate checks still own authorization and no-op exits. Promotion passes the
already-resolved issue identity to its private writer; no application port or
provider contract changes. Missing issue identity uses company reconstruction.
Repeated attempts after settlement do not schedule another milestone sweep.

The wake-queue transaction now signals before deferred promotion inserts its
run and before immediate recovery inserts its wake/run pair. The existing issue
lock, deferred claim, run linkage, and execution lock remain atomic. Tests use
these real adapter ports; external host dependencies return fixture values and
no provider execution is started. Notice creation occurs only after commit.

Evidence:

- `/tmp/sleep28-run-dispatch-before.log`: both real retry paths committed their
  expected status but failed the missing-notice assertion. The first stale-run
  fixture failed earlier because chat comments intentionally bypass terminal
  task status; no production policy was changed to accommodate that fixture.
- `/tmp/sleep28-staleness-corrected-before.log`: a max-turn continuation correctly
  cancelled but its terminal notice was absent before the signal was added.
- `/tmp/sleep28-wake-recovery-before.log`: both deferred and immediate admission
  created their queued runs but failed the missing-notice assertions.
- `/tmp/sleep28-recovery-producers-tests.log`: all 166 selected cases pass,
  comprising 29 milestone worker cases and existing run-dispatch/wake-queue
  application and run-dispatch policy suites. Earlier 97-case verification
  overlaps this set and is not an additional unique count.
- `/tmp/sleep28-recovery-producers-typecheck.log`: server production types pass;
  test files are excluded from that command. `git diff --check` passes.

Queued-comment changes, raw queue cancellation and wake-receipt writers, native
review admission acceptance, and remaining dependency producers are still open.
The periodic combined projector remains in production; this checkpoint does
not claim slice publication, full-suite/PR acceptance, or instance sleep.


## Native wake dispatch receipt checkpoint

`dispatchPendingNativeStatusWakeups` now registers milestone intent when it
repairs an interrupted dispatch receipt, coalesces another same-scope intent,
or records the result of fresh admission. Each receipt UPDATE has a narrow
transaction; enqueue/provider execution remains outside it. Existing status,
claim, provenance, and update guards are unchanged. The parsed issue identity
already owned by this dispatcher scopes the notification (company fallback
when absent). Claims, retry timestamps, and rejected targets do not acquire
milestone intent just because they were inspected.

The existing continuation reader requires both the delivered decision effect
and the coalesced original wake plus matching dispatch receipt. Consequently,
the run-admission notification alone is insufficient: it can be consumed while
the original intent is still claimed. The new normal-dispatch regression forces
that ordering using the dispatch suppression callback, then verifies the final
receipt reactivates projection without starting provider execution.

Evidence and limitations:

- `/tmp/sleep28-native-wake-receipt-before.log`: interrupted dispatch recovery
  linked the run successfully but its queued notice remained absent.
- `/tmp/sleep28-native-wake-fresh-without-signal.log`: removing only the final
  receipt notification reproduced a missing notice after the early admission
  sweep. The production signal was restored in a finally block.
- `/tmp/sleep28-native-wake-restored-tests.log`: all 56 milestone/queue cases
  pass (31 milestone cases, 25 existing queue cases), including normal and
  recovered receipts, repeat recovery quiet, and drain-held dispatch.
- `/tmp/sleep28-native-wake-dependency-tests.log`: all 13 existing dependency
  scheduling cases pass on a new isolated PostgreSQL database. The suite logs
  responsible-user setup denial for some existing fixture paths; this is not
  evidence of successful provider execution or full product acceptance.
- The dependency suite now accepts guarded `PAPERCLIP_DEPENDENCY_TEST_DATABASE_URL`
  and removes its fixed fixture user/closes its client during teardown. Its
  existing broad cleanup must run only on a dedicated database. Initial reuse
  retained the old fixture user; a manual cleanup command used the wrong physical
  table name, and the following run failed in setup with duplicate `user_pkey`:
  `/tmp/sleep28-native-wake-dependency-final.log`. Corrected teardown removed the
  fixture; a fresh read confirmed zero rows before the successful four native
  cases in `/tmp/sleep28-native-wake-dependency-clean.log` (nine unselected).
- Server production typecheck passes: `/tmp/sleep28-native-wake-typecheck.log`.
  Test files remain outside that typecheck. No whole-slice PR acceptance claimed.

Raw queue cancellation, queued-comment/lineage changes, native reviewer claim
acceptance, and the remaining dependency producer audit still prevent retiring
the production periodic projector. All original stack scope remains required.


## Remaining queue cancellation writers

The general chat-control recovery gate now registers intent before its guarded
terminal write, after the existing proof/no-op decisions. Invalid admission at
dispatch still fails closed and never calls the provider callback. Repeated
attempts against a settled run exit before signaling.

Superseded case handoffs previously cancelled with a root-client UPDATE. That
single status change now owns a narrow transaction, locks/selects the still-queued
run, and registers company-scoped intent before updating it. The company scope
avoids trusting a superseded handoff's issue identity as the run's current chat
binding. Status/company guards and the existing post-update wake-status callback
remain unchanged. A repeated claim finds no queued row and creates no intent.
The added run-first lock does not enclose provider I/O or introduce an issue lock.

Admission's stale scheduled-retry and reassigned execution-owner cancellations
also signal before their existing transaction writes. Those transactions may
later insert/notify a replacement run, but that later intent is insufficient for
the protocol's before-first-write requirement. Company/issue identity comes from
the owning admission state; no new module port or provider branch is added.

Evidence:

- `/tmp/sleep28-case-handoff-before.log` reproduces committed cancellation with
  no terminal notice before the fix.
- `/tmp/sleep28-chat-control-before.log` reproduces the same gap for a failed
  recovery gate; the repaired case-handoff regression passes in that run.
- Both gate tests verify no provider execution and quiet repeated attempts.
- The two real replacement-admission cases cover queued and scheduled-retry
  predecessors, their distinct cancellation codes, the old run's terminal notice,
  and the drain-held replacement. These are behavioral coverage, not claimed
  missing-notice-before reproductions: later admission signaling can also wake
  the same issue. Their early intent placement is established by code audit.
- `/tmp/sleep28-cancellation-final-tests.log`: all 60 milestone/queue cases pass,
  including 35 milestone worker cases. Earlier 58-case and two-case runs overlap.
- `/tmp/sleep28-cancellation-final-typecheck.log`: server production types pass.
  Test files are excluded. `git diff --check` passes. No PR acceptance claimed.

The identified raw queue cancellation and native wake receipt writers are now
covered. Still required: queued-comment/lineage mutations, native reviewer claim
acceptance, publication and interaction changes, conversation/configuration,
question claim/retry, and monitor/semantic receipt dependencies. Production still
uses the combined periodic projector until those producers are complete.


## Queued-comment lineage and native reviewer claim coverage

The queued-comment PostgreSQL adapter now signals before rewriting a run's
canonical comment IDs, deleting a queued comment, or cancelling its emptied
queued run. Its private transaction builder receives the already-locked issue
identity; exported application ports and caller wrappers are unchanged. Body-only
edits, issue timestamp touches, and wake-payload bookkeeping do not independently
signal: milestone binding reads comment identities/links and run lineage, not the
queued message text. The same transaction's run rewrite owns the wake for reorder
or nonempty discard; deletion owns the first intent for discard.

The reconstruction regression deliberately starts with the saved queue and run
context out of sync. The real reorder use case reprojects the run context from
that authoritative queue. It is recovery/compatibility coverage, not a claim that
ordinary reordering introduces new comment identities. The discard regression
uses the actual use case and adapter inside a caller-owned transaction and proves
that intent settles only at outer commit. Existing adapter tests retain rollback
and company/issue authorization coverage. Reference/external-object callbacks in
these fixtures are no-ops; this does not claim their integration behavior.

The previously outstanding native-review claim test now exercises the real
PostgreSQL claim against a seeded valid review assignment: applied decision,
matching projected status version, pending confirmation with a separate reviewer,
source native run, queued reviewer run and matching wake. It checks issue/run/wake
ownership and the working notice, then verifies repeated claim is quiet. This
covers claim/notification integration, not the entire review-creation workflow.

Evidence:

- `/tmp/sleep28-queued-comment-before.log`: reconstructed lineage failed to wake
  its notice; discard emitted no transaction intent. Both failed before repair.
- `/tmp/sleep28-native-review-claim-without-signal.log`: removing the real claim
  notification reproduced the missing working notice. The signal was restored
  in finally; no production native-claim edit remains in this checkpoint.
- `/tmp/sleep28-lineage-final-tests.log`: all 74 selected cases pass across the
  38 milestone worker tests, queued-comment adapter/use cases, and native review
  participant policy. Earlier 51-case and targeted native-claim runs overlap.
- `/tmp/sleep28-queued-comment-typecheck.log`: server production types pass;
  test files are outside that command. `git diff --check` passes.
- The existing queued-comment adapter tests now accept guarded
  `PAPERCLIP_QUEUED_COMMENT_TEST_DATABASE_URL` and close their client. Their broad
  fixture cleanup ran only on freshly created/migrated
  `paperclip_sleep28_queued_comment_20261025_test`; embedded mode remains default.

The queued-comment producer and native reviewer claim gaps are closed for this
slice. Publication/interaction, conversation/configuration, question claim/retry,
and monitor/semantic receipt producers still need their own audit and proof.
The production periodic projector remains; no slice publication or full-goal
completion is claimed.

## Question claim and retry checkpoint

Question response claim state is publication lineage, not merely delivery
bookkeeping. A delivering answer can temporarily bind its source run to an
already published prompt on another conversation. Returning that claim to
pending restores the original chat lineage and can make a previously suppressed
working notice eligible.

The question service now registers issue-scoped milestone intent before entering
that claim state and before an owned retry releases it. Retry release locks and
rechecks the existing attempt generation before signaling or updating; exhausted
claims retain ownership until the existing terminal receipt commits. Stale-claim
reset locks the actual stale rows, signals their distinct issue scopes, and resets
only those rows in the same transaction. Updates use batches of 500 IDs to avoid
an unbounded statement parameter count. This preserves the existing reset-all
semantics; it does not make the stale-row scan itself bounded. Live lease renewal,
still-owned exhausted claims and no-op claim attempts add no milestone wake.
Provider cancellation and execution remain outside these transactions.

Verification:

- `/tmp/sleep28-question-retry-corrected-before.log` reproduces a missing working
  notice after real delivery retry. The callback captures observations for
  assertions outside the service's error handler so assertions cannot be swallowed.
- `/tmp/sleep28-question-claims-before.log`: retry and stale reset fail before
  the fix; a live claim remains unchanged and emits no notification.
- `/tmp/sleep28-question-final-tests.log`: 76 pass, one test expectation failed:
  rollback emits settlement again when shared XID reconciliation confirms abort.
  State and publication assertions passed. The corrected test checks intent,
  eventual settlement, preserved claim, absent notice and subsequent idle quiet
  without assuming settlement notifications are delivered exactly once.
- `/tmp/sleep28-question-final-fixed-tests.log`: all 77 cases pass: 42 milestone
  worker cases plus 35 existing question-delivery cases, including lease renewal,
  stale-worker fencing, retries and adapter behavior.
- `/tmp/sleep28-question-typecheck.log`: server production typecheck passed.
  Test files are outside that compiler configuration. `git diff --check` passed.

Existing question-delivery tests now support guarded
`PAPERCLIP_QUESTION_DELIVERY_TEST_DATABASE_URL`, retaining embedded mode by default
and closing their client. Their broad cleanup ran only on the dedicated migrated
`paperclip_sleep28_question_delivery_20261025_test` database. Milestone fixtures
used their separate dedicated database.

Fresh origin/master inspected at `8c6bd5a83b`; reconciliation of the stack remains
outstanding. Publication/interaction, conversation/configuration and monitor
receipt producers remain under audit. Production registration and periodic-loop
removal are still pending, so this checkpoint is not a completed migration PR.

## Monitor receipt ordering checkpoint

The normal native monitor owner does not need another milestone signal when it
saves a schedule. `PaperclipRunnerToolAuthority.#setTaskMonitor` writes the issue
monitor and its semantic tool receipt inside the same `#withMutationReceipt`
transaction. The future deadline cannot be consumed before that commit. A later
monitor wake's real queue admission already signals the issue scope, and the
projector validates the committed receipt through `readNativeMonitorSource`.
Do not add a redundant signal to the generic semantic tool wrapper merely because
the projector reads a receipt.

The new test executes the actual `set_task_monitor` tool authority, then admits
the due wake through the real heartbeat queue after the source has finished. It
checks the queued notice and idle quiet. Source completion is fixture-controlled
and provider execution is held by task drain; this is receipt/admission/lineage
coverage, not full monitor scheduler or harness acceptance. Alternate monitor
wake rewrites and recovery paths still require audit before the whole producer
family is declared complete.

The initial proposed late-receipt test seeded an admitted wake before creating
its future monitor, which did not represent the normal ordering. Its first run
also failed the actual future-deadline validator after advancing the test clock
(`/tmp/sleep28-monitor-receipt-before.log`). That failure was a fixture problem,
not a production regression. The replacement follows the real ownership order
instead of manufacturing a missing signal for an unsupported ordering.

- `/tmp/sleep28-monitor-admission-tests.log`: targeted real producer path passes.
- `/tmp/sleep28-monitor-final-tests.log`: all 43 milestone worker cases pass.
- No production monitor code changed; `git diff --check` passed.

Remote gates refreshed at this checkpoint: #17490 at `31bcd1988823` still has
failed E2E shard 3 and aggregate checks; #17590 at `e501d6c99d72` still has queued
Paperclip Review; #17592 at `f53ae3d6d27c` still has neutral Paperclip Review.
These are not claimed ready and no merge was attempted.

## Publication outcome and operator-resolution checkpoint

`notifyChatPublicationWork` now accepts an optional company/issue scope. It
retains its existing delivery and receipt notifications. Callers supply that
scope when a publication outcome can change run lineage or release the run's
provider response slot. The shared scheduler still receives only a domain scope;
it does not inspect provider payloads or select presentation policy.

The publication worker supplies the scope for successful receipts, cancellations
and terminal preparation failures. Its attempt claim, lease renewal and paused
attempt restoration do not signal milestone work. The failure finalizer supplies
it for failed/cancelled outcomes, while retry and delivery_unknown retain the
response slot. Operator mark-delivered/cancel resolution supplies the scope;
retry-anyway does not authorize presentation until its actual delivery settles.
All additions use existing transactions and execute before the relevant write.
Provider I/O remains outside the receipt transaction. No table was added.

Real PostgreSQL regression evidence:

- `/tmp/sleep28-publication-preparation-before.log`: initial fixture failed its
  setup expectation because answering a question correctly cancels an unsent
  prompt. This was not a production failure. The corrected fixture models a
  claimed send still in flight when the user answers through the UI.
- `/tmp/sleep28-publication-failure-before.log`: definite delivery failure left
  the eligible source failure notice asleep. Retry and unknown-outcome controls
  passed and retained suppression. The new scoped signal fixes the failure.
- `/tmp/sleep28-prompt-receipt-tests.log`: a user answers during the controlled
  provider send, the real question delivery saves a target receipt, and the
  worker consumes that wake while the prompt is still streaming. Only the later
  real publication receipt makes the target notice eligible.
- `/tmp/sleep28-prompt-receipt-without-signal.log`: removing only the new receipt
  signal reproduces the missing target notice. The source was restored in
  finally. Transport and credential authorization ports are controlled; actual
  attempt leases, question receipts and publication commit use PostgreSQL. This
  test does not establish provider authentication or live network behavior.
- `/tmp/sleep28-publication-resolution-before.log`: both cancel and
  mark-delivered operator resolutions failed to wake their newly eligible notice.
  The real resolution owner now signals before its state change. Cancel exposes
  the source failure; marking delivered enables the question continuation.
- `/tmp/sleep28-publication-final-tests.log`: all 48 milestone and 35 error-policy
  cases passed. The three arbitration cases did not run because their embedded
  PostgreSQL setup failed after its own startup retries. That suite now supports
  guarded `PAPERCLIP_ARBITRATION_TEST_DATABASE_URL`, closes its client, and uses
  unique company prefixes. `/tmp/sleep28-arbitration-tests.log` shows all three
  pass against dedicated `paperclip_sleep28_arbitration_20261025_test`.
- `/tmp/sleep28-publication-acceptance.log`: four existing chat integration cases
  pass: malformed/transient preparation, parsed Discord question continuation,
  expired provider-accepted receipt ownership, and ambiguous close confirmation.
- `/tmp/sleep28-publication-final-typecheck.log`: production server typecheck
  passes. Test files are excluded from that configuration. Diff checks pass.

This covers the primary publication worker/failure/resolution owners. Interaction
mutation and cancellation, provider-specific receipt writers, inbound/binding
changes and configuration producers remain to audit. In particular, a helper
called after an interaction mutation cannot replace intent before that earlier
mutation. Production registration and removal of the combined periodic owner
remain pending. Publish this slice as a draft for CI feedback, not as a completed
sleep migration or merge-ready PR.

## Interaction resolution checkpoint

Question answers, question cancellation, withdrawal, skipping and terminal-task
expiry now signal milestone work before their relevant mutations. Withdrawal,
skipping and expiry restrict the signal to ask_user_questions and
request_confirmation, the two kinds used by lifecycle presentation arbitration.
Existing actor checks, linked tool/secret resolution, pending-state CAS, caller
hooks and transaction ownership remain in place. No service wrapper or new table
was introduced. Dismissal alone does not change the arbitration predicate and
adds no notification.

Historical answers are a distinct case: an ordinary deferred question on a done
task remains answerable, but deliberately enqueues no question delivery. That
path cannot rely on a later delivery claim to wake the milestone projector.
The actual answer transaction now owns its notification without reopening work.

- `/tmp/sleep28-interaction-resolution-before.log`: answer, skip and historical
  answer all leave an eligible failure notice asleep before the fix.
- `/tmp/sleep28-interaction-transitions-before.log`: six real producer variants
  fail the missing-notice assertion: answer, skip, cancel, withdraw, terminal
  expiry and historical answer. Cancel/withdraw also exposed a fixture cleanup
  error because they create durable chat actions referencing the conversation.
- `/tmp/sleep28-interaction-transitions-tests.log`: notice assertions pass after
  the fix; cancel/withdraw still fail the missing chat-action cleanup. Cleanup
  now deletes this fixture's actions before its conversations. The old
  `paperclip_sleep28_worker_final_20261025_test` database retains partial failed
  fixtures and must not be reused for global worker quiet assertions.
- `/tmp/sleep28-interaction-final-tests.log`: all 160 cases pass across the full
  milestone and existing interaction-service suites, on fresh separate databases
  `paperclip_sleep28_interaction_worker_20261025_test` and
  `paperclip_sleep28_interaction_service_20261025_test`. The former is the new
  self-cleaning milestone test database; the latter is exclusive to the service
  suite's broad cleanup.
- `/tmp/sleep28-interaction-typecheck.log`: production server typecheck passes;
  test files are excluded. `git diff --check` passes.

Draft PR #17606 targets #17592. Its first head `f398314ecd406d2e0eebbfb81a5d9dd7edc7c437`
started CI run 40198190088 and review run 40198190000. At the last inspection,
24 checks succeeded and 27 remained in progress, with no reported failures.
That is progress evidence, not final acceptance of this subsequent checkpoint.

Remaining producer work includes confirmation accept/reject and invalidation,
interaction creation/source changes, provider-specific receipts, conversation
bindings, configuration and alternate recovery writers. Production registration,
removal of only the lifecycle polling lane, complete latest-head checks and final
stack/master reconciliation remain required. No merge or full-goal completion.


## Confirmation verdicts and comment invalidation

The interaction service owns verdict and invalidation writes. Acceptance and
rejection now register milestone intent before the caller's optional in-transaction
resolution hook. Existing authorization, issue/proposal/interaction lock order,
workspace finalization checks and postcommit effects remain unchanged. Only
request_confirmation affects the current milestone response-slot policy;
checkbox confirmations do not acquire this additional intent.

Live human-comment invalidation registers intent for question/confirmation rows
before changing their state. Historical-comment reconciliation registers one
issue-scoped intent per relevant bulk write. A historical checkbox-only group
remains outside this notification. No new wrapper, table or periodic retry was
introduced. All paths continue using the existing outer-transaction protocol.

Evidence:

- `/tmp/sleep28-confirmation-before.log`: real acceptance/rejection both fail to
  produce the newly eligible failure notice; confirmation skip/withdraw/terminal
  expiry already pass using the previous checkpoint's signals.
- `/tmp/sleep28-confirmation-invalidation-before.log`: six missing-notice
  regressions fail: acceptance/rejection and question/confirmation supersession
  by live/historical comments. The invalidation tests verify the actual service
  expired their original interaction before asserting the missing notice.
- `/tmp/sleep28-confirmation-tests.log`: 169 cases pass, comprising all 63 worker
  cases and 106 existing interaction-service cases, using the same separate
  self-cleaning PostgreSQL databases as the previous checkpoint.
- `/tmp/sleep28-confirmation-typecheck.log`: production server typecheck passes.
  It excludes test files. `git diff --check` passes.

The latest fetched master is 3536b3649f98155d92b45cfb5dc3abcc2fea97d6; it has
not yet been reconciled into this stack. CI run 40198785531 for parent checkpoint
20f8c301f5 was still live with no reported failures at inspection. This does not
establish current-head final acceptance.

Remaining interaction producers include document-target invalidation, deleted
addressees, startup supersession and creation/replacement. Provider receipt,
conversation/configuration and alternate recovery audits also remain. Production
worker registration and lifecycle polling removal are still intentionally pending.


## Creation and sibling replacement

Creating a question or confirmation can expire a prior card from the same agent,
release the prior run's provider response slot, and cancel its unsent prompt.
The creation transaction now registers a single issue-scoped milestone intent
before inserting the new row. This precedes both sibling invalidation and prompt
publication changes. Existing idempotent reuse and validation return/throw before
this boundary; unrelated interaction kinds remain outside it. Provider policy
and sibling-supersession semantics are unchanged.

The replacement regressions create two runs before worker startup, suppress the
older failed run with its pending card, let the worker become quiet, then create
the replacement through the actual service. They verify that the old card is
expired and its failure notice appears without another run transition or poll.

- `/tmp/sleep28-interaction-replacement-before.log`: question and confirmation
  replacement both fail the missing-notice assertion before the creation signal.
- `/tmp/sleep28-interaction-replacement-tests.log`: all 184 cases pass across
  the 65 milestone worker, 106 interaction-service integration and 13 interaction
  service unit cases. PostgreSQL suites use separate isolated databases.
- `/tmp/sleep28-interaction-replacement-typecheck.log`: production server
  typecheck passes; test files are excluded. `git diff --check` passes.

The remaining direct terminal-interaction writers are document-target expiry
(the resolution-time helper and explicit document-change method), deletion of
an addressed agent, and startup supersession. Document-change callers are in
`routes/issues.ts`; the owning state mutation is in the interaction service.
Audit those before removing the lifecycle poll. This checkpoint still does not
register the worker in production or establish final CI/review acceptance.


## Remaining terminal transitions in the interaction service

The resolution-time stale-document helper, explicit document-target invalidation,
deleted-addressee cancellation and startup supersession now register milestone
intent before their first interaction write. The guards follow the existing
response-slot policy: question/confirmation for addressee cancellation, and
confirmation for document targets. No validity, permission, locking, publication,
or expiry behavior changes. Existing transactions own the notification.

New regressions use actual document creation/update/deletion and the interaction
service's document-invalidation/accept/reject entry points. An early document
write is allowed to settle before interaction expiry, proving that the last
state transition still wakes projection. Deleted-addressee cases use another
agent, so the source run and its chat endpoint remain valid. Startup supersession
creates both pending cards before startup with ordinary sibling replacement
explicitly disabled; the actual repair selects and expires the older one.

- `/tmp/sleep28-fixture-extraction-tests.log`: all 65 existing worker cases pass
  after extracting only shared fixture creation/cleanup into
  `__tests__/helpers/chat-milestone-fixtures.ts`. Worker, clock and quiet assertions
  remain in the tests; cleanup still occurs after coordinator shutdown. The
  helper tracks only fixture company/user IDs and now cleans fixture documents.
- `/tmp/sleep28-terminal-interactions-before.log`: all seven new cases reach
  the correct terminal interaction state but fail to produce the eligible
  failure notice: document change/deletion, stale accept/reject, two deleted-
  addressee variants and startup supersession. There are no setup failures.
- `/tmp/sleep28-terminal-interactions-tests.log`: all 191 cases pass across
  72 worker, 106 service integration and 13 service unit cases. The two real-DB
  suites use their separate existing isolated databases.
- `/tmp/sleep28-terminal-interactions-typecheck.log`: production server
  typecheck passes; tests are excluded. `git diff --check` passes.

The raw interaction-writer audit also found owners outside this service. These
must be reconciled with their outer transaction signals before removing polling:
`agent-conversations.ts`, `secret-proposals.ts`, `tool-action-review.ts`,
`tool-gateway.ts`, native automatic/obsolete review retirement, and native
external-review supersession. Result/summary-only writes, connection-intent-only
writes, and writes already covered by an outer status-decision/run transaction
need explicit disposition rather than indiscriminate new notifications.

Provider receipts, conversation/configuration changes and alternate recovery
writers remain under audit. This checkpoint does not register the new worker
in production or remove lifecycle polling, and is not final PR acceptance.


## Governed interaction writers: proposals and tool reviews

The proposal service bypasses the ordinary interaction resolver when reflecting
binding approval/rejection/withdrawal/expiry and rejection of dependent binding
proposals. Its existing transaction now registers scoped milestone intent only
when the linked interaction changes status. Repeated accepted-result metadata
updates remain quiet. Binding creation only inserts a new pending card, without
superseding another; that operation makes response eligibility more restrictive
and does not independently release an existing notice.

Human tool-review verdicts similarly register intent in commitToolActionReview,
after current authority/state checks and before the first request mutation.
The gateway's separate projection transaction registers intent when a pending
interaction becomes expired/cancelled. Result-only tool-execution metadata is
not treated as a response-slot transition. Tool-request execution receipts are
also lineage inputs; their broader writer audit remains required separately.
No provider execution, signing policy or request ownership changed.

`chat-run-milestone-governed-work.test.ts` is a separate cohesive suite using
`PAPERCLIP_MILESTONE_GOVERNED_TEST_DATABASE_URL`, currently the dedicated migrated
`paperclip_sleep28_governed_worker_20261025_test` database. It reuses only the
company/chat fixture helper; worker startup, clock, settlement and quiet assertions
remain explicit. Cleanup is company-scoped and runs after worker shutdown.

- `/tmp/sleep28-governed-before.log`: all four ordinary binding transitions
  fail to produce the newly eligible notice before the fix.
- `/tmp/sleep28-governed-transitions-before.log`: six cases fail, adding nested
  rollback followed by successful rejection, and parent-proposal rejection that
  cascades to a binding. The rollback itself preserves pending state and quiet.
- `/tmp/sleep28-governed-all-before.log`: retains the proposal failures and an
  invalid tool fixture assertion: the real gateway correctly creates a prompt
  publication, so an empty-publications expectation was wrong. The corrected
  fixture represents a previously failed prompt delivery and asserts absence of
  run notices rather than absence of all publications. A pending review still
  owns that run's response until resolved.
- `/tmp/sleep28-tool-review-before.log`: all three corrected tool cases fail at
  the missing-notice assertion after actual approval/rejection/expiry. The real
  gateway creates and signs the request; a controlled remote port forbids any
  provider calls. The persisted failed prompt is fixture state, not a provider
  delivery claim.
- `/tmp/sleep28-governed-tests.log`: 200 cases pass across the 72 lifecycle
  worker, 9 governed producer, 106 interaction integration and 13 interaction
  unit cases on separate isolated PostgreSQL databases.
- `/tmp/sleep28-tool-review-acceptance.log`: all 109 existing tool-gateway cases
  pass on newly migrated `paperclip_sleep28_tool_review_20261025_test`, selected
  through its existing PAPERCLIP_TOOL_REVIEW_TEST_DATABASE_URL guard.
- `/tmp/sleep28-governed-typecheck.log`: production server typecheck passes;
  it excludes tests. `git diff --check` passes.

The native external-review supersession helper has one production caller in
status-decision-committer: its existing milestone intent precedes decision writes
and that helper in the same outer transaction. It needs no extra notification.
Native automatic/obsolete review retirement, conversation reset, authorization
prompt reactivation and tool-request execution lineage still need disposition,
alongside remaining publication/configuration/recovery producers. Production
registration, lifecycle polling removal and full-stack final checks remain pending.


## Native review retirement, conversation reset, and CI isolation

Automatic fallback review retirement and obsolete policy review retirement now
register milestone intent inside their existing transactions, after finding and
locking the issue and before changing the interaction. Existing selection,
explicit-review protections, lock order, and terminal publication handling remain
with their owners. The real selectors are tested with retained prompt history,
no prompt history, and explicit requests that must remain pending. Current
system-authored cards are not newly externalized; the retained-prompt cases prove
recovery of stored history rather than claiming a new provider send path.

Conversation reset registers intent before its existing issue/comment/question
writes. The regression exercises the actual reset service with a valid saved
conversation identity and chat binding. It establishes the service contract for
stored bindings, not a claim that the current UI creates combined Agent Chat and
external-chat conversations. Its failed prompt remains historical; expiring the
question releases response ownership and reactivates the failed-run notice.

Evidence:
- `/tmp/sleep28-native-retirement-before.log`: both retained-prompt retirement
  cases fail at the missing-notice assertion. Four control cases pass. The reset
  case initially fails fixture setup because conversationState was missing.
- `/tmp/sleep28-conversation-reset-before.log`: after supplying the required
  active conversation state, reset expires the question but fails to produce
  the newly eligible notice before the signal is added.
- `/tmp/sleep28-native-retirement-tests.log`: all 16 governed producer cases pass.
- `/tmp/sleep28-retirement-combined-tests.log`: 101 tests pass (72 lifecycle,
  16 governed, 13 interaction unit). This command used the wrong integration
  filename, so it did not run that suite; its count is not reported as 207.
- `/tmp/sleep28-retirement-interaction-service-tests.log`: the correctly selected
  existing interaction integration suite separately passes all 106 cases.
- `/tmp/sleep28-native-retirement-typecheck.log`: server production types pass.

CI at 3603b45c43 failed chat shard 1 in the newly added native review metadata
repair test: expected no signal, received an initial intent. The shared database
owner retains failed transactions until XID reconciliation; subscribing correctly
replays unresolved intent even when this test's operation is a no-op. A deliberate
unrelated rolled-back producer reproduces the same failure in
`/tmp/sleep28-ci-intent-before.log`. The repair test now uses a separate database
signal owner, preserving the intentional rollback and all commit/no-op assertions.
`/tmp/sleep28-ci-intent-tests.log` passes this test plus both current-authority
revocation cases (3 total). Production uncertainty handling is unchanged. Remote
acceptance still needs a fresh head; no blind CI retry was requested.

Fresh origin/master is aec86c794b. No changes landed in the three service owners
above or chat-run-publications since the preceding 3536b3649f inspection. Full
stack reconciliation remains outstanding. The lifecycle projector remains
unregistered and its periodic production scan remains until the rest of the
publication, configuration, and recovery producer audit is complete.


## Interactive callback receipt recovery

The shared interactive callback can recover a question/confirmation prompt from
`delivery_unknown` to `published` before attempting to resolve the interaction.
That receipt alone can authorize existing continuation lineage, even when the
later resolution does not write. It now supplies the issue scope to the existing
publication notification in that receipt transaction. A published row receiving
only its missing provider message ID keeps its existing delivery wake without
adding a milestone wake: prompt lineage reads publication state, not that ID.
No provider protocol, action authorization, or dispatch policy moved into wiring.

The existing full Slack closed-choice test now observes the scoped settled signal
at its pre-resolution barrier. This prevents the later answer transaction from
masking a missing receipt wake. `/tmp/sleep28-callback-receipt-before.log` fails
there before the change; `/tmp/sleep28-callback-receipt-tests.log` passes all five
selected Slack/Discord/Telegram callback, modal, and continuation cases. The test
still verifies actual publication receipt, answer, continuation, deduplication,
unauthorized actions and acknowledged callback behavior. Provider transports are
controlled test ports, not live-provider qualification. Server production types
pass in `/tmp/sleep28-callback-receipt-typecheck.log`; diff whitespace checks pass.

Additional producer dispositions inspected at this checkpoint:
- Discord and Telegram large-publication preparation explicitly reject cards and
  interactionId. They preserve the root publication identity while splitting text
  or attachments; they do not confirm an interactive prompt receipt.
- Slack file-receipt admission rejects cards/interactionId. Teams file-transfer
  authority also rejects those plus progress/control/wake publications. Their
  file delivery settlement is not an interactive prompt lineage producer.
- Authored-final suppression tests durable publication/comment identity, not the
  transport state. File receipt outcomes do not remove that identity.
- Ordinary provider question/confirmation winner-action writes run in the same
  resolution transaction as the already-covered interaction signal. Winner
  actions restrict eligible destinations; they do not create a separate callback
  polling obligation. Alternate recovery writers still require review.
- Tool-action continuation admission selects already-terminal requests joined to
  existing delivery receipts before calling heartbeat.wakeup. Delivery's later
  deliveredAt write is not read by milestone lineage. Normal admission therefore
  observes the earlier durable request/receipt and supplies its existing wake.
  Do not add an unconditional signal to every tool-request metadata write merely
  because the lineage query joins that table.
- Gateway connection-authorization creation/reopening inserts a pending review
  without superseding another or changing sourceRunId. It restricts eligibility;
  its later ordinary resolution is covered by interaction-service signals.

These dispositions do not finish the entire publication/configuration/recovery
audit. In particular, endpoint and conversation reactivation, policy changes and
alternate recovery receipts still need complete real-producer coverage before
production registration and removal of the lifecycle scan.


## Shared drain repair acceptance

The voice-recovery review exposed dirty hints retaining a settled intent hold
while dispatch is paused. The repair is owned by #17576 and propagated through
#17578's shared scoped-deadline worker into this slice. The milestone first-write
and failed-selection drain tests now also assert zero active work and a stable
idle snapshot, then process the retained notice after resume without a new write.
All 99 lifecycle/governed/voice recovery cases pass in
`/tmp/sleep28-propagated-drain-tests.log`; server types pass. Both Teams scheduled
consumer groups pass 24 cases in `/tmp/sleep28-teams-drain-consumers.log`.

Broader acceptance found two tests relying on the old held counter to wait for
resume: report and retention flush helpers return as soon as active work is zero,
which is now correct during drain even before the retained retry fires. The run
in `/tmp/sleep28-shared-drain-consumers.log` has 36 passes and those two failures.
Confirm the saved deadline runs on resume, strengthen idle assertions, and repair
these tests at their owning parent PRs before claiming propagated acceptance.

The report and retention test corrections were verified at their owning parents
and propagated. /tmp/sleep28-shared-drain-final-tests.log now passes all 38 cases
in the previously failing combined selection. Together with the 99 milestone/
voice-recovery and 24 Teams cases, every shared dispatcher consumer has selected
passing evidence; the full 108 voice integration cases passed at its parent.
This establishes the changed dispatch/drain boundary, not final PR readiness or
host sleep. The same pending predicate in three earlier independent workers is
still a required parent repair. Remaining milestone producers/wiring are unchanged.

## Resource reactivation producers (2026-10-25)

The current selector admits active/waiting conversations. Resource inventory and
provider lifecycle recovery can reopen an unavailable conversation after the
milestone worker exhausted its earlier scan. Both paths lacked an issue wake.
The real-owner regressions in /tmp/sleep28-resource-before.log fail after commit
with no failed-run publication, establishing the gap independently of manual
notification helpers.

Resource reconciliation now owns one local availability transition function. It
locks the unavailable bindings it will reopen, signals their distinct issue
scopes before mutation, and retains the existing availability/completed-history
rules. Both inventory and lifecycle callers use it. Unchanged inventory produces
no milestone intent; status/health metadata is not indiscriminately promoted to
company-wide milestone scans. No shared scheduler contract or provider protocol
changes. The tests use the real credential lease and nested resource transaction,
prove savepoint release does not publish, prove outer rollback leaves the worker
quiet, and prove outer commit creates the expected publication. Completed history
stays completed. They then verify two minutes of quiet and no intent from a
repeated unchanged inventory.

All 90 milestone lifecycle/governed/resource cases pass in
/tmp/sleep28-resource-combined-tests.log. That command also named a nonexistent
__tests__/chat-run-publications.test.ts path; it did not run projection units.
The separate corrected service-path run is recorded in
/tmp/sleep28-resource-projection-tests.log. Six existing provider acceptance cases
pass in /tmp/sleep28-resource-acceptance.log (1,424 deselected, not counted), covering
Slack membership/reinstall, Slack archive/unarchive, Teams/Telegram lifecycle,
GitHub resource identity preservation, durable lifecycle retry, and canonical
Chat SDK resource identifiers. Server typecheck passes in
/tmp/sleep28-resource-typecheck.log. The dedicated resource database is
paperclip_sleep28_resource_20261025_test.

The earlier three configuration-owner drain repairs are now propagated. All 109
health/Discord/receiver cases pass together at 9775b2bc4a in
/tmp/sleep28-configuration-drain-tests.log. An earlier combined run had 108 passes
and one schema mismatch because the parent test databases lacked the downstream
voice cleanup column; the retained log is
/tmp/sleep28-configuration-drain-schema-before.log. Applying the actual tip
migrations to those disposable databases fixes that setup error.

This closes resource-owner reactivation, not every configuration producer.
GitHub-specific repository/installation restoration, other conversation rebinding,
late authority/lineage recovery, and remaining producer dispositions still need
review before production registration and retirement of the lifecycle scan.
Endpoint status/health are not direct milestone selector predicates; changing
them alone does not justify wiring a broad company wake to every health check.
The delivery owner retains its current authority checks.

Final resource checkpoint: all 20 projection units pass at the corrected path in
/tmp/sleep28-resource-projection-tests.log, and server build passes in
/tmp/sleep28-resource-build.log. Combined selected evidence is 116 distinct
milestone/projection/provider cases, plus the 109 propagated configuration-owner
cases. Full remote checks/reviews remain required for the new head.

## GitHub repository restoration follow-up

GitHub's signed repository callback has a separate restoration path. Its real
owner regression fails in /tmp/sleep28-resource-github-before.log. The provider
module now receives a narrow restoreResourceConversations callback from the
existing resource owner, using the same transaction and issue notification.
Provider payload parsing stays in github/resources.ts. All three resource cases
pass in /tmp/sleep28-resource-github-tests.log; five GitHub integration cases
pass in /tmp/sleep28-resource-github-acceptance.log, including rename/transfer,
concurrent installation events, foreign-installation canonical inventory,
credential rotation, and paused endpoints. Server build/typecheck passes in
/tmp/sleep28-resource-github-build.log. Installation recovery already invokes
reconcileProviderResourceRows; its restoration uses the covered inventory path.

Next concrete producer: telegram/resources.ts::migrateTelegramResourceConversations
sets moved conversations active before the generic availability transition runs,
so that transition cannot discover the earlier unavailable state. Preserve the
existing migration semantics and notify its affected issue scopes before the
migration write. Normal chat admission also writes links and activates the
conversation in chat-channels.ts; establish its wake ordering explicitly. The
Slack waiting-to-active helpers preserve selector eligibility (both states are
already admitted). Email uses explicit publication mode, which the lifecycle
selector and lineage resolver exclude. These dispositions narrow the remaining
configuration audit; they do not authorize removing the periodic scan yet.


## Telegram migration producer

Telegram group migration reactivates conversations before the generic resource
availability helper runs. A real owner regression at b634353059 fails to publish
the existing failed run after commit (/tmp/sleep28-resource-telegram-before.log).
The Telegram module now locks the bindings it moves and registers distinct issue
milestone intents before its existing update. It preserves the caller's outer
transaction, current migration/authorization semantics, and canonical topic IDs.
No shared scheduler contract or new durable table is introduced.

All four resource producer cases pass, including nested-savepoint/outer rollback,
commit reactivation, unrelated completed history, two minutes of quiet, unchanged
inventory and duplicate Telegram migration without a new milestone intent:
/tmp/sleep28-resource-telegram-tests.log. All 88 existing lifecycle/governed cases
pass in /tmp/sleep28-resource-telegram-lifecycle.log. Eight existing Telegram
migration integration cases pass in /tmp/sleep28-resource-telegram-acceptance.log
(1,422 deselected): unset/inherited/cleared/configured execution defaults, with
and without an existing destination, topic identity and subsequent reply routing.
Server production typecheck and build pass in the corresponding
/tmp/sleep28-resource-telegram-{typecheck,build}.log files. Total: 100 distinct
selected tests; no live Telegram or host-suspension qualification is claimed.

The cancellation E2E diagnostic completed at b634353059: focused two cases pass,
the full Agent Chat projects file passes all 16, and the two cases with a
100ms database-only running-row delay pass. Evidence is retained in
/tmp/sleep-cancel-e2e-20261025, /tmp/sleep-cancel-full-e2e-20261025 and
/tmp/sleep-cancel-delayed-e2e-20261025. Captured lock waits do not establish the
CI deadlock cycle. These passing runs do not resolve the actual #17572/#17490
E2E failures; no blind retry or cancellation-error masking was applied.

Normal inbound conversation/link activation and remaining authority/lineage
producer dispositions still gate production registration and polling removal.
Fresh master is 7ebf98eafd; final base reconciliation remains outstanding.


## Ordinary inbound conversation activation

The actual Slack ingress owner reproduces another missing wake: a prior failed
run has valid inbound lineage, but its unavailable conversation is restored by a
new message after the projector exhausted its startup work. The harness accepts
the new wake without creating a new run, so this does not rely on later queue
admission to hide the gap. Before repair the expected failed-run publication
never appears (/tmp/sleep28-inbound-before.log).

persistTaskMutation now registers the existing issue scope before its mutations,
or the newly created issue scope before inserting its conversation. The same
transaction creates the inbound link and reactivates the binding. Existing
endpoint/resource/principal authorization runs before this owner; provider calls
remain outside it. This is a direct use of the shared transaction intent helper,
not a new wrapper or background scan. No business policy or public API changes.

The regression passes (/tmp/sleep28-inbound-tests.log), and the combined selection
passes 12 cases: ordinary ingress reactivation, three existing Slack/Teams/Telegram
reach-revocation cases, and eight Telegram migration cases
(/tmp/sleep28-inbound-acceptance.log; 1,419 deselected). Server production
typecheck/build pass in /tmp/sleep28-inbound-{typecheck,build}.log. The isolated
DB is paperclip_sleep28_inbound_20261025_test. Existing resource and lifecycle
proofs remain recorded at their prior checkpoints; the whole integration file
was not run locally for this edit.

Remaining audit: alternate monitor/wakeup receipt rewrites, board reply identity,
provider-specific configuration/authority, and any remaining direct lineage
writers. Endpoint update does not assign a new agent or change publication mode;
its unrelated health/configuration writes must not cause blanket milestone scans.
Production registration/poll removal, complete remote gates, prior parent findings,
and the full original stack remain unfinished.


## Interrupted inbound receipt settlement

freshChatSourceAfterPublishedControl requires both the inbound action and its
delivery to be processed. A durable admitted run can exist before action
settlement, and operator recovery can repair a delivery while keeping its already
processed action/run. Earlier queue/admission signals cannot cover either later
commit. Two real Discord post-close recovery cases reproduce missing working
notices before these producer signals.

The inbound wakeup owner now registers issue intent before successful action
settlement, and before repaired delivery acceptance when the action was already
processed. It uses the existing validated durable request/receipt and transaction;
no new validation layer, queue, scheduler or provider-specific branch is added.
Failed/issued action settlement does not create milestone work. Existing claim
fences, authorization, retry semantics and duplicate-admission protection remain.

Evidence:
- /tmp/sleep28-inbound-receipt-before.log: action settlement becomes processed
  without publishing the expected working notice (causal before-fix failure).
- /tmp/sleep28-inbound-receipt-tests.log: action recovery passes after repair.
- /tmp/sleep28-inbound-receipt-delivery-before.log: delivery repair misses the
  publication. The action case also hit its existing NOWAIT contention retry;
  its immediate processed assertion was invalid. The test now drives the owning
  recovery path through its saved retry and waits for both durable receipts.
- /tmp/sleep28-inbound-receipts-tests.log: both cases pass with no second wake.
- /tmp/sleep28-inbound-receipts-acceptance.log: all 41 selected cases pass,
  comprising the full 29-case fresh-after-close authority group and the previous
  12 ingress/revocation/Telegram migration cases (1,392 deselected).
- Production server typecheck/build pass in
  /tmp/sleep28-inbound-receipts-{typecheck,build}.log.

Further producer audit remains required before production wiring. In particular,
run-identity.ts::activate changes responsibleUserId, which the monitor and native
continuation lineage readers compare between source and successor. Audit actual
identity activation/steering ownership and test legitimate reactivation before
adding a signal. Native safe replacement and provider-capacity retry create
scheduled_retry rows, which are outside this projector's current status selector;
the already-covered promotion/claim paths own their later eligibility. Task retry
strategy-only wake changes do not alter lineage fields. Slack Board dispatch uses
source issue.comment and its own response path; do not infer milestone eligibility
from the shared binding reader alone. These are dispositions and next audits,
not proof that all remaining producers are complete.


## Run identity activation

Monitor/continuation lineage requires matching responsibleUserId on source and
successor. Initialization and accepted steering can restore that match after the
worker exhausted its candidates. The identity owner now reads the bound issue
and registers its intent before the existing activation write. Pending steering
and replayed acceptance do not activate work. Production callers already own a
transaction; standalone tests now use reconcileSteeredIdentity, the existing
transaction/lock owner, instead of accepting directly on a raw client.

Two real-PostgreSQL worker cases reproduced missing notices before the fix and
pass afterward: initialization and accepted steering, each with pending/quiet
state, outer rollback, outer commit, replay, and settled two-minute SQL quiet.
Evidence: /tmp/sleep28-identity-before.log and /tmp/sleep28-identity-tests.log.
All 43 existing identity/GitHub credential tests pass in
/tmp/sleep28-identity-acceptance-fixed.log. The first acceptance run found two
lock fixtures still using the embedded-only URL; those now use the configured
connection URL, retain their one-second lock timeout, and close the extra pool.
Server typecheck/build passed in /tmp/sleep28-identity-{typecheck,build}.log.

Fresh master is 34409a92c4 (native failover backup filtering); it was fetched,
not merged into this draft. Recovery service orphan terminalization and adapter
failure classification are the next direct run writers to audit. Production
registration/poll removal and the original stack's gates remain unfinished.


## Orphan-run terminalization

The stale-lock recovery owner can move a running run to interrupted/cancelled
without passing through normal run lifecycle writers. Its terminal update now
registers an issue-scoped milestone intent in a short transaction. The existing
conditional update still rechecks status, runtime, native ownership/finalization,
and legacy controller generation/lease. Process checks and telemetry remain
outside that transaction; cleanup and audit handling retain their prior order.

Two real-producer cases (dead process and cancelled issue with a live process)
first exhausted the worker after its working notice, then recovered the run.
Both lacked the terminal notice before this change. Both now publish it once,
return to two-minute SQL quiet, and remain quiet after a repeated empty sweep.
Evidence: /tmp/sleep28-recovery-before.log and /tmp/sleep28-recovery-tests.log.
All 40 existing stale-lock recovery cases pass against a separate test database
(/tmp/sleep28-stale-lock-acceptance.log), including native ownership arrival,
controller/finalization races, shared references, explicit retry ownership and
failed audit insertion. Its test harness now supports the guarded external DB
path; no recovery assertions were weakened. Server typecheck/build and diff
whitespace checks pass (/tmp/sleep28-recovery-{typecheck,build}.log).

Adapter-failure classification remains a separate producer audit: it changes
errorCode/resultJson/updatedAt after issue-monitor or escalation writes, so an
earlier issue notification cannot by itself prove coverage of the later run
commit. Production registration and removal of the lifecycle poll remain gated.


## Late adapter-failure classification

The owning recovery path updates the issue monitor/escalation before persisting
its run classification. That later run write refreshes updatedAt and can bring
an old failed run into the projector's existing 24-hour window. The earlier
issue wake is insufficient: a real quota-recovery case established the monitor
and classification but produced no notice after the worker exhausted startup.

Classification now registers the issue intent in its own short write transaction.
All four original-assignee/review-participant classification paths pass their
already-owned issue identity. The update is company scoped and preserves its
JSON merge so concurrent workspace receipts remain intact. Provider execution,
classification policy, monitor deadlines, escalation and existing recovery
ownership are unchanged. Repeated recovery with an existing quota monitor is
quiet and does not dispatch another run.

Evidence: /tmp/sleep28-classification-before.log fails on the missing notice;
/tmp/sleep28-classification-tests.log passes all three recovery milestone cases.
All 89 existing recovery-action cases pass in
/tmp/sleep28-recovery-actions-acceptance.log. Their guarded external DB harness
uses paperclip_sleep28_recovery_actions_20261025_test, separately from worker
fixtures. Server typecheck/build pass in
/tmp/sleep28-classification-{typecheck,build}.log. The earlier 40 stale-lock and
43 identity/credential cases passed at their recorded checkpoints and were not
blindly repeated for this private classification write.

Still required: finish the authority/configuration producer dispositions,
register the lifecycle worker, retain the separate native-progress duty, remove
only the lifecycle poll, and complete current-head CI/review. Fresh master
34409a92c4 is fetched but not yet reconciled into the stack. Older parent CI and
voice security/deletion findings plus every original remaining reason stay open.


## Restoring current publication authority

Post-control lineage reads current connection enablement/status, resource reach,
endpoint reach/unlinked policy, linked human membership, and task visibility.
Restoring one of those facts can make a retained notice eligible without a run
transition. Nine real service-owner cases now cover that change after the worker
has exhausted startup: connection enablement, resource selection, unlinked reach,
identity confirmation, updateMember, updateMemberAndPermissions, ensureMembership,
setUserCompanyAccess, and task visibility. All keep the original authorization
reader and exact admitted source proof. No new run is dispatched to get a notice.

Owner changes:
- The existing notifyChatEndpointWork contract now requires the already-known
  company identity and also wakes milestones. Its configuration/status callers
  pass that identity; ordinary health-only callbacks still use the narrower
  notifyChatEndpointConfiguration/notifyChatConnectionConfiguration contracts.
  This is a bounded wake on an actual configuration operation, not a health poll.
- Endpoint policy edits signal only newly enabled direct/group/unlinked reach.
  Identity confirmation signals inside its existing advisory/row-lock transaction.
- Resource selection signals only a net disabled-to-enabled grant, covering both
  individual and bulk GitHub selection through their common owner. Unchanged
  inventory/defaults/selection does not create milestone work.
- Membership mutation owners signal human activation or viewer-to-active-role
  restoration before writing. ensureMembership now owns its read/write transaction;
  agent memberships and unchanged human state do not emit milestone intents.
- The issue update owner signals only hidden-to-visible restoration. Ordinary
  chat-bound assignee changes are rejected by the existing chat_binding_agent_locked
  guard, not treated as a supported restoration path.

Evidence and corrected failures:
- /tmp/sleep28-authority-before.log: seven actual missed-wake failures, plus an
  invalid Discord group-reach test. Discord channels use resource.enabled rather
  than allowGroupChats; that fixture was already eligible before restoration.
  Do not count that invalid failure as a production defect.
- /tmp/sleep28-authority-tests.log: the seven valid cases pass after repair; the
  incorrect reach test still fails its precondition. It was replaced with actual
  connection enablement, which fails before repair in
  /tmp/sleep28-connection-authority-before.log.
- /tmp/sleep28-resource-selection-before.log: real resource grant restoration
  misses its notice. Existing NOWAIT retry logs are retained; the assertion
  failure is absence of the terminally eligible publication.
- /tmp/sleep28-authority-final-acceptance.log: all 50 selected integration cases
  pass (the full post-close authority group plus ingress/revocation/Telegram
  migration). Nine restoration cases include unchanged replay quietness where
  supported; one-time link confirmation retains its existing consumed-token
  behavior. Explicit connection updates retain their configuration wake.
- /tmp/sleep28-access-acceptance.log: all 18 access service regressions pass.
- /tmp/sleep28-authority-action-tests.log: all six action-worker cases pass.
- Initial typecheck caught a caller using connection.companyId that its query
  did not select. It now uses the owning operation's companyId. Final server
  typecheck/build pass in /tmp/sleep28-authority-final-{typecheck,build}.log.

Alternate human-membership producers remain: middleware/auth.ts Cloud trusted-
header synchronization and board-claim.ts. Startup local-board insertion runs
before worker reconstruction; compatibility backfill only inserts agent members.
Cloud sign-in and board claim can restore humans while a worker is running and
must be covered before removing its poll. Credential rotation advances the
runtime fence; old sources must not regain authority from a new credential
fingerprint. Keep the existing generation/chronology denial tests. Remaining
producer dispositions, production wiring, full remote gates and original stack
scope are still required; this checkpoint is not a completed sleep migration.


## Cloud sign-in and board-claim authority restoration

Cloud trusted-header membership synchronization now owns a short transaction for
its existing membership upsert. It locks the existing membership while comparing
its authority and registers a company-scoped milestone intent before a new,
reactivated, or formerly viewer membership becomes active. Profile-only syncs
remain silent even when the debounce is bypassed by a changed profile. The
trusted-header roles already exclude viewer; existing authentication, company
provisioning, stale instance-admin removal and default-grant behavior are retained.
This adds one indexed membership read and a transaction per actual debounced sync,
not an idle timer. Provider calls are not wrapped in a transaction.

Board claim uses its existing transaction and signals only actual membership
insertion/reactivation. Existing active membership behavior is unchanged. Its
real database tests verify that nested savepoint completion emits intent, while
settlement waits for the caller's outer commit and the outside connection still
sees the old membership. This is producer/transaction proof; the Cloud integration
case additionally proves the real post-close milestone becomes publishable.

Evidence retained:
- /tmp/sleep28-cloud-sync-before.log: restored Cloud authority missed its exact
  working notice before repair, after the worker had exhausted startup discovery.
- /tmp/sleep28-board-claim-before.log: new and suspended membership cases failed
  because no intent was emitted; unchanged active membership passed.
- /tmp/sleep28-cloud-authority-acceptance.log: all 39 post-close integration cases
  pass, including Cloud restoration and a forced second profile sync with no
  milestone signal. Existing NOWAIT admission retries remain visible in the log.
- /tmp/sleep28-cloud-owner-acceptance.log: all 30 Cloud provisioning, auth route,
  transient retry and board-claim cases pass. Dedicated external test DB support
  preserves the embedded fallback and closes the owning clients.
- /tmp/sleep28-cloud-authority-typecheck.log retained the initial redundant
  viewer comparison failure. Cloud's validated role union excludes viewer; the
  redundant condition was removed. Final typecheck and build pass in
  /tmp/sleep28-cloud-authority-final-typecheck.log and
  /tmp/sleep28-cloud-authority-build.log. Diff whitespace checks pass.

The pre-push remote head 0f38d1079d fails E2E shard 3 and aggregate in run
40210763612, job 121221379705. The complete completed-job log is retained at
/tmp/sleep28-0f38-e2e3-failure.log. It again fails split-handoff cleanup at
agent-chat-projects.spec.ts:161 (HTTP 500), followed by the experiment-state
assertion at line 568. The log also records a process-identity event append
transaction deadlock at heartbeat.ts:3409 / run-lifecycle.ts:583. This is evidence
for the unresolved cancellation investigation, not proof of its entire lock cycle.
No blind rerun or masking was performed. Production milestone registration,
final producer dispositions, native progress as its separate slice, remote gates,
and every remaining original stack duty remain outstanding.


## Latest review and CI repair (2026-10-25)

Review of `1b0bec0b25` found three defects. All were reproduced before repair:

- GitHub `linkObservedIdentity` is a separate supported identity writer. It now
  signals before creating/reactivating its identity link, inside the existing
  membership and principal locks. Reconfirming an already-linked identity is
  silent. The real producer test covers outer commit, rollback and reconfirmation.
- Orphan-run terminalization registered intent even when its guarded update
  rejected retained native finalization. It now locks an eligible run before
  intent and preserves the same predicate on the update. Five retained phases,
  each swept three times, emit no milestone signals. All 40 stale-lock tests pass,
  including coordinator-arrival races, terminal-issue authority and exhausted
  finalization recovery. This does not migrate the stale-lock polling owner.
- The voice retention integration test still supplied the former coordinator
  callback name. It now uses `projectNativeProgress`; the original failure was
  `input.projectNativeProgress is not a function`.

CI run `40212695778` also exposed an incomplete Cloud-auth fake and shared-user
fixture leakage. The fake now models transaction and locking calls, retaining
failure injection for optional membership/settings reads. The Cloud authority
integration test restores the shared user's name/email/verification metadata in
its finally block. Previously it left `Owner 1` behind, breaking later Slack
publication assertions that expected `Owner User`. No publication policy or
assertion was weakened to hide the changed name.

Evidence:

- `/tmp/sleep28-review-before.log`: five redundant-wake regressions and the
  missing GitHub identity intent fail before repair.
- `/tmp/sleep28-voice-callback-before.log`: reproduces the renamed-callback error.
- `/tmp/sleep28-review-fixed.log`: all 40 stale-lock tests pass; one unscoped
  signal assertion observed another fixture's notification. The two GitHub
  transaction assertions now filter the actual company scope; both pass in
  `/tmp/sleep28-review-github-scoped.log`.
- `/tmp/sleep28-voice-callback-fixed.log`: 28 failures on a reused database with
  retained voice sessions/reports. Preserve this failed run. The full suite on
  fresh migrated `paperclip_sleep28_review_voice_20261025_test` passes all 122
  cases (`/tmp/sleep28-review-voice-fresh.log`). Global reconstruction tests need
  an isolated database; reusing a previous suite's retained obligations is invalid.
- `/tmp/sleep28-review-cloud-fakes-final.log`: 38 Cloud-auth/session tests pass.
  The first repair exposed an obsolete one-read assertion; the updated assertion
  still verifies the exact own-user/active filter on the authorization read.
- `/tmp/sleep28-review-long-board.log`: reproduces the `Owner 1` fixture leak.
- `/tmp/sleep28-review-chat-isolation.log`: 28 cases pass together on fresh
  `paperclip_sleep28_review_chat_20261025_test`: all ten authority-restoration
  cases, both GitHub signal cases, and all 16 long-publication cases.
- `/tmp/sleep28-review-typecheck.log` and `/tmp/sleep28-review-build.log`: server
  production typecheck and build pass. Test files are not typechecked.

Latest-head CI/review and stack reconciliation remain required. These local
passes do not discharge previous cancellation/deadlock evidence or parent review
findings. No merge or host-sleep qualification is claimed.


## Master integration: extracted GitHub credential fixture

Master extracted the credential fixture into a helper shared with project Git
authorization. Its direct `acceptSteeredIdentity(db, ...)` call bypassed the
existing transaction owner. Combined verification reproduced four credential
failures and one project-authorization failure when activation registered work.
The helper now calls `reconcileSteeredIdentity`, which already owns the task/run
locks and transaction. No production transaction contract changed.

The project suite initially skipped all 30 cases because embedded PostgreSQL was
unavailable. It now supports the existing validated external-test-database option
through `PAPERCLIP_PROJECT_GIT_TEST_DATABASE_URL` and closes that pool. Use a fresh
disposable database per run: the suite seeds fixed A/B user IDs. Reusing the red
run's database caused a duplicate-user setup failure; a new database resolved
that fixture setup issue without changing product behavior. All 25 credential
cases and all 30 project-authorization cases then passed on the owning branch.
The original failures remain in `/tmp/sleep-master-credentials-tests.log` and
`/tmp/sleep-master-project-git-external-before.log`; corrected results are in
`/tmp/sleep-master-identity-fixture-tests.log` (credentials) and
`/tmp/sleep-master-project-git-fixed.log` (project authorization).


### Slack setup identity producer correction (2026-10-27)

The extracted Slack setup service's `linkSlackAccount` callback was missing the
milestone intent before its identity upsert. It now uses the existing company-
scoped notification after lease/membership/conflict checks and before the write.
An already linked account returns without a notification. No polling, new storage,
or caller wrapper is added; downstream milestone consumers retain their own scope
and current-authority checks.

Two real setup regressions failed before the fix with no intent observed. A real
PostgreSQL table lock proves the intent exists while the insert is still blocked,
the link is invisible until commit, and settlement follows commit. A failed insert
rolls back identity without sending a test message; repeated successful linking
emits no new milestone work. The complete automatic Slack registration group
passes 115 cases (the other integration groups were not selected), and server
TypeScript checking passes. Combined stack and current-head CI remain separate
verification gates.


## Current-parent integration and acceptance (October 28)

The existing milestone slice is prepared on Teams attempt recovery #17592 at
`24c54399909105984e2a10f5869064984f69c472`. Its previous published head is
`7991c2fa2ce7298bee69b25dbc6cb60a5e2fe250`, with original own base
`e634f655375853421a62692abf95fd859585a800`. This is a normal merge, with no
new scheduler, queue table, or worker duty. Final landed-parent reconciliation,
exact-head CI, and Greptile 5/5 remain separate publication and merge gates.

Four explicit-base integration conflicts were resolved by preserving both owners:

- Publication resolution and successful delivery retain milestone-scoped
  notifications and the parent's exact voice conversation scope.
- Native finalization retains the server-owned first-task completion guard and
  this slice's milestone notifications.
- The run-identity fixture retains current parent coverage for query parameters,
  lock timeout options, and the additional authorization read scopes. Its three
  steering acceptance calls use the existing reconciliation transaction owner.
  The current parent's external PostgreSQL setup and client cleanup remain.

All unrelated parent paths, including migration 0397, bounded consent recovery,
voice cleanup/retention fixture repairs, and runner checkpoint restoration, are
preserved. No migration regeneration or dependency/workflow change is introduced.

Fresh isolated PostgreSQL fixtures pass **330 distinct selected cases**:

- **305 cases across 14 complete suites:** all five milestone worker suites,
  run identity, board claim, Cloud provisioning, auth session routes, Cloud actor
  authentication, stale-lock recovery, GitHub credentials, project Git
  authorization, and app admission wiring.
- **25 selected real chat integration cases** cover saved milestone discovery,
  identity and authority producers, post-close receipt settlement, all ten
  authority-restoration paths including Cloud synchronization, Slack account
  linking and rollback, and changed native review metadata. The remaining
  **1,590 chat cases were skipped**, not passed.
- Server production typechecking, build, and module-boundary checks pass.
  Production typechecking does not statically check test files; the selected
  tests above were executed.

Commands and results were retained in
`/tmp/sleep28-current-parent-acceptance-command.json`,
`/tmp/sleep28-current-parent-acceptance.log`,
`/tmp/sleep28-current-parent-producers.log`, and the corresponding
`types`, `build`, and `boundaries` logs, each with a zero exit-status receipt.
Every database owner used its own newly created and app-migrated fixture.
The intentional cancellation and audit-write failures in the recovery tests
remain visible in the successful acceptance log.

Earlier failure records and combined-stack counts above retain their original
revision scope. This acceptance is not a complete local repository run, a live
provider test, an external alarm qualification, physical host/database suspension,
or evidence of fleet savings. Native progress and subsequent sleep slices keep
their separate owners.
