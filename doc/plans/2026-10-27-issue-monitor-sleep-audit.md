# Issue monitor deadline migration

Parent: slice 61, PR #17840, `68339f4162f26f5e12df0848d92f2ed62af8841f`.
Fresh remote master: `0cb3fc7db591ba23e21fbbc70042bc44ec7d6f20`.

This slice owns only issue-monitor scheduling. Legacy agent interval policy stays
on the existing heartbeat cadence for its own subsequent slice. Manual combined
`tickTimers` behavior must remain compatible. No Cloud sleep proof is relaxed.

Truth is already in issues: monitorNextCheckAt, monitorWakeRequestedAt, assignee,
status, and execution policy. Native runs and finalization phase suppress a new
monitor while the prior native owner remains active or unfinished. The scheduling
module keeps dispatch authorization, exact-claim CAS, quota recovery, attempt
limits, diagnostics, and monitor consumption. Index wiring selects workers only.

The next deadline must include already-due work left by the 50-item pass and a
claim's five-minute stale threshold (including its strict comparison boundary).
Failed/deferred dispatch keeps concrete due debt with the shared deadline worker's
bounded retry. Empty/history-only state becomes unscheduled. Suppressed work must
reactivate through settings and lifecycle notifications, including after drain.

Producer audit: issue service create/update, native set_task_monitor, native
preserved-monitor decisions, scheduler manual/automatic claim/release/consumption,
issue lifecycle state, company pause/reactivation/budget transitions/deletion, and
native run/finalization changes. Import deliberately leaves monitor deadlines null
until explicitly activated. Existing native projection and issue review-state
notification boundaries already cover their corresponding transition owners.
Signals must precede writes in the committing transaction; filesystem/provider
work must stay outside those transactions. Process-local writer coverage does not
claim support for unrelated SQL writers or another server replica.

Acceptance must measure quiet SQL, first real producer, future and stale-claim
boundaries, capped overdue work, deferred/error retry, manual compatibility,
outer commit/rollback, native settlement reactivation, company pause/resume,
startup/restart, drain/standby, and shutdown. Existing monitor/admission integration
coverage remains required. This audit is a plan, not evidence of completion.

## Implemented boundary

`createHeartbeatScheduling` now exposes `tickIssueMonitors` and
`nextIssueMonitorAt`. It also exposes `tickAgentTimers`. The public `tickTimers`
method still combines both for existing manual callers. `registerScheduledWork`
uses the existing deadline worker for monitors and a separate coordinator topic
for legacy agent ticks. The heartbeat interval only wakes the latter.

The monitor query includes overdue work, including a capped pass's remainder.
Its deadline is the greater of the saved deadline and the claim timestamp plus
five minutes plus one millisecond. The extra millisecond matches the existing
strict stale-claim comparison. A native queued/running/retry owner or unfinished
native finalization excludes the monitor until a state change wakes inspection.

The worker uses the configured heartbeat interval as a minimum retry spacing
while overdue debt remains. The spacing applies to the monitor worker, so new
notifications during that backoff do not start another immediate scan. Future
saved deadlines run directly when no overdue retry is pending. State-change
bursts use a coalescing window equal to the configured heartbeat interval. No per-monitor
queue, new table, independent timer, or shared scheduler modification was added.

## Producer coverage

| Owning path | Notification boundary |
| --- | --- |
| Issue create/update | Existing monitor intent before the issue write |
| Native `set_task_monitor`; preserved-monitor decisions | Existing monitor intent before the issue write |
| Manual/automatic claim, release, diagnostic fallback, consumption | Added intent in the existing or short write transaction; provider admission remains outside it |
| Issue checkout and stale checkout adoption | Added a short transaction around the existing CAS and intent; captured the expected execution ID before entering the callback |
| Issue removal, release, and force release | Added intent in the existing transaction |
| Tree restoration, member reassignment, agent deletion | Added intent before changing monitor eligibility |
| Agent conversation activation/settlement and external conversation settlement | Added intent before direct issue status writes |
| Workspace reconstruction and execution-recovery blocking | Added intent before changing eligibility |
| Native projection/finalization and issue review transitions | Extended existing notification fanout; no service invocation inside the notifier |
| Execution-control recovery writes and active-run watchdog folding | Extended transaction notifications because these can release native ownership |
| Company status/deletion/budget changes | Added monitor topic beside existing schedule notifications |
| Worktree execution suppression setting | Existing native projection notification now also wakes monitor inspection |

The next-deadline predicate deliberately has the same issue/company/native-owner
eligibility as the existing due-monitor query. Admission still owns authorization,
quota behavior, exact claim guards, current assignment, and client-error handling.
An abort or drain observed after a claim leaves that claim durable for later stale
claim recovery. It does not dispatch new work after that lifecycle check fails.

## Verification on the slice

- Baseline: existing monitor admission and scheduled-work suites, 25 passed.
- Final combined run: eight complete suites, 219 passed, no skipped tests. The
  suites were `heartbeat/scheduling`, `scheduled-work`, `scheduled-work-postgres`,
  `routine-schedule-work`, `issue-monitor-scheduler`, `server-startup-feedback-export`,
  `execution-control-work`, and `native-run-projection-work`.
- Six isolated external PostgreSQL 17 databases had all 403 migrations applied.
  This avoids treating unavailable embedded-Postgres suites as passing evidence.
- New lifecycle cases verify zero worker select/execute/transaction calls over
  multiple old poll periods after settlement, with completed monitor history
  retained. They also verify the first ordinary issue producer, nested outer
  commit/rollback, first work during drain, deferred admission, stale claims,
  pause/resume, checkout reactivation, earlier deadline/cancellation, and a
  51-monitor backlog that needs a second bounded pass.
- Native finalization integration verifies that a dormant monitor worker wakes
  when workspace settlement finishes and applies an expired monitor's existing
  recovery policy without another provider turn. Existing manual and combined
  scheduler cases still pass. The assembled heartbeat test exercises the new
  monitor-specific entry point and its persisted wake/admission result.
- The lifecycle fixture waits for both finished reconciliation and no remaining
  deadline before measuring quiet. Rollback may first require XID reconciliation;
  drain may retain an intent hold until resume. Neither is counted as quiet
  completion before the shared protocol actually finishes.
- `pnpm -r typecheck` passed. The server package build passed. `git diff --check`
  passed. Repository-wide tests/build and live provider sleep qualification have
  not been completed for this slice; the PR's CI gates remain separate evidence.

## Limits and next duty

The supported writers share one server process's database-work scope. Independent
SQL writers and other server replicas need their own ingress/reconciliation
contract. Active events can still cause inspection; the quiet claim concerns an
unchanged subsystem after settlement, not zero queries during active work.

This slice does not prove host or database suspension. Cloud's existing durable
routine/monitor alarm proof remains unchanged. Legacy agent interval policy and
other remaining recurring duties still run. Migrate the legacy agent timer as
its own slice, preserving due claims, worktree cutoff, eligibility, and budgets.

## Review corrections

The original lifecycle fixture covered idle drain but missed ordinary maintenance
drain. Monitor registration now checks all task drains through the existing
admission owner. The shared deadline worker retains an unfinished request if
admission closes during either the run or the deadline read. It clears the old
local deadline in that state, so a past deadline cannot create an immediate spin;
a bounded in-memory retry remains. Explicit stop and TTL expiry restore dispatch.
Other deadline-worker consumers keep their existing admission predicates.

Ordinary issue and execution-control writes can wake this queue. Their global
scans are now bounded by the configured heartbeat interval instead of one second.
Known saved deadlines still preempt that batching window. New notifications can
therefore take up to one interval to be inspected, matching the previous polling
latency. This does not add a periodic scan after the queue settles.

New tests reproduce both findings before the fix. They cover mid-run and
mid-read drain transitions, ordinary drain stop/expiry, repeated notification
traffic, and repeated real checkout/release transactions. Integration fixtures
advance the scheduler clock between real I/O completions and disable driver
socket timers in that fixture; DB disconnect/reconnect has separate tests. The
operator writer contract is in [idle-issue-monitors.md](../idle-issue-monitors.md).

Validation after review: eight complete suites passed (211 tests). The routine
suite initially had five failures because its unused monitor stub retained the
new batching deadline. That fixture now registers only the real routine worker;
all 17 routine tests pass separately. An intermediate test setup used a worker
stop method that is not exposed; it was removed before final verification. The
combined affected coverage is 228 passing tests, with no skips in the final
complete suite results. Server typechecking and build pass. These are local
results; current-head CI and remaining reviews are separate gates.

## October 29 master reconciliation and current acceptance

This existing issue-monitor slice was reconciled with the accepted routine parent
and its landed prerequisites through ordinary merges. Two conflicts required
explicit composition: monitor consumption keeps its new transaction and intent
while preserving master's `triggered` result after an already-admitted check loses
the replacement consumption fence; issue deletion keeps the scoped decision-target
removal notifier together with the new monitor intent. All remaining paths match
the automatic merge, and the package tree is identical to the qualified parent.

Current source `c24aadfc91e9394d73c799f9e05fc67202160557` passed **1,233 cases
in 35 complete files**, without skips, in 458.16 seconds. Coverage includes
heartbeat scheduling and monitor admission, scheduled deadline queries, retained
routine lifecycles, native monitor preservation and run projection, execution
control, issue and tree services, conversation producers, budget/company changes,
startup, and the shared deadline helper's plugin, credential expiry, tool review,
decision, retention, custom-image and Grok consumers. Database build, production
server typechecking/build, module boundaries, migration order and Runner profile
identity pass. All selected hashes and temporary external-fixture imports were
restored exactly. Twenty-four fresh PostgreSQL 17 schemas, plus helper-owned
per-file databases, applied all 412 journal entries through index 413.

The old remote head's CI failures are preserved separately from current acceptance.
Its delegated Slack rate assertion admitted an unexpected second send. A minute
boundary is consistent with the old live-clock fixture; the precise historical
cause is not established. The inherited parent fixture now freezes Date for all
rate variants, retaining the same denial and send-count assertions, and is byte
identical to merged #17835. The old Runner fixture also failed its initial
provider-drain deadline, before its deliberate timeout stage. Current packages
are byte identical to merged #17835's qualified profile-80 tree. These inherited
changes and local passes do not waive fresh final-head CI or security gates.

The final routine-parent publication changed only its audit; all production trees
and these 35 test hashes remain identical to accepted source. Publication still
requires adopting the actual merged routine squash and new exact-head review.
No full local repository-suite, live provider, external alarm delivery, measured
instance/database suspension, production load or fleet cost claim is made.
