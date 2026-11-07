# Configuration worker drain repairs

The voice drain audit exposed a pattern in three earlier independent workers:
retained dirty scopes reported as pending work keep the coordinator's intent
activity hold alive after the write has settled. No recurring SQL is necessary
to block idle admission this way. The earlier tests checked traffic but did not
check the idle counter or generation while paused.

Each owner must retain its hints and next deadline for resume, report dirty work
as pending only while dispatch is allowed, and leave unresolved transaction
fencing to the shared coordinator. No hint is acknowledged or discarded during
drain. Business health/registration/lease deadlines and provider behavior stay
unchanged. This is an idle-work boundary repair, not provider sleep qualification.

## Tool health — slice 18 / #17554

Baseline 9ef6e4f4c8 reproduces the bug: the strengthened existing drain case fails
with active=1 after commit, recorded in /tmp/sleep18-drain-before.log. The repaired
case asserts active=0, then a stable idle snapshot and no SQL/provider calls for a
minute, then the saved work runs on resume without another producer.

All 23 lifecycle cases pass in /tmp/sleep18-drain-tests.log; production server
typecheck passes in /tmp/sleep18-drain-typecheck.log. The test database is the
fresh migrated paperclip_sleep18_drain_20261025_test. No test failures were retried
blindly. Current master bf9a8551c3 has no changes to these three worker owners
since the preceding aec86c794b inspection; full stack reconciliation remains open.

Discord command registration and receiver discovery require the same causal
check at their own parents, then propagation through every dependent stack PR.
The full original recurring-work inventory, milestone producer audit, older E2E
failure and inbound cleanup/deletion policy finding remain outstanding.

## Discord command registration — slice 19 / #17557

The strengthened outer-rollback/drain case reproduces active=1 after commit in
/tmp/sleep19-drain-before.log. The repair preserves the dirty scope and saved
deadlines, but reports pending dirty work only while dispatch is allowed. The
shared coordinator still holds unresolved transactions independently.

All 67 registration/store cases pass in /tmp/sleep19-drain-tests.log, including
90 seconds of no SQL/provider calls and an unchanged idle snapshot during drain,
followed by registration on resume without another producer. Production server
typecheck passes in /tmp/sleep19-drain-typecheck.log. These tests use the migrated
paperclip_sleep19_drain_20261025_test database. Remote CI/review must run on the
new head; this is not evidence of provider suspension.

## Receiver discovery — slice 20 / #17572

The strengthened first-receiver drain case fails with active=1 after commit in
/tmp/sleep20-drain-before.log. Apply the same owner-level pending predicate while
retaining all dirty scopes and lease/retry deadlines. All 19 receiver lifecycle
cases pass in /tmp/sleep20-drain-tests.log, including no SQL and an unchanged idle
snapshot for a minute after settlement, then receiver acquisition on resume.
Production server typecheck passes in /tmp/sleep20-drain-typecheck.log. The fresh
migrated database is paperclip_sleep20_drain_20261025_test.

The three configuration owners now have measured drain activity as well as traffic
checks. Their retained timers remain memory-only while paused; they do not provide
external wake coverage. Fresh remote CI/review and downstream propagation remain
required. Origin/master was refreshed to e335265568; the latest change removes
idle task-run UI polling and does not replace these worker repairs.
