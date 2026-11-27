# Approval queue seeding without retention polling

## Obligation and stack dependency

The attention maintenance scan does two different jobs: retention and automatic
queue membership. Its call to `materializeSeededQueues` adds pending approvals to
the PR queue when the first linked issue has a pull-request work product. Queue
API readers use saved membership; they do not first build the attention feed.
Removing approvals from maintenance therefore lost automatic queue population.
A real PostgreSQL regression reproduced an empty queue with a pending linked
approval and PR work product, without an attention reader.

This slice owns automatic PR-queue membership for approvals. It depends on the
approval producer boundaries introduced in #17497 and is required with that
retention migration before treating the combined behavior as complete. Join
requests have no issue association or matching seed rule. Other attention-source
seed discovery remains in the existing feed scan and must migrate with an
explicit owner before those sources leave that scan.

## Source of truth and ownership

Existing approvals, issue approvals, issue work products, queues, and queue items
are the only durable state. No new table, outbox, external API, or provider branch
is introduced. `approvalQueueSeedingService` selects missing memberships for:

- A pending approval in an active company.
- Its first linked issue, ordered by issue ID, in the same company and eligible
  under the attention feed's execution-issue visibility predicate.
- A pull-request work product belonging to that issue and company.
- A missing PR queue or an enabled seed rule without this approval's membership.

Disabled rules, nonmatching approvals, completed approvals, and existing seeded
history are passive. A pending approval itself prevents its linked Slack/Speko
conversation from projecting as idle, so this source does not depend on every
other conversation-state producer. Hidden/harness/conversation-container issue
changes retain their explicit signals.

The queue service owns seed matching, creation, membership uniqueness, and audit
writes. The feed and worker use the same writer through a small normalized source
contract. The candidate lookup and writer share the pull-request product SQL
predicate, so the matching policy has one owner. A worker does not construct a presentation-layer AttentionItem. Queue
reads keep their existing source authorization checks. A queue-rule update and
seeding serialize on the existing queue row. Existing memberships are not pruned
when an approval resolves. This preserves current behavior; pruning is a separate
change, including the proposal in #13364.

## Producer audit

| Producer | Commit boundary and effect |
| --- | --- |
| Approval create, cancel, revision, resubmit, resolve | `writeApprovalChange` notifies retention and company-scoped queue seeding before writes in the owning transaction. Approve/reject/cancel retain their explicit tool-review notification; ordinary mutations do not wake those queues. |
| Shared approval records, budget approvals, formal tool approvals | The same approval notification covers their existing transactions. |
| Issue approval link, unlink, link-many, tool-created links | Existing approval transaction helper. Link removal can expose a different first issue. |
| Issue visibility changes and issue deletion | Existing approval notification before the update or cascading delete. Routine failure cleanup retains this signal. |
| Company activation, pause, archive, deletion and budget pause/resume | Existing company notification wakes both approval consumers. |
| Work-product create, type/issue update, import batch, delete | The owning work-product transaction notifies seeding when a pull-request row is involved. |
| PR queue creation, rule update and manual approval membership removal | The queue mutation transaction notifies seeding. An enabled rule can re-add a still-matching manually removed item, as the old scan did. |

Other direct work-product writes only create artifacts or update title, metadata,
or trust. They cannot create a pull-request match. Supported writes use these
in-process service boundaries. Independent SQL writers and multiple server
replicas are not covered by local transaction signals.

Retention-only keep/archive/revive changes do not create queue projection debt.
The old seed writer ran before retention filtering, so archived or kept approvals
still follow the same seeding rule. User-specific dismissals do not filter the
unscoped maintenance feed. No new deadline is inferred from those display states.

## Worker lifecycle

Startup reconstructs missing memberships across the instance. Each later committed
producer carries its company ID and wakes only that company's reconciliation.
Pending scopes coalesce in memory; one company's ordinary mutations cannot restart
a global scan. Scope rotation prevents one failing company from starving another. Each sweep processes at most 100 approvals, with an ID cursor and a fixed upper ID per scan cycle. The cursor advances past
failures and finishes that finite cycle before revisiting them; new arrivals cannot
extend it indefinitely. Each row is rechecked under
an approval lock before the queue writer runs. One bad row cannot permanently
hide later candidates. Atomic existing membership uniqueness prevents duplicate
rows and duplicate insertion audit events.

After a sweep, another lookup decides whether actual projection debt remains.
Unprocessed pages and newer committed signals retain a one-second continuation.
Failed scopes back off exponentially from one second to one minute. A successful
nonempty batch resets consecutive failures; an empty cursor rollover while debt
remains preserves outage backoff. New signals
do not reset a failing scope's backoff; other companies can proceed independently.
The next retry is registered with the shared scheduler, with no SQL during the
wait. A failed scope remains tracked until its owed memberships are reconciled. The generation check follows the final awaited lookup, so a commit arriving
during an empty read cannot be erased. Once reconciled, there is no deadline and
no recurring worker SQL. The shared coordinator preserves requested work during
drain. Passive pending checks inspect memory only; startup reconstructs from rows. Shutdown aborts between rows
and waits for an admitted transaction; unprocessed rows remain recoverable.
Registration follows the existing heartbeat-maintenance enablement switch.

This slice does not extend Cloud alarm coverage or loosen host sleep admission.
It proves a worker's quiet/reactivation behavior, not deployed host or database
suspension. The remaining attention maintenance interval is still present for
other source owners.

## Verification

- Before the fix, the PostgreSQL regression found no PR queue after the normal
  maintenance path excluded approvals. After the fix, the queue API finds it
  without a full attention read.
- Twenty-one real-database worker tests cover empty-to-active-to-quiet behavior,
  startup and completed history, actual approval/link/work-product producers,
  batch import, first-link selection, company isolation, hidden targets, queue
  rule enablement, company activation, resubmission, outer commit and rollback,
  first write during drain, database failure through drain, multiple pages,
  failed-page progress and retry, concurrent resolution, archived/kept history, shutdown/restart, and an admitted transaction at shutdown.
- 115 existing tests pass across queue routes, attention, approval retention,
  approval service, work products, and startup wiring. The shared writer still
  passes existing plan/question/PR seed tests and authorization tests.
- Workspace typechecks and the production build pass. Fresh PR checks are
  tracked in the PR and must pass before readiness is claimed.
- The actual pending lookup on 40,000 completed approvals plus one pending PR
  approval uses the existing partial pending-retention index. The probe runs in
  a rolled-back transaction; execution took 0.094 ms on this local fixture. No new index or migration is needed for this case.

The first expanded test run caught two fixture errors: a hand-inserted queue
omitted required creator attribution, and a failure test expected no idle hold
while committed projection work was still unresolved. The corrected test waits
for the active attempt to finish and checks passive SQL directly while preserving
that required hold. Neither required weakening the worker's recovery contract.

Review found a queue/item lock inversion between seeded insertion and manual
membership changes. A two-connection PostgreSQL regression reproduced `deadlock
detected`. Manual add/remove now lock the queue before touching its items, matching
the seed writer. The regression and the existing queue route suite pass (27 cases).
Server typecheck and build pass after the repair. Fresh-head CI/review is required.

Security review found that normal producer wakes could restart a cross-company
scan. The regression reproduced another company's queue being populated by an
unrelated company write. Producers now include company hints, including batch
imports and nested transactions. A separate controlled PostgreSQL test holds the
final empty read while a real producer commits and verifies the retained wake.

After company scoping, all 169 selected cases pass across approval queue seeding,
approval retention, queue routes, approval services, work products, and issue
comment routes. Server typechecking passes. The preceding run suffered timeouts
and a consequent cleanup foreign-key error; it is not counted as passing. The
route suite separately exposed cold imports inside timed tests. Moving those
imports to suite loading preserves assertions and prevents timed-out requests
from leaking into later mock state. The watchdog fixture collision from CI uses
monotonic identifiers instead; its 19 real-PostgreSQL cases pass.

The next CI run passed the security gate and the two originally failing shards.
Its remaining server shard caught a historical cleanup test checking 33 provider
inspections after only 32 had completed. The test advanced fake time before the
previous asynchronous page had necessarily published its next deadline. It now
waits for all 33 inspections, then retains the zero-further-work assertions. All
14 environment cleanup cases pass on real PostgreSQL; production code is unchanged.


Further review reproduced 120 failed transactions in two simulated minutes for a
persistently failing projection. Per-scope backoff now bounds that test to at most
eight attempts, even with new signals every second. Removing the fault recovers
the membership. A real coordinator/producer case proves thirty seconds without
SQL during backoff, another company's successful queue seeding during that wait,
and eventual recovery without losing the original work. All 25 worker cases pass.
The first consumer command omitted the external DB setting for queue routes and
skipped those six cases; the corrected command executes and passes all six.
The shared PR predicate is exercised by both those writer tests and worker tests.
Server typecheck and build pass; fresh remote review/checks remain required.

The final startup, approval-retention, and attention consumer run passes all 93
cases. With the 25 worker and six queue cases, 124 affected tests pass.


## Current retention-parent integration

The seeding worker reuses `firstApprovalIssueId` from the approval-visibility
owner rather than retaining its own first-link SQL. Company IDs are part of the
approval notification contract because projection reconciliation is scoped.
Generic approval writes notify retention and seeding only; the existing terminal
approve/reject/cancel owners alone notify tool-review consumers. Current precise
issue-deletion target notifications, unseen retention controls, finite retention
cycles and the real source-row lock regressions are preserved.

All 522 cases in fifteen complete suites pass at `4e725e2055`, with server
typecheck and production build. This includes seeding, queue routes, work products,
issue comments, both retention workers, approvals, attention, retention controls,
budgets, tool gateway, startup, scoped deadlines, environment cleanup and task
watchdogs. Four new disposable fixtures were cloned from the already migrated
parent fixture; this is not a fresh-empty-schema claim. The other suites used
separate existing disposable databases. No database was shared with another
concurrent local test run. The subsequent parent merge changes only two documents;
all tested runtime and acceptance sources remain byte-identical.

The first integration typecheck caught two incorrect gateway company references.
They now use the existing session company, and typecheck plus the complete gateway
suite pass. Earlier deadlock, cross-company wake, backoff, skipped-fixture and
teardown failures remain in the historical sections above. The parent's attention
cleanup timeout and expiry-test CI assertion are recorded in its document; this
larger current run passes without changing their assertions or timeouts. Fresh
exact-head reviews and CI remain required before this dependent PR can merge.


## Final master and review repairs

Join retention merged as `8406047b4e`. The normal master reconciliation first
proved that landed tree equals the existing parent. Conflict resolution preserved
the complete tested seeding tree; it also removed a duplicate helper introduced
by automatic merge. The PR again differs from master in only its original 25
seeding paths. Database schema and migration metadata are identical to master.

Three retry regressions failed before repair: ongoing arrivals skipped a recovered
membership, a partial successful batch retained the old sixty-second failure
penalty, and resetting that counter on an empty cursor rollover weakened outage
backoff. The worker now fixes the upper ID per cycle and resets consecutive
failures only on real successful progress or complete reconciliation. Exact
one-second recovery and two-second consecutive-failure assertions pass; repeated
signals still cannot reset a failing scope's delay. No new table or retry wrapper
is introduced.

The external seeding, queue-route and watchdog fixtures now apply pending
migrations before creating their client. Each of three empty-database regressions
failed with missing tables before this setup repair. All 55 cases then passed on
a second set of genuinely empty databases, with the suites applying their own
migrations. The final additional rollover guard brings the three complete suites
to 56 passing cases (28 seeding, 6 queue-route, 22 watchdog), using those now
migrated fixtures. Server types/build pass at `7948136ef8`. The earlier 522-case
integration run remains evidence for its stated revision and unchanged consumers;
it is not relabeled as a current full-suite run.

The first expanded fresh run passed 54 cases and failed the new backoff test's
cleanup expectation: after an entirely failed full page, a separate empty pass
ends the cycle before the next pass revisits rows. The corrected fixture permits
that explicit continuation and still checks complete recovery and the exact retry
deadline. Earlier failures remain recorded. Fresh final-head CI and reviews are
required before merge.
