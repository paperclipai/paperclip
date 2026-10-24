# Pending tool-review expiry and idle behavior

Pending tool action requests already save their review deadline in `expiresAt`.
This worker replaces the recurring pending-expiry scan with committed changes,
startup reconstruction, and that saved deadline. It does not add a queue table
or change the one-hour review policy.

## Ownership and producer inventory

The tool gateway owns request signing and authorization. `toolReviewExpiryService`
owns pending-expiry selection and settlement. `registerToolReviewExpiryWork`
supplies those operations to the existing shared deadline worker. Startup wires
that contract without interpreting tool or provider behavior.

The supported writers are:

- `tool-access-policy.ts` inserts an unsigned pending request without an expiry.
  It creates no expiry obligation yet. The existing signing grace remains intact.
- The normal agent gateway signing path and the board test-call path assign the
  saved deadline. Each signals in its SQL transaction before that update.
- Gateway signing failures, competing-call invalidation, invalid signatures,
  and legacy pending-to-approved/expired transitions signal before removing a
  pending obligation.
- `commitToolActionReview` signals inside its existing human-resolution
  transaction. The issue/interaction locks, human authority checks, and delivery
  enqueue remain owned there.
- Administrative interaction resolution signals in the caller-owned transaction
  before resolving linked requests. Review-queue invalidation signals before
  invalidating unreadable or unsigned requests.
- The expiry worker signals before its own settlement. A compare-and-set against
  pending status and the observed update time protects concurrent resolution.

Only the SQL mutation is wrapped. Signing, provider requests, telemetry, and
interaction publication are not moved inside an enclosing recovery transaction.
The database signal layer handles nested savepoints, outer commit/rollback, and
uncertain transaction outcomes. No recovery object is passed through callers.
Independent SQL writers and other database owners/replicas still require a live
notification contract. Startup reconstructs saved rows but is not ongoing
cross-process discovery.

## State and recovery

Expiry updates the authoritative request and invocation in one transaction. If
invocation settlement fails, the request remains pending and the worker retries.
After commit, the gateway reflects the result in the linked interaction. The
existing terminal projection-repair duty remains in `sweepActionReviews` and
repairs a crash or failure between authoritative settlement and projection.
That duty is a separate migration; this worker must not claim it has completed.

The public/manual `sweepActionReviews()` still includes expiry by default. Server
startup and the recurring legacy review sweep pass `includeExpiry: false` when
expiry has its own startup pass or worker. Approved-action recovery, interrupted
execution quarantine, and terminal projection repair retain their behavior.
An unknown external outcome is never replayed by this expiry worker.

The next deadline comes from pending rows only, using a partial expiry index.
Null-expiry unsigned requests and retained resolved history do not keep this
worker active. The concurrent index migration uses the existing top-level
executor and is safe to apply again after interruption.

The shared coordinator coalesces changes and preserves a write arriving during
reconciliation. It retries failed or unfinished reconciliation after 30 seconds.
Once reconciliation completes with no deadline, it has no recurring SQL. Drain
retains first writes without passive database scans; resume processes overdue
reviews. Startup reconstructs persisted deadlines. Shutdown stops subscription
and timer ownership and joins active work.

Approval still rejects an expired request synchronously before physical cleanup.
With heartbeat scheduling disabled, startup-only expiry remains as before.

## Verification scope

Real PostgreSQL tests exercise normal gateway signing and human decisions,
configured idle and terminal history, outer commit/rollback, startup/restart,
drain/resume, concurrent producer/read, unsigned rows, multi-page expiry, and
injected invocation-write failure with atomic rollback and retry. Existing
service tests cover approval/execution, interrupted outcomes, and projection
repair through the compatible manual entry point. Startup tests cover wiring.
The external test database override requires a disposable database ending in
`_test`; the suite deletes fixtures and stops the worker before database cleanup.

This is one worker migration, not proof that the instance can sleep. Other tool
review duties remain periodic. Existing Cloud sleep-safety gates and external
alarm coverage are unchanged. An in-process deadline cannot wake a stopped host.
