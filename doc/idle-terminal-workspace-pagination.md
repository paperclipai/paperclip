# Terminal workspace scan and retry deadline precision

Terminal workspace maintenance already uses the shared delivery coordinator and
retains deadlines only for outstanding work. Its bounded scan must progress past
ineligible rows so that later eligible work can finish and the worker can park.

The source query orders candidates by `(updated_at, id)`. PostgreSQL timestamps
can contain microseconds. The former cursor used a JavaScript Date, which loses
that precision. A skipped row could then compare greater than its own rounded
cursor. Repeated full pages kept recovery active and prevented later cleanup.

The query now carries the database timestamp as text alongside each workspace.
Only the private scan cursor uses that value. Workspace data, business deadlines,
and the frozen rotation boundary keep their existing types and behavior. The
cursor comparison uses the same timestamp/ID tuple as the ordering. The source
service continues to own cleanup eligibility, authorization, concurrency fences,
page limits, abort handling, failed-page recovery, and rotation under churn.
No scheduler API, queue, migration, producer signal, or external alarm changes.

## Verification

The existing full-page starvation regression now gives its skipped rows actual
PostgreSQL microsecond timestamps. Before the repair, the eligible workspace was
never archived. After the repair, the full workspace service and terminal worker
selection passes all 87 tests, including bounded rotation under continuous churn,
changed rows behind the cursor, failed-page recovery, quiet workers, and shutdown.
The service suite accepts the repository's validated disposable external
PostgreSQL URL. Setup applies pending migrations before opening the test client,
then clears fixture tables before the first test as well as after each test. This
supports a fresh database and reuse after an interrupted test run. The database
connection closes during teardown. Server typechecking passes.

This fixes recovery progress. It does not establish provider suspension or change
which active or unresolved resources prevent instance sleep.

Workspace-wide typechecking and the production build also pass. Full sharded CI
and fresh review remain required before this PR is ready.

Review follow-up reproduced the missing-schema failure against a newly created,
unmigrated disposable database. The setup repair migrates that same database
inside the suite; the full workspace-service selection then runs without manual
schema preparation. The production cursor implementation is unchanged.

## Preserve one retry deadline through early inspection

Nested-clone migration and isolated-source rehoming kept a retry guard and a
separate advertised scheduler deadline. Each value called the clock separately.
When the clock advanced between those calls, an early inspection copied the
earlier guard back into the advertised deadline. CI observed a one-millisecond
backward change in an otherwise unchanged retry.

Each path now computes one retry timestamp and stores that value in all of its
retry and scheduling state. The cadence, cleanup eligibility, quiet conditions,
rotation, and wake contract do not change. No new timer, queue, or table is added.

The existing nested-clone regression and the isolated-rehome dry-run case now
use a clock that advances one millisecond per read. Both failed before the fix
with the same one-millisecond drift. Both exact-deadline assertions remain. The
complete migration suites passed all 49 cases afterward, using real PostgreSQL
and Git, including preserved files/history and interrupted migration recovery.
The complete workspace-service and terminal-worker suites passed another 87
cases; server typechecking passed. The two focused pre-fix failures used a name
filter intentionally; the reported final 136 cases are four complete suites
without skips. Validated external test database hooks keep each migration suite
on its own disposable database and retain the existing embedded fixture fallback.

These are local correctness and scheduling results, not deployed host-sleep or
external-wake proof. Remote acceptance must be checked at the published head.

## External fixture migrations (October 26 review repair)

Review found that the two migration suites opened external test databases without
applying migrations. The previous verification used prepared databases, which
hid this setup gap. Both selected retry cases failed against new empty disposable
databases with missing `companies` and restore-point tables. Setup now applies
pending migrations before creating its test client, matching the workspace
service fixture. The embedded path is unchanged.

All 49 cases in the two complete suites then passed against those same databases,
including Git/filesystem migration, recovery, and exact retry-deadline checks.
The fixture itself prepared the databases. This repair changes no production
recovery code. Evidence: `/tmp/sleep-workspace-fresh-red.log` and
`/tmp/sleep-workspace-fresh-green.log`.


## Current parent verification

Approval-retention parent `3efda33812` is integrated with normal merges. All
workspace precision, retry and fixture implementations remain unchanged from the
preceding candidate. All 136 cases in the complete workspace-service, terminal
worker, isolated-rehome and nested-clone suites pass at `9d846c84e7`; server types
and production build pass with the current Runner vendor.

The preceding `f0f0de1f6f` run also passed all 136 cases with three newly created,
unmigrated external databases: the suites themselves applied the current
migrations. The `9d846c84e7` run reused those clean fixtures after the parent's
approval wake repair. This retains actual proof of fixture self-preparation
without mislabeling the reused run as a fresh-database test. No new migration,
queue, wake contract or workspace policy change is added by this PR.

Earlier microsecond starvation, one-millisecond retry drift and missing-schema
failures remain documented above. Fresh exact-head CI and both 5/5 reviews remain
required in stack order; the parent is not claimed merged.
