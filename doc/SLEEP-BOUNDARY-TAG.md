# Sleep-boundary run tagging

## What it does

The Paperclip server runs a process-wide `SleepBoundaryTracker` that samples the
wall clock on a 10s cadence and records any sample whose elapsed wall-clock time
exceeds the expected interval by more than 30s. That divergence is a reliable
signal that the host process was suspended -- typically a macOS deep sleep
(`Sleep -> Wake`) but the same technique catches Linux suspend-to-RAM and
similar OS-level pauses.

When a heartbeat run reaches a terminal status (`succeeded` / `failed` /
`timed_out` / `cancelled`), `setRunStatus` queries the tracker for sleep
boundaries that overlap the run's wall-clock window. If any boundary overlaps,
the run row is stamped with `sleepBoundaryCrossed = true` (column
`heartbeat_runs.sleep_boundary_crossed`).

The flag also propagates through:

* `GET /api/heartbeat-runs/:runId`
* `GET /api/companies/:companyId/heartbeat-runs`
* The dashboard run-activity series (`runActivity[].sleepBoundaryFailed`)
* The agent run ledger / activity charts in the UI

## Why it matters

A heartbeat run whose process spent the bulk of its wall-clock minutes
suspended is **not** a real failure -- it is an environmental glitch (laptop
lid closed, host sleep, etc.). Failure dashboards that don't distinguish these
make it look like the agents are crashing.

For example, in `LEV-99` Eliot's run `011092e7` sat 81 minutes between
`run registered` and the first stdout byte because macOS went into deep sleep
during the 3s DarkWake window after Paperclip spawned the child. Without the
sleep-boundary tag, that run looked like a Codex crash. With the tag, the
dashboard reports "1 sleep-stranded" alongside the failure count.

## Surface area

* Database column `heartbeat_runs.sleep_boundary_crossed` (boolean, default
  `false`, NOT NULL). Migration `0073_run_sleep_boundary_crossed`.
* `HeartbeatRun.sleepBoundaryCrossed` in `@paperclipai/shared`.
* `DashboardRunActivityDay.sleepBoundaryFailed` (subset of `failed` in the
  dashboard summary endpoint -- counts runs whose `status` is `failed` or
  `timed_out` and which crossed a sleep boundary; cancelled tagged runs are
  intentionally excluded since they aggregate into `other`, not `failed`,
  and the metric exists to de-noise the failure bucket).
* Structured warn-level log line `heartbeat run wall-clock spans a host sleep
  boundary; tagged sleepBoundaryCrossed=true` on each tagged finalization.
* Structured warn-level log line `heartbeat run started inside DarkWake window
  (host just woke from sleep)` when a run's process starts within 5s of a
  detected wake -- this lets us quantify how often the LEV-102 dispatch race
  fires and informs whether option 2 (defer dispatch during deep sleep) is
  worth building.

## Operational notes

* The tracker is started from `server/src/index.ts` only when
  `config.heartbeatSchedulerEnabled` is true. Worker processes that don't run
  the scheduler don't burn a timer on it.
* Detection is platform-agnostic: timer skew works on macOS, Linux, and
  Windows. We did not pull in a native macOS-only `pmset`/IOKit hook.
* The default thresholds (10s interval, 30s skew, 5s wake window) are
  conservative -- they should never fire under normal jitter and only react to
  multi-second host suspension events.
* The tracker keeps the most recent 256 boundaries in-memory. That is plenty
  for tagging finalizing runs (which always finalize within the buffer
  window) but is not a long-term audit log -- structured log lines are the
  durable record.

## Out of scope (for now)

* **Defer dispatch during deep sleep** (LEV-102 option 2) -- a board-facing
  decision. The tag here is the lower-risk additive change.
* **Cross-host correlation** -- if Paperclip is ever moved off Jason's local
  laptop, we'd want to record the host identity alongside the boundary so
  multi-host fleets can attribute sleeps to a specific machine.
