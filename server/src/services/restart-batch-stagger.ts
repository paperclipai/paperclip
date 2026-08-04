// Global thundering-herd damping (RENA-54107, extended to the stranded-issue
// reconciliation path in RENA-54203): a control-plane restart (crash or
// graceful redeploy) resets in-memory process tracking and in-flight recovery
// state, so a single reap/drain/reconcile sweep can find many runs or issues
// "stranded" at once and would otherwise re-queue all of them immediately,
// flooding the API. When a sweep's batch size crosses this threshold, each
// retry/recovery wake gets an additional uniform-random stagger before its
// automatic re-queue.
//
// Shared by server/src/services/heartbeat.ts (reapOrphanedRuns /
// drainRunningRunsForShutdown / enqueueWakeup) and
// server/src/services/recovery/service.ts (reconcileStrandedAssignedIssues)
// so every restart-triggered enqueue path gets the same protection from one
// place instead of duplicated constants.
function parseEnvInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const RESTART_BATCH_PROCESS_LOSS_REAP_THRESHOLD = Math.max(
  1,
  parseEnvInt(process.env.HEARTBEAT_RESTART_BATCH_REAP_THRESHOLD, 8),
);
// An explicit "0" here means staggering is disabled; only fall back to the
// 5-minute default when the env var is unset or not a finite number (RENA-54203
// review fix -- the previous `|| 5 * 60 * 1000` silently discarded a real 0).
export const RESTART_BATCH_PROCESS_LOSS_STAGGER_MAX_MS = Math.max(
  0,
  parseEnvInt(process.env.HEARTBEAT_RESTART_BATCH_STAGGER_MAX_MS, 5 * 60 * 1000),
);
export const RESTART_BATCH_STAGGER_RETRY_REASON = "restart_batch_stagger";
export const RESTART_BATCH_STAGGER_WAKE_REASON = "restart_batch_stagger_retry";

// Uniform-random delay in [0, maxDelayMs], used to spread automatic re-queues
// of a restart-triggered batch of stranded runs/issues instead of firing them
// all at once.
export function computeRestartBatchStaggerDelayMs(
  random: () => number = Math.random,
  maxDelayMs: number = RESTART_BATCH_PROCESS_LOSS_STAGGER_MAX_MS,
): number {
  if (!(maxDelayMs > 0)) return 0;
  const sample = Math.min(1, Math.max(0, random()));
  return Math.round(sample * maxDelayMs);
}
