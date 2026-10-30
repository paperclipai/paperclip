import type { createDeliveryWorkCoordinator } from "../delivery-work-coordinator.js";
import { registerDeadlineWork } from "../deadline-work.js";
import { DELIVERY_QUEUES } from "../delivery-work-notifications.js";

export function registerRunDispatchWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  owner: {
    promoteDueScheduledRetries(): Promise<unknown>;
    nextScheduledRetryAt(): Promise<number | null>;
    resumeQueuedRunsAfterDrain(): Promise<unknown>;
    schedulingSuppressed(): Promise<boolean>;
  },
  canRun: () => boolean,
) {
  let suppressed = false;
  const retries = registerDeadlineWork(coordinator, DELIVERY_QUEUES.scheduledRetryDispatch, {
    retryMs: 30_000,
    continuationMs: 1_000,
    canRun,
    run: async signal => {
      suppressed = await owner.schedulingSuppressed();
      if (!signal.aborted && !suppressed && canRun()) await owner.promoteDueScheduledRetries();
    },
    next: () => suppressed ? Promise.resolve(null) : owner.nextScheduledRetryAt(),
  });
  const queue = registerDeadlineWork(coordinator, DELIVERY_QUEUES.queuedRunDispatch, {
    retryMs: 30_000,
    canRun,
    run: async signal => {
      if (!signal.aborted && canRun()) await owner.resumeQueuedRunsAfterDrain();
    },
    next: async () => null,
  });
  return {
    ready: Promise.all([retries.ready, queue.ready]),
    wake() { retries.wake(); queue.wake(); },
    async stop() { await Promise.all([retries.stop(), queue.stop()]); },
  };
}
