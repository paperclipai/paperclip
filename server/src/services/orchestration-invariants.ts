/**
 * Orchestration invariants for heartbeat scheduling (tasks 007 / 010 family).
 *
 * **HB-007 — Timer without assignment:** `source === "timer"` must not enqueue work when
 * the agent has no issue assigned in a runnable state (`assigneeAgentId` match and status
 * not in backlog / done / cancelled). Rationale: timer prompts are open-ended; without a
 * bounded issue, adapters tend to drift (see `执行/007-心跳调度无issue不触发.md`).
 *
 * **HB-010 — Bare on_demand wake:** `source === "on_demand"` with a non-empty textual
 * `reason` but no resolvable `issueId` (payload / snapshot / resume override) must not
 * enqueue a run. Rationale: reason-only wakes bind no task scope (see `执行/010` §裸唤醒).
 * Legacy empty-body `/heartbeat/invoke` keeps `reason` absent → still allowed to queue.
 *
 * **Closed issue vs running run:** If a run is still `running` while its snapshot `issueId`
 * points at a terminal issue, heartbeat finalizes bookkeeping (see
 * `reconcileRunningRunsForClosedIssues` in heartbeat service): `done` → `succeeded` when the
 * adapter path is gone; `cancelled` → `cancelRun`; skip while executeRun or the child is alive.
 *
 * **HB-043 — Timer vs non-timer backlog:** Scheduled `heartbeat_timer` skips enqueue while the agent
 * still has heavier `heartbeat_runs` (`queued` / `running` / `scheduled_retry` with `invocationSource`
 * other than `timer`) and adjusts `agents.lastHeartbeatAt` so scheduler passes do not spin; see constants
 * below and `heartbeat-timer-yield.ts`.
 */

/** Recorded on `agent_wakeup_requests.reason` when the timer skips — HB-007. */
export const HEARTBEAT_SKIP_TIMER_NO_ASSIGNED_ISSUE = "heartbeat.timer_no_assigned_issue";

/** Recorded when on_demand wake carries text but no issue — HB-010. */
export const HEARTBEAT_SKIP_ON_DEMAND_BARE_WAKE = "heartbeat.on_demand_bare_wake";

/**
 * @deprecated Prefer {@link RUN_FINALIZE_ISSUE_CLOSED_DONE} / {@link RUN_CANCEL_ISSUE_CANCELLED_WHILE_RUNNING}.
 * Kept for activity/log backfill references only.
 */
export const RUN_CANCEL_ISSUE_TERMINAL_WHILE_RUNNING =
  "事务已进入终态，但运行仍标记为进行中；为对账已取消本运行。";

/** Recorded in run stop metadata when a done issue is reconciled to succeeded. */
export const RUN_FINALIZE_ISSUE_CLOSED_DONE =
  "事务已标记完成；控制面按关单语义将本运行结案（适配器未自行退出或进程已结束）。";

/** Cancel reason when the issue was cancelled while the run was still running. */
export const RUN_CANCEL_ISSUE_CANCELLED_WHILE_RUNNING =
  "事务已取消，本运行已停止。";

/** Skip reason on `agent_wakeup_requests.reason` — HB-043. */
export const HEARTBEAT_SKIP_TIMER_NON_TIMER_PENDING = "heartbeat.timer_yield_non_timer_pending";

/**
 * Seconds pushed into the next timer eligibility via `agents.lastHeartbeatAt` when yielding.
 * Set `PAPERCLIP_TIMER_YIELD_NON_TIMER_DEFER_SEC=0` to reset the heartbeat clock to “now” (discard round,
 * wait a full interval from this moment instead of a bounded deferral).
 */
export const HEARTBEAT_TIMER_NON_TIMER_PENDING_DEFER_SEC = clampEnvSeconds(
  "PAPERCLIP_TIMER_YIELD_NON_TIMER_DEFER_SEC",
  120,
);

function clampEnvSeconds(label: string, fallback: number): number {
  const raw = typeof process.env[label] === "string" ? process.env[label]?.trim() : "";
  if (!raw || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(Math.min(Math.max(n, 0), 86400)) : fallback;
}
