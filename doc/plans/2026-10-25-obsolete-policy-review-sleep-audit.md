# Obsolete native policy-review cleanup

Date: 2026-10-25; current integration: 2026-10-29. Parent: cancelled workspace
preservation #17677 at `b34f0589847f33754ecde9413fd36bf007353d2c`.
The original draft parent was `33567f91551d60053722c013f0d9b402c1db29e6`.

## Owner and scope

The native finalization reconciler combines independent duties. Its initial
calls recover historical unsafe exports, dismiss obsolete policy reviews, and
retire automatic completion reviews. Its main loop also dispatches status
effects, repairs committed response presentation, reassesses changed evidence,
and resumes workspace/result finalization. Each duty needs its own migration;
removing the combined scan would lose work.

This slice owns obsolete version-change policy reviews only. The existing
`obsolete-policy-reviews.ts` service identifies their full historical signature:
pending system confirmation, exact prompt, applied native review decision,
exact two-effect payload, and matching company/issue/run/effect/assessment.
Real completion reviews, authored requests and answered cards are excluded.
The current status arbiter does not generate this old prompt. The typed decision
committer still supports the old effect shape, so a startup-only scan is not
used as the complete writer contract.

## Producers and durable truth

The existing interaction, status decision, effect, and assessment rows are truth.
The only production inserter of status decisions and decision effects is
`commitNativeStatusDecision`. Its existing transaction registers an issue-scoped
notification before creating the decision/effects. The signal settles at outer
commit, including a caller-owned transaction. It adds no new transaction around
provider work and no table. A normal current decision can cause one scoped
lookup without leaving a recurring deadline.

Other interaction writers cannot independently create the matching applied
native decision/effect lineage. Existing decision mutation paths update lineage
or delivery state, not the historical signature. Current-policy producers do
not create new obsolete reviews, but their common commit boundary remains covered.
Startup reconstructs old records. Independent SQL writers and concurrent older
controllers are not covered by process-local signals; they require an explicit
integration or restart reconstruction.

## Scheduling and recovery

The service registers with the existing scoped deadline helper. Startup and
committed issue hints reconstruct exact candidates in 100-row keyset pages.
The worker stores interaction/company/issue IDs and due times, not the decision
payload. Batches of twenty use the shared fairness mechanism. Each check rereads
the exact candidate and delegates to the existing transaction owner.

The owner retains coordinator/issue/interaction locking, current status-version
and decision-pointer guards, other-review checks, chat terminal publication,
and activity persistence. The conditional withdrawal additionally matches the
selected payload, kind, source run, idempotency key, and system author fields.
A card changed after discovery is not withdrawn from a stale snapshot.

After an attempt the worker rereads the exact pending predicate. Pending cards
retain a 30-second retry; successful, answered, changed, or deleted cards disarm.
An owner failure must not starve another candidate. Discovery failures use the
shared backoff and retain the dirty scope. No expiry or retry budget is invented
for historical records. No unresolved card is silently discarded for quiet.

This preserves manual/scoped reconciliation and startup repair. Only periodic
orphan reaping passes the new skip flag, so that path stops repeating this
cleanup. The worker is registered when heartbeat maintenance is enabled and
shares the existing admission/drain/standby gates. Shutdown joins admitted
cleanup and removes the registration. Paused dispatch retains dirty requests.

## Cost and boundaries

The change is a worker migration, not proof of provider suspension. The combined
reaper and unrelated finalization duties still run until migrated separately.
Cloud alarms and sleep eligibility remain unchanged.

Startup cost scales with historical pending candidates and their joins. Scoping
ordinary commit hints to company/issue uses the existing interaction indexes.
There is no new schema or unconditional hasPending query. Query-plan evidence
and final test results are recorded below when available.

## Verification record

Before production changes, all 44 existing status-authority corpus tests passed
on a fresh disposable PostgreSQL database. The host's embedded harness remains
unavailable; the corpus now accepts the repository's validated external-test DB
URL convention and closes its pool. No production connection behavior changed.

The initial server typecheck and the typecheck including new worker tests both
passed. Full owner/startup, affected consumers, final workspace checks and exact
PR head CI/review remain required. No local or remote completion is claimed here.

The first combined run had 67 passing tests and 49 failures. The producer helper
serialized the structurally assignable commit input rather than projecting its
company/issue fields. That included the database object and threw a circular
JSON error on real commits. The helper now serializes only its two domain IDs.
The failed run is retained at `/tmp/sleep44-owners-v1.log`. A fresh full selection
is required after this production repair.

After the payload repair, all 116 tests in the owner/startup/timing selection pass
without skips (56 corpus tests, 58 startup tests and two timing tests). The corpus
includes the existing 53 native/legacy fixtures inside its matrix test.

A rolled-back query fixture added 10,000 completed interaction rows on the same
issue and restored one matching pending historical review. The company/issue
lookup used existing decision, interaction-idempotency, effect-ordinal and
assessment indexes. It returned one candidate in 0.058 ms locally. This supports
the scoped-query access path, not a production latency claim. Startup remains
a global reconstruction whose cost scales with history; it does not recur when
settled. SQL and plan are in `/tmp/sleep44-query-plan.sql` and `.log`.

Final affected consumer acceptance passed all 235 cases across heartbeat recovery,
native finalizer telemetry, external-chat response waits and governed chat
milestones. Combined with the 116 owner/startup cases, 351 tests passed without
skips. Workspace typecheck and build also passed. Remote CI and review remain
required for the published head. No workflow, lockfile or schema change is made.


## Earlier parent and acceptance (2026-10-29)

Normal integration with the verified cancelled-preservation parent yields
`18809268f6292462bb8dc7aea4d081eca4851328`. Every substantive owned edit is preserved,
and unrelated upstream blobs are unchanged. The entire database source tree
is identical to the parent; this slice adds no migration or table and preserves
its 0407 history and five newest snapshots. No new code comments are added.

All **443 cases across seven complete files pass with no skips**, in 47.08
seconds. The corpus includes its existing native/legacy fixture matrix; fixtures
inside one matrix case are not added again to the test count. Exact counts:

| Complete file | Passing cases |
| --- | ---: |
| src/services/native-runtime/external-chat-wait.integration.test.ts | 234 |
| src/__tests__/native-status-arbiter-corpus.test.ts | 56 |
| src/services/heartbeat/recovery.test.ts | 45 |
| src/__tests__/chat-run-milestone-governed-work.test.ts | 16 |
| src/services/native-runtime/native-run-finalizer-telemetry.test.ts | 29 |
| src/__tests__/server-startup-feedback-export.test.ts | 61 |
| src/services/native-runtime/native-finalization-reconciler-timing.test.ts | 2 |

Five distinct fresh PostgreSQL 17 databases were created and migrated before
the corpus, recovery, finalizer, external-chat, and governed-milestone fixtures.
These external URLs use the supported test paths and avoid a new embedded
cluster while this host is near its semaphore limit; no selected suite is skipped.
Database build, server typecheck/build, module boundaries, target migration
order, and all five fresh parent-0407 migrations pass. The earlier circular
notification-payload failure remains recorded above; no passing run erases it.

This verifies the combined cleanup owner, actual producer/transaction cases,
status authority and affected consumers. It does not establish deployed sleep
or Cloud alarms. Actual landed parent ancestry and fresh published-head review
and CI remain required.


## Current migration409 parent and complete acceptance

Normal integration `4dff94ae9b261379b45c5b5e96a2bc7e8bbab772` preserves the
complete original runtime patch and every unrelated upstream blob. The entire
database source tree equals the current parent, including 0409 history and
the five newest snapshots. No migration or table is added.

All **443 cases across seven complete files pass without skips**, in 47.38
seconds. The selection and per-file counts are unchanged from the table above.
Five separate fresh PostgreSQL 17 databases migrate through 0409 before setup.
Database build, server types/build, module boundaries and exact-head migration
order pass. Existing supported external-database fixture paths are used; no
source fixture adaptation or skipped suite is required. Prior failures remain
recorded. These tests verify worker quiet and supported reactivation, not
deployed host/database suspension or external alarms.

Adopting published parent `b34f0589847f33754ecde9413fd36bf007353d2c` through normal merge
`e57aa9ca1bbbac82ebb13e032487344f0ea4da1d` changes ancestry and parent documentation only.
Complete server, package, test and UI trees remain identical to the accepted
443-case source. The actual cancelled-preservation parent still must land.
Publication is held until its squash ancestry is reconciled. Fresh published-head
CI and reviews remain required.


## Actual cancelled-preservation squash ancestry

Parent #17677 landed as `51c3f8924cb0bd5fe7cbda15ad9b8f06a6a11055`. Its
entire tree equals reviewed parent `b34f0589847f33754ecde9413fd36bf007353d2c`,
which is already an ancestor of this child. Normal merge
`3c36e163ae918833b15457a4da5f969b49fb2ded` resolves inspected duplicate
squash-ancestry conflicts. Its whole resulting tree equals the accepted child.
Complete server, package, UI and test trees remain identical to the 443-case
source. The database source remains exactly parent-identical, including all
0409 history and retained snapshots. Fresh published-head CI and reviews remain
required; no previous review score is used as current evidence.


## External corpus repeatability review correction

Greptile reported that rerunning the supported external corpus fixture fails
because the prior companies retain the fixed PSC and OUT prefixes. The exact
reviewed head `45cb0d9ccc9b0c37068f56a709f16572bd7b7ddc` reproduces PostgreSQL
23505 on `companies_issue_prefix_idx` when rerun against its previously successful
fixture. Setup fails and all 56 cases are skipped; this is a failing reproduction,
not an assertion pass.

An initial cleanup attempt at `669da4422df74e90eab324100ddab345f21df020`
passes all 443 assertions but fails the suite in afterAll. Activity-log records
hold non-cascading company foreign keys. That attempt is not accepted and no
passing retry erases it. The cleanup and import were fully removed.

The final change derives each prefix from its own already-unique company UUID,
normalizes it to uppercase alphanumeric text, and keeps the PSC or OUT label.
It changes exactly two fixture values relative to the reviewed head. Existing
teardown, all assertions and timing limits, runtime code and database schema
remain unchanged. It performs no deletion and leaves retained fixture history
intact. The database prefix column accepts this form.

Source `4cc0d03ae96bd92a4fdad44168c2a8647d42466c` passes all **443 distinct
cases across seven complete files**, without skips, in 46.46 seconds. The complete
56-case corpus immediately passes a second time against the same database in
10.15 seconds. The repeat is not added again to the distinct test count. Three
preexisting companies include retained PSC/OUT prefixes and an unrelated sentinel.
All three remain byte-identical in the inspected ID/name/prefix fields after
both runs. Only each invocation's two distinct companies are appended.

Five new isolated PostgreSQL 17 fixtures migrate through 0409. Actual database
build, server typecheck/build, boundaries and exact-head migration order pass.
The complete database source stays unchanged. Fresh published-head CI and review
remain required; the old head's 5/5 score and green checks do not establish them.
