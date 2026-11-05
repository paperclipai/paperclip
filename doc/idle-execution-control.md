# Execution-control workers and idle instances

Execution-control maintenance uses the shared delivery coordinator instead of an
unconditional 15-second interval. This changes when recovery is inspected; it
does not change the authority, evidence, locking, idempotency, or cleanup rules
inside the six owning services. No table or migration is added.

## Duties and durable state

| Duty | Trigger and durable source | Remaining scheduled work | Quiet condition |
| --- | --- | --- | --- |
| Abandoned finalization | Committed control-deadline writes on `heartbeat_runs` and `native_run_finalizations` | Earliest non-null control deadline; a due row still present after recovery retries after 15 seconds | No control deadlines |
| Safe native replacement | Committed run transitions and reconciliation decisions; existing failed run/coordinator rows | Retry while the existing replacement predicate selects a candidate, including one awaiting provider termination or sandbox release | No replacement candidate, or a recorded successor/denial |
| Reconciled continuation | Committed recovery-action marking/resolution; `evidence.continuationDelivery` | Retry pending delivery after 15 seconds | No resolved action awaiting continuation delivery |
| Execution status | Committed run status writes; `execution_status_delivery_id` | Retry while a delivery marker remains | All markers acknowledged |
| Automatic disposition | Committed run/recovery-action changes; existing eligible recovery-action queries | Retry while a selected action still needs disposition or an obsolete conversation hold remains | No eligible action/hold; resolved history alone is quiet |
| Local login cleanup | Committed local login creation; existing `adapter_auth_sessions.expires_at` | Earliest local login expiry; retry overdue failed cleanup | No local login expiry remains |

Each worker runs once on startup to restore durable obligations. Passes are
coalesced at the former 15-second resolution: a tenant's repeated writes cannot
force continuous global scans. This is a minimum spacing between requested
passes, not a recurring poll; an empty worker never arms that spacing by itself.
A newly discovered deadline within the spacing window runs at its end, retaining
the former maximum 15-second scheduling resolution. Future deadlines outside
that window retain their exact due time. Workers remain
independent: a slow replacement proof cannot stall status delivery. Batches and
failed obligations retain the existing 15-second retry budget; empty workers do
not repeatedly inspect the database. Login authorization still checks expiry on
use even before physical cleanup completes.

## Producer contract

`notifyExecutionRunWork(transaction)` signals the run transition's status,
finalization, replacement, and disposition consumers before the write. Existing
transaction owners call it directly. Standalone deadline and recovery-action
writes use `writeExecutionControl` to give the write a transaction boundary.
Nested transactions retain the existing outer-commit notification semantics.

Producer coverage includes heartbeat status transitions, legacy terminalization,
native finalization and restart/failure settlement, replacement successors and
denials, recovery-action upserts/resolution, operator reconciliation, control
deadline creation/cancellation, and local login creation. Workers acknowledge
existing records rather than creating a second queue. The replacement and
disposition pending checks reuse the executing services' eligibility queries.

This is the existing single live server / shared `createDb` owner signal model.
Independent SQL writers or separate replicas must integrate notifications; these
workers do not continuously discover unannounced external writes. Startup still
recovers committed rows after process loss. Uncertain commit handling remains in
`packages/db/src/work-signals.ts`.

## Lifecycle and verification

A worker consumes a requested generation only after its sweep and deadline
inspection succeed. Writes during a sweep, startup during drain, and a failure
before drain remain pending for resume. Passive waiting during drain performs no
worker SQL. Shutdown uses the coordinator to unsubscribe and await in-flight work.

`server/src/__tests__/execution-control-work.test.ts` covers empty and retained
history with the real sweep implementations, a real producer inside an outer
commit/rollback, saved deadlines, deadline replacement/cancellation, durable
status retries, recovery continuations, independent duties, and drain/resume.
Database tests use embedded PostgreSQL by default. An isolated external test
instance can be supplied through `PAPERCLIP_EXECUTION_SLEEP_TEST_DATABASE_URL`;
the database must have a dedicated name ending in `_test` and is cleared by the
suite. Never use a tenant database.

Worker quiet is not host sleep authorization. The existing idle-safety blockers
remain, and Cloud's external wake contract does not gain coverage for execution
or login deadlines through this change. Provider suspension and wake must be
qualified separately before relaxing those blockers.
