# Agent Runnable Scheduler (JOU-39)

## Rollback

1. Disable the instance experimental flag `enableAgentRunnableScheduler` (Settings → Experimental). With the flag off, wakes resume the legacy path: heartbeat runs are created immediately and `maxConcurrentRuns` alone governs dispatch.
2. Rows already in `agent_wakeup_requests.status = agent_runnable` are not auto-dispatched while the flag is off. After re-enabling, finishing any active run triggers promotion via `startNextQueuedRunForAgent`.
3. To drain without enabling dispatch, reassign affected issues or cancel stale runnable wakes in the database under operator supervision.
4. Revert the application deploy to the previous Paperclip server image if a code rollback is required. No migration is required; `agent_runnable` is a text status value.

## Enable (Journey controlled validation)

1. Set `enableAgentRunnableScheduler: true` on the Journey instance experimental settings.
2. Leave agent `heartbeat.maxConcurrentRuns` unchanged unless parallel execution is explicitly desired; set `heartbeat.allowParallelExecution: true` only for agents that are safe to run multiple issues concurrently.
3. Observe `activity_log` entries with action `agent.scheduler` for enqueue/dequeue reasons and queue depth.

## Canonical runnable work

- **Parked:** `agent_wakeup_requests` with `status = agent_runnable` and `run_id IS NULL`.
- **Dispatchable:** `heartbeat_runs.status = queued` linked through `agent_wakeup_requests.run_id`.
- **Active:** `heartbeat_runs.status = running` counted against per-agent capacity.
