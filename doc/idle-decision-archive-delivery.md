# Decision-archive notification delivery

Auto-archive already writes `decision_archive_notification_outbox` in the same
transaction that archives its retention row. The old retention sweep called
notification delivery on every maintenance tick, including an empty outbox.
Delivery is now its own coordinator worker. Retention scanning remains a separate
migration; this PR does not change what is archived or when.

## Ownership and producer audit

`decision-retention.ts` owns eligibility, current-version checks, source authority,
origin resolution, and archive writes. Its sole outbox producer is `autoArchive`.
It now awaits the delivery notification immediately before inserting the outbox
row in the existing transaction. Caller-owned transactions and savepoints retain
outer commit/rollback ownership through the shared database signal mechanism.
Manual archive/revive and reviewed-manifest archive do not create these
notifications today; this change does not add notifications to those actions.

`decision-archive-delivery.ts` owns claim recovery, selection, grouping, delivery,
and settlement. `decisionRetentionService.deliverNotifications` remains a
compatible delegate. Its notification callback and batch type retain their
existing contract. The scheduler only sees the delivery operation and next
work deadline. Claim and acknowledgement writes belong to this worker; they do
not broadcast self-generated wakes. No table is added. A concurrent partial index supports the pending delivery
order on the existing outbox.

The server registers the worker in enabled-heartbeat startup housekeeping and
removes notification delivery from `runRetentionSweep`. Registration scans saved
work before the retention pass can enqueue more. The disabled-heartbeat branch
continues not to dispatch agent notifications. A service without a callback
leaves outbox rows intact and does not attempt notification delivery.

## Work and deadlines

Pending outbox rows are due for delivery. Each pass claims up to 500 rows and
groups them by company and origin agent, preserving company scope and the
existing notification payload. Failed or remaining pending rows retain a
30-second retry. Never-attempted rows sort first, then the oldest attempts, so
one failing batch cannot repeatedly hide later rows.

A delivering row retains its existing five-minute claim deadline. Startup
reconstructs that deadline from `lastAttemptAt`; a legacy missing timestamp is
immediately recoverable. A worker waiting only for a future claim deadline does
not repeatedly query until that deadline. Settlement and failure reset require
the same claim timestamp, so a delayed old result cannot settle or release a
replacement claim. Delivered counts include only rows actually settled.

An empty outbox or retained delivered history has no worker deadline and no
recurring SQL. The coordinator coalesces writes and prevents overlapping passes.
The shared deadline worker preserves first enqueue during drain, changes during
delivery, and failed retries across drain/resume. Coordinator shutdown joins
in-flight work. These guarantees do not replace the durable rows.

## Recovery and limits

A failed enqueue rolls back both the archive mutation and its outbox insertion.
An uncertain transaction retains the shared intent until its outcome is known.
A notification failure returns the same rows to pending. A process stopping
while delivering leaves the claim for deadline recovery on restart.

Delivery remains at least once. A wake accepted before a lost acknowledgement
can be retried. This change does not promise exactly-once agent wakeups or add
new deduplication storage. The five-minute stale threshold is unchanged.

Supported producers share the process-local database signal owner. Independent
SQL or another active server needs a separate wake contract. The existing Cloud
sleep proof still blocks this outbox conservatively; no external-wake coverage
or sleep guard is relaxed. Worker quiet does not prove actual database or host
suspension. Retention scanning and decision continuations remain separate duties.

## Verification

The original migration selection passed 54 tests: 15 real-PostgreSQL retention/delivery cases
and 39 startup cases. Twelve new cases cover configured idle, retained delivered
history, real enqueue, restart, exact stale-claim timing, legacy missing timestamps,
first enqueue during drain, failed-delivery retry through drain, outer commit and
rollback, enqueue failure rollback, writes during delivery, more than 500 rows,
and stale-result fencing. Quiet assertions observe no reads or writes across an
hour of controlled time. Workspace typecheck and build pass.

The first 52-case selection passed. Adding fault/concurrency tests then exposed
two fixture errors: duplicate globally unique issue identifiers across two seeded
companies, and asserting quiet before rollback reconciliation had run. Seeded
identifiers now use their company prefix; quiet checks advance the retained retry
and await authoritative settlement. All 54 cases passed on rerun. No production
hold, recovery deadline, or timeout was weakened. Full repository CI and fresh
review are required before this PR is ready.


## Review repairs: startup, claim results and backlog selection

Startup regressions now exercise `startServer` itself. Enabled startup must
register `decisionArchiveDelivery` and invoke the delivery owner; calling the
captured heartbeat interval still performs retention reads without another
notification delivery. Calling the registered worker invokes delivery again.
The disabled-heartbeat case explicitly preserves the existing no-notification
contract. An initial expanded test incorrectly expected that disabled mode to
register the worker and failed; inspection confirmed the documented disabled
contract, so the test now asserts it rather than enabling new background work.

The real stale-claim regression first returned `notifiedAgents: 1` after the
replacement claim prevented any settlement. The counter now increments only
for a group that actually settles rows, while the existing timestamp fence and
at-least-once delivery contract remain intact. Failure reset uses one timestamp
for `lastAttemptAt` and `updatedAt`.

Generated migration `0387_boring_professor_monster.sql` creates a concurrent
partial index on `(last_attempt_at NULLS FIRST, created_at, id)` for pending rows.
The existing top-level migration executor handles concurrent creation and
invalid-index recovery. No history migration or existing journal entry changes;
the generated snapshots retain the five newest versions.

A real migration and query-plan check used a separate database with 50,000
outbox rows, including 30,000 pending. The existing claim-selection query returned
500 rows in both cases. Without the new index PostgreSQL sorted the pending
backlog with a top-N heapsort and touched 944 shared buffers; with the index it
used an index-only scan without sorting and touched 505 buffers. The baseline
index removal was rolled back inside that dedicated database, and the migrated
index was confirmed valid afterwards. These local measurements establish the
access path, not production latency or cost savings.

All 58 cases across real PostgreSQL delivery/retention, startup and the shared
deadline worker pass. Generated snapshot drift, migration numbering/safety,
server types and build pass. The earlier stale-counter failure and invalid
scheduler-disabled expectation are retained above. The existing 500-row batch
limit and thirty-second retry for remaining pending work are unchanged. Fresh
current-head CI, Greptile and Ponytail remain required before merge.
