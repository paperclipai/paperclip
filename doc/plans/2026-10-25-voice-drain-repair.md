# Voice recovery drain repair

Owner: slice 21, PR #17576. Reviewed baseline: 1bf70185d2.

Greptile finding 4370544173 is valid. The worker retained dirty scopes while
paused, and reported those in-memory hints as pending work. After the producer
committed, the coordinator therefore retained its intent activity hold. No SQL
was required to reproduce the blocked drain; the earlier quiet assertion checked
SQL only and missed the nonzero idle counter.

The worker now reports pending dirty scopes only while dispatch is permitted.
It still retains every hint and next deadline. The coordinator independently
checks databaseWorkPending, so an open/uncertain transaction retains its activity
hold until transaction reconciliation establishes settlement. Paused timers then
use the existing passive-maintenance path without changing the idle generation.
Resume processes the retained first session without another producer signal.
No provider behavior or external sleep eligibility rule changes.

The strengthened real-PostgreSQL test proves: an open write during drain retains
an activity hold; commit releases it; a further minute causes neither SQL nor
an idle-snapshot change; resume processes the one retained session exactly once.

- /tmp/sleep21-drain-before.log: original worker fails, active is 1 instead of 0.
- /tmp/sleep21-drain-tests.log: all 11 voice recovery lifecycle tests pass.
- /tmp/sleep21-drain-typecheck.log: production server typecheck passes.
- Dedicated migrated database: paperclip_sleep21_drain_20261025_test.

Propagate this predicate into slice 22's extracted scoped-deadline worker and
all descendants, then rerun its existing consumers. The earlier tool-health,
Discord command, and receiver workers have the same predicate pattern; audit
and repair those at their own parent PRs as a separate propagation pass. Do not
report all stack drain behavior fixed from the voice test alone. The company
inbound cleanup/deletion policy, older E2E failure, current chat milestone audit,
and full original inventory remain outstanding.


## Shared-worker propagation in slice 22

Slice 22 extracts voice recovery into scoped-deadline-work. The merge keeps that
extraction and applies the predicate in the shared dispatcher, covering both
voice session recovery and reply delivery. The phone-reply drain test now also
checks zero active work and an unchanged idle snapshot during a further minute,
then verifies the saved reply sends on resume without another producer.

- /tmp/sleep22-shared-drain-tests.log: 11 recovery cases pass.
- /tmp/sleep22-shared-drain-acceptance.log: all 108 voice integration cases pass.
- /tmp/sleep22-reply-drain-tests.log: the strengthened reply drain case passes
  on a separate fresh database after the full suite run.
- /tmp/sleep22-shared-drain-typecheck.log: production server types pass.

All later shared-worker consumers inherit this repair through the stack. Their
combined-tip checks and PR checks still need fresh verification after propagation.
