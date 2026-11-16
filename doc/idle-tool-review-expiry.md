# Pending tool-review expiry and idle behavior

Pending tool action requests already save their review deadline in `expiresAt`.
This worker replaces the recurring pending-expiry scan with committed changes,
startup reconstruction, and that saved deadline. It does not add a queue table
or change the one-hour review policy.

## Ownership and producer inventory

The tool gateway owns request signing and authorization. `toolReviewExpiryService`
owns pending-expiry selection and settlement. `registerToolReviewExpiryWork`
supplies company-scoped operations to the existing shared scoped deadline worker. Startup wires
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
- Company deletion signals its company before removing saved review obligations.
- The expiry worker signals before its own settlement. A compare-and-set against
  pending status and the observed update time protects concurrent resolution.

Every notification requires the company ID. Normal commits reload only that
company's saved minimum expiry; due cleanup selects only that company. Startup
reconstructs all saved company deadlines once. A company with only unsigned
null-expiry requests has no deadline.

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

The next deadline comes from pending rows only. Startup uses the existing
partial expiry index to reconstruct company deadlines. A company notification
uses an ordered, single-row lookup backed by the partial `(company_id,
expires_at)` index, rather than aggregating that company's pending backlog.
Null-expiry unsigned requests and retained resolved history do not keep this
worker active. The concurrent index migration uses the existing top-level
executor and is safe to apply again after interruption.

The shared coordinator coalesces changes and preserves a write arriving during
reconciliation. Each due pass expires at most 100 rows for one company; companies
rotate between passes until the backlog drains. Failed scopes retry independently
with exponential backoff from 30 seconds to five minutes. Other companies retain
their own deadlines. New writes do not erase a failed sweep's backoff.
Once reconciliation completes with no deadline, it has no recurring SQL. Drain
retains first writes without passive database scans; resume processes overdue
reviews. Startup reconstructs persisted deadlines. Shutdown stops subscription
and timer ownership and joins active work.

Approval still rejects an expired request synchronously before physical cleanup.
With heartbeat scheduling disabled, startup-only expiry remains as before.

## Verification scope

Real PostgreSQL tests record SQL to prove signing, human decisions, and due expiry
remain company-scoped. They also verify five-second and earlier replacement
deadlines, company deletion, and bounded multi-pass draining. Existing cases cover
normal gateway signing and human decisions,
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

## Scoped lookup review repair (2026-10-27)

The original scoped aggregate examined 12,004 rows to return one deadline in a
real PostgreSQL regression. The repaired lookup returns the earliest non-null
pending expiry for the requested company with `ORDER BY expires_at LIMIT 1`.
The grouped startup inventory remains unchanged. Existing company signals,
authority checks, expiry settlement, paging, backoff, and sleep gates remain
owned by their existing services.

The additive company-expiry index is migration `0383_tool_review_company_expiry`.
It builds the index concurrently and idempotently through the existing top-level
migration executor. Initially reserving number 0402 passed per-branch checks but
caused CI to reject descendants whose migrations preceded their target branch.
A local 0380 correction fixed that ordering, but master had meanwhile added its
own 0378 and 0379 migrations. The integrated stack preserves master's history,
renumbers its unmerged migrations after 0379 in PR dependency order, and preserves
every migration's SQL bytes. Exact filename references and journal tags/indices
follow the new names. Stack journal timestamps remain ordered after master's
latest entry. Each generated snapshot includes both master and that PR's schema.

Each PR must pass the exact target-branch migration-order gate, in addition to
the existing numbering, safety, five-snapshot retention, and schema-drift checks.
Local branch checks alone did not establish the stack's append-only ordering.
Fresh application, upgrades from the previous numbered task databases, and
replay also require verification. These unmerged stack migrations have not
changed the SQL of migrations already on master.

Two failures shaped the repair. The first migration attempt omitted its explicit
top-level registration and PostgreSQL rejected the concurrent build inside a
transaction; adding the registration fixed application and replay. An initial
three-column index also lost to the global expiry index in the planner, which
filtered 12,001 foreign-company rows before returning a result. The final index
omits the unused request ID. With 12,000 additional pending rows in each of two
companies, including earlier foreign deadlines, all three measured reloads
examine one row. The assertion counts filtered rows as well as returned rows.
This is evidence for the recorded fixture and query plan, not a production
latency guarantee or a claim that PostgreSQL can never choose another plan.

The complete gateway service, gateway acceptance, credential expiry, startup,
custom-image deadline, and schema snapshot suites pass: 223 tests across six
files. The run also exposed a credential test-clock overshoot; its correction
belongs to the earlier gateway PR and waits for real SQL before advancing to
an actually armed follow-up. Commit/rollback and exact expiry assertions remain.
Server typechecking passes. Combined-stack migration upgrades, full build, and
fresh remote checks remain required. Full local test:run is still unverified
because of embedded PostgreSQL startup/capacity limits; real gateway suites used
isolated, migrated test databases in the task-owned PostgreSQL instance.


A later review found an unbound `query` name in the SQL-capture assertion.
The due-row predicate short-circuited before that expression in the passing
fixture, and server typechecking excludes test sources. The assertion now
independently requires both the due expiry scan and the non-null deadline lookup
through each captured `read.query`. The earlier passing run did not detect this
name error; acceptance must include the service suite with both assertions.
