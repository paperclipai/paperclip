# Remaining GitHub chat maintenance owners

Inspected after slice 33 at `6d01f4c730aed91e660a63eede688f4f4da61252`.
No implementation or verification claim yet.

The label "GitHub history maintenance" hides several separate duties.
`chat-channels/github/maintenance.ts` serially calls response-comment
`processPending`, then review-check `processPending`. It launches through the
chat service's tracked message-processing lifecycle, with a single-flight flag.
Do not replace that tracked work with an unjoined promise or shared-provider code.

## Candidate slice 34: response-comment acknowledgement dispatch

Owner: `chat-github-response-comments.ts`. Existing durable actions have
kind `github_response_comment`. `stageResponse` inserts status received before
competing for the repository publication lease, so contention does not lose work.
It is called both by acknowledgement and `writeGitHubResponseComment`, including
agent-authored/final response paths. Insertion currently uses a root client;
notification must be in a transaction around the actual write. Repeated calls
also read the existing action, and must not repeatedly wake themselves solely
because an insert lost onConflictDoNothing.

The first half of `processPending` selects received actions and failed actions
with result.retryable=true whose saved retryAt is due, oldest-created first,
limit 10. `tryAcknowledge` records attempts and exponential retryAt capped at
five minutes; existing policy stops automatic retries after eight attempts.
403 authorization changes cancel the action. Preserve that current policy,
company/endpoint/principal authority, generation fencing, and lease ownership.
Do not infer successful delivery from a missing row or an SDK return alone.

Acknowledgement can deliberately defer to a fast response while its request or
publication is pending/running/streaming, or until its saved expiresAt. Published
or ambiguous fast responses supersede the ordinary acknowledgement without
another send. A worker cannot simply repeatedly run every received action with
now+backoff: park behind committed fast-response/publication state and retain
only the real expiration/recovery obligation. Inspect all those producers.

Provider history scanning is bounded at 100 pages of 100 comments and fails
closed if identity cannot safely be recovered. Preserve App-owned markers,
shared pull-response targets, legacy placeholder retirement, no-regression final
receipts, and uncertain-post handling. Provider details stay in this owner.

## Separate reason: terminal response reconciliation

The second half of response `processPending` scans processed actions with
result.final != true. It joins conversation/endpoint/issue and latest terminal
run for the assigned agent, with blocked-issue or source-message provenance
conditions. Acknowledgement completion is not final-response completion.
Run transitions, issue changes, source linkage, response/publication settlement,
and fast-response changes can affect eligibility. Current milestone notifications
may provide an existing boundary but require a full writer audit.

`acknowledge` preserves source-run/active-identity checks and defers while
`githubRunReplyState` is unsettled. A successful final reply may require retiring
an older placeholder rather than posting a second reply. Existing no-op maintenance
writes updatedAt only to rotate oldest-prefix candidates; removing that polling
must replace starvation handling without manufacturing permanent writes.
Waiting for a nonterminal run is passive, while unresolved actual delivery still
needs owned recovery. Keep this independently reviewable from initial dispatch.

## Separate reason: GitHub review-check publication

Owner: `chat-github-checks.ts`, kind `github_review_check`. Enqueue comes from
webhook-events and chat-github-reviews. It snapshots runtime generation and
normalized review event. Delivery derives queued/running/completed state from
review, run, inbound delivery, assessment and current configuration. Existing
repository publication leases and GitHub head/authority checks remain mandatory.
A terminal assessment has its own outbox; ordinary check delivery marks itself
processed when that assessment owns the result. Never dispatch agents here.

Nonterminal success currently saves received plus retryAt=now+5s, even if
nothing changed. Replace that state discovery with producer events. Failed
publication has saved exponential retryAt and the existing eight-attempt policy.
Investigate stale-head discovery: an external PR push must have a supported
webhook/replay contract or a scoped outstanding-check reconciliation deadline.
Do not remove its only fallback on assumption that local run events cover it.

## Separate reason: late review projection repair

Before dispatch, check processPending globally updates queued/running review
rows without assessments when a matching cancelled stale-head check receipt
exists. This repairs admission that commits after cancellation. Both writers
must signal it; late review insert and cancellation are separate commits.
Extract this duty from publication dispatch rather than keep a global update
on every check wake. Preserve exact company/endpoint/delivery/event identity.

All four duties still need real producer tests, startup reconstruction, scoped
fair progress, rollback/commit, drain/resume, and quiet retained-history tests.
The aggregate maintenance call cannot be retired until every duty is covered.

## Additional producer/dependency evidence

Response writes also enter from `chat-github-reviews.ts` (agent comment/update
and assessment paths), `chat-channels/publications/transport.ts` (failed-run
publication), and `github/wake-authority.ts` after inbound admission. The
`tryAcknowledge` boundary classifies current authority failures as cancellation;
it does not silently return null for a missing source. Preserve that distinction.

Fast-response insertion already signals `DELIVERY_QUEUES.fastResponse` through
`fast-responses.ts`, but that notification currently has no scope and later
request-state transitions need their own audit. Publication notifications carry
optional issue scope only on relevant writers; not every publication mutation
currently fans out to milestones. A future acknowledgement worker must cover
both request and publication transitions without importing GitHub policy into
these shared services. The concrete cross-owner capability is notification of
a change to an existing response slot, not a GitHub-specific scheduler branch.

Existing integration fixtures and regression tests are in the early GitHub
section of `chat-channels.integration.test.ts` (around lines 2,750-6,200 in this
revision); there are no standalone response-comment or check suites at the
initial guessed filenames. Reuse the controlled provider API and real DB
fixtures rather than replace authority/lease operations with mocks.

## Design constraints refined during slice 33 acceptance

Keep initial acknowledgement dispatch separate from terminal-response recovery.
The public/manual `processPending` can delegate to both, while recurring
maintenance calls only the terminal half until its own later migration.

The repository publication lease already releases through a transaction and
signals `chatGitHubPublications`. A new acknowledgement worker must not register
a second worker under that occupied topic. It needs its own topic and narrowly
scoped lease-release hints or a shared response-availability notification.
Lost/contended lease acquisition returns undefined; that is not proof of a
successful acknowledgement. Represent the actual outstanding lease expiry and
react to release. Renewals are active-operation work, not idle polling.

Avoid a self-wake loop: `stageResponse` is called repeatedly while acknowledging
an existing action. A no-op insert/read must not repeatedly trigger dispatch of
that same received action. A received action waiting on fast-response publication
needs either the saved fast-response expiry, publication outcome changes, or
concrete unresolved claim recovery. Never return now indefinitely for it.

Most ordinary publication terminal writers already supply company/issue scope to
`notifyChatPublicationWork`; provider retry/unknown and stale-stream quarantine
paths sometimes omit it. Specifically inspect `publications/failures.ts`,
`worker.ts::settlePublicationPreparationFailure`, and queue quarantine. A fast
response that changes streaming -> retry/unknown must release/reclassify the
acknowledgement's wait. Do not depend solely on succeeded publication events.

Fast-response state writers include enqueue, skip, settle, claim, publication
comment binding, supersede, final publication-status suppression, and bulk expiry.
Only changes to the actual acknowledgement predicate require a wake. Expiry is
already a saved deadline; claim pending -> running keeps the same predicate.
Early failure/skip and adding a publication binding require producer coverage.
Do not blindly wrap every write or introduce GitHub branches in fast-responses.
Use a normalized response-slot change contract if these shared owners need a
new notification capability, with existing transactions reused wherever present.

## Slice 34 implementation and boundaries

Initial response acknowledgement now registers with the existing delivery
coordinator. This is a separate worker from terminal-response reconciliation,
review-check delivery, and stale-head repair. The latter three remain in the
GitHub maintenance owner. The explicit/manual combined `processPending` entry
point still performs both initial and terminal response recovery.

The durable source remains `chat_actions.kind = github_response_comment`.
Received actions and retryable failed actions are reconstructed on startup in
100-row ID pages. The shared scoped-deadline helper dispatches a fair batch of
25 across companies. Exact delivery, conversation, issue, and repository-lease
hints restrict reconstruction. Processed/cancelled actions and exhausted failures
leave this worker's inventory; retained response history does not arm a timer.
No new queue table or changed automatic retry limit is introduced.

The next deadline is derived from existing saved retry state, a competing
repository publication lease, or a pending fast response's expiration. A
streaming fast response parks acknowledgement work until publication settlement
or quarantine changes its state. The publication worker still owns stale-stream
recovery. This worker does not invent a second timeout or replay an uncertain
publication. Published or delivery-unknown fast responses suppress the ordinary
acknowledgement through the existing provider owner.

Producer coverage:

- `stageResponse` signals its insert transaction. Existing response lookups do
  not emit another signal. This prevents acknowledgement itself from continuously
  waking an unchanged received action.
- Failed/cancelled acknowledgement settlement signals the existing action's
  delivery before its transaction writes the result.
- Repository publication lease release signals the precise endpoint/repository/
  pull-or-issue number. The signal covers receipt changes made under that lease,
  and releases waiting acknowledgements when another publication finishes.
- Fast-response admission, early skip, accounting settlement, and publication
  binding signal the existing response slot. Pending-to-running claims retain
  the same wait predicate; pending expiry already has a saved deadline.
- `supersedeFastResponse` is used only by Board chat, which has no external
  acknowledgement delivery. It was audited and left unchanged.
- Publication completion, failure, retry, ambiguous delivery, preparation failure,
  pause-race reset, and stale-stream quarantine notify response availability.
  Task-control cancellation covers the affected conversation. Content preparation
  and lease bookkeeping do not create response-availability debt.
- Endpoint removal deletes its response actions. Other authority checks remain
  in the response service before any provider write. The worker does not cache
  authorization or infer authority from a queued action.

The shared capability is `notifyChatResponseAvailability`: an identifier-only
hint that an existing response slot may have changed. Fast-response and ordinary
publication owners do not inspect GitHub payloads or choose GitHub behavior.
Only the GitHub acknowledgement owner parses repository thread identity and
applies its response protocol. Notification serialization explicitly picks IDs
so passing a publication row cannot carry its payload into scheduler hints.

Provider requests remain outside database transactions. The existing repository
lease, current source/principal checks, response markers, shared pull-response
identity, version fencing, and final-receipt preservation remain in charge of
provider effects. A recovered known receipt is marked processed so it cannot
remain permanently in the pending acknowledgement inventory. Admission is checked
at the actual fetch boundary after lease renewal; an in-flight request may settle,
but a stopped worker cannot start the next provider request. Stop-related failures
do not consume the provider retry budget.

The migration adds three concurrent, idempotent indexes: pending acknowledgement
IDs, fast-response delivery lookup, and publication comment/destination lookup.
It uses the existing top-level migration mechanism and snapshot pruning rules.
These indexes avoid rebuilding pending work by scanning completed history.

Supported writes are the service's process-local transaction notification model.
Independent SQL writers or a second instance do not acquire a new wake guarantee
from this change. Host sleep eligibility and external alarm coverage are unchanged.
A local deadline is not evidence that a stopped host can wake itself.

## Verification evidence retained during development

- The first eight lifecycle tests failed on a PostgreSQL JSON-expression precedence
  error in the lease lookup. Parenthesizing the repository-ID expression fixed
  the query; all eight then passed.
- Removing the real fast-response settlement notification made the regression
  fail: fallback waited until the response expired. Restoring that signal is the
  implementation under test. The assertion measures when the action settles,
  separately from the coordinator's final coalesced bookkeeping pass.
- The initial concurrent-index application failed because the migration was not
  in the existing top-level statement registry. Registering it fixed application;
  a second application also completed successfully.
- Expanded tests exposed provider error normalization at the fetch boundary.
  The worker now preserves a stopped attempt without charging a provider failure.
  The fault fixture was also narrowed to response-comment POSTs so installation
  access-token requests were not mistaken for acknowledgement attempts.
- Fourteen new real-PostgreSQL cases and the startup guard pass. They cover empty
  and retained-history quiet, lease release, restart, drain, standby, fast-response
  failure/expiry/publication/unknown outcome, stale-stream quarantine, outer
  rollback/commit, saved provider retry, and stop between provider requests.
- Full chat/fast-response acceptance, workspace typecheck/build, remote CI and
  review remain pending. This document does not yet claim PR readiness.

Workspace typecheck/build now pass. The fast-response test harness supports an
explicit fresh `_test` PostgreSQL database, retaining embedded PostgreSQL by
default. Its first run passed the 69 test bodies but failed cleanup on an invalid
client-close call; the corrected setup then hit retained fixed-prefix fixtures
when the same database was reused. A fresh database passes all 69 tests and cleanup.
Final server typecheck passes. All three migration indexes are valid in PostgreSQL.
The complete affected chat suites are still running; remote checks/review have not
been claimed complete.

A rollback-only PostgreSQL plan experiment seeded 10,000 completed response
actions and 10,000 unrelated fast-response records alongside one pending action
and its matching request. The pending-ID lookup used
`chat_actions_github_ack_work_idx` and read one row (two shared buffers); the
request lookup used `fast_response_requests_delivery_idx` and read one row
(three shared buffers). This checks the two lookup access paths, not whole-worker
latency or deployed fleet savings. All experimental writes were rolled back.

The first complete chat acceptance passed all 1,554 tests without skips in
496.42 seconds. Final review then added three receipt-lifecycle cases: confirmed
received/failed receipts settle, but cancelled receipts stay cancelled. The new
cancelled case failed before correction. Settlement now applies only to pending
states and compares the observed status before writing. The final version of the
producer-removal test also failed as expected without the settlement notification.
The corrected implementation is undergoing a fresh full acceptance run with the
three additional cases; earlier full results are not substituted for that run.

After the final receipt correction, all 17 new lifecycle cases and the startup
guard pass. Workspace typecheck and build pass again. The final complete chat
run remains in progress; source and branch remain fixed during acceptance.


## Acknowledgement presentation wait correction

An acknowledgement for the latest successful native run can remain `received`
while that run's presentation decision is still absent. Reattempting it only
acquires/releases the publication lease and returns, leaving an overdue entry.
Recovery now shares the delivery owner's request/run projection and parks that
specific no-reply state. It retains normal lease, fast-response, and delivery
retry deadlines for actionable requests. Run/presentation/publication changes
wake it through the existing transaction-aware response-availability topic.
No new rows or periodic recovery scan are introduced.

The GitHub owner keeps request binding and provider reply interpretation in
`github/response-run-state.ts`; both delivery and scheduling use the same
projection. Heartbeat's existing presentation write is named
`recordRunPresentationDecision` without changing its transaction or event order,
so the real producer can be exercised with outer commit and rollback. This does
not move GitHub publication authority into the generic native chat repair path.

The first usable regression reproduced an overdue deadline in
`/tmp/sleep-ack-presentation-red-terminal.log`. Earlier fixture attempts lacked
GitHub configuration or terminal success. An attempted generic native-response
repair correctly returned false: GitHub replies remain tool-owned. Those fixture
failures remain in the red/configured, green, and current logs. The final regression
uses the existing GitHub delivery fixture and real heartbeat decision writer:
no SQL for two virtual minutes while parked or after rollback; commit updates the
same provider comment once, then returns to quiet.

All 228 GitHub workflow cases pass (`/tmp/sleep-ack-presentation-acceptance.log`),
as do all 30 heartbeat completion cases (`/tmp/sleep-ack-completion-full.log`) and
server typecheck (`/tmp/sleep-ack-presentation-types-final.log`). The initial
completion command omitted its database URL and skipped 29 cases; the full result
uses a fresh dedicated migrated database. No full-repository, final-stack, or
deployed sleep claim follows from these owner-level checks.


## Current parent and migration acceptance — October 28

The existing GitHub acknowledgement slice is normally integrated onto published
continuation parent `a1d16f84b3fae361d5d648670a5964486370c3a3`. Integration
`51f2f35f54d75648e50f9ec9beada1e479307ecb` preserves every original domain/schema
edit and every unrelated parent blob. It carries the parent confirmation and
continuation work indexes. Proof:
`/tmp/sleep34-indexed-parent-composition-proof.json`.

The old draft-owned migration 0394 collided with landed history. Its three
indexes were first regenerated locally as 0399; the preceding continuation then
needed its own proven work index at 0399. This slice now generates
`0400_absent_phantom_reporter.sql` against the current schema. Only unlanded
artifacts were replaced. The three original concurrent/idempotent SQL index
definitions are identical after whitespace normalization. All prior SQL files,
journal entries and retained snapshot bytes remain intact. Canonical generation
prunes 0395 and keeps the five newest snapshots, 0396–0400. The top-level
migration registry includes the new filename. Both normal merge parents and the
exact tree are checked; no force push or rebase occurs.

At `337f272853d4f8a51b5b9300900a46eb4e13f698`, **305 distinct cases pass**:

- All 236 selected GitHub agent-review workflow cases, with 1,485 other chat
  cases skipped. This includes acknowledgement lease/restart/drain/standby,
  fast-response outcomes, outer rollback/commit, saved retry, stop between sends,
  receipt-state preservation and the real heartbeat presentation writer.
- All 26 cases in the complete fast-response service suite.
- All 30 cases in the complete heartbeat completion suite, with an explicit
  external database so no embedded-platform guard skips the cases.
- All 13 app/startup cases.

Database build, server typechecking/build, module boundaries, three fresh
PostgreSQL migrations through 0400 and the exact parent-to-head migration-order
gate pass. The first migration-order invocation passed symbolic `HEAD` to a
command that requires a full 40-character SHA; its usage output is retained.
The corrected command passes without a code change.

An existing populated 0399 test database also upgrades to 0400: all 398 prior
migration receipts remain identical, exactly one receipt is added, and replay
adds none. All three indexes are valid and ready in both a fresh and upgraded
database. Receipt: `/tmp/sleep34-upgrade-replay-receipt.json`. This tests schema
application and replay; it does not claim whole-worker latency or fleet savings.

Commands and exact fixtures: `/tmp/sleep34-current-acceptance-command.json`.
Logs/exit receipts: `/tmp/sleep34-current-{db-build,types,build,boundaries,github,fast,completion,startup}.*`
and `/tmp/sleep34-current-migrate-{github,fast,completion}.*`. The earlier 69-case
fast-response group, 228-case GitHub group and broad chat runs above retain their
original revision scopes. In particular, the current complete service file has
26 cases; an earlier broader count is not substituted for it.

This remains local preparation while #17653 finishes current-head remote gates.
Its eventual landed squash parent must be reconciled before publication. The
following acceptance-only edit leaves all owned source/test/migration hashes
unchanged. Fresh exact-head CI and Greptile 5/5 with no actionable findings are
still required for this slice. No full local repository suite, live GitHub tenant
or deployed sleep result is inferred from this acceptance.


## Acceptance on the actual landed continuation parent

Continuation recovery #17653 has merged at
`063cfd43813cabf18417605fb9eefb9aacf95c8d`. Normal two-parent integration
`9b3607e159153e00ccdfe538d52b591bd38d6499` preserves the full 28-path owned
binary patch and all 20 intervening master paths. Those paths include native
retry recovery, OpenCode provider-event exit codes and evaluation report-lock
workflow fixes. The verified published parent is the semantic base for historic
squash conflicts. Both normal parents and the exact tree are checked; there is
no force push or rebase. Proof:
`/tmp/sleep34-landed-parent-publication-proof.json`.

**87 distinct current cases pass on that landed-parent source:** all 18 selected
acknowledgement lifecycle/presentation cases (1,703 other chat cases skipped),
all 26 fast-response service cases, all 30 heartbeat completion cases and all 13
startup cases. Database build, server typechecking/build, module boundaries,
three fresh PostgreSQL migrations through 0400 and the current-master migration
order gate pass. The Runner vendor bundle is rebuilt successfully because its
upstream provider-event inputs changed. Database build runs first so the prior
local terminal-response preparation's ignored 0401 output cannot leak into this
0400 acceptance.

This selection rechecks the supported signals, claims, rollback/commit,
presentation parking, stop boundaries and settlement consumers after the master
context changes. The earlier 305-case matrix remains scoped to prepared revision
`337f272853d4f8a51b5b9300900a46eb4e13f698`; the repeated 87 cases are not added to
305. All three index definitions and schema history are unchanged during this
integration. The populated upgrade/replay and fresh/upgrade index-validity proof
above therefore keeps its stated schema scope.

Commands, revision and actual fixtures:
`/tmp/sleep34-landed-acceptance-command.json`. Receipts/logs:
`/tmp/sleep34-landed-{db-build,types,build,boundaries,github,fast,completion,startup}.*`,
`/tmp/sleep34-landed-migrate-{github,fast,completion}.*`, and
`/tmp/sleep34-landed-migration-order.*`.
The following audit-only commit leaves all owned source/test/migration hashes
unchanged, recorded in `/tmp/sleep34-landed-tested-source-sha256.json`.
Original failures and earlier scopes above remain visible. Publication requires
fresh exact-head CI and Greptile 5/5 with no actionable findings. No full local
repository, live GitHub tenant or deployed sleep result is inferred.
