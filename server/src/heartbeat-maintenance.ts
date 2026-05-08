import { logger } from "./middleware/logger.js";

const ORPHANED_RUN_STALE_THRESHOLD_MS = 5 * 60 * 1000;

type HeartbeatLike = {
  tickTimers(now: Date): Promise<{ checked: number; enqueued: number; skipped: number }>;
  reapOrphanedRuns(opts?: { staleThresholdMs?: number }): Promise<unknown>;
  resumeQueuedRuns(): Promise<unknown>;
  reconcileAssignedIssueWakeups(opts?: { requestedByActorId?: string | null }): Promise<{
    checked: number;
    enqueued: number;
    skipped: number;
  }>;
};

type RoutinesLike = {
  tickScheduledTriggers(now: Date): Promise<{ triggered: number }>;
};

type SchedulerTimer = ReturnType<typeof setInterval>;
type SetIntervalFn = (
  callback: () => void,
  intervalMs: number,
) => SchedulerTimer;

export async function runHeartbeatSchedulerCycle(input: {
  heartbeat: HeartbeatLike;
  routines: RoutinesLike;
  now?: Date;
}) {
  const now = input.now ?? new Date();

  await input.heartbeat
    .tickTimers(now)
    .then((result) => {
      if (result.enqueued > 0) {
        logger.info({ ...result }, "heartbeat timer tick enqueued runs");
      }
    })
    .catch((err) => {
      logger.error({ err }, "heartbeat timer tick failed");
    });

  await input.routines
    .tickScheduledTriggers(now)
    .then((result) => {
      if (result.triggered > 0) {
        logger.info({ ...result }, "routine scheduler tick enqueued runs");
      }
    })
    .catch((err) => {
      logger.error({ err }, "routine scheduler tick failed");
    });

  await input.heartbeat
    .reapOrphanedRuns({ staleThresholdMs: ORPHANED_RUN_STALE_THRESHOLD_MS })
    .then(() => input.heartbeat.resumeQueuedRuns())
    .catch((err) => {
      logger.error({ err }, "periodic heartbeat recovery failed");
    });

  await input.heartbeat
    .reconcileAssignedIssueWakeups({ requestedByActorId: "heartbeat_scheduler" })
    .then((result) => {
      if (result.checked > 0) {
        logger.info({ ...result }, "heartbeat assigned-issue reconciliation checked dispatch gaps");
      }
    })
    .catch((err) => {
      logger.error({ err }, "periodic assigned-issue reconciliation failed");
    });
}

export function startHeartbeatScheduler(input: {
  heartbeat: HeartbeatLike;
  routines: RoutinesLike;
  intervalMs: number;
  setIntervalFn?: SetIntervalFn;
}) {
  const schedule = input.setIntervalFn ?? setInterval;

  // Reap orphaned running runs at startup while in-memory execution state is empty,
  // then resume any persisted queued runs that were waiting on the previous process.
  void input.heartbeat
    .reapOrphanedRuns()
    .then(() => input.heartbeat.resumeQueuedRuns())
    .catch((err) => {
      logger.error({ err }, "startup heartbeat recovery failed");
    });

  return schedule(() => {
    void runHeartbeatSchedulerCycle({
      heartbeat: input.heartbeat,
      routines: input.routines,
      now: new Date(),
    });
  }, input.intervalMs);
}
