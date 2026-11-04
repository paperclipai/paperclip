# GitHub stale-head review projection repair

Date: 2026-10-25. Parent: GitHub review-check migration #17662.

## Obligation and owner

The GitHub check dispatcher can record `cancelled/stale_head` before task
admission creates its review row. A review in `queued` or `running` with no
assessment must then become `superseded`, but only when the cancellation belongs
to that exact admitted delivery. Same PR/head alone is not enough authority.

Existing reviews, check actions, and deliveries are durable truth. This is local
projection repair, not provider reconciliation. It needs no provider HTTP,
periodic deadline, or new queue table. The GitHub provider directory owns the
predicate and repair; the shared coordinator owns coalescing, fairness, retries,
drain, startup reconstruction, and shutdown.

## Producer audit

- `githubReviewCheckService.dispatch`: stale-head cancellation commits the action.
  Signal before the action write, even if no review existed during dispatch.
- `retainGitHubReviewReceipt`: task admission inserts the automatic review in the
  caller-owned transaction. Signal before insertion, preserving outer settlement.
- `githubChatReviewService.reviewForHead`: binding an unbound automatic review can
  set it back to running. Signal before that update. Newly inserted manual review
  identities use `run:...` and cannot match an admitted delivery UUID.
- Check publication can set a review to running. Signal before that review update
  to cover an existing cancellation for its exact delivery.
- Assessment writes remove eligibility. Publication receipts/check metadata do
  not create it. Supersession removes it. Delivery authority updates preserve the
  original automatic context; task admission creates the review after the context.

## Correctness and lifecycle

Discover only matching unfinished repairs, with bounded keyset pages and shared
fair dispatch. Recheck the complete pending predicate in the UPDATE so a competing
assessment or state transition cannot be overwritten from a stale selection.
A failed selection or update retains a retry through the existing coordinator.
No pending repair means no recurring SQL. Configured endpoints, manual reviews,
assessed reviews, and settled cancellation history are passive.

Signals are process-local to a database owner and its child clients. Independent
SQL writers or another process require an explicit integration; startup rebuilds
already committed work. This does not extend Cloud wake coverage, relax idle
safety, or prove host/database suspension.

## Scope

Remove this duty from the periodic GitHub maintenance wrapper. Retire the empty
wrapper and its publication-maintenance wiring while preserving the independent
GitHub missed-webhook recovery lane. Preserve explicit/manual combined check
recovery. Other server maintenance remains in the original stack inventory.

## Evidence

Ten new real-PostgreSQL cases cover real webhook admission after cancellation,
cancellation after a held remote-head read and intervening admission, nested
receipt commit/rollback, restart/drain/standby, failed-update retry across drain,
assessment ownership under an observed PostgreSQL row-lock wait (with and
without concurrent shutdown), and 106 pending repairs plus 105 manual rows.
The existing late-projection regression still exercises the explicit recovery API.

The first selection passed eight and failed two cases. The nested-commit
assertion had the default one-second timeout, matching rather than exceeding
the shared worker's one-second coalescing interval. It now uses the established
five-second observation allowance. Warm standby correctly retains an unresolved
intent hold until reconciliation is admitted; the fixture now asserts that hold
while also proving no passive SQL. No coordinator or production delay changed.
After repair, all 20 worker/legacy/startup cases passed in 24.72 seconds and
again in 30.61 seconds after query/index changes.

Workspace typecheck and build passed before the final scalar-query refinement;
fresh acceptance for that final refinement is pending. Migration generation,
safety checks, application, replay, and index validity passed. The generated
migration adds two concurrent, idempotent indexes and retains five snapshots.

A rollback-only PostgreSQL plan seeded 10,000 each of completed reviews, manual
queued reviews, processed checks, unrelated cancelled checks, and deliveries.
The original joined EXISTS query used the receipt index only for company and
endpoint. An unrelated prefix forced 10,001 cancellation reads, 32,382 shared
buffers and about 34 ms. A nested EXISTS form was flattened into a hash scan of
retained cancellations. The final scalar receipt lookup uses all three index
keys, the delivery primary key, and the partial pending-review index: one result,
21 shared buffers, about 0.062 ms in the recorded fixture. This is a query-plan
check, not a whole-worker or fleet benchmark.

The canonical lower-case UUID guard preserves the old delivery.id::text equality:
manual run identities and noncanonical strings never matched that predicate.
CASE guards the cast even if PostgreSQL reorders predicates. The receipt lookup
is limited to one row and runs with the review's company and endpoint authority.
The candidate partial index excludes assessed, terminal, and manual history.

Final scalar-query verification: all 20 selected worker, legacy regression, and
startup tests passed in 33.62 seconds. Workspace typecheck and build passed on
the same source. Full chat/publication/startup acceptance is running in a fresh
database; its result and remote PR checks remain required. Parent #17662 at
01efd3f4f7 has all 53 checks passing, fresh Greptile 5/5, and no review threads.


## Current-parent acceptance (October 28)

The original query, authority checks, update predicate, and producer/lifecycle
changes remain intact. The existing branch was merged normally with published
review-check parent `2bba08403b195bf646eda48992b46d6f5cebf756`. Complete domain
and schema edits and all unrelated parent blobs were preserved. The historical
snapshot rename/delete conflict was resolved to the exact parent snapshot bytes.
Only this branch's unlanded `0397_fearless_supernaut` migration artifacts were
removed before canonical regeneration; all parent SQL and journal entries remain.

Migration `0403_natural_cerise.sql` creates the same two partial indexes with
concurrent, idempotent creation. Both definitions match the original migration.
All retained parent snapshot bytes are unchanged. Canonical generation retains
the five snapshots 0399 through 0403.

At `dd6bca0485c3444d6e3d0ee10ec4aa651e801392`, all 274 complete GitHub workflow
cases and all 13 startup cases passed: 287 distinct cases. The GitHub command
filtered 1,485 unrelated cases. It used a new, pre-migrated PostgreSQL database.
Coverage includes cancellation before/after real admission, outer commit and
rollback, restart, drain and standby, update failure, concurrent assessment under
an observed database row lock, shutdown during that wait, multi-page repair,
manual-history exclusion, and settled-history quiet. Database build, server
production typecheck/build, module boundaries, and target migration order passed.

A populated parent database upgraded from 0402 to 0403 with all 401 previous
migration receipts unchanged and exactly one new receipt. Replay added none.
Both indexes were ready and valid on fresh and upgraded PostgreSQL databases.
The earlier query-plan measurements above retain their historical revision scope;
no new fleet or whole-worker performance measurement is claimed.

The audit-only follow-up preserves the accepted source, tests, and migration
hashes. Fresh remote checks and exact-current-head Greptile review remain required.
This acceptance does not prove deployed host/database suspension or extend Cloud
alarm coverage. The separate missed-webhook obligation remains for the next slice.


## Browser CI clipboard read repair (October 28)

Head `1453a4447c0d4d33f713ae3e00734c7950f95426` received fresh Greptile 5/5 with
no findings. Its browser shard 7 failed twice in the lost-creation-response YAML
journey: the clipboard helper copied page text beginning with “Skip to Main
Content” and tried to parse it as YAML. The second failure followed the single
allowed unchanged-code retry. All three initial isolated local repetitions passed
with retries disabled and original budgets; that did not establish resolution.
The entire UI, failing test, Playwright config, and lockfile match the green parent.

The CI failure artifact shows the main region focused and the YAML editor not
focused. A one-shot native focus change to main during Copy, with whole-page
selection, reproduced the identical parser failure in the real browser. The exact
actor and timing that changed focus in CI were not captured; no infrastructure
cause is inferred from the earlier local passes.

The shared test read helper now clears stale clipboard data, clicks the actual
editor, and repeats the read-only copy gesture within the existing expectation
budget until a fresh canonical YAML header is present. YAML parsing still runs,
and every journey body, persistence assertion, command counter, and test deadline
is unchanged. This changes the browser fixture, not production background work.

The controlled focus-loss probe failed before the repair and passed afterward.
The temporary fault was removed before acceptance. All six complete agent YAML
configuration journeys then passed with zero retries in 50.9 seconds. This includes
real resource writes, partial/lost responses, non-replayed creation commands,
conflict handling, destination instructions, and revision restore.

Only the central test read helper and this verification note change after the
reviewed head. Entire server, package, and UI source trees remain identical.
The earlier 287-case backend acceptance therefore retains the same source bytes.
Fresh current-head CI and Greptile review are required for this repair; the old
head's score does not satisfy that gate. Both earlier CI failures remain recorded
in run 40777754306, including attempts 1 and 2, and its failed-job artifacts.


## Ponytail startup boundary correction

All CI and Greptile checks passed on `b3c81baebf1787ffb200bdd55533b422c2687033`,
but Ponytail's completed 4/5 review said “Ship after fixing 1.” That conditional
verdict blocked the merge. Its required finding was valid: one source-wiring test
used the removed `unsubscribeChatPublicationSignals` marker, so its end index was
-1 and its slice inspected almost the whole application file.

Explicit boundary assertions reproduced that defect: the selected test failed
because -1 was not after its start. The test now stops at the existing
`let chatPublicationTimer:` declaration and requires a nonnegative start and an
end after that start. All 13 startup/hostname cases pass with this correction.
No production behavior, deadline, or browser assertion changes in this follow-up.
The YAML helper and its six-case acceptance remain unchanged.

The review's second item was optional cleanup of the no-op coordinator lane.
Existing dependent #17666 removes the whole coordinator and the last chat interval;
this PR keeps its narrower scope. Fresh review and CI are required for the corrected
head. A neutral review check or a confidence score does not override a conditional
ship verdict or an unresolved required finding.
