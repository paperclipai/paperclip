# Retained workspace recovery: fill a free slot across the cursor

This is a shared CI repair carried at the sleep-stack root. It fixes the existing
retained-workspace owner; it does not add another background duty or migrate the
remaining run/task recovery inventory. No PR is merged by this repair.

## Failure and ownership

The retained-workspace worker permits two physical exports. A held export stays
in the durable unfinished candidates, even though this process already owns it.
Discovery paginates by recovery-action ID and wraps only when its query returns
no rows. A page containing only a held export was nonempty, but its only row was
skipped in memory. Newly committed work before the cursor therefore waited for
another 15-second recovery pass despite a free slot.

The CI failure at PR #17446, run 40423925338 / job 121925042581, leaves the third
export `scheduled` at the existing 20-second assertion. The older #17450 failure
has the same observable result. A deterministic real-PostgreSQL/filesystem
regression reproduces it by starting the highest action ID, holding its provider
resume, completing a middle action, then requesting the lowest action. The
before-fix test failed at that same third-export assertion.

## Change and preserved boundaries

The existing candidate query accepts the locally in-flight run IDs and excludes
them before pagination on both unfinished and passive discovery paths. The
coordinator reads this set after its existing two-slot guard, so the exclusion
contains at most one run for an admitted discovery pass. An empty page can now
wrap in the same pass and find new work before the cursor. The in-memory duplicate
guard remains to handle changes while a query is running.

The retained-workspace module owns candidate selection. Its callers, SQL source
eligibility, physical ownership lock, retry policy, concurrency limit, completion
callbacks, and shutdown joins retain their existing contracts. Other-process
locks are still handled by the existing bounded cursor rotation. No new timer,
queue, table, provider branch, or retry authority is added. Held work remains
tracked as active and is not treated as settled or safe to sleep through.

## Verification

At the integrated pre-repair tip, the deterministic test failed with `scheduled`
instead of `complete`. After the repair, that regression and the existing
other-worker physical-lock rotation test both pass with real files and database
state. The free-slot test keeps the original 20-second completion bound, verifies
preserved files, no extra agent run, at most two concurrent resume operations,
and shutdown waiting for the held export before its final completion.

At the stack root, all 56 retained-workspace recovery cases pass on a dedicated
migrated PostgreSQL test database. The full suite also exercises retries,
exhaustion, stop verification, cleanup authorization, source bindings and saved
file recovery. Integrated workspace typecheck/build and fresh remote checks must
be recorded in the PR after parent propagation. This is not a full repository or
deployed-sleep claim.
