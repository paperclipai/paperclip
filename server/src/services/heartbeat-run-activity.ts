import type { heartbeatRuns } from "@paperclipai/db";

export const LIVE_HEARTBEAT_RUN_FRESHNESS_WINDOW_MS = 150_000;
export const OWNED_HEARTBEAT_RUN_QUIET_THRESHOLD_MS = 10 * 60 * 1000;

type HeartbeatRunActivityLike = Pick<
  typeof heartbeatRuns.$inferSelect,
  "lastActivityAt" | "updatedAt" | "startedAt" | "createdAt"
>;

export function heartbeatRunActivityReferenceTime(run: HeartbeatRunActivityLike) {
  return run.lastActivityAt ?? run.updatedAt ?? run.startedAt ?? run.createdAt;
}

export function heartbeatRunActivityAgeMs(run: HeartbeatRunActivityLike, now = Date.now()) {
  return Math.max(0, now - heartbeatRunActivityReferenceTime(run).getTime());
}

export function isHeartbeatRunFresh(
  run: HeartbeatRunActivityLike,
  now = Date.now(),
  freshnessWindowMs = LIVE_HEARTBEAT_RUN_FRESHNESS_WINDOW_MS,
) {
  return heartbeatRunActivityAgeMs(run, now) <= freshnessWindowMs;
}

export function classifyHeartbeatRunFreshness(
  run: HeartbeatRunActivityLike,
  now = Date.now(),
  freshnessWindowMs = LIVE_HEARTBEAT_RUN_FRESHNESS_WINDOW_MS,
) {
  return isHeartbeatRunFresh(run, now, freshnessWindowMs) ? "fresh" : "quiet";
}

export function isHeartbeatRunActivityWarningRecoverable(errorCode: string | null | undefined) {
  return errorCode === "process_detached" || errorCode === "process_suspect";
}
