# Status-card evaluation deadlines

Status-card evaluation uses existing cards, updates and issues as durable truth.
`index.ts` registers a typed worker. The status-card owner controls evaluation,
generation claims, assignment through the ordinary issue wake API, and failed
assignment cancellation. Shared delivery infrastructure controls transaction
settlement, coalescing, retries, admission drain, standby and shutdown.

Manual cards have no automatic obligation. Interval cards retain the requested
evaluation cadence. Reactive cards evaluate committed source changes and retain
only an actual debounce, hourly rate, daily budget, active-hour or saved-query
membership deadline. Unchanged cards disarm. A changed experimental setting
invalidates the worker's cached feature gate. Other source writes do not reread
settings. Startup reconstructs every disarmed reactive scope together with any
concurrent company-scoped hint, without moving saved eligibility/retry deadlines.

Company search reports the earliest matching `updatedWithin` expiry through an
optional internal callback in its existing aggregate query. It includes rows
outside the returned page: an expiring priority-ranked row ahead of an offset
can change the watched set. The callback exposes only a normalized deadline;
ordinary search consumers and API responses retain their existing contract.
Overlapping query scopes can require an evaluation when one query expires even
if another still retains the same issue; no generation occurs without a filtered
card change. No recurring scan replaces the expired query obligation.

## Claims and recovery

A feature-owned PostgreSQL transaction advisory lock serializes scheduled
per-card evaluation across connections. Its transaction holds no card row lock
while existing issue/card services commit through their own transactions. The
lock remains held through actual refresh settlement. Existing card deadline CAS,
generating-issue ownership and issue idempotency keys remain in force. Manual
refresh and older instances continue to use those existing guards. A busy lock
retains a company-scoped retry; consuming a hint is not successful evaluation.
A failed scheduled refresh retains the existing five-minute durable claim.

Once a generation exists, the normal issue assignment authority remains its
owner. Assignment failure cancels that issue and finalizes the card's failed
ledger entry. The user's ordinary refresh action can retry it. Restart recovery
must not repeat an already completed generation. No new timer table, automatic
write replay, execution-authority exemption or sleep-safety relaxation is added.

## Supported producer coverage

All hints are registered before the relevant write within its owning transaction.
Nested service writes share outer commit ownership. Company-scoped hints batch
reactive reconciliation; ordinary execution writes without known scope retain
all existing execution consumers without sending an instance-wide card hint.

| Producer | Notification boundary and coverage |
| --- | --- |
| Card create, configuration, archive/restore, delete, compile, query/summary result, evaluation claim | Status-card mutation transactions; stalled issue finalization signals before releasing the card claim |
| Experimental status-card setting | Instance experimental-settings transaction; full reconstruction is appropriate for this instance-wide setting |
| Company pause/archive/reactivate/delete | Company lifecycle/deletion transactions and budget-owned company hard-stop/resume transactions |
| Issue create/update/delete and label changes | Ordinary issue transactions; label deletion signals its known company before cascades; title and prefix changes signal their existing owner transactions |
| Issue checkout/adoption/release/reset and environment-selection recency | Existing issue transaction, or a transaction around the previously standalone write; company comes from the existing issue/run read |
| Comment create, edit, delete, tombstone, import and recency | Common comment insert; outer root comment transaction; queued-comment and Telegram edit transactions; existing metadata-upgrade path; remove/tombstone transactions |
| Issue import, comment import, document import | One notification per affected company in the existing batch transaction; no per-row notification lookup |
| Document create/update/restore/delete and search membership | Document owner transactions; only the existing company is passed, without copying search predicates into producers |
| Review, interaction and execution transitions | Existing issue-review-state and native-status-reassessment boundaries; scoped execution-control helpers; interaction recency touches own a transaction when called after settlement |
| Run admission, retries, monitors, watchdog/recovery and native settlement/reclaim | Existing scoped review/milestone/status/execution-control hooks; explicit notifications at the uncovered issue execution bind, legacy claim, monitor claim/release and review-participant recovery transaction |
| Agent deletion/access reassignment and project deletion/privacy cascades | Existing company-scoped owner transactions before foreign-key or recursive issue changes |
| Workspace selection/binding, plugin/provider workspace and cleanup/audit touches | Existing owner transactions, including standalone cleanup and audit recency writes now enclosed with their intent |
| Skill-test harness expiry and task-watchdog fingerprint touch | Existing owner mutation transaction; no feature policy is moved into the writer |

The audit includes direct issue/comment mutations, raw recursive privacy updates,
bulk insert helpers, label/project/agent cascades, linked document search content
and timestamp-dependent search membership. Metadata-only writes that do not
change the fingerprint, matching fields or visibility do not create an evaluation
obligation: examples include run identity linkage, workspace IDs without a
recency change, document locks and source-trust receipts without searched content
changes. Routine and status-summary documents that have no issue-document link
do not change issue search membership.

This follows the existing [single-active-writer contract](../idle-sleep-safety.md).
Supported services, import/recovery writers, caller-owned transactions and startup
reconstruction participate. Independent SQL writers or another active server
process require explicit wake ingress; process-local hints do not establish
cross-replica notification delivery. The advisory lock supplies competing
scheduler exclusion, not cross-process event transport. Internal deadlines do
not establish a Cloud wake alarm or prove host/database suspension.

## Verification

Real PostgreSQL acceptance uses ordinary card create/compile and authorized
summarizer writeback. The assignment boundary is controlled: it persists a wake,
and the test explicitly performs the authorized result write; no model runs.
Checks cover empty/manual/reactive/disabled quiet SQL, first source change,
debounce and durable wake/result, earlier/cancelled deadlines, outer commit and
rollback, drain/resume, competing connections, busy locks, restart eligibility,
active hours/rate/budget gates, multiple companies, budget-owned company resume,
ignored activity, document/comment membership, relative query expiry including
an off-page candidate, failed assignment cleanup/manual retry and the persisted
five-minute internal-failure retry across restart/drain.

Shared coordinator regressions also cover warm standby, ambiguous transaction
intent, failure entering drain and different domain/coordinator gates. The paused
worker releases only settled holds and retains a future in-memory resume wake.
An expired saved deadline cannot schedule an immediate skipped-attempt loop.
Existing startup, status-card, company-search, execution and monitor suites cover
the production wiring and unchanged consumers. Exact commands and results belong
in the PR verification record; this document does not claim deployed savings.

### Review corrections: pool capacity and restart deadline ownership

Scheduled evaluation holds its advisory transaction on `withDedicatedDbConnection`,
not on the ordinary write pool. The helper ends that physical connection in
`finally`, including contention and failed evaluation. Its lock still spans the
actual refresh settlement. Summary writeback runs watched-query reads on its
existing transaction, so a one-connection main pool completes the full flow.

Migration0420 adds nullable internal `next_eval_reason` to the existing card row.
Membership deadlines may be reconstructed at startup after a committed source
hint was lost. Policy eligibility and the atomically recorded five-minute retry
lease retain their saved deadline. Explicit refresh deadlines remain due work.
The HTTP card response removes this internal provenance; the public schema stays
unchanged.

Migration0419 retains the published agent-comment retry uniqueness and conversation read-state backfill. The status-card column follows it in migration0420; the combined schema snapshot is generated from both owners.

For legacy rows, a pending change hash preserves policy eligibility. An untagged
active deadline farther than five minutes away cannot be an outstanding
five-minute claim, so startup rechecks it. An ambiguous untagged deadline within
five minutes keeps its remaining time without extension. This bounds migration
compatibility delay while preserving prior crash/failure recovery. After the
first successful evaluation all newly saved deadlines have explicit ownership.
No recurring compatibility scan is added.

Source notifications use the shared deadline helper's fixed one-second batching
window. The first hint after idle can reconcile immediately. Later hints merge
by company until that window ends. The window does not slide with each new
write, so a sustained source stream cannot postpone reconciliation forever.
One second keeps reactive cards prompt (the removed heartbeat default was 30s)
and bounds burst SQL. No minimum spacing is set: an already-known policy,
expiry, or retry deadline can preempt batching. The window alone creates no
scheduled work after settlement. Real issue/comment producer acceptance measures
due/next queries and actual searches under 100 writes, preserves both companies'
hints, dispatches another company's saved deadline inside the batching window,
and checks SQL quietness after authorized results.

Card deletion resolves the card's owning company and emits only that company's
deadline-reconstruction hint. Every card mutation requires a company ID; only
instance-level settings retain wildcard ingress. Deleting an already-missing
card emits no hint. The real two-company regression proves deletion does not
re-run unchanged reactive searches or wake either summarizer, then stays quiet.

Active-hours eligibility keeps the existing exact UTC-minute search across DST
changes. A bounded 32-entry timezone formatter cache removes repeated ICU
construction. A bounded 256-entry cache reuses the next opening for the exact
(timezone,start,end) policy only while the candidate instant stays within its
previously searched closed range. The precise instant is checked first, so
historical second-based offsets, the opening itself, and millisecond deadlines
keep their behavior. Clock rollback and policy changes cannot reuse the wrong
range. Empty windows return without formatter or search work. A cold nonempty
policy can still perform at most 2881 conversions including its first check; warm
closed-range evaluations perform one conversion, not another minute walk.
Both caches use bounded LRU retention and hold no company/card data. Tests prove
eviction, skipped/repeated hours, half-hour DST, date-line changes, rollback,
strict boundaries, and actual twenty-card source delivery followed by quiet.


Refresh decisions use the card's PostgreSQL row revision as a private compare-and-swap fence. If a card changes during watched-source reads, the owner rereads it and reconsiders the current policy, for at most three attempts. A replacement future interval deadline remains unchanged; a replacement manual policy does not run automatically. The same fence protects no-change, paused-policy and generation claims. Refresh task idempotency includes that captured revision: concurrent requests for the same revision still share one task, while a later revision gets an independent task even when its watched fingerprint is unchanged. A superseded refresh can therefore cancel its losing task without cancelling a newer revision's not-yet-claimed task. Compile task identity is unchanged. The row revision is not exposed through card APIs or shared scheduling contracts.

Company source hints do not preempt a future deadline owned by a failed evaluation (`retry`). Membership and policy deadlines remain eligible for source-driven rechecks, and actual due retries still run. An explicit policy edit can replace the retry through the existing card mutation path. Real PostgreSQL regressions hold the actual search while committing an ordinary policy edit, then verify the saved interval still fires. Persistent search failures stay quiet through issue hints and restart, retry at their saved deadline, and recover through an ordinary policy edit.

Card queries request the search owner's internal `issueResultsOnly` capability.
Nonissue result branches and their counts are excluded before pagination, so
project, agent or artifact changes cannot evict a watched issue from a bounded
page. This corrects the former accidental competition with results that cards
discarded after pagination. The saved query's text scope is unchanged: `all`
still matches issues through their comments and documents, and explicit comments
or documents scopes retain their task matches. Issue filters, privacy, tenant
boundaries, facets and membership-expiry deadlines remain search-owned. Card
preview, visibility counts, generation and writeback all use the same restriction.
Normal company search keeps its mixed result kinds by default. No extra
project/agent/artifact wake fanout or public query syntax is introduced.

A losing refresh cancels only an unclaimed task. It locks the exact company task
in the canonical issue-first order, checks its generation ledger, and preserves
terminal state and timestamps. Successful summary writeback records that ledger
in the same transaction that clears the card's generation pointer. Because the
failed card revision CAS excludes a future claim of this revision's task, the
loser cannot mistake a completed shared winner for an unclaimed orphan. The same
original request returns without enqueueing or reporting an active generation;
a separate later manual request can still start a new revision. Canonical issue
cancellation uses a transaction-bound service so its preflight reads also work
with one connection. Activity publications and native-question actions run only
after the outer transaction commits. Archive and truly unclaimed-task cleanup
retain their existing effects.


Every reactive summary writeback records one immediate card-owned refresh deadline in the same transaction that clears its generation. This preserves changes whose committed source hint was consumed while the old generation still owned the card, including changes after the summary's final watched-source read. The existing card commit hint restores that one deadline; it does not fan out to other companies or force generation. A fresh unchanged search disarms it. A relevant diff follows the existing policy, assignment, result and quiet path. Manual and interval writeback cadence stays unchanged. Rollback removes both the summary and its recheck obligation. Real PostgreSQL controls hold the actual summary search, commit an ordinary issue write, observe the worker consume that hint while generation is still owned, then verify exactly one needed generation or one unchanged recheck followed by SQL quiet.
