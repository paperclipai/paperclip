/**
 * Evaluates agent run health from a flat list of heartbeat runs.
 *
 * WHY: heartbeat.list() orders by desc(createdAt) and truncates to a limit.
 * Under maxConcurrentRuns=1, a long-running slot-holder has the oldest createdAt
 * and therefore falls out of any small-N window, leaving only the queued backlog
 * visible. The naive "top-5 are all queued → starved" conclusion is a false positive.
 * This evaluator corrects that by checking for a running or recently-succeeded run
 * across the full provided window regardless of createdAt ordering.
 */

export type AgentRunHealthInput = {
  id: string;
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
};

export type AgentRunHealthSignal =
  | {
      kind: "slot-held";
      runId: string;
      /** How long the slot-holder has been running, in milliseconds. */
      ageMs: number;
      /** Number of queued runs waiting behind the slot-holder. */
      queuedCount: number;
    }
  | {
      kind: "starved";
      /** Number of consecutive queued runs at the top of the createdAt window. */
      queuedStreak: number;
    };

export type AgentRunHealthResult = {
  /**
   * True only when the agent has NO running run and NO recently-succeeded run in
   * the provided window. False (not starved) when a slot-holder run exists.
   */
  isStarved: boolean;
  signals: AgentRunHealthSignal[];
};

export type AgentRunHealthOptions = {
  /**
   * A running slot-holder that has been active longer than this threshold while
   * other wakes are queued behind it is reported as "slot-held / head-of-line
   * blocking". Default: 2 hours (7_200_000 ms).
   */
  slotHeldThresholdMs?: number;
  /**
   * Minimum number of queued runs required to emit a slot-held signal.
   * Default: 2.
   */
  slotHeldMinQueuedCount?: number;
  /** Current wall-clock time (injectable for deterministic tests). Default: Date.now(). */
  nowMs?: number;
};

const DEFAULT_SLOT_HELD_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const DEFAULT_MIN_QUEUED_COUNT = 2;

/**
 * Evaluates agent run health without touching the database.
 * Pass the full window of recent runs (e.g. the last 20 by createdAt desc).
 */
export function evaluateAgentRunHealth(
  runs: AgentRunHealthInput[],
  options: AgentRunHealthOptions = {},
): AgentRunHealthResult {
  const {
    slotHeldThresholdMs = DEFAULT_SLOT_HELD_THRESHOLD_MS,
    slotHeldMinQueuedCount = DEFAULT_MIN_QUEUED_COUNT,
    nowMs = Date.now(),
  } = options;

  if (runs.length === 0) {
    return { isStarved: false, signals: [] };
  }

  const runningRun = runs.find((r) => r.status === "running");
  const hasRunning = runningRun !== undefined;

  // A succeeded run anywhere in the window means the agent is healthy.
  const hasRecentSucceeded = runs.some((r) => r.status === "succeeded");

  const isStarved = !hasRunning && !hasRecentSucceeded;

  const signals: AgentRunHealthSignal[] = [];

  if (isStarved) {
    // Count the leading queued-only streak by createdAt desc order (what the
    // naive evaluator would observe) so the signal is actionable.
    const sorted = [...runs].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
    let streak = 0;
    for (const r of sorted) {
      if (r.status === "queued") streak++;
      else break;
    }
    if (streak > 0) {
      signals.push({ kind: "starved", queuedStreak: streak });
    }
  } else if (hasRunning && runningRun) {
    // Check for head-of-line blocking: slot-holder running beyond the threshold
    // while other wakes are queued.
    const slotStartMs = (runningRun.startedAt ?? runningRun.createdAt).getTime();
    const ageMs = nowMs - slotStartMs;
    const queuedCount = runs.filter((r) => r.status === "queued").length;

    if (ageMs >= slotHeldThresholdMs && queuedCount >= slotHeldMinQueuedCount) {
      signals.push({ kind: "slot-held", runId: runningRun.id, ageMs, queuedCount });
    }
  }

  return { isStarved, signals };
}
