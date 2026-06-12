# Distributed Run Execution

With lease-based scheduler leadership (`doc/scheduler-leadership.md`), one
replica runs the scheduler. Before this feature, that replica also *executed*
every scheduled run — adding replicas scaled HTTP and WebSocket traffic but
added zero agent throughput. Now triggering and executing are split:

- **The leader triggers**: heartbeat ticks, routine triggers, queued-run
  promotion, recovery passes. Unchanged, leader-only.
- **Every replica executes**: an executor loop claims queued runs in batches
  and runs them locally. Scheduled agent throughput scales with replicas.

API-triggered runs are unchanged: they execute on the replica that serves
the request, as before.

## The claim

Executors claim with one atomic statement — `FOR UPDATE SKIP LOCKED` over
`status = 'queued'` ordered by `created_at`, setting `status='running'`,
`claimed_by` (a per-process replica id), `claimed_at`,
`executor_heartbeat_at`, and incrementing `claim_attempts`. Concurrent
executors never serialize on the same rows and can never double-claim.

After claiming, each run passes the same validations the immediate-dispatch
path applies (agent existence, invokability, budget, pause/dependency holds,
staleness). A run that fails a hold-style validation is released back to
`queued` — claim columns cleared, `claim_attempts` kept. Cancel-style
validations follow their existing transitions.

Claims are FIFO across all agents. Per-agent prioritization
(dependency-readiness and issue-priority ranking) still orders the
API/immediate-dispatch path; executor batches deliberately trade that
ordering for an index-friendly claim. Runs whose `claim_attempts` exceeds
the bound (5) are escalated through the existing failure path instead of
being re-queued — a poison run cannot loop forever.

## Execution semantics

At-least-once. A run whose executor dies is reaped and follows the existing
retry/escalation paths; handlers must tolerate re-execution (the run
pipeline's recovery design already assumes this).

- **Executor heartbeats:** every claimed, locally-executing run refreshes
  `executor_heartbeat_at` (~15s) via a process-wide heartbeat loop that
  covers *all* local executions — executor-claimed and API-dispatched alike,
  on every replica regardless of `PAPERCLIP_RUN_EXECUTOR`.
- **Reaping:** the leader's orphan reaper treats runs in two classes. Runs
  claimed by *other* replicas are reaped only when `executor_heartbeat_at`
  is older than 90s (≈ three missed beats plus margin) — never by local
  process checks, which are meaningless across pods. Its *own* and legacy
  (unclaimed) runs keep the original process-aware logic, with a freshness
  guard so a just-claimed run is never reaped in the window before its
  in-memory tracking appears.
- **Graceful drain:** on shutdown the executor stops claiming, waits up to
  20s for in-flight runs, then releases the rest back to `queued` — the
  reaper is only the crash path. Draining happens *before* leadership
  resign, so a departing leader hands over a queue that already reflects
  its releases.

## Configuration

| Env | Meaning |
|---|---|
| `PAPERCLIP_RUN_EXECUTOR` (default true) | Set `false` for replicas that must serve traffic but never execute scheduled runs. |
| `HEARTBEAT_SCHEDULER_ENABLED` (default true) | Scheduler-leadership candidacy (see `doc/scheduler-leadership.md`); independent of executing. |

Executor defaults: 5 concurrent runs per replica, 2s claim cadence
(jittered), 20s drain budget.

## Workspace affinity

Execution workspaces store local filesystem paths and carry no host binding
today, so cross-replica affinity cannot be derived from data. The claim path
exposes a `canExecuteRunHere` seam (default: everything is claimable) as the
hook for future host-bound workspace support; sandbox-execution runs are
pod-independent by construction.
