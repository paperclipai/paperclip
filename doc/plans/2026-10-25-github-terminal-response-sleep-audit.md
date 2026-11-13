# GitHub terminal-response recovery

Slice 35 starts from acknowledgement PR #17656 at
`43900c1f94500af4c4de1987f9608ac4e12feae6`.
The final parent acceptance passed all 1,557 chat/publication/startup tests without
skips in 514.70 seconds. Parent workspace types/build and 69 fast-response tests
also passed. Greptile reviewed that head at 5/5 without findings. Remote CI was
still completing when this slice started; no merge or full-stack completion is
claimed.

## Obligation and ownership

A received acknowledgement and an owed terminal response are different states
of the existing `github_response_comment` action. Slice 34 owns received actions
and retryable failed deliveries. This slice owns processed, nonfinal actions
whose bound request has a terminal outcome or needs a paused notice. Review-check
publication and stale-head projection repair remain independent duties.

The provider owner must determine exact source/run provenance, latest-run
ownership, and whether a real reply is confirmed or uncertain. Keep those queries
and presentation decisions in `chat-channels/github/response-execution.ts`; shared
notification and scheduler code must not interpret GitHub payloads. Existing
principal/configuration checks, provider markers and repository publication leases
remain the authority for sends and receipt writes.

## Passive history is not unfinished delivery

A paused response deliberately remains nonfinal so a later resumed run can answer
it. The old scan repeatedly revisits it, even when it makes no provider mutation.
The replacement needs a saved paused-presentation version in the existing receipt,
written only with confirmed receipt persistence. A changed run or pause state
invalidates that version. No table or separate queue is needed.

An unrelated newer terminal run does not automatically authorize closing every
older request. Resolve native identity and legacy wake-comment provenance using
the existing owner. Passive non-owning rows must be excluded without acquiring
and releasing a publication lease on every wake. That would otherwise create a
self-wake loop through the release notification.

## Producer audit still required

- Run and issue transitions, identity/lineage changes and restored authority use
  the existing milestone notification boundary; extend it once with the narrow
  response-state topic after verifying coverage.
- Response action completion and provider publication/assessment settlement must
  wake affected terminal candidates. Repository lease release is scoped to its
  company, endpoint, repository and PR/issue number.
- An unresolved competing lease owns its saved expiration, not a permanent scan.
- Failed terminal sends remain with the existing acknowledgement retry owner,
  including the current attempt budget and ambiguous-outcome policy.
- Startup reconstructs eligible work; drain/standby/shutdown retain skipped work
  and prevent starting subsequent provider requests.

## Acceptance required before polling removal

Use real PostgreSQL and the existing controlled GitHub fixture. Cover terminal
run producer commit/rollback, native identity, blocked-but-non-owning requests,
paused-history quiet and resume, final/superseded history, lease release and
restart, uncertain reply settlement, admission changes between provider requests,
changes during a sweep, and candidate prefixes across the bounded page size.
Measure actual SQL and HTTP effects while idle, not only timer registration.

Current state: extracting the provider-owned execution decision and persisting
confirmed paused presentation versions. The terminal worker, complete producer
audit, lifecycle tests, startup wiring and recurring-call removal remain pending.

## Implemented worker checkpoint

The provider execution resolver is extracted. Successful paused receipt writes
save `pausedVersion` in the existing result. The scoped worker reconstructs
processed nonfinal candidates in 100-row ID pages, excludes unrelated run
history and unresolved reply owners, and uses real publication-lease expiration
when another writer owns the lane. A settled paused receipt is passive. New
run state invalidates it. The owning acknowledgement service still checks
current authority and stops subsequent provider requests at admission/shutdown.
Failed sends transfer to the existing acknowledgement retry worker.

The response-availability helper now wakes this worker as well as initial
acknowledgements. The milestone boundary wakes it for existing run, identity,
lineage and authority producers. Issue-service status/assignee changes notify
inside their owning transaction. GitHub publication staging, missing-binding
cancellation and scoped lease release also notify. Registration is exposed by
the provider service for tests, but app startup still does not register it and
the old terminal maintenance call remains until the audit below is complete.

New acceptance covers eight cases: startup terminal recovery and settled-history
quiet; outer issue transaction rollback/commit; paused-history quiet and a later
run; restart; drain; standby; native-identity rollback/commit; real repository
lease contention/release. All eight pass in `/tmp/sleep35-lifecycle-coalesced.log`
(21.88 seconds). The SQL-quiet checks advance 120 seconds and inspect real
`select` and `transaction` calls. GitHub HTTP remains controlled.

Server typecheck and build pass at this checkpoint, with logs
`/tmp/sleep35-final-server-types.log` and `/tmp/sleep35-final-server-build.log`.
All GitHub review-workflow acceptance is running in
`/tmp/sleep35-github-acceptance.log`; no broad result is claimed yet.

Material failures retained:

- `/tmp/sleep35-before-producer.log`: all three first cases failed because the
  test coordinator omitted its required `canRun` function. Corrected the fixture.
- `/tmp/sleep35-before-producer-fixed-fixture.log`: startup and paused recovery
  passed, while the real issue commit failed to wake terminal response work.
  The issue owner now signals the response slot before writing its status.
- `/tmp/sleep35-producer-fixed.log`: the producer regression and 15 adjacent
  cases passed; the paused restart assertion observed the legitimate pending
  coalesced lease-release pass rather than waiting for settlement.
- `/tmp/sleep35-lifecycle.log`: four passed and four assertions failed at the
  default one-second poll timeout or before the coalesced pass. The coordinator
  itself coalesces at one second. Explicit five-second observation bounds now
  allow that existing behavior; `/tmp/sleep35-lifecycle-coalesced.log` passes all
  eight. No production delay or retry policy was widened to make tests pass.
- `/tmp/sleep35-owner-extraction.log`: nine existing ownership/paused/native/
  legacy-placeholder cases passed after extraction.

## Direct issue writers found before startup wiring

These are unresolved producer-audit items, not exemptions:

1. `issue-tree-control.ts::restoreIssueStatusesForHold` restores issue status
   directly. Its cancellation path already calls `issueService.update`, but the
   restoration path does not. Test a restored blocked request with existing
   response history and cover its transaction before removing the old sweep.
2. `heartbeat/queue.ts` directly blocks a task whose isolated worktree lacks a
   usable project. This can happen before any run is admitted, so a run-terminal
   notification cannot cover it. Existing assembled coverage is in
   `heartbeat-workspace-branch-containment.test.ts` around the projectless
   isolated-worktree rejection case. Verify this producer's response notification.
3. `execution-recovery-resolution.ts::settleUnrecoverableExecutions` can set
   status blocked after a run was already terminal. It does not currently send
   the response notification. Existing real-database coverage is in
   `native-safe-replacement.test.ts` and run-dispatch adapter tests. Preserve its
   task/coordinator/run lock order and failure rollback when adding the signal.

The native-finalization reconciler's blocked transition calls issueService and
is covered by the new owning boundary. Recovery/service's inspected blocked
transitions also call issueService. Runner goal statuses are session-goal data,
not issue status, and do not independently change this response predicate.
Additional dynamic status writers, lookup/index cost, uncertain-publication
settlement, page fairness, final startup wiring, full acceptance and remote review
still need completion. Do not present this checkpoint as polling removal.

## Production registration and direct-writer repairs

The three direct writers above now notify response availability before their
writes in the existing transactions. Three real-producer regressions reproduce
missing paused response settlement before the change. Tree cancellation continues
to use issueService; restoration now notifies each restored issue. Queue admission
notifies only a transition into blocked. Exhausted recovery does likewise and
retains its existing lock order and failure behavior.

`/tmp/sleep35-direct-producers-before.log` records the missing tree/recovery wakes.
Its workspace case initially failed earlier because the fixture had not enabled
isolated workspaces, so it exercised normal admission instead of the intended
pre-dispatch refusal. The corrected fixture enables and restores the feature,
drains any executions on cleanup, and reproduces the missing workspace wake in
`/tmp/sleep35-workspace-producer-before.log`. The real issue state reaches blocked
before the missing-notice assertion, so the red result establishes the producer
boundary rather than an unrelated setup failure. All eleven producer/lifecycle
cases pass after repair in `/tmp/sleep35-direct-producers-fixed.log`.

The remaining inspected direct status writes in agent-conversations, Slack
lifecycle/state, access reassignment, checkout/release, and native workspace
reconstruction move away from blocked or remove assignment. They do not create
a new paused-response obligation. Execution eligibility is reread before any
send, so an outstanding lease-delayed candidate observes these changes. New
run/lineage changes still go through the milestone boundary. Generic issue-service
assignment/status mutations notify directly. Agent deletion does not restore an
owed response. Goal status fields are separate session state.

Two further cases drive the real review-publication owner through token acquisition,
a terminal run transition and pre-send authority denial. A known-unsent publication
cancels and wakes terminal fallback through lease release. A saved ambiguous write
remains parked, with no repeated SQL over 120 seconds. The latter does not assert
that the provider write failed or relax host safety. Both pass in
`/tmp/sleep35-publication-settlement.log`. The existing eight-attempt acknowledgement
policy remains the owner of actual failed fallback sends.

The app now registers terminal-response work with warm-standby and idle-drain
gates, and recurring GitHub maintenance no longer calls terminal reconciliation.
The explicit/manual combined recovery entry point is preserved. Review-check
publication and stale-head review repair remain separate duties in maintenance.

## Candidate lookup and final acceptance

Generated migration `0395_jittery_norrin_radd.sql` adds a partial index for
processed, nonfinal response actions. It runs concurrently through the existing
top-level migration registry and is idempotent on replay. Snapshot pruning retains
0387 through 0391, exactly five. Application, replay, numbering/safety checks and
PostgreSQL index validity pass. No table or queue storage was added.

The worker pages candidates by ID, then asks the GitHub owner to resolve actual
run provenance and reply state. This has per-candidate read cost at startup or
an affected scope change; it does not scan while settled. Issue/delivery/repository
hints narrow normal wakes. A 101-row prefix of unrelated retained requests cannot
hide the owed terminal response and does not publish those unrelated requests.
The shared helper provides fair 25-entry dispatch batches after reconstruction.

A rollback-only experiment inserted 10,000 completed actions. The candidate index
query read four eligible rows using an index-only scan and four shared buffers.
See `/tmp/sleep35-index-plan.sql` and `/tmp/sleep35-index-plan.log`. This proves
completed-history exclusion for the candidate access path, not whole-worker latency
or fleet savings. The lifecycle tests prove settled SQL quiet separately.

Verification:

- The earlier extracted-owner GitHub acceptance passed 194 cases in 140.71 seconds
  (`/tmp/sleep35-github-acceptance.log`) before the three direct-writer repairs.
- Final focused selection passes 15 cases: fourteen new terminal-worker cases
  plus one existing matching case (`/tmp/sleep35-wired-focused.log`, 46.15 seconds).
  The startup source suite did not match this focused selector and is included
  in the full run below; it is not claimed passed by that focused command.
- Workspace typecheck and build pass after final source/wiring/index changes
  (`/tmp/sleep35-workspace-types.log`, `/tmp/sleep35-workspace-build.log`).
- Fresh complete chat/publication/startup acceptance is running on
  `paperclip_sleep35_full_20261025_test`, log `/tmp/sleep35-full-chat.log`.
  Its expected count is 1,571. Do not claim completion before its terminal result.
- Remote checks/review and any resulting repairs remain required.

Independent SQL writers and multiple replicas gain no new wake protocol. Cloud
alarm coverage and sleep admission are unchanged. The full recurring-server stack,
older failed gates/review findings and final master reconciliation remain open.

## Quietness fixture settlement and isolation (October 26)

The coordinator removes a due timer before it runs reconciliation. Therefore,
`nextWakeAt() === null` alone does not establish that the worker has finished.
The completed-history test now waits for both no scheduled deadline and zero
tracked active work before starting its existing two-minute quiet measurement.
It still requires zero database reads, zero transactions, and no provider writes.
No production worker, deadline, or recovery policy changes in this repair.

The same test previously restored its database spies only after all assertions
passed. A failed quietness assertion left the transaction spy installed. The
later audit fixture bound that existing spy, then replaced its implementation
with a callback through the bound spy, causing recursive calls.

A controlled experiment inserted one real SQL read inside the quiet measurement.
Before cleanup was repaired, the quietness assertion failed and the subsequent
`audit_insert` case failed with a stack overflow instead of its expected audit
error (two failures and one pass). With the same intentional SQL read and
unconditional spy restoration, only the quietness assertion failed; both audit
failure cases passed. The temporary SQL read was removed before acceptance.
This proves failure isolation without weakening the quietness assertion. It does
not independently reproduce the original CI timing race.

All 228 cases in the complete GitHub agent review, Discord automatic command
registration, and resource-change audit groups then passed against a migrated,
disposable PostgreSQL database. Other groups were excluded by the test selector;
this is not a complete chat-file result. Logs:
`/tmp/sleep-chat-quiet-contamination-red.log`,
`/tmp/sleep-chat-quiet-contamination-contained.log`, and
`/tmp/sleep-chat-quiet-owner-tests.log`.


## Master integration: native presentation and passive review waits

Master added two durable presentation guards after this worker was extracted.
The integrated provider resolver retains both through the same bounded run
projection used by direct response authorization. A terminal native status with
an unsettled presentation decision creates no fallback-send obligation yet.
The worker becomes quiet and the existing native finalizer milestone signal
reactivates it after a committed presentation update. A confirmed publication
still takes precedence over an absent fallback.

For a main PR response whose exact owned run deliberately yielded without a
publication, acknowledgement retires its own action under the publication lease
and keeps the shared assessment untouched. Issue-thread and review-thread
fallbacks retain their existing behavior. The cancellation signals response
availability inside the committing transaction. No provider call is replayed.

Acceptance includes master's passive-assessment and malformed/pending-decision
cases plus two worker cases: quiet pending presentation, rolled-back settlement,
committed passive or missing-response settlement, and final drain. The fixture
uses real PostgreSQL with controlled GitHub responses. The new cases must pass
before this integration is published; source merging alone is not acceptance.


## Current local preparation — October 28

Normal integration `ed1c9fcfa10d492bb56ea2e23cd97cddeebe9d5b` adopts the prepared
GitHub acknowledgement parent `3fef8f08c0337301706bc6348a05bb2a2fc50679`.
Every original domain/schema edit and unrelated parent blob is preserved.
The only conflict is a historical snapshot rename/delete; it retains the current
parent's 0396 snapshot byte for byte. The parent migration/client state is
identical before this slice's index is regenerated. Proof:
`/tmp/sleep35-parent-composition-proof.json`.

`706cb6dbf58bf42a5f611319994c2c3907c9a80f` regenerates the original terminal
work index as `0401_yummy_ultimates.sql`. Its concurrent/idempotent index SQL is
identical after whitespace normalization to the old unlanded 0395 definition.
All prior SQL/journal entries and retained snapshot bytes remain unchanged.
Canonical generation keeps the five newest snapshots, 0397–0401. The existing
top-level migration registry uses the new filename.

The exact parent-to-head migration-order gate, database build and production
server typechecking pass on that revision. Commands/receipts:
`/tmp/sleep35-current-compile-command.json` and
`/tmp/sleep35-current-{order,db-build,types}.*`.
These are compilation/history checks, not current lifecycle or PostgreSQL
migration-application acceptance. No current test count is claimed here.
The earlier lifecycle, quietness, provider, failure-isolation and presentation
results above retain their original revision scopes.

This remains local and unpublished while preceding PRs finish their required
gates and merges. Actual landed-parent reconciliation, relevant functional
acceptance, fresh exact-head CI and Greptile 5/5 without actionable findings are
still required. No full local repository, live provider or deployed sleep result
is inferred from this preparation. The following audit-only commit leaves the
compiled source and migration bytes unchanged.


## Current prepared-parent functional acceptance

Normal integration `aa72f32641b2e2c680342cd49477272349aca9db` adopts published
GitHub acknowledgement parent `09ca00b9f029838434ec042cda691345d67b493e`.
The complete original owned binary patch and all inherited master changes are
preserved. Proof: `/tmp/sleep35-published-parent-composition-proof.json`.

**304 distinct cases pass:** all 253 GitHub agent-review workflow cases (1,485
other chat cases skipped), all 30 heartbeat completion cases, all eight cases
across the complete real/unit issue-tree control suites, and all 13 startup
cases. Database build, server typechecking/build, module boundaries and three
fresh PostgreSQL migrations through 0401 pass. The control suite is explicitly
premigrated, preserving its original setup budget. Commands and actual fixtures:
`/tmp/sleep35-current-acceptance-command.json`; receipts/logs:
`/tmp/sleep35-current-{db-build,types,build,boundaries,github,completion,tree,startup}.*`
and `/tmp/sleep35-current-migrate-{github,completion,tree}.*`.
These results retain that prepared-parent revision scope.


## Acceptance on the landed GitHub parent and current master

GitHub acknowledgements #17656 landed at
`ba5bba86dcdde32b14d4d7dec1b51898e5f6f22d`. Its entire tree is byte-identical
to the published parent `09ca00b9f029838434ec042cda691345d67b493e`.
Master then added the queued-comment consumption optimization #18021.
Normal two-parent integration `3c8339a541bf68bc9957b9d5a8df80d3a7c3452d`
adopts master `52b86c2032a189b0ea259c5b0cb7158b07ef788c`. It preserves the full
24-path owned binary patch and all five new master paths. Both normal parents
and the exact tree are checked, including historical squash-ancestry resolution
against the verified published parent. Proof:
`/tmp/sleep35-landed-parent-publication-proof.json`. No force push or rebase occurs.

**74 distinct current cases pass:** all 17 terminal-response lifecycle/producer
cases (1,721 other chat cases skipped), all six queued-comment consumption
regressions for the new upstream optimization, all 30 heartbeat completion cases,
all eight real/unit issue-tree control cases and all 13 startup cases. Database
build, server typechecking/build, module boundaries, four fresh PostgreSQL
migrations through 0401 and the current-master migration-order gate pass.
The repeated 68 cases are not added to the earlier 304-case matrix; its full
GitHub group remains evidence at its stated revision.

The terminal cases cover finalized-history quiet, deleted Board sources, pending
presentation and passive results, outer rollback/commit, paused/new runs,
restart/drain/standby, native identity, lease waits, unrelated full-page history,
uncertain publication ownership and tree/workspace/exhausted-recovery producers.
The six new upstream tests cover bounded repeated reads and preserve saved-comment
JSON, identity, scope, author and cancellation semantics in the execution blocker.

A populated 0400 database upgrades to 0401 with all 399 prior migration receipts
identical and exactly one new receipt. Replay adds none. The terminal index is
valid and ready in both fresh and upgraded databases. The original SQL index
definition is unchanged apart from generation whitespace and filename references.
All prior SQL/journal entries and retained snapshot bytes remain preserved;
canonical retention keeps snapshots 0397–0401. Receipt:
`/tmp/sleep35-upgrade-replay-receipt.json`.

Actual commands, revision and fixtures:
`/tmp/sleep35-landed-acceptance-command.json`. Logs/receipts:
`/tmp/sleep35-landed-{db-build,types,build,boundaries,github,queued,completion,tree,startup}.*`,
`/tmp/sleep35-landed-migrate-{github,queued,completion,tree}.*`,
`/tmp/sleep35-landed-migration-order.*`, and `/tmp/sleep35-upgrade-replay.*`.
The following audit-only follow-up leaves all owned source/test/migration hashes
unchanged, in `/tmp/sleep35-landed-tested-source-sha256.json`.
Original producer, quietness, failure-isolation, skipped-suite and presentation
results above retain their original scopes. Fresh exact-head CI and Greptile 5/5
with no actionable findings remain required. This does not establish a full
local repository result, live GitHub delivery or physical host/database sleep.


## CI: native presentation startup observation

PR #17680 head `40f84082526d6ba405f206475c919c3b4b67ec4c` fails chat shard
1 in run 40814818307, job 123253388098. The passive native-presentation case
expires its initial default one-second idle poll with no deadline and two active
tracked operations. The aggregate verify check fails because of that shard.
This is retained as a real CI failure; no unchanged-head retry was issued.

The scoped worker's minimum pass interval is also one second. The initial poll
was added after the earlier coalescing correction documented above and still
used the default, while neighboring settlement observations use five seconds.
The unchanged local focused pair passes, so there is no claim of an unmodified
local reproduction of CI scheduling.

A temporary controlled fixture commits a real milestone hint during the initial
registered run and holds the second registered run attempt for 600 ms after
delegating to the existing implementation. That attempt may defer at the
unchanged one-second gate, retaining a coalesced follow-up. Both old observations
fail at the original one-second bound. With the identical probe, both pass when
the initial observation uses the existing five-second bound. The controlled
failures have a pending deadline and one active token; CI saw no deadline and
two active tokens. This proves that the observation window cannot reliably fit
allowed startup follow-up, not the exact unrecorded CI token-owner timeline.

The probe is removed byte for byte before final acceptance. The permanent
change is one argument on the initial poll. It still requires a null deadline
and zero active work, then proves two virtual minutes with zero SQL, transaction
or provider writes. Rollback, committed settlement and final drain assertions
are unchanged. Production code, scheduler cadence, retry/business deadlines and
the overall test budget are unchanged. Only this eventual-startup observation
uses the established five-second bound.

The no-probe focused pair passes. The complete named GitHub agent-review
workflow then passes all **274 selected cases** in 232.06 seconds on fresh
PostgreSQL 17. The other 1507 cases in the large integration file are outside
that named selection, not counted as acceptance. Five dedicated fresh 0409
fixtures isolate baseline, controlled red, controlled green, focused and workflow
runs. No embedded CI-environment equivalence is claimed. The source file hash
for permanent acceptance is
`d0dbef76741f03862dfef0a42338f97d5ea7a9f36d4b465c7538a5eaacd65b2c`.
Fresh published-head CI and review remain required.
