// MAD-622: lease/TTL liveness for heartbeat runs that hold issue locks.
//
// Issue lock reaping used to be status-driven only: a run row had to be
// terminal (or missing) before `checkoutRunId` / `executionRunId` could be
// cleared. A run whose *process* dies without its DB row ever transitioning —
// API restart mid-run, host crash, model session limit — is neither terminal
// nor missing, so its lock was held forever and the issue was stranded.
//
// This module adds the second liveness axis: a non-terminal run is treated as
// dead when it has no live process AND has been silent past a TTL. Both
// conditions are required. The pid probe alone is not enough (pid reuse, and
// runs that legitimately have no local process); the TTL alone is not enough
// (a healthy long-running turn can be quiet for minutes).
//
// On pid reuse (see MAD-375): a recycled pid makes `isPidAlive` report a run as
// alive when it is not. That error direction is the safe one here — it delays a
// reap rather than reaping a live run's lock, and letting two runs mutate one
// issue concurrently is strictly worse than a stuck lock. Every ambiguous case
// below therefore resolves to "still alive".

import { runningProcesses } from "../adapters/utils.js";
import { isPidAlive, isProcessGroupAlive } from "./local-service-supervisor.js";

/**
 * How long a non-terminal, process-less run may stay silent before its issue
 * lock is considered abandoned. Deliberately generous: reaping too early is a
 * correctness bug, reaping late is an availability annoyance.
 */
export const DEFAULT_RUN_LEASE_TTL_MS = 15 * 60 * 1000;

export type HeartbeatRunLivenessRow = {
  id: string;
  status: string;
  processPid: number | null;
  processGroupId: number | null;
  processStartedAt: Date | null;
  lastOutputAt: Date | null;
  startedAt: Date | null;
  updatedAt: Date | null;
  createdAt: Date | null;
};

function hasLiveProcess(run: HeartbeatRunLivenessRow): boolean {
  // An in-memory handle is the strongest signal available: this server process
  // is still supervising the run, so it is alive regardless of what the row says.
  if (runningProcesses.get(run.id)) return true;

  const pid = run.processPid;
  const processGroupId = run.processGroupId;
  if (typeof pid !== "number" && typeof processGroupId !== "number") {
    // No process metadata at all. We cannot probe; fall back to the TTL alone.
    return false;
  }

  return (
    (typeof pid === "number" && isPidAlive(pid)) ||
    (typeof processGroupId === "number" && isProcessGroupAlive(processGroupId))
  );
}

function lastActivityAt(run: HeartbeatRunLivenessRow): Date | null {
  if (run.lastOutputAt) return run.lastOutputAt;
  if (run.startedAt) return run.startedAt;

  // MAD-891: a run that never started (`queued` with `startedAt = null`) has no
  // execution activity to measure. `updatedAt` is *bookkeeping*, not liveness —
  // any unrelated row write (retry promotion, wakeup linkage, a status re-stamp)
  // pushes it forward and would silently renew the lease of a run that is doing
  // nothing at all, making the reaper a no-op for exactly the orphan case it
  // exists to catch. Key the lease off `createdAt` for never-started runs so the
  // clock starts when the run was enqueued and only ever moves forward once.
  if (!run.startedAt) return run.createdAt ?? run.updatedAt ?? null;

  return run.updatedAt ?? null;
}

/**
 * True when a non-terminal run is demonstrably dead and its lease has expired,
 * so any issue lock it holds may be reaped.
 *
 * Callers must still handle the terminal/missing cases themselves — this
 * function speaks only to the "row says running but nothing is running" case.
 */
export function isAbandonedHeartbeatRun(
  run: HeartbeatRunLivenessRow,
  options: { now?: Date; ttlMs?: number } = {},
): boolean {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_RUN_LEASE_TTL_MS;

  if (hasLiveProcess(run)) return false;

  const activityAt = lastActivityAt(run);
  // No timestamp to reason about → fail closed and leave the lock alone.
  if (!activityAt) return false;

  return now.getTime() - activityAt.getTime() >= ttlMs;
}

/** Column selection matching {@link HeartbeatRunLivenessRow}. */
export const HEARTBEAT_RUN_LIVENESS_COLUMNS = [
  "id",
  "status",
  "processPid",
  "processGroupId",
  "processStartedAt",
  "lastOutputAt",
  "startedAt",
  "updatedAt",
  "createdAt",
] as const;
