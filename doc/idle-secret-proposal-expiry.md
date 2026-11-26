# Secret-proposal expiry and idle behavior

Secret proposals already store `status`, `expiresAt`, and encrypted pending
values. This worker uses those records; it adds no queue table or migration.

## Ownership and activation

`secret-proposals.ts` still owns quotas, authority checks, approval, expiry,
ciphertext scrubbing, dependent binding rejection, audit records, and interaction
reflection. `expiryDeadlines(companyId?)` returns one saved deadline per pending
company. Normal write notifications reload only the affected company. Startup
reconstruction loads all companies once. The manual `nextExpiryAt()` query remains
available to existing callers.
Terminal history does not create a deadline. Approval still rejects an expired
proposal synchronously, even when maintenance is paused.

The supported producers register `secretProposalExpiry` intent before their
writes in the owning transaction:

- `createWithinQuota`: both secret and binding creation, after quota admission.
- `markApproved`: ordinary approval and prerequisite approval during a cascade.
- `transition`: rejection, withdrawal, expiry, and dependent binding rejection.
- Interaction resolution: rejection, withdrawal/cancellation, expiry, and failed
  acceptance execution that resolves a linked pending binding.
- Company deletion: a company hint removes its cached deadline after deletion commits.

Each producer includes its company ID. The remaining proposal write only attaches
an interaction ID and does not change expiry eligibility. Independent SQL writers
or another DB root are not supported live producers of these process-local signals;
startup reconstructs their persisted rows, but it is not a live replica contract.

The shared database signal boundary defers notification until the outer transaction
settles. Nested savepoints, rollback, and uncertain commit outcomes retain the
existing protocol. Callers do not pass recovery counters or reconnect the database.

## Scheduling and lifecycle

`registerSecretProposalExpiryWork` runs once at startup while heartbeat scheduling
is enabled. It replaces the secret-proposal sweep in the aggregate maintenance
tick. Disabled heartbeat scheduling keeps its existing behavior.

The worker reloads the affected company's saved minimum expiry after a committed
change. It does not sweep future work. At a due deadline it sweeps at most 100
expired proposals for that company, then reads that company's next deadline.
Companies rotate fairly between bounded passes. Retained history creates no work.
No pending proposal, unresolved write, or failed reconciliation means no recurring
query. Unscoped legacy hints still reconstruct all companies.

`scoped-deadline-work.ts` owns scope invalidation, cached deadlines, fair dispatch,
and failure backoff. It owns no SQL or proposal policy. Failed loads and failed
company sweeps back off independently from 30 seconds to five minutes. A new
write reloads that company without erasing its failed sweep's backoff. Other
companies keep their own deadlines, including already-due work. The coordinator's
optional `nextRunAtOnError` contract permits immediate eligible work only after
the worker has recorded per-item backoffs. Failed transaction reconciliation and
failed pending-state inspection retain the coordinator's normal retry.

Secret expiry opts out of the shared helper's default one-second pass spacing so
newly learned short deadlines are not clamped. Other scoped consumers retain that
default. Custom-image expiry continues to use `deadline-work.ts` unchanged. No
shared scheduler or startup wiring interprets secret-proposal policy.

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
coordinator suite verifies fallback retry and uncertainty boundaries. New cases
record actual SQL to prove normal writes and due expiry stay company-scoped; they
also cover five-second deadlines, earlier replacement deadlines, company deletion,
and another company making progress while one sweep fails. A deterministic
shared-worker test covers a 250ms replacement deadline.

The worker tests use a controlled clock and a real PostgreSQL database. Existing
route tests cover quotas, isolation, authorization, concurrency, and lifecycle
semantics. The test-only database URL must refer to a disposable migrated database:
the suite deletes its fixture tables. Ordinary CI uses its isolated embedded DB.

This is worker quiet, not proof of host or database suspension. No Cloud alarm or
sleep-eligibility exemption is added. Existing sleep-safety checks remain in force;
a local expiry timer cannot wake a stopped host. Tool review expiry and gateway
session cleanup are separate migrations.
