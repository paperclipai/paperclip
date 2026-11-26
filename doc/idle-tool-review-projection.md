# Tool-review interaction repair

The tool-action request and invocation are authoritative. The interaction card
is a projection of their outcome. Previously the aggregate maintenance tick
joined these tables repeatedly, even when every card already matched.

The projection worker reconstructs affected companies at startup and reconciles
after committed changes. Producer hints carry the company ID. Subsequent
candidate discovery and paginated repair queries filter by that company; review
writes cannot drive a scan of another company's terminal history. The shared
scoped worker dispatches one company per pass with one-second minimum spacing.
It retains a 30-second retry only for a mismatch or failed reconciliation.
Configured idle tools, pending reviews without terminal outcomes, and matching
terminal history have no recurring projection SQL or provider calls. This is
worker quiet, not whole-instance suspension.

## Ownership and trigger contract

`tool-review-projection.ts` owns candidate discovery and pagination. The gateway
retains card interpretation, current-state checks, locks, activity publication,
and the existing continuation callback. The scheduler consumes company discovery,
`sweep(companyId)`, and the returned retry obligation. No provider payload enters shared scheduling.
No table is added. A concurrent company/interaction lookup index supports the
existing link checks and linked-request updates.

The existing review notification helper now also signals projection repair.
Notifications are awaited before writes and inherit the outer transaction's
commit, rollback, and uncertainty tracking. Unrelated review changes can cause
one empty company-scoped reconciliation; they do not create a recurring deadline.
Interaction-only writes first check for an actual linked tool request using the
company and affected card IDs. Generic confirmation kinds alone do not signal
any tool-review queue. This also preserves recovery for legacy linked cards
without current tool payload flags. These reads happen in the mutation owner,
not a background poll. Sibling selection shares the update predicate and runs
under the existing issue lock before publishing the notification.

| Producer | Notification ownership |
| --- | --- |
| Gateway signing, approval inference, execution claims, provider outcomes, and invalidation | Existing `writeToolReviewChange`; the closed-issue expiry path now uses it too |
| Human approval/rejection | `commitToolActionReview` signals in its existing transaction |
| Pending expiry, approved recovery, interrupted claims, Test-tab settlement | Existing review-write boundary |
| Review-queue invalidation | Existing review-write boundary |
| Interaction withdrawal, skip, terminal-issue expiry | Linked-request resolution signals before the mutation |
| Linked tool-card accept/reject, deleted-addressee cancellation | Projection notification before replacing card state in the owning transaction; unlinked confirmations do not notify |
| Sibling supersession, startup duplicate cleanup, new/historical comment supersession | Projection notification before card replacement, including cases where the request is already terminal |
| Comment-based confirmation resolution | Calls the interaction owner inside the same outer transaction; its later comment-ID update shares that signal |

The audited other interaction writers do not create this mismatch: native bridge
and status-committer summary/status-only updates preserve the projection; native
review retirement owns separate completion-review cards; connection and secret
flows own their separate card types. Document-staleness and plan-resume paths
use document targets, while tool cards use `tool-action:` custom targets.
Reflection consent uses its instruction/profile/skill target keys, not tool-action
keys. A future writer that replaces tool-card result state must use the same
transaction notification boundary. A future writer that changes authoritative
tool outcomes must signal the review boundary.

## Repair, concurrency, and lifecycle

The mismatch predicate preserves the previous policy: terminal executed, failed,
expired, or cancelled requests with a linked interaction whose displayed tool
status differs. Cancelled requests display `expired`. Invocation error and result
summaries come from saved state. Repair never repeats a provider action.

Candidate queries page in request-ID order, 100 rows at a time. A card that cannot
yet be projected does not starve later pages. Per-row failures do not prevent
attempting the remaining candidates; failures keep the retry. A final mismatch
check retains retries for no-op repairs rather than silently declaring them done.
Failed companies retain their own backoff across notifications while other
companies progress. An unresolved no-op projection retains a 30-second deadline;
a new relevant company change can make it actionable sooner. A company pass
still drains all its pages, preserving progress past an unprojectable card.
The joins inspect that company's history on activation. This change removes repeated
idle scans; it does not introduce an indexed projection-debt table or claim that
an activated reconciliation has constant cost independent of history size.

The gateway locks the interaction and request, then checks the current request
status. If another repair already wrote the same status and outcome fields,
it avoids a second write and duplicate activity. Different saved details still
use the existing update path. Missing projection state remains repairable.

The shared deadline worker retains first writes during drain, failed retries,
and changes arriving during reconciliation. Shutdown joins coordinator work.
Startup reconstructs debt from existing rows. With heartbeat scheduling disabled,
startup still performs one pass, preserving the existing disabled-mode contract.
The public/manual combined review sweep remains available; server maintenance
no longer calls it periodically.

## Continuation and sleep limits

Card state is not proof that continuation delivery finished. Existing
`tool_action_deliveries` receipts and their coordinator remain responsible for
that work. Activity publication still occurs after the card transaction; this
slice does not add exactly-once activity delivery or a new outbox.

Signals remain process-local to the supported database owner. Independent SQL
writers and another active server require a separate notification/reconciliation
contract. Cloud eligibility still conservatively blocks retained tool-action
requests. No external wake or sleep-safety guard is relaxed here.

## Verification

Twelve new real-PostgreSQL cases exercise normal approval and single execution,
quiet configured and terminal-history states, four persisted outcome states,
outer commit/rollback, first write during drain, failure retry through drain,
foreground/worker repair contention, multi-page progress past an unprojectable
card, and an administrative card overwrite that reactivates repair. Quiet checks
observe absence of database reads across an hour of controlled time.

The first focused run caught a missing-projection null access in the new
idempotency check; optional access fixes it. The pagination fixture also attempted
to change a referenced request ID; it now orders the additional candidates without
mutating that key. The focused rerun passed all eleven then-existing tests.
After adding the concurrent repair case, all 148 service/startup tests and 92
gateway acceptance tests passed. Workspace typechecking and build passed. All 469 tool-access and 106 interaction
service tests also pass (815 tests across the final selections). The first
interaction run passed 105 cases but timed out in one cleanup hook during a
53-minute local run; the isolated full rerun passed in nine seconds. No production
change or timeout increase was made to force that result. Full repository tests
will run in CI; the local selections do not claim a complete repository test run.
Fresh PR CI/review remains required.

Company-scoping follow-up reproduced two regressions: captured recovery SQL lacked
a company predicate, and ordinary confirmation creation/replacement/cancellation
published three unnecessary tool-projection wakes. Both regressions now pass
through real producers. Additional coverage keeps failed-company retry timing
independent, proves ordinary mutations still complete without recovery scans,
and exercises administrative repair of legacy cards identified by their saved
link rather than payload flags.

Company-scoping follow-up verification: all 180 gateway and startup cases and all 152 interaction and secret-proposal route cases passed against dedicated PostgreSQL test databases. Server typechecking passed. These are local checks; stack CI and deployed sleep qualification remain separate.


## Indexed interaction links

Review found that the new link check had no supporting interaction index. An
ordinary unlinked confirmation could scan all tool-action history for its company.
The generated `0386_steady_epoch.sql` migration adds the non-unique
`(company_id, interaction_id)` index concurrently, and the existing top-level
migration executor handles its creation and interrupted-build recovery. The
schema and generated snapshot describe the same index; older SQL and journal
entries are preserved and snapshot pruning retains the five newest snapshots.

A real PostgreSQL check applied the migration to a fresh dedicated test database
and seeded 30,000 tool-action rows. The ordinary missing-link query returned no
rows in both treatments: without the index it performed a sequential scan,
filtered 30,000 rows and touched 429 shared buffers; with the index it used the
new index and touched two buffers. These are local planner measurements, not a
fleet latency or cost claim. The baseline index removal was rolled back in that
dedicated database, and the index remained valid afterwards. An initial probe
failed while binding a JSON fixture parameter before any comparison; correcting
the parameter encoding made the complete probe pass. That failed fixture is not
counted as a product regression.

Migration numbering/safety checks, generated snapshot drift, server types and
server build pass. All 214 cases in the full gateway/projection/startup/scoped-
deadline selection pass against a separate freshly migrated database, preserving
notification quiet, company isolation, transaction settlement, and interruption
behavior. Latest-head CI and automated reviews remain required merge gates.

## Bounded projection and lifecycle interruption

A review found that one company could drain an unlimited backlog in a single
worker pass. Five real PostgreSQL regressions reproduced 501 rows being consumed
instead of the 500-row budget, missing abort/drain handling, and the absence of
continuation past a full page of unprojectable or failed cards.

The worker now gives its existing service a 500-row budget, the coordinator's
abort signal, and its admission predicate. The service checks admission between
rows and reads at most 100 candidates per page. It retains the last attempted
request ID for each unfinished company, including after a failed pass, so a
poisoned early page cannot hide later healthy cards. A truncated pass schedules
a one-second continuation; the existing shared per-company fairness and failure
backoff remain in force. A completed pass that still has an unprojectable card
backs off from thirty seconds to five minutes. Fresh committed company changes
reset that delay and wake the affected scope promptly. These are real unresolved projections,
not an unconditional empty-history scan.

Reconstruction clears continuation state for companies that no longer have
mismatches. A sixth real regression reproduced an abandoned cursor skipping the
first new earlier card after an empty reconstruction; clearing that cursor makes
the first new pass repair it immediately. The maps contain no durable truth:
restart reconstructs from the existing rows, and completed rows stop matching.
There is no cursor table, independent timer or per-producer recovery wrapper.

Legacy manual/global and scheduler-disabled one-shot repair calls retain their
complete-sweep behavior unless they request a budget. The normal coordinator
worker always supplies the bounded options. Cancellation is observed between
rows and pages; an already issued database query or reflection finishes before
the service stops. A sweep never replays a provider tool action.

All 220 cases across the full gateway/projection/interruption, startup and scoped
deadline suites pass, with no skipped cases. The five initial regressions and
sixth cursor regression failed before their fixes; server types and build pass.
The earlier 219-case acceptance remains evidence for the preceding revision.
Fresh integrated-head CI and both automated reviews remain merge gates.


After normal reconciliation with master `f6bc653f7f`, all 320 integrated cases
pass, including the 81 authenticated gateway HTTP cases and the upstream narrowed
identity-read tests. Server types and build pass. Thirty-five independent master
performance files are preserved exactly; the gateway's narrowed identity read
is preserved alongside the projection extraction. The pre-integration 220-case
selection above remains evidence for its stated revision.


## Review efficiency follow-up

A company-scoped hint now enters the bounded owner directly rather than first
repeating company discovery. Startup/global reconstruction still discovers
companies from existing rows. An empty sweep with no saved cursor returns after
one candidate query; a resumed cursor or attempted reflection still needs the
final query to detect unresolved earlier cards. The reflection callback returns
no settlement result, so an attempted reflection cannot establish that a card
was repaired.

Returned unresolved work now backs off through 30, 60, 120, 240 and 300 seconds,
matching the shared error-backoff cap. Truncated backlog continuation remains
one second. Settlement removes the retry; a new committed hint resets backoff.
No pending row is discarded, and no independent timer or table is added.

The fixed-cadence regression failed before repair and now verifies the full
backoff cap, producer reactivation and quiet after settlement. An initial scan
assertion incorrectly assumed that a complete approval emitted only one wake;
its separate legitimate writes caused two scans even after optimization. The
corrected case isolates one committed hint and verifies one candidate scan with
matching history, followed by an empty direct sweep with one query. All 222
cases in the full gateway, startup and scoped-deadline suites pass without skips;
server typecheck and build pass. Fresh-head CI and both reviews are still required.
