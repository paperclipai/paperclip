# Join request retention while idle

Pending join requests already have durable activity timestamps. Retention now
uses their next 90-day archive deadline instead of including them in the main
maintenance tick's attention-feed scan. The regular attention UI still includes
join requests. This changes automatic retention discovery, not access approval.

## Owner and eligibility

`join-request-retention.ts` owns candidate eligibility, its locked recheck and
deadline. `decision-retention-sweep.ts` shares bounded paging, per-row retention
transactions and failure handling with the approval-retention owner. The shared
sweep consumes normalized candidates; each owner retains its table/query policy.
A candidate is a pending_approval request belonging to an active company, with
an invite whose company matches the request. Kept and already archived items do
not schedule work. Invite expiration or revocation does not remove the existing
attention item and therefore does not disable its retention. No provider policy
is interpreted by the worker or shared scheduler.

The next deadline is the earliest eligible updatedAt plus 90 days, rounded up
in SQL to the scheduler's millisecond resolution. It must not wake a fraction of
a millisecond early and then wait thirty seconds for recovery. The partial
pending index orders updated_at and id. Resolved request history is excluded by
the index predicate. Each pass attempts at most 100 due rows. The private cursor
preserves database timestamp precision so a failed page cannot starve later work.
Errors keep the shared 30-second retry; successful full pages continue until
work is exhausted. No eligible rows means no scheduled SQL or network scan.

Each candidate is re-read under its request row lock before retention changes.
A writer that wins that lock first is rechecked before archival. If archival
commits first, a later activity write leaves the item archived until explicit
revival; updating activity does not clear existing retention choices. The tests
cover the writer-first race and the archive-first committed outcome. Supported
invite replay expires before the 90-day cutoff and Slack access replay deduplicates;
a future producer that needs to reappear after archival must request revival.
The shared retention owner still controls keep, archive/revive, version checks,
activity logging, and notification creation. Archiving does not approve or reject a join.
Join requests have no origin agent, so their archival creates no agent delivery.
Company and invite joins preserve existing visibility policy; this does not add
cross-table serializability beyond the existing retention contract.

## Producer audit

| Producer | Notification boundary |
| --- | --- |
| Invite acceptance creates a pending request | Existing acceptance transaction, before the request insert |
| Supported gateway invite replay changes activity | Small writeJoinRequestChange transaction around the existing SQL update |
| Automatic human approval after acceptance | Same helper around the status update |
| Explicit approval and rejection | Same helper around the status update |
| Slack self-service access request | Existing platform transaction, before the request insert |
| Company pause, resume, archive, or deletion | Company-level retention notification inside the existing transaction |
| Budget-driven company pause or resume | Same company notification in the accounting transaction |
| Keep/unkeep, manual archive/revive, accepted archive proposal | Existing typed retention notification now routes join_request to its worker |

Provider calls, membership grants, and unrelated route behavior stay outside the
small SQL mutation helper. Nested callers retain the existing outer transaction
settlement and uncertain-outcome protocol. The access router itself requires a
root database connection; it is not wrapped in a caller transaction.

API-key consumption only permits an already-approved request. It cannot create
pending retention work and does not acquire a new wrapper or signal. Invite
acceptance that reuses a human request does not update that request. Revocation,
expiry, and acceptedAt changes do not change the feed predicate. Invite/company
identity is immutable in supported routes; company deletion is the invite delete
owner. A future producer that changes these facts must join the same contract.
Process-local signals do not cover independent SQL writers or another instance.

## Lifecycle and limits

Startup reconstructs pending deadlines. The worker is registered only when the
existing heartbeat maintenance switch is enabled. Writes during drain retain a
wake without passive SQL. Failed work retains its retry across drain. Shutdown
joins an admitted archive and stops before subsequent candidates; restart picks
up the durable remainder. There is no new queue table or permanent DB listener.
The in-process deadline is not a Cloud alarm. Existing unsupported-future-work
sleep blockers remain in place.

## Earlier verification

Seventeen new real-PostgreSQL cases pass. They cover actual invite acceptance,
rejection, human approval, gateway replay, and Slack access requests; empty and
resolved-history quiet; saved deadlines; startup reconstruction; keep and manual
archival controls; company pause/resume; unchanged expired/revoked invite policy;
normal versus maintenance feeds; nested commit/rollback; first writes and failed
work during drain; concurrent source updates; 101-row microsecond paging with a
full failed page; and shutdown/restart.

Another 139 consumer cases pass: 71 invitation/startup cases, 21 approval worker
cases, and 47 shared retention/attention/budget cases. This is 156 selected tests,
not a full local suite claim. The first consumer command used a nonexistent
retention test filename and ran only the approval suite; the corrected selection
ran the actual retention suite against its dedicated external database.

Initial test failures exposed fixture assumptions: the access router cannot run
on a transaction handle; unresolved recovery cannot be expected to become idle;
Slack links require actual endpoint/principal ownership rows; and shutdown tests
must establish admission and deterministic candidate order. Those fixtures were
corrected without weakening assertions or production checks. The first replay
fixture lacked required gateway credentials. The final fixture supplies test-only
credentials. A reused transaction spy retained admission calls during the quiet
assertion; restoring it before the quiet measurement fixed the measurement.

Migration 0387 applies, the full migration set replays, and the concurrent index
statement replays idempotently. Migration safety and numbering checks pass; the
five newest schema snapshots are retained. The actual next-deadline query with
40,000 resolved requests and one pending request uses the pending index and
executes in 0.017 ms locally. The probe rolls back its data. This is query-plan
evidence, not production latency or measured savings. Workspace typechecking and the production build pass. Fresh PR CI/review remain
required before readiness.


## Current review repair and verification

The duplicate approval/join archive loop is now one `createDecisionRetentionSweep`
implementation. Each owner supplies its candidate ordering boundary, page, locked current-state
lookup and next deadline. This keeps eligibility, company/invite joins and
source-row locks with their owner while sharing cursor/error/retention behavior.
The existing 100-row budget, PostgreSQL text cursor and failure rotation remain.
Both workers coalesce notification-driven global reads under a thirty-second
aggregate budget; saved deadlines preempt it and no idle scan is scheduled.

Manual keep/archive/revive can materialize an unseen join request in the existing
retention write transaction, as approvals already can. The company-scoped source
is locked, its real activity is read, and existing versioned state is synchronized.
Authorization, archive choices and other source kinds retain their contracts.
No route bookkeeping, queue table, permanent listener or Cloud exemption is added.

Five real regressions failed before repair: three unseen-request controls returned
404 and both owners rounded a saved microsecond deadline down. All pass. The first
two-owner run passed 50 cases but failed two old producer expectations that used
a truncated JavaScript Date. They now compute the expected scheduler millisecond
independently from integer database microseconds; exact assertions remain.

The first missing-lock mutation exposed a weak test: its timing-only writer gate
released before proving the sweep had reached the lock, so it still passed without
`FOR UPDATE`. The strengthened test observes the actual PostgreSQL lock wait before
releasing the writer. It passes with the production lock and fails with zero waiters
when that lock is removed. The production source was restored in `finally` before
commit. A separate archive-first committed-order case preserves the existing
archived-stays-archived behavior and verifies explicit revival.

All 340 cases in nine complete suites pass at `405c7dcdef`, including all 31
approval and 22 join worker cases. Server typecheck and production build pass.
Normal integration of parent `0b0e844b77` changes only four independently merged
Runner E2E accounting files and the ledger; runtime and acceptance sources remain
byte-identical. Existing results retain their tested revision.

Generated concurrent/idempotent migration `0393_open_grandmaster.sql` adds only the
pending-request index. All 391 parent journal entries and historical SQL files are
unchanged; five generated snapshots remain (0389–0393). Migration safety/numbering,
schema drift and actual apply/replay on six isolated PostgreSQL fixtures pass.
Earlier setup, timing, mutation and CI failures remain recorded here and in the
stack ledger. Fresh final-head CI, security and both 5/5 reviews remain required.


## Retry progress under continuing arrivals

Each scan cycle saves the final due `(updated_at, id)` tuple, at full database
precision. Its pages stop at that boundary. Later due rows cannot keep extending
the cycle and postpone failed rows forever. The cursor still advances past an
individual failure, so one bad request—or an entire failed page—does not block
later healthy rows. Once that finite cycle ends, the next cycle revisits failures.
There is no new durable queue or per-row retry registry. Restart reconstructs
eligibility from existing rows.

Two real PostgreSQL regressions failed before this repair: continued newer overdue
arrivals left a recovered approval and join request behind the cursor. Both now
archive in the next cycle. All 55 worker cases pass, including the existing
100-failure-page progress and microsecond-cursor cases. The nine-suite run passed
341 cases but failed the attention suite's cleanup hook after its 16,400-run case:
`delete from heartbeat_runs` exceeded thirty seconds. After vacuum/analyze of only
the disposable attention fixture, all 31 attention cases pass without code or
timeout changes. The other eight suites passed 311 cases in the original run;
342 distinct cases pass across those complete-suite executions. This demonstrates
recovery, not a proven explanation of the cleanup slowdown. Server typecheck and
production build pass at `df1815fbba`; the subsequent master integration has an
identical complete source tree.

Earlier CI at `df1d4d0` also failed the unchanged decision-expiry restart test:
its earliest wake was a thirty-second retry rather than the saved expiry. The
complete unchanged expiry suite passes all twenty cases locally. Its CI timing
cause remains unproven; it is not labeled infrastructure or silently discarded.
Fresh final-head CI and reviews must pass before merging.
