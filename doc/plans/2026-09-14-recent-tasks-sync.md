# Stop Recent Tasks storage feedback between tabs

## Problem and evidence

Recent Tasks stores five task snapshots in localStorage. Each open tab fetches
the task details and subscribes to storage changes. The persistence effect also
depends on the stored entries. When two query caches disagree about a task,
each storage event makes the receiving tab write its own cached title and status
back to storage. This repeats without new server data.

A live affected tab received 1,084 storage events and 673 same-tab notifications
in three seconds. Detaching only its Recent Tasks listeners reduced its renderer
CPU from about 90% to about 2%. Restoring the listeners restored the high load.
The stored status repeatedly alternated between two values.

## Design

- Store `snapshotUpdatedAt` from the server's task `updatedAt` separately from
  `recordedAt`. Comments can advance activity without changing the task version.
- Accept only a strictly newer, finite snapshot version. Keep the stored
  snapshot for equal versions. Use the same merge rule for persistence and the
  rendered sidebar so stale query data cannot mask a newer stored title/status.
- Run the persistence effect when query results or task membership change.
  Receiving metadata or activity from storage must not publish cached data again.
- Skip storage writes and same-tab notifications when the normalized list is
  unchanged. Keep the five-task limit and the existing activity-order debounce.
- Use a versioned storage namespace. Existing tabs running the old code can
  otherwise undo the version guard. Read the legacy list for initial display,
  then persist it once in an effect. Preserve an empty migrated list too. Leave
  the independent restart-wake retry key unchanged across the upgrade.

The server and API contracts do not change. The list remains scoped to company
and user. This is a local browser cache, not a transactional activity ledger:
simultaneous read-modify-write operations can still race. Avoiding feedback is
essential even when such a race delivers an older snapshot to a newer cache.
Tabs running old code keep their own legacy list until reloaded. Reload every
affected tab after deployment to stop feedback among the old tabs themselves.

## Verification

Regression tests alternate old and new snapshots, mount independent query
caches, and assert that rendering and writes settle. They cover comment activity,
equal and invalid versions, legacy migration, unchanged writes, subsequent query
updates, unavailable tasks, and pending restart retries. Existing sidebar tests
cover rename, archive, task membership, and debounced ordering.

Browser acceptance uses the actual sidebar in two tabs with controlled API and
router fixtures. Check that task names agree after a rename, persist across
reload, and produce no continued storage traffic at rest. Run the focused tests,
token gates, repository typecheck, full Vitest suite, and build before merge.

The browser acceptance run passed. Both tabs displayed the renamed task, and the
stale tab retained it after reload. Each tab then had zero storage writes,
storage events, same-tab notifications, React commits, and detail requests during
a 15-second idle sample. Both consoles had no errors or warnings. This exercised
the real sidebar and browser storage with fixture API data, not a live server
deployment.
