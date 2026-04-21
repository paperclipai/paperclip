import { OWNED_HEARTBEAT_RUN_QUIET_THRESHOLD_MS } from "./heartbeat-run-activity.js";

type LiveRunLimitRelevantRunLike = {
  status: string | null | undefined;
  lastActivityAt?: Date | null;
  updatedAt?: Date | null;
  startedAt?: Date | null;
  createdAt?: Date | null;
};

function isBlockingRunningRun(run: LiveRunLimitRelevantRunLike, now = Date.now()) {
  if (run.status !== "running") return false;
  const referenceTime = run.lastActivityAt ?? run.updatedAt ?? run.startedAt ?? run.createdAt ?? null;
  if (!(referenceTime instanceof Date)) return true;
  return Math.max(0, now - referenceTime.getTime()) <= OWNED_HEARTBEAT_RUN_QUIET_THRESHOLD_MS;
}

export function countLiveRunLimitRelevantRuns<T extends LiveRunLimitRelevantRunLike>(runs: T[]) {
  return runs.filter((run) => isBlockingRunningRun(run)).length;
}

export function hasReachedLiveRunLimit<T extends LiveRunLimitRelevantRunLike>(
  runs: T[],
  limit: number,
) {
  return countLiveRunLimitRelevantRuns(runs) >= limit;
}
