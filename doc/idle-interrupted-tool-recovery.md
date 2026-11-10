# Interrupted tool-action recovery

An executing tool-action request has an existing ten-minute stale deadline from
its `updatedAt` claim timestamp. Recovery now registers the earliest actual
claim deadline with the shared scheduler. It no longer scans executing requests
on every aggregate maintenance tick.

## Ownership and producers

The gateway owns execution claims, provider calls, and result settlement. The
new interruption service owns only the deadline query and stale-row settlement.
The worker uses the existing deadline registration and exposes no provider
protocol or signed argument representation to the scheduler.

The review write helper signals interruption alongside approved recovery and
pending expiry. All three agent claim paths and the Test-tab claim use that
helper. Test-tab outcomes already commit both rows inside it. Agent pre-dispatch
and execution failure settlement uses the same notification transaction, and
successful or failed direct execution request updates now notify before writing.
Administrative review transitions continue to use the same existing boundary.

Unrelated pending review changes can cause a bounded empty reconciliation. They
do not create a periodic deadline. Process-local signals cover the existing
single-active-writer database owner; independent writers require a wake contract.

## Settlement and quiet states

The query uses a partial executing-request index and reads one earliest row.
There is no deadline after all executing claims settle. Retained terminal
requests and configured-but-idle tools produce no recurring worker queries.

At the deadline, settlement locks invocation then request, matching the existing
execution-failure lock order. It rechecks the claim status and timestamp after
locking. A changed or completed claim cannot be settled from an earlier scan.
Unknown outcomes atomically mark both rows failed with
`tool_execution_outcome_unknown`. Recovery never calls the external provider.

A saved terminal invocation is authoritative. Recovery repairs its request to
executed or failed without replacing the saved result, failure reason, or
completion time with an unknown-outcome failure. This covers a crash between
legacy invocation completion and request settlement. Interaction projection
runs after the transaction through the existing gateway owner. A failed
projection still relies on the separate projection-repair duty.

A database failure rolls back both outcome rows and retains a 30-second retry.
Startup reconstructs saved deadlines. Drain pauses dispatch without forgetting
the first claim or failed retry; resume processes overdue claims. Completion
notifications cancel unnecessary future scans. The scheduler-disabled path keeps
one startup pass. The public combined review sweep retains its existing duties.

## Verification and limits

Sixteen new real-PostgreSQL cases cover real foreground execution activation
and completion, configured idle and terminal history, restart/deadline timing,
six saved terminal invocation states, first-write drain/resume, outer commit and
rollback, transactional failure/retry, concurrent claim change, and multi-page
settlement. The service/startup selection passes 136 tests on the combined parent-review
head. Workspace typecheck/build and migration safety checks pass on that head.
Migration application and reapplication passed. The combined run also exercised
469 tool-access tests: 468 passed and an unchanged connection-archive case timed
out under concurrent build load. That case passes in isolation. The separate full tool-access suite passes all
469 tests and gateway acceptance passes all 92 (697 across the final selections).
Fresh full CI/review remains required.

The first typecheck caught optional approval IDs losing narrowing in transaction
callbacks; capturing them before the callback fixes it. Two new fault/transaction
cases initially waited for idle before advancing their next fake-clock retry.
They now advance time while waiting for the authoritative outcome, and the full
selection passes. These are fixture corrections, not permission to clear an
unresolved work hold.

The ten-minute policy is unchanged. Active provider execution, unknown external
outcomes, and other worker obligations still prevent unsafe sleep. No Cloud
eligibility or external-alarm coverage changes here. Worker quiet is not evidence
of whole-instance or database suspension.

## Sequential-write cost correction (October 27)

Review found that sequential tenant writes could each request a global
interruption pass, even when no execution was stale. A real-SQL regression
created ten tool review requests through the gateway and allowed each preceding
pass to finish. It measured 11 stale-claim scans including startup. Concurrent
notification coalescing alone did not cover this sequence.

The worker now uses the existing deadline helper's 30-second notification
coalescing window, matching the former default maintenance cadence. The same
regression measures one startup scan and one follow-up scan for those ten
requests, then no worker SQL through an additional idle hour. A loaded stale
claim deadline only 500 milliseconds away still preempts the window and
quarantines the unknown outcome without invoking the provider. Foreground
execution and result settlement remain immediate. Newly discovered work can
wait up to this window; the ten-minute stale-claim policy is unchanged.

This is the bounded-frequency alternative raised in review. Discovery is still
instance-wide, and real stale backlogs still drain through the existing pages.
It does not claim company-isolated scans or constant cost for a real backlog.
No notification and no saved execution deadline means no periodic scan. No new
table, index, or scheduler is added. Startup, drain, retry and shutdown retain
the existing owners.

The first full verification passed 175 cases and failed three fake-clock waits:
settlement writes leave a notification pending for its coalesced follow-up, so
waiting for the idle hold without advancing that armed deadline cannot finish.
An initial shared clock adjustment then advanced an unrelated five-second
expiry test too far (177 passed, one failed). The adjustment is now confined to
the interruption tests. It lets real SQL finish and advances only to an actually
armed short follow-up. The imminent-deadline test checks quarantine before that
30-second window and separately waits for eventual quiet. Product assertions
were retained.

The final complete gateway-service and startup-wiring suites pass all 178 cases
without skips, and server typechecking passes, on owner source based on
`e255d8eff3363cf0bb63541bdc7ef055d4321f83`. The attempted third test selector
`deadline-work.test.ts` did not exist at this owner; no separate helper-suite
pass is claimed. The shared helper is exercised by the full gateway suites.
Fresh combined-source checks and remote review remain required.
