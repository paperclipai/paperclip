import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

/**
 * Periodic, instance-wide sweep of orphaned run scratch directories. The
 * per-run executor cleanup only covers runs that reach their finally block;
 * crashed or restarted runs need this worker to reclaim their scratch (and
 * the managed AI credential homes inside). A truncated scan reschedules a
 * bounded follow-up so a crowded root cannot stall progress.
 */
export function registerRunScratchSweepWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  input: {
    intervalMs: number;
    canRun: () => boolean;
    sweep: () => Promise<{ truncated: boolean }>;
  },
) {
  const { intervalMs } = input;
  const continuationMs = Math.min(intervalMs, 30_000);
  let nextAt = Date.now();
  return coordinator.register(DELIVERY_QUEUES.runScratchSweep, {
    retryMs: intervalMs,
    pausePassiveMaintenance: true,
    hasPending: async () => false,
    nextRunAt: () => nextAt,
    run: async () => {
      if (Date.now() < nextAt) return;
      if (!input.canRun()) {
        // Advance the deadline anyway: drain, standby and shutdown are
        // bounded states, and spinning on a skipped sweep helps no one.
        nextAt = Date.now() + intervalMs;
        return;
      }
      let truncated = false;
      try {
        truncated = (await input.sweep()).truncated;
      } finally {
        nextAt = Date.now() + (truncated ? continuationMs : intervalMs);
      }
    },
  });
}
