# Routine schedules without the heartbeat poll

## Scope and baseline

This is slice 61 of the recurring-server migration stack. Its parent is
`026fdef06a377f059fdb14bc80da1e906067bbb5` (PR #17836). Inspected
`origin/master` at `0cb3fc7db591ba23e21fbbc70042bc44ec7d6f20`; the routine owner
and schedule registrar have no newer upstream changes. The broader stack still
needs master reconciliation and remote acceptance.

A heartbeat used to wake the routine worker on every tick. The worker therefore
queried schedules even when no routine owed work. It already registered future
deadlines, but its query excluded overdue rows. A capped catch-up batch could
leave more ticks due and depend on the next heartbeat to find them.

This slice removes only that routine wake. Issue monitors, legacy agent timers,
other heartbeat duties, and the rest of the inventory remain separate work.

## Obligation and owner

- Trigger: startup/resume, an eligible cron deadline, or a committed producer change.
- Durable truth: the existing routine, trigger, and company rows. No new table.
- Eligibility: schedule triggers that are enabled, not archived, have saved cron,
  timezone and next-run values, and belong to an active routine in an active
  company. Trigger/routine company IDs must agree.
- Next deadline: the earliest eligible saved next-run timestamp, including overdue
  timestamps left by capped catch-up. The owner returns a number or null.
- Retry: the configured heartbeat interval only after an error or while overdue
  work remains. Successfully read future deadlines retain their exact timestamp.
- Disarm: no eligible schedule and no unresolved producer notification.

`routineService` owns eligibility, database reads and cron dispatch. Its due and
next-deadline queries share the same eligibility predicate. The existing
`registerDeadlineWork` helper owns request generations, retries and lifecycle
behavior. The schedule registrar delegates to it. Its coordinator argument type
now requires only `register`, the only operation that helper uses; other consumers
keep the same runtime behavior. Server startup supplies the owner callbacks and
admission gate, then tracks readiness and shutdown through the existing owner.

The next-deadline read orders by `next_run_at` and returns one row. The schema
already has `routine_triggers_next_run_idx`. The existing due dispatcher is not
redesigned or replaced with a new queue.

## Producer audit

| Writer | Wake coverage |
| --- | --- |
| Routine create/update, including status | Existing transaction-aware routine signal |
| Trigger create/update/delete | Existing transaction-aware routine signal |
| Revision restore and recreated triggers | Existing transaction-aware routine signal |
| Company import and built-in routines | Use routine-service create/update/trigger APIs; separate direct writes change metadata only |
| Manual run naming a schedule | New signal before the transaction changes its next-run timestamp |
| Company pause/reactivation/archive | New signal in the existing company transaction |
| Budget-induced company pause/resume | New signal in the existing accounting transaction |
| Company deletion | New signal before deleting routine data in the company transaction |
| Scheduler's claimed next-run update | Worker reloads after its own pass; no self-notification per catch-up run |
| Folder moves, revision pointers, webhook secret/delivery metadata | Do not change schedule eligibility or deadlines |

Ordinary API, MCP, plugin and import callers use these owning services. The Grok
bot uses a different table and has its own migration. Company name/prefix repairs,
budget projections, issue counters and feedback settings do not change company
status. Process-local signals do not support an independent SQL writer or another
replica that bypasses these producers.

## Preserved behavior and explicit differences

Cron/timezone calculation, sub-hourly coalescing, the 25-run catch-up cap,
compare-and-set claims, activity gates, concurrency policies and suppressed-run
records stay with the existing dispatcher. Capped overdue work gets a retained
retry instead of becoming invisible. A paused company now matches the active
company eligibility already used by the old deadline query; due triggers remain
saved until company reactivation. Routine reactivation still uses its existing
next-cron reset policy.

Project pause and worktree execution suppression still advance cron ticks and
record skipped runs. Those configured ticks remain real timed obligations. This
slice does not claim those cases require zero SQL forever.

Drain/shutdown can stop between trigger candidates. Once a trigger's next-run
value is claimed, its admitted batch finishes; interrupting midway would abandon
runs whose timestamp was already advanced. Unclaimed trigger rows remain durable
for resume or restart. The shared coordinator joins in-flight work and cancels
subscriptions/deadlines on shutdown.

Notifications attach to outer transaction settlement. Nested savepoint release
is not commit. Rollback removes the intent, and changes during a sweep retain a
new generation. Drain keeps deferred requests in memory without passive SQL.
Startup reconstructs the actual next deadline from the database.

## Verification and observed failures

The initial regression run failed both intended assertions: a 27-tick hourly
backlog lost its deadline after the first 25 runs, and company pause left the
old deadline armed. Both pass after the migration. Two additional budget tests
reproduced missing pause/resume notifications before the budget producer fix.

The new integration suite checks no resources, an active routine with no trigger,
future configured work, retained run history, first producer, earlier replacement,
disable/archive/delete/restore, outer commit/rollback, manual invocation, company
lifecycle, budget lifecycle, restart catch-up, drain/resume, failed deadline reads,
concurrent mutation during a read, and interruption between claimed batches.
Quiet assertions observe database select/execute/transaction calls over former
poll periods. Existing cron, project pause, activity gate and coalescing tests
remain in the full owner acceptance set. Startup tests assert that the routine
worker's wake is not called by the recurring heartbeat.

Harness failures are retained separately from product regressions:
- The company-deletion fixture initially lacked a running agent lifecycle driver.
  Its deletion case now seeds completed termination before exercising the real
  company deletion transaction; it does not mock deletion or weaken its guard.
- A drain test incorrectly required all tracked intent work to end before resume.
  It now tests passive SQL quiet during drain and waits for settlement after resume.
- The SQL-query fixture called a retry-backed worker again before its retained
  backoff elapsed. It now advances the test clock before the second pass.
- Embedded company-test PostgreSQL startup timed out. The same suite now supports
  the validated external `_test` URL, applies migrations, and closes its client.
- The previous disposable external cluster subsequently lost `global/pg_filenode.map`.
  That attempted budget regression did not reach assertions. A new loopback-only
  disposable PostgreSQL 17 cluster and separate databases run the same suites.
  No additional IPC cleanup was performed. The cause of the missing file is unproven.

Final local acceptance: all 224 tests in eight complete suites passed, workspace
`pnpm -r typecheck` passed, and the full `pnpm build` passed. Those commands ran
against the final uncommitted source on parent `026fdef06a`; the build stamp names
that parent, not a clean parent-only build. The publication commit adds this audit
and ledger text without further source changes. Full local `test:run` was not
repeated because of the embedded PostgreSQL startup/capacity problem. Remote CI
and review are separate gates and remain pending at publication.

## Sleep boundary and remaining work

This establishes routine-worker quiet between obligations. It does not establish
provider suspension, database suspension, fleet savings, or new Cloud alarm
coverage. The existing durable routine/issue-monitor idle proof and admission
fencing remain unchanged. In-process `nextWakeAt()` is not a universal external
alarm registration API. Unknown or invalid durable schedule states keep their
existing conservative host-sleep proof.

The next distinct scheduling duty is issue-monitor/legacy-agent-timer polling.
Its suppression and producer coverage need their own audit before removing
`scheduled.timers.wake()`. GitHub event/continuity polling, merged-PR confirmation,
external-object refresh, status cards, skill/native-harness retention, and other
heartbeat leftovers remain in the original inventory.

## October 29 master reconciliation and current acceptance

This existing slice is being reconciled through the backup parent #17836 and its
merged prerequisites. Normal merges preserve the routine worker, its predicate,
producer hooks and all existing test assertions. The package tree remains the
qualified profile-80 parent tree. Final publication must adopt the actual merged
backup parent; local preparation on its accepted source is not a review pass.

Current source `4659ef76d398193b15e7812d4a97f3da3b743226` has **417 passing
unique cases across 14 complete files**, without skips: routine deadline work,
scheduled work and its PostgreSQL queries, routine service, routine HTTP E2E and
routes, plugin-managed routines, budgets, companies, git workspace expiration,
agent-device login, startup registration, scoped deadline work and the shared
delivery coordinator. Database build, production server typechecking and build,
module boundaries, target migration order and Runner profile identity pass.

The initial combined run passed 416 cases and timed out in the UUID routine HTTP
authorization case at its existing 20-second limit. A fresh complete affected
13-case E2E file passed in 13.92 seconds; that case completed in 425 ms. A sanitized
PostgreSQL wait-state observer completed without errors. No test assertion,
timeout or production source changed for that diagnostic, and the cause of the
initial timeout is not claimed as established. The initial failure remains in
the acceptance record rather than being described as an uninterrupted green run.

Six fresh PostgreSQL 17 schemas and fresh helper-owned per-file databases applied
all 412 migration journal entries through index 413. Temporary local fixture
imports allowed those existing assertions to run against the owned external
PostgreSQL process; every selected source hash and import was restored exactly.
The worker tests retain their direct zero-select/execute/transaction assertions
through multiple former polling periods and real committed-producer reactivation,
outer commit/rollback, pause/resume, catch-up, restart, drain and retry coverage.

This is bounded local source acceptance, not a full repository-suite pass,
measured instance/database suspension, external alarm delivery or fleet savings.
Independent writers and replicas still require their own supported notification
contract. The final published head needs fresh CI, security and review gates.
