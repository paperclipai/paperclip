# Secret-proposal expiry and idle behavior

Secret proposals already store `status`, `expiresAt`, and encrypted pending
values. This worker uses those records; it adds no queue table or migration.

## Ownership and activation

`secret-proposals.ts` still owns quotas, authority checks, approval, expiry,
ciphertext scrubbing, dependent binding rejection, audit records, and interaction
reflection. `nextExpiryAt()` returns the earliest pending proposal expiry.
Terminal history does not create a deadline. Approval still rejects an expired
proposal synchronously, even when maintenance is paused.

The supported producers register `secretProposalExpiry` intent before their
writes in the owning transaction:

- `createWithinQuota`: both secret and binding creation, after quota admission.
- `markApproved`: ordinary approval and prerequisite approval during a cascade.
- `transition`: rejection, withdrawal, expiry, and dependent binding rejection.
- Interaction resolution: rejection, withdrawal/cancellation, expiry, and failed
  acceptance execution that resolves a linked pending binding.

The remaining proposal write only attaches an interaction ID and does not change
expiry eligibility. Company deletion removes obligations. Independent SQL writers
or another DB root are not supported live producers of these process-local signals;
startup reconstructs their persisted rows, but it is not a live replica contract.

The shared database signal boundary defers notification until the outer transaction
settles. Nested savepoints, rollback, and uncertain commit outcomes retain the
existing protocol. Callers do not pass recovery counters or reconnect the database.

## Scheduling and lifecycle

`registerSecretProposalExpiryWork` runs once at startup while heartbeat scheduling
is enabled. It replaces the secret-proposal sweep in the aggregate maintenance
tick. Disabled heartbeat scheduling keeps its existing behavior.

The worker reconciles committed changes and registers the earliest saved expiry.
A failed pass or an overdue batch retries after 30 seconds. Each pass retains the
existing bounded 100-row sweep. Completed batches publish their changes; further
overdue rows retain a deadline until drained. Own writes are coalesced to avoid
an immediate self-triggering scan loop. No pending proposal, unresolved write, or
failed reconciliation means no recurring query.

`deadline-work.ts` shares only generation tracking, bounded re-entry, and scheduler
registration with custom-image expiry. Each service supplies its own operation and
next deadline. Neither shared code nor startup wiring interprets secret proposals
or provider protocols. Custom-image expiry retains its existing behavior.

A request stays pending until reconciliation succeeds. Changes arriving during a
pass, first writes during drain, and failures followed by drain retain a request.
Passive drain performs no proposal SQL. Resume reconciles retained requests;
restart reconstructs deadlines. Coordinator shutdown unsubscribes and waits for
active work. Deferred physical cleanup does not extend approval authorization.

## Verification and limits

The PostgreSQL route suite exercises actual service producers, nested outer commit
and rollback, quiet empty and terminal states, quiet future deadlines, automatic
ciphertext scrubbing and dependent-card resolution, startup reconstruction,
withdrawal, interaction rejection/failed execution, failure retry, and drain/resume.
It also verifies that expired approval fails while cleanup is paused. The existing
custom-image lifecycle suite checks the other consumer of the shared helper.

The worker tests use a controlled clock and a real PostgreSQL database. Existing
route tests cover quotas, isolation, authorization, concurrency, and lifecycle
semantics. The test-only database URL must refer to a disposable migrated database:
the suite deletes its fixture tables. Ordinary CI uses its isolated embedded DB.

This is worker quiet, not proof of host or database suspension. No Cloud alarm or
sleep-eligibility exemption is added. Existing sleep-safety checks remain in force;
a local expiry timer cannot wake a stopped host. Tool review expiry and gateway
session cleanup are separate migrations.
