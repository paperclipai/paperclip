# Approval retention without idle polling

This slice removes approval retention from the recurring attention-feed sweep.
It does not migrate the other attention source kinds or establish host sleep.

## Obligation and owner

A pending approval in an active company is eligible for automatic archiving
90 days after its last approval activity, unless kept or already archived.
This is a presentation/attention archive: it does not approve, reject, cancel,
or delete the approval. The deadline and policy are unchanged.

Approval rows are the source of truth, including those never viewed in the
attention UI. Scheduling only existing `decision_retention` rows would miss
unseen approvals because the old feed reader materializes those rows lazily.
`approval-retention.ts` discovers eligible approvals directly and registers
the earliest actual deadline with the existing delivery coordinator.

The query retains the attention feed's first-linked-issue rule and consumes
`executionIssueCondition` from the issue visibility owner. Hidden, harness and
agent-conversation tasks remain excluded. A waiting external conversation with
a linked pending approval is active under that same shared visibility policy;
its chat state alone cannot hide this approval. Tests exercise the Slack case.

Each pass visits at most 100 candidates in activity/id order. The cursor keeps
the database timestamp as text so sub-millisecond precision cannot repeat a
failed page. A failed row does
not prevent later pages from progressing. The failed durable record remains
eligible for recovery. Each candidate is re-read and locked before archiving,
so a resubmission committed while the worker waited cannot archive the new
activity using an old selection. Existing retention version, keep and archive
compare-and-set checks remain authoritative. This does not add cross-table
serializability for concurrent link/visibility/company policy changes.

## Producer coverage

| Supported producer | Notification boundary |
| --- | --- |
| Approval create, cancel, revision, resubmit | SQL write transaction in approval records |
| Approval resolution, including hire lifecycle | SQL write, retaining the caller's outer transaction |
| Hard budget approval and budget resolution | Existing accounting transaction |
| Formal tool approval and issue link | SQL write transaction; provider work is outside it |
| Link, unlink and bulk link | Issue approval write transaction |
| Issue visibility changes and deletion | Existing issue mutation transaction |
| Routine creation rollback cleanup | Existing transaction before cascading issue deletion |
| Company activation, pause, archive and deletion | Existing company/accounting transaction |
| Keep, manual archive, revive and accepted archive manifest | Existing retention mutation transaction |
| Retention materialization or source activity change | Signal only when inserting or changing actual state |

Approval comments do not change approval activity under the existing policy.
Company portability imports do not write approvals; restored durable records
are reconstructed at startup. Signals belong to the application DB owner and
its dedicated child pools. Independent SQL writers or another active process
need explicit integration; this change does not claim to observe them.

## Shared contracts and lifecycle

The main maintenance feed excludes the approval source before collecting it.
Public attention reads keep their existing default behavior. Other attention
sources remain in the aggregate sweep until separately migrated.

The retention service accepts the source fields it actually uses rather than
requiring fabricated full UI attention items. Its existing versioned state,
audit writes, authorization and archive-notification outbox are reused. No new
queue table is introduced. Transaction-aware notifications retain intent until
the outer transaction settles, including nested writes and rollback.

The deadline worker uses the shared scheduler's generation and drain behavior.
Startup reconstructs pending work; idle drain retains requests without passive
SQL; resume reconciles them. Failed work retains a 30-second recovery spacing.
No eligible approval means no recurring deadline or query. Completed history,
kept/archived approvals, and inactive companies are quiet until a supported
mutation changes eligibility. Shutdown joins admitted work and stops between
candidates. Notification delivery remains owned by the separate archive worker.

A pending-only `(updated_at, id)` index bounds deadline lookup independently of
resolved approval history. The migration uses concurrent, idempotent creation
and the existing migration runner's nontransactional execution list.

## Verification and limits

Real-Postgres lifecycle tests cover unseen sources, future deadlines, retained
history, keep/unkeep, archive/revive, revision/resubmission, company activity,
linked issue visibility/deletion/order, normal versus maintenance attention
reads, nested commits/rollback, startup and first-write drain, failed database
writes through drain, bounded progress past failure, shutdown, and a concurrent
resubmission. The waiting-Slack case also checks durable notification creation.

Existing approval, attention, retention, budget, tool-gateway and startup suites
are relevant consumers. Track final results and any failures in the PR and the
[stack ledger](plans/2026-10-24-recurring-server-sleep-stack.md).

The Cloud sleep guards are unchanged. An in-process deadline cannot wake stopped
compute, and this approval deadline has not been added to Cloud's durable wake
contract. This proves only the named worker's quiet/reactivation behavior.


## Initial review repair verification

The feed and retention worker now share `approval-visibility.ts` for the first
linked issue and its execution visibility. The feed still applies actor-specific
read access before including a linked approval. Both link orders are covered:
hidden first/visible later stays excluded; visible first/hidden later stays
eligible. The worker's current-state recheck remains under the approval row lock.

Manual keep, archive and revive materialize an unseen approval on demand inside
the existing retention write transaction. They lock the company-scoped approval
row in the same order as automatic archival, read its real activity timestamp,
and use the existing versioned `syncItems` operation. Missing or unauthorized
sources retain their existing rejection; other source kinds are unchanged. This
adds no eager startup materialization or recurring scan.

Four real regressions failed before repair: unseen young keep/archive/revive
returned 404, and the atomic materialization test could not reach the keep write.
All pass after repair. A failing keep update rolls back the inserted retention
row and emits no audit; the next successful keep persists exactly one audit.
All 26 lifecycle cases pass, including the existing timestamp-precision failure
rotation. The complete eight-suite consumer selection passes 311 cases at
`063b61584d`: approval worker/service, attention, retention, budget, tool gateway,
startup and scoped deadlines. Server typecheck and production build pass.

Normal parent reconciliation preserves every historical parent SQL file and all
390 parent journal entries. The approval index is regenerated through the normal
workflow as concurrent/idempotent `0392_small_frightful_four.sql`; five generated
snapshots remain (0388–0392). Schema drift, safety/numbering and actual fresh
migration apply/replay on five isolated PostgreSQL databases pass. Earlier
transaction-stub, budget-import, query-probe and CI failures remain recorded in
the stack ledger. Fresh current-head CI and both reviews are required.


## Wake amplification repair

Ordinary creation, links, revision requests and resubmission signal retention
only. Tool-review queues are notified by the actual terminal transition owners:
approve/reject in approval resolution, and cancel in the approval service. These
are the same terminal transitions that notified tool reviews before this PR.
Cancellation must remain a producer because it settles parked tool actions as
unavailable. No extra wrapper or scope argument is threaded through those calls.

The aggregate retention worker now coalesces sequential notifications for thirty
seconds after a successful reconciliation. This is a single instance-wide read
budget, stricter than granting each company an independent thirty-second budget,
and matches the former default maintenance cadence. Known business deadlines
still preempt the coalescing window. The window schedules no work on its own;
without a notification or saved deadline the worker remains quiet. Newly changed
eligibility can wait up to that window, as under the old default maintenance.

Three new real regressions failed before repair: approve and reject cases
observed unwanted tool-review signals from ordinary mutations, and four
sequential tenant writes caused eight global reads rather than one two-read
reconciliation. Terminal approve/reject/cancel signals are now tested explicitly.
With another company's pending approval present, sequential writes cause no extra
SQL within the window and one reconciliation when the window ends.

The first coalescing fixture incorrectly expected the pending-work hold to clear
before the requested reconciliation; it now lets the deferred wake remain owed
and measures SQL directly. The first broad repair passed 313 cases and failed
the existing parked-review cancellation case. Restoring the original cancel
producer fixed that regression without weakening its outcome assertion. All
315 cases in eight full suites now pass at `dd844f4e8c`, including 30 approval
worker cases; server types/build pass. The earlier security check at `5991f257bb`
was action-required and Greptile reported service error reference
`8fb1835c-e564-476b-b802-d5be164ea915`. Neither is claimed as passing; the repaired
head requires fresh security, CI and both bot reviews.
