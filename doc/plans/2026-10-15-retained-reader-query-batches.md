# Bound retained-reader authorization database work

## Measured problem

A synthetic local service fixture uses 383 workspace paths and 64 retained runs
with the same agent and responsible user. It exercises the production publication
guard against disposable PostgreSQL. It does not represent a live tenant or a
Product E2E evaluation.

The original guard made 1,431 queries. A declared 4ms round-trip delay in a
loopback proxy increased one admission to 15.19 seconds and three concurrent
admissions to 54.69 seconds. The company root fence serializes those admissions.
With this change, one admission makes 680 queries and takes 7.13 seconds under
the same proxy; three take 20.93 seconds. The zero-injected-delay samples took
359ms before and 146ms after. Timing samples are controlled local evidence, not
an agent-response or hosted latency guarantee.

## Change boundary

Retained readers still need individual saved-run identity and execution-policy
checks. Current readers still need the existing write checks. Existing company
root fences, row locks, source privacy and publication ordering stay in place.

Batch retained-reader project reads through the existing multi-actor read API.
Share only database read promises within one call. Keep actor-supplied membership
snapshots and per-actor privacy results separate. Key raw reads by their company,
principal and run as applicable. Each later call reads current grants again.
Select only the run identity and saved policy fields needed by the guard,
including both native and legacy issue-binding fallbacks.

## Verification and remaining proof

The query-count regression must fail on the original code without changing its
800-query bound. Distinct reader identities and stored policies must still fail
closed. Grant revocation must affect the next call. Supplied membership snapshots
must match individual decisions in both actor orders without leaking into database
snapshots. Run the complete affected authorization and source-trust suites.

Full repository typecheck and build plus fresh current-head CI and review precede
merge. A real hosted warm agent reply remains the acceptance test for the separate
under-30-second objective. Neither this service benchmark nor a fresh local
provider run establishes that hosted result.
