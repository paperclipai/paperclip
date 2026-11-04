# Failed-run retry notice migration

Date: 2026-10-25. Branch: `codex/sleep-31-failed-retry-notices`.
Parent: [#17647](https://github.com/paperclipai/paperclip/pull/17647),
`fee07f3fa8cbc489cb9bbf657a6065c6e00748c3`.
This is slice 31 of the recurring-server-work stack. The branch now registers
a scoped worker and removes retry notices from periodic publication maintenance.
Producer audit and full acceptance remain in progress; this is not merge-ready.
Draft PR: [#17649](https://github.com/paperclipai/paperclip/pull/17649).

## Obligation and boundary

A failed-run retry may have a durable wake receipt but no admitted run. Its
existing `chat_actions` row has kind `failed_run_retry`; the same-ID,
same-company `agent_wakeup_requests` row is authoritative for whether the retry
waits or was declined. The notice is eligible while `runId` is null and the
receipt is deferred, cancelled, failed, or skipped. A matching existing
publication discharges that state. Queued and not-started are separate saved
states; a later cancellation can owe a second notice.

The retry service owns current source/batch authorization, task Retry generation,
original principal, retained source digest, endpoint reach, provider binding,
execution containment, and retry admission. The new projection module receives
a narrow authorization callback returning the destination, task and source
comment IDs. It does not reproduce that policy or add provider branches.
Existing publication transport still authorizes immediately before I/O.

The new projection module is `chat-channels/failed-retry-notices.ts`. It owns
candidate selection, receipt locking, deduplicated insertion, exact cursor
precision and scoped reconciliation. The service retains its existing public
combined manual notice API. Nothing adds a database table or a framework adapter.

## Current implementation and evidence

- The manual cursor previously converted `createdAt` to JavaScript Date. A full
  denied page with PostgreSQL microseconds was selected repeatedly, starving
  a later valid retry. The regression reproduces through the public combined
  API in `/tmp/sleep31-cursor-before-public-api.log`: the second call inserts
  zero instead of the expected one notice.
- `/tmp/sleep31-cursor-before.log` is an invalid first reproduction that attempted
  to call a private service method. It is retained as failure evidence, not
  evidence of the cursor defect.
- Cursors now use PostgreSQL `timestamp::text` plus the UUID tiebreaker. Manual
  selection retains its existing maximum batch of 50; scoped reconciliation
  bounds candidate authorization work, not successful publications.
- Permanent authority rejection settles the pass. Actual PostgreSQL/authority
  contention is returned separately for the future worker to retain. Unknown
  errors propagate. Run-bound and already projected states leave no candidates.
- Five integration cases pass in `/tmp/sleep31-scoped-notices.log`: manual/scoped
  denied-prefix pagination, scoped isolation and receipt contention/cancellation,
  and the existing Slack/Telegram queued/working/selected-final identities.
  The scoped cursor test observes exactly 50 then one candidate transaction.
- Server typecheck passes in `/tmp/sleep31-scoped-typecheck.log`.
  This establishes the projection contract, not idle worker behavior or host
  suspension. Full acceptance, worker registration, CI and review remain open.

## Producer audit to complete

- [ ] Receipt admission/defer: trace actual heartbeat and wake-queue writers,
  including the ordinary task Retry intent and the chat action receipt. A
  callback returning a truthy result is not sufficient persistence evidence.
- [ ] Receipt cancellation/failure: task tree, agent, budget, company, Slack Stop,
  deferred queue writers, and retry-specific authorization denial. Reuse the
  existing transaction signals where possible; test outer rollback and commit.
- [ ] Admission/promotion and settlement: run-bound receipts stop owing notices;
  retain notification ordering through transaction commit and failure.
- [ ] Retry action lifecycle: staged, claimed, processed, failed, cancelled,
  recovered, and superseded generations; determine which transitions can make
  current source authorization succeed or fail.
- [ ] Current authority restoration: endpoint/provider runtime, resources,
  linked identity, membership, task/project privacy and explicit grants, and
  original source/run lineage. Use existing eligibility signals rather than
  scattering new wrappers through these owners.
- [ ] Source and generation changes: inspect task Retry intent rewrites,
  recovery completion, preserved source metadata, and repaired delivery records.
- [ ] Mixed ordinary/retry receipt ownership: `findExistingDeferredWake` does
  not exclude a failed-retry owner by kind. A retry's own `allowRunCoalescing:
  false` does not establish what a later ordinary wake can select. The ordinary
  retirement path requires an exact visible queued publication; retry-owned
  publication authorization additionally requires its comment ID to equal the
  final original retry source comment. Establish the reachable combinations with
  real admission before exempting the retry denial writer from ordinary signals.
- [ ] Independent clients/replicas: current process-local signals cover only the
  supported owning application client and child pools. Do not claim external
  SQL or another replica is observed.

## Worker and acceptance still required

- [ ] Register a scoped deadline worker using the shared coordinator, retaining
  exact page cursors and contention across pages. Committed invalidation must
  restart a cursor so restored earlier candidates are revisited.
- [ ] Empty/configured-idle/retained-history quiet, real first admission, actual
  producer cancellation, denied history, lock contention, retry after failure,
  rollback/outer commit, restart, drain/resume, shutdown, and writes arriving
  during selection and pagination.
- [ ] Preserve all existing provider identity and authorization acceptance.
- [ ] Remove only retry notices from periodic maintenance after the above passes.
- [ ] Full required verification, template PR, latest-head checks and fresh 5/5
  review with no unresolved findings. Do not merge the stack.

No change to Cloud sleep-safety gates or external wake coverage is proposed.
Terminal confirmations, interaction continuations and GitHub maintenance remain
separate duties. The rest of the original migration ledger remains in scope.


## Broader acceptance and retained failure evidence

Server build passed in `/tmp/sleep31-scoped-build.log`. Broader selection
`retry|Retry|pre-run FIFO` first finished with 180 passing and one failing case
in `/tmp/sleep31-retry-acceptance.log`. The failing test injects the first
transactional agent-status read error while publishing a selected final. It
instead reached retry-notice maintenance because the reused test database still
contained two deferred retry candidates from the deliberate failing reproductions.
Direct SQL identified those candidates at 13:33:57 and 13:34:35, matching the
invalid first reproduction and the valid before-fix cursor reproduction. Neither
had a publication. This is fixture contamination, not an inferred flake from a
later success.

The cursor fixture now removes its own original staged action/receipt as well
as its denied clones in `finally`, including on a failed assertion. The original
database is retained as evidence. After applying migrations to a fresh isolated
`paperclip_sleep31_retry_acceptance_20261025_test`, all 181 selected cases pass
in `/tmp/sleep31-retry-acceptance-fresh.log`. No production error handling was
relaxed to bypass the failure. The local timestamp/fixture evidence is test-only.

Additional producer audit findings to resolve before wiring:

- The admission reader can select a previously deferred retry as a later
  ordinary wake's owner; the current ordinary publication path requires a
  matching visible original queue notice, while retry-owned transport requires
  its original final source comment. Reachability must be established, not
  assumed from the retry's own no-coalescing option.
- Wake-queue `cancelDeferredWake` and `failDeferredWake` signal the ordinary
  inbound-notice helper rather than the broader milestone helper. A retry
  notification added only to milestones would miss those real writers.
- `normalizeDeferredWakeCommentIds` changes the saved payload without a notice
  signal. Check whether removing merged/deleted input restores a retry's exact
  source eligibility before classifying it as harmless bookkeeping.
- `retireSupersededTaskRetry`, `requestTaskRetry`, and retry reconciliation write
  the separate task-intent receipt. The notice candidate uses the chat-action
  receipt; examine generation/source authorization before adding blanket wakes
  to all intent timestamp writes.


## Admission and cancellation migration checkpoint

The worker now uses the shared scoped-deadline coordinator. It reconstructs
existing receipt obligations at startup, resets an issue cursor on a committed
invalidation, and retains bounded pages, real contention, and failed selection.
Settled and denied history has no recurring scan. No new table is added.

`notifyChatInboundWakeNotices` now also notifies the retry-notice topic. This
keeps task-tree, agent, budget, company, deferred-queue, source/privacy, and
existing milestone authority signals at one boundary. The hint serializes only
company and optional issue IDs. The new worker is absent from older parents;
there it creates no new timer or database listener.

New producer changes are narrow:

| Owner | Obligation and notification |
| --- | --- |
| Retry admission callback | After current authorization succeeds, register intent inside the heartbeat transaction before the receipt write. |
| Retry authorization denial | Retire the exact unadmitted receipt in a transaction that registers notice intent before its conditional update. No provider I/O enters the transaction. |
| Heartbeat early refusal | A durable chat receipt can be skipped before its authorization callback. Signal its existing execution-wait transaction, or create one transaction for the previously standalone skipped-row insert. Non-chat callers retain their existing path. |
| Deferred-queue requester merge | A manual requester replacement can restore or revoke the original receipt identity. Register intent before that update. Payload-only merges do not add a notification. |

Causal evidence retained:

- `/tmp/sleep31-cancellation-before.log`: agent cancellation missed the notice;
  the tree case initially used an invalid direct function reference.
- `/tmp/sleep31-tree-cancellation-before.log`: corrected real task-tree service
  also reproduces the missing notice. The shared notification repair passes
  39 related cases in `/tmp/sleep31-cancellation-fixed.log`.
- `/tmp/sleep31-real-admission-lifecycle.log`: real heartbeat admission missed
  the notice in normal, drain, and failed-selection modes. Restart alone found
  it. The callback notification fixes that causal gap.
- `/tmp/sleep31-real-admission-fixed.log`: one normal-path assertion observed
  an unexpected worker error without printing it. This error was not classified
  as a flake. The assertion now shows full errors. The diagnostic run instead
  exposed the expected failure's AggregateError wrapper; that expectation now
  checks its nested cause. Retain the first observation for broad acceptance.
- `/tmp/sleep31-denial-before.log`: the actual recovery service restages a
  deferred retry; a controlled admission rejection saves `failed`, but no
  not-started notice appears. The conditional transaction notification fixes it.
- `/tmp/sleep31-early-refusal-before.log`: real heartbeat admission with
  wake-on-demand disabled saves a skipped receipt but misses its notice. The
  early-refusal writer notification fixes it.
- `/tmp/sleep31-requester-before.log`: the real deferred-queue Postgres writer
  restores the original requester but misses the notice. This exercises the
  producer transaction, not a synthetic notification. It does not establish
  every end-to-end ordinary/retry coalescing path.
- `/tmp/sleep31-producer-lifecycle.log`: all 14 selected cases pass, including
  real admission, first-write drain/resume, failed selection followed by drain,
  stop/restart, agent/tree rollback and commit, admission denial, early refusal,
  privacy restoration after idle and during a bounded page, and requester merge.
  The quiet assertions observe no root SQL/transaction calls for 120 seconds.
- `/tmp/sleep31-workspace-typecheck.log` and
  `/tmp/sleep31-workspace-build.log`: workspace typecheck and build pass.

The full chat/startup suite passes all 1,503 cases on fresh migrated
`paperclip_sleep31_wired_chat_20261025_test`, with evidence in
`/tmp/sleep31-wired-full-chat.log` (456.47 seconds, exit 0). This includes
the existing provider authorization and publication acceptance suite.
The stopped-worker case also checks that publication maintenance no longer
projects retry notices before startup reconstruction resumes the worker.

### Remaining producer qualifications

`readTaskChatRetryIntent` uses saved identity, generation, source, actor and
binding. It does not use the separate task-intent status or updatedAt. Ordinary
status reconciliation therefore does not itself restore notice eligibility.
Restaging the chat action from processed to issued also stays within the set of
statuses already allowed for publication. Changes that bind a receipt to a run
remove it from this notice obligation; the projection rechecks before writing.

`assertFailedRetryReceipt` validates stable receipt identity, not normalized
queued-comment payload. Payload-only comment normalization is not an authority
restoration for retry notices. The requester replacement is different and is
now covered at its actual writer. Existing ordinary-source notice behavior is
still included through the shared signal fanout.

Native exact-retry source authorization needs further qualification before
readiness: it reads native finalization ownership, cleanup history, environment
lease settlement, and retained checkpoint proof. `native-session-executor.ts`
commits a settled maintenance history entry and then removes its activation
file; `environments.ts::releaseLease` uses environment-cleanup notifications.
Determine which of these can restore an already-existing retry notice and prove
the required wake after the full authority boundary. A signal before the final
filesystem handoff may be too early. Do not claim all native cleanup producers
are covered by the general milestone fanout merely because run finalizers use it.

All older stack failures and original recurring-server duties remain required.
No merge, expanded Cloud wake coverage, or deployed host sleep is claimed.


## Native lease producer qualification

Two real producer gaps are now repaired without changing retry authority:

- `environmentService.releaseLease` can settle a source lease after a notice
  pass was denied. It now locks the exact matching row and registers the
  existing scoped notice intent before changing eligibility fields. The
  pending-cleanup attempt predicate remains on both selection and update;
  stale claims cannot release the resource or create a notice wake. Unchanged
  release repeats do not notify this worker. The existing environment-cleanup
  transaction remains the owner, including caller-owned outer transactions.
- `environmentService.acquireLease` can retire a retained predecessor when
  transferring a reusable sandbox to a new run. It registers a company-scoped
  intent in that existing transaction before retirement. The predecessor can
  belong to another issue in the same execution workspace, so the new issue is
  not a sufficient scope. The original company/environment/resource/ownership
  predicates and rollback on failed handoff remain unchanged. The notice worker
  still bounds candidate authorization per pass.

Both regressions start with an admitted retry receipt, make its native source
ineligible through a lease, settle the denied worker, then use the actual service
writer. They cover stale claims, outer rollback and commit, repeat writes, one
publication, and 120 seconds of logical idle with no root SQL or transactions.
The retained before-fix logs are `/tmp/sleep31-native-cleanup-before.log` and
`/tmp/sleep31-replacement-before.log`. Atomic release passed 35 selected cases
in `/tmp/sleep31-native-cleanup-atomic.log`. Both producers and the other notice
lifecycle cases pass 36 tests in `/tmp/sleep31-native-lease-producers-fixed.log`.

The intermediate combined run `/tmp/sleep31-native-lease-producers.log` passed
the new producer cases but failed the disabled-admission case with a recorded
PostgreSQL `CONNECT_TIMEOUT`. Its fake clock advanced 1,000ms on each wait while
real TCP connection work was pending. Those waits now advance 10ms; the same
strict error assertions and 120,000ms settled-quiet assertion pass. This supplies
a concrete cause for this failure, not proof that the earlier unprinted error
had the same cause. Keep that earlier observation in the acceptance record.

### Native cleanup boundary disposition

The notice projection calls `authorizeFailedChatRunRetry(publication: true)`.
For a non-task Retry this reaches `failedNativeRetryCoordinator`, which reads
saved native ownership, recovery and environment lease state. It does not call
`assertFailedNativeRetryState` or its filesystem activation/checkpoint verifier.
The stronger filesystem check remains on initial preparation and admission.
Task Retry uses its saved intent authority and intentionally bypasses the
non-task coordinator check for status publications; it does not gain execution
permission from the notice worker. Therefore filesystem activation completion
is not itself a new notice-eligibility producer.

For the retired-owner recovery path, initial non-task retry preparation already
requires settled native maintenance and the physical checkpoint proof. The
maintenance service refuses another ordinary pass over a nonempty canonical
root with existing maintenance history; its interrupted-copy path requires
exactly the earlier incomplete history and cannot recreate a settled generation.
The first successful cleanup precedes creation of that non-task retry action.
Do not add a pre-activation notification to filesystem cleanup on the assumption
that all execution predicates are also notice predicates. Existing source
finalization writers use the milestone notification boundary; source lease
release and reuse were the actual missing producers found here.

`releaseLeasesForRun` has no production caller in the inspected repository;
only its definition and environment-service test call it. `extendLease` changes
expiry/last-used metadata, which these notice authorization predicates do not
read. Same-run reacquisition makes a lease active (revokes eligibility); its
later settlement uses the covered release writer. Current publication authority
is still rechecked before sending. Future producers must use the same committed
notification contract rather than relying on this audit as a blanket exemption.

### Remote and local gate record

At `cbfaab918a`, Greptile reports 5/5 with no inline findings, explicitly leaving
the native audit unresolved. CI run 40224785432 has a Runner failure in
`local-runner.test.ts`: duplicate command receipt `command_happy_path_3` timed
out. Evidence: `/tmp/sleep31-ci-runner-failure.log`, job 121263785884.
The first local attempt was invalid because debug Rust binaries were missing
(`/tmp/sleep31-runner-receipt-check.log`). After the prescribed `build:rust`,
all 10 cases pass in `/tmp/sleep31-runner-receipt-built.log`. This does not alone
clear remote CI. No unchanged-job retry has been used for this PR.

Server typecheck passed with the two lease producers in
`/tmp/sleep31-native-lease-types.log`. The environment-service suite now accepts
an explicitly named isolated external test database ending in `_test`, retaining
embedded startup by default and closing the external client afterward. This
allows verification of the existing lease contracts on this host. Its result,
full updated acceptance, latest-head review and CI still need recording.


Existing environment-service acceptance passes all 51 cases on fresh migrated
`paperclip_sleep31_environment_20261025_test` in
`/tmp/sleep31-environment-service.log`. Server typecheck and build pass at this
lease-repair checkpoint (`/tmp/sleep31-native-final-types.log` and
`/tmp/sleep31-native-final-build.log`). Updated full chat acceptance and remote
checks remain required. Initial remote head `cbfaab918a` finished with only the
Runner receipt timeout and dependent `ci / verify` failing; all other 51 checks
passed. The forthcoming source-change push must earn its own checks and review.


## Master integration: budget-refusal fixture transaction

The combined full chat suite passed 1,761 cases and failed the newer-saved-input
case that remains budget-blocked. A focused run reproduced that failure among
49 related cases. Its `failed_chat_retry_contended` receipt was not evidence of
actual database contention: temporary diagnostic instrumentation captured
`Database work must be registered inside a transaction` from the budget mock's
`request.authorize(db)` call. The real admission owner passes a transaction.

The mock now authorizes and writes its skipped wake receipt in one transaction.
All original requester, source-comment, and skipped-status assertions remain.
No production retry, budget, or authority behavior changed. All 49 related cases
pass on this owner. The initial full-suite and focused failures remain recorded
in `/tmp/sleep-master-chat-full-tests.log` and `/tmp/sleep-master-chat-budget-tests.log`;
the captured cause and corrected result are in
`/tmp/sleep-master-budget-fixture-diagnostic.log` and
`/tmp/sleep-master-budget-fixture-fixed.log`. Temporary diagnostic logging was
removed before this commit. The full combined suite still requires a fresh run.


## Agent lifecycle reactivation

A parked failed-retry notice also becomes eligible when its agent finishes
resuming. The lifecycle transaction now uses the shared `beforeStatusChange`
effect before changing a non-invokable status to an invokable status. The service
supplies the existing company-scoped inbound/failed-notice notification; the
lifecycle module owns status transitions and knows no chat/provider policy. This
brings forward the same lifecycle effect used by downstream native response work,
without adding a polling fallback, table, or caller recovery wrapper.

The real retry-notice integration first failed because a successfully resumed
agent left the parked notice unpublished (`/tmp/sleep-agent-resume-red.log`). All
four authority-reactivation cases now pass, including two minutes of virtual
quiet before and after the real pause/resume producer
(`/tmp/sleep-agent-resume-green.log`). The full lifecycle suite passes all 64
cases, including outer transaction commit/rollback and no notification on an
unchanged ready state (`/tmp/sleep-agent-resume-lifecycle-fixed.log`). The first
lifecycle regression fixture incorrectly hired an initially paused agent, whose
resume target is preparation; it was corrected to hire, complete preparation,
pause, and resume through the real lifecycle. Its initial failure is retained in
`/tmp/sleep-agent-resume-lifecycle.log`. Server typecheck passed in
`/tmp/sleep-agent-resume-types.log`. These results establish worker and transaction
behavior only; final-stack acceptance and latest-head CI still apply.


## Current integration and discovery acceptance — October 28

The prepared local slice follows current inbound parent
`661f2f6da8c6c22cdcc25edccd57502ee6fa8c4b`, including actual master
`a2fbce9305c48f5242e6bafb19d049d29edc1d72`. Normal merges preserve the
19-path slice. Two conflicts retained current lifecycle fixture migrations/client
cleanup and the extracted retry notice import; duplicate imports were removed.
The identical producer helper copied forward to the parent is retained once at
this slice's original location, with both parent producer regressions intact.
An initial raw binary-patch comparison failed after parent test additions changed
blob hashes and hunk offsets. A full-context comparison excluding only those
representation fields passes; `/tmp/sleep31-discovery-parent-update-proof.json`
records the exception rather than claiming raw binary identity.

The discovery-cost finding in #17647 also existed in this owner's page loop.
Three new real PostgreSQL regressions with 250 retained candidates and a second
company fail before the fix. Known task hints now require zero discovery SQL;
company/startup discovery selects DISTINCT company/task identifiers using the
same candidate predicate as bounded projection. The first SQL version failed
with PostgreSQL 42702 because both joined tables project company_id; an explicit
projection alias fixes the ambiguity. The final four targeted discovery/history
cases pass. This does not claim constant database work for broad discovery.

Current focused acceptance passes **404 distinct cases** on the integrated owner:
259 across six complete consumer/lifecycle/environment suites, 20 failed-retry
notice and native-lease producer cases, 53 ordinary-notice compatibility cases,
and 72 separate retry/budget compatibility cases. The three chat selections skip
1,651, 1,618 and 1,599 cases respectively; skipped cases are not passes.
Each group uses separate PostgreSQL fixtures; lifecycle and control apply their
own migrations, while chat and environment fixtures are explicitly premigrated.
Final server typechecking/build and module boundaries pass.

Exact commands/fixtures are `/tmp/sleep31-final-acceptance-command.json`; logs and
exit receipts are `/tmp/sleep31-final-{consumers,notices,ordinary,compatibility}.*`
and `/tmp/sleep31-alias-final-{types,build}.*`. The original query-budget failures,
first ambiguous-column failure, and final green result remain in
`/tmp/sleep31-discovery-{red,green,alias-green}.log`. Prior historical counts and
failures above retain their original revision scope. This local preparation has
not been published, and the parent has a new current-head P1 about ordinary input
restoration that must be repaired and adopted before this slice can merge.
Fresh exact-head remote CI/review, full repository acceptance and deployed sleep
are separate claims; no live provider or physical sleep result is asserted here.


## Final landed-parent acceptance — October 28

The preceding inbound notice PR #17647 has now merged at
`1aa3a21ac41f602977638cf0be875b01a243e69f`, including both discovery and restored-input
wake repairs. The current normal two-parent integration is
`43d0f84ea56845b8fc4946a7533ecbf7f07b679a`, with parents the prepared retry slice
`c56cc27611c76587a278ac175470e0b4646b7b5f` and actual master. Squash ancestry makes
the ordinary historical merge report eight conflicts. Using the verified landed
parent `41f7e2c9e351efa6cfa5ef699c0e69df7425012b` as the semantic merge base yields
a clean tree. The full 19-path owned binary patch is identical and all 23 unrelated
master paths/deletions are preserved. That proved tree resolves the ancestry-only
conflicts in an ordinary two-parent merge; no rebase or force push is used.

Current combined-master acceptance passes **42 distinct cases**: 21 retry-notice,
native-lease and restored-input producer cases (1,651 skipped), plus all 21 cases
in app/startup and task-drain admission release suites. The newly landed sandbox
resume/admission behavior is exercised with this slice's queue notifications.
Checks run after server typechecking/build and module-boundary verification to
avoid competing cold-import setup loads. All those checks pass. Commands/fixtures:
`/tmp/sleep31-landed-acceptance-command.json`; results/receipts:
`/tmp/sleep31-landed-{types,build,boundaries,notices,consumers}.*`.

The earlier 404-case matrix and subsequent 21-case parent check retain their
original revision scopes and are not counted as freshly rerun. All owned source
and test files remain unchanged through the current normal integration; only
this acceptance documentation follows the current tests. Their 17 hashes are in
`/tmp/sleep31-landed-tested-source-sha256.json`; the complete integration proof is
`/tmp/sleep31-landed-parent-publication-proof.json`. Fresh exact-head remote checks
and Greptile 5/5 remain required after publishing this updated branch. There is
no full local repository, live provider or deployed sleep claim.
