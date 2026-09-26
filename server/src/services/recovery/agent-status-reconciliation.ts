/**
 * Watchdog decision for an agent row that claims to be `running` while no
 * execution genuinely holds it.
 *
 * Why this exists
 * --------------
 * `agents.status = "running"` is written at execution start and is only ever
 * cleared by `finalizeAgentStatus` on a run teardown. Nothing else reads it, so
 * any teardown that stops between the run-status write and the agent-status
 * write leaves the row `running` forever: the agent page keeps the live badge
 * and the product has no way to notice besides a human sweep. The
 * late-finalization fix removes the common cause,
 * but a backstop or a crash can still strand the row. This watchdog is the
 * general backstop: reconcile the agent status from observed run state instead
 * of trusting the last write.
 *
 * The decision is deliberately conservative. It only reconciles when:
 * - the agent row is `running` (never touch paused/terminated/pending_approval/
 *   idle/error rows), and
 * - no active run is genuinely live (in-memory handle, native ownership hold,
 *   live controller lease, or a live recorded pid/process group), and
 * - no active run is fresh enough that its execution start is still settling
 *   (a `queued`/`scheduled_retry` row inside the grace window means dispatch is
 *   still in flight and the agent status is legitimately `running`), and
 * - the newest evidence of activity for the agent is older than the grace
 *   window, so a healthy but slow run is never interrupted.
 */

/** Default age after which a `running` agent with no live run is stranded. */
export const DEFAULT_STRANDED_AGENT_STATUS_GRACE_MS = 10 * 60 * 1000;

export type AgentStatusReconciliationRunInput = {
  status: string;
  updatedAt: Date;
  /** True when the run is genuinely live (see `isRunGenuinelyLive`). */
  live: boolean;
};

export type AgentStatusReconciliationInput = {
  agent: {
    status: string;
    lastHeartbeatAt: Date | null;
    updatedAt: Date;
  };
  /** Active (non-terminal) runs for this agent: queued/running/scheduled_retry. */
  activeRuns: AgentStatusReconciliationRunInput[];
  now: Date;
  graceMs: number;
};

export type AgentStatusReconciliationDecision = {
  nextStatus: "idle";
  reason: "no_live_run";
  /** Newest activity timestamp considered, for audit. */
  lastActivityAt: Date;
};

function newest(values: Array<Date | null | undefined>): Date | null {
  let best: Date | null = null;
  for (const value of values) {
    if (!value) continue;
    if (Number.isNaN(value.getTime())) continue;
    if (!best || value.getTime() > best.getTime()) best = value;
  }
  return best;
}

export function decideAgentStatusReconciliation(
  input: AgentStatusReconciliationInput,
): AgentStatusReconciliationDecision | null {
  if (input.agent.status !== "running") return null;

  if (input.activeRuns.some((run) => run.live)) return null;

  const graceMs = Math.max(0, input.graceMs);
  const freshPendingRun = input.activeRuns.some(
    (run) =>
      run.status !== "running" &&
      input.now.getTime() - run.updatedAt.getTime() < graceMs,
  );
  if (freshPendingRun) return null;

  const lastActivityAt =
    newest([
      ...input.activeRuns.map((run) => run.updatedAt),
      input.agent.lastHeartbeatAt,
      input.agent.updatedAt,
    ]) ?? input.agent.updatedAt;

  if (input.now.getTime() - lastActivityAt.getTime() < graceMs) return null;

  return { nextStatus: "idle", reason: "no_live_run", lastActivityAt };
}
