# Decision TTL expiry while idle

Open decisions already contain an `expiresAt` deadline. The expiry worker now
uses that timestamp instead of scanning TTL candidates on each maintenance tick.
This slice owns time-based expiry only. Target invalidation, interrupted effect
recovery, and retention remain separate duties.

## Producers and transaction ownership

Creation and bundle creation call `notifyDecisionCreated` before the decision
insert in their existing transaction. It signals expiry only: an open row cannot
owe continuation delivery yet. Existing decision updates share `notifyDecisionChange`, which now
signals expiry as well as continuation delivery. Cancellation, dismissal, and
execution claims therefore remove obsolete expiry deadlines. All production
inserts and updates are in the decision owner; acknowledgement only changes
terminal delivery metadata and cannot change an open expiry. No supported API
currently edits an existing decision's expiry timestamp. A future such writer
must use this same notification boundary.

The helper adds no recovery wrappers to routes. Outer transactions and nested
savepoints retain the shared commit/rollback and uncertain-outcome protocol.
Creation without a committed row cannot publish a business deadline. Startup
reconstructs saved deadlines, including already-overdue work. Independent SQL
writers and another active server process need their own wake contract.

`decision-expiry.ts` owns due selection, the next deadline, and expiry settlement.
`decisions.ts` delegates expiry-on-use and the existing target-driven expiration
transition to that owner. Target selection remains outside the TTL worker.
Startup registers TTL work before the combined decision sweep. The periodic
combined sweep opts out of TTL selection and cannot expire a row merely because
its TTL elapsed. Its public default still includes TTL and preserves the
configured combined-sweep batch limit.

## Deadline, settlement, and recovery

The next deadline is the earliest open `expiresAt`. A partial index on
`(expires_at, id)` covers open decisions. The query selects one indexed row;
retained terminal history does not enlarge the deadline lookup. Expiry is due
when `expiresAt <= now`, including equality. The old combined path skipped the
exact equality despite selecting that row; this migration fixes that boundary.

Each worker pass honors `PAPERCLIP_DECISIONS_SWEEP_BATCH_SIZE` (default 100),
ordered by expiry and ID.
Its in-memory cursor advances across failures and wraps after the last page.
Remaining overdue work retains a one-second continuation through the saved
earliest deadline after a successful pass.
Failures retain the existing 30-second retry throttle. New earlier creation or
resolution of the earliest decision causes deadline reconciliation. When only a
future expiry remains, the worker does not query again until that deadline or a
committed change. No open decisions means no recurring expiry work.

Settlement requires the row to remain open. TTL settlement also rechecks that
the saved deadline is due. Metadata is merged into the current row. The existing
expiry activity is persisted in the same transaction as the terminal transition.
Publication and origin continuation follow commit. If the audit insert fails,
the expiry and continuation obligation both roll back. A deadline-driven expiry
records `ttl`; target-driven expiration retains its own reason. When both causes
are possible, the first successful terminal transition determines the reason.
Continuation failures belong to the continuation worker after the decision is
expired. Neither owner replays decision effects.

Drain and standby defer dispatch while retaining the request. The worker checks
the coordinator's AbortSignal between candidates. Shutdown finishes the admitted
expiry and leaves untouched candidates for restart. It does not process the
whole backlog before stopping. There is no new queue table or permanent DB
listener, and no provider call is held inside a new transaction.

## Limits

The disabled-heartbeat branch keeps its existing behavior and does not register
this worker. Expiry-on-use remains enforced independently of background work.
The in-process deadline is not an external Cloud alarm. Existing conservative
sleep blockers remain; this migration does not permit an instance to sleep with
unsupported future obligations. Worker quiet is not proof of host or database
suspension.

## Verification

The original combined selection passed 103 tests: 14 initial real-PostgreSQL expiry worker
cases, 50 decision service/continuation cases, and 39 startup cases. It covered
empty and terminal-history quiet, actual create and bundle producers, exact
expiry, moving the next deadline earlier, cancellation, restart, outer rollback
and commit, first creation during drain, failed retry through drain, failed wake
delivery, separate aggregate/TTL ownership, 101 candidates with a failed first
row, creation during delivery, and shutdown/restart with outstanding candidates.
The parent archive race and bounded continuation shutdown regressions also pass.

The first selection had 97 passes and one fixture failure. The fault test cleared
its error collector before an already-admitted failed query had finished. It now
checks all collected causes after recovery settles. The next selection passed
101 cases; after the parent review repairs and bounded expiry/shutdown coverage,
all 103 pass. No production hold, retry, or timeout was weakened.

The original index applied and replayed successfully; after normal parent
integration it is regenerated as `0389_brave_hulk.sql`. Fresh apply also passes. With 40,000 synthetic decisions
and one open row, the next-deadline query uses the partial index, reads two shared
buffers, and executes in 0.022 ms locally. The probe transaction rolls back. This
is query evidence, not a production latency or savings claim. Workspace
typecheck and build pass on the combined branch. Full PR CI and fresh review
remain required before readiness.

A follow-up paging regression uses 101 overdue rows sharing a PostgreSQL
microsecond timestamp, with the first 100 writes failing. The original Date-based
cursor rounded the timestamp to milliseconds and repeatedly selected that failed
page, starving the last valid row. The cursor now carries PostgreSQL timestamp
text into its tuple comparison; business deadline calculations still use Date.
The regression failed before the fix and verifies progress past the failed page,
then recovery of all failed rows after the fault is removed.
The repaired expiry suite passes all 15 cases, and server typechecking passes.


## Current review repairs and verification

Three review findings failed real PostgreSQL regressions before repair: the
standalone worker ignored the configured batch limit, a successful overdue
backlog waited thirty seconds between batches, and a failed audit write left the
row expired without durable activity. The worker now honors its existing batch
configuration and continues successful overdue work after one second. The
shared deadline adapter accepts an optional `continuationMs`; omitted values
preserve every existing consumer's retry interval. Errors still retain the
existing thirty-second retry. Expiry and durable activity commit atomically,
then publish activity and deliver the origin continuation. Provider calls stay
outside that transaction.

All 129 selected cases pass: 18 expiry, 53 decision/continuation, 15 archive, 42
startup and one scoped-deadline case. The archive selection exercises an existing
shared-deadline consumer with the new option absent. Server typecheck/build and
generated snapshot/schema drift pass. Parent journal entries remain unchanged
and five generated snapshots remain. No snapshot was hand-edited.

The first complete selection passed 113 cases and failed the future-startup
assertion because it inspected the scheduler before an additional committed
notification reconciliation finished. Coordinator `ready` awaits the first
admitted pass, while a notification arriving during that pass can schedule
another immediate pass. The assertion now waits for reconciliation to expose
the exact saved future deadline, then still proves the decision does not expire
early. The three production regressions and this fixture failure remain
recorded; no error retry or business deadline was relaxed to pass the tests.
Fresh current-head CI and reviews remain merge gates.


After normal integration of continuation recovery's final coalescing and
deterministic contention tests and pinned master `8161f2a813`, all 130 selected
cases pass: 76 expiry/archive/startup/deadline cases plus all 54 decision cases.
Server types/build pass. Existing notification coalescing remains thirty
seconds for continuation recovery; expiry's successful backlog continuation is
one second, and failure retry remains thirty seconds. Migration replay reports
no pending migrations and the parent journal remains an exact prefix. Extra
upstream embedded-only tests attempted during parent integration could not
initialize locally; fresh CI must cover that environment, as recorded in the
archive parent PR.


Normal integration with master-target continuation parent `18f682863c` preserves
expiry, deadline and producer implementations exactly. All 61 expiry/startup/
scoped-deadline cases and server types/build pass with the rebuilt Runner vendor.
The previous full 130-case selection remains evidence at its stated revision.
No migration SQL changed, and five generated snapshots remain. Fresh head CI
and reviews are required after this parent integration.


## Creation notification review repair

Single and bundle creation previously notified continuation recovery even though
the inserted decision was open. Two real producer regressions failed before
repair because continuation received intent and settlement. Creation now uses the
existing central notification file's expiry-only `notifyDecisionCreated` helper.
Update and terminal transitions keep `notifyDecisionChange`, including the normal
continuation signal. No optional flags, per-route bookkeeping or new table is
needed. Both regressions verify the exact future expiry, no early wake, and a
subsequent cancellation that still signals and delivers continuation normally.

All 117 current expiry/decision/startup/deadline cases pass, including 20 expiry
cases. Server types/build pass. The preceding f7 candidate's identical-tree
merge proof remains history; this subsequent creation-signal repair changes
runtime behavior and has its own acceptance above. Fresh current-head CI and
both reviews are required.
