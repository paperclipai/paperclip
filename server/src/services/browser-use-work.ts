import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

/** The app owns this worker; request-scoped services only signal durable writes. */
export function registerBrowserUseCleanup(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: { sweep(): Promise<void>; nextSweepAt(): Promise<number | null> },
  canRun: () => boolean,
) {
  let next: number | null = null;
  return coordinator.register(DELIVERY_QUEUES.browser, {
    retryMs: 3000,
    run: () => service.sweep(),
    hasPending: async () => {
      // During idle drain retain a memory-only wake, including startup or a
      // newly committed first session. Warm standby is gated by the coordinator.
      next = canRun() ? await service.nextSweepAt() : Date.now() + 3000;
      return false;
    },
    // Bound overdue batches without spinning on a busy database.
    nextRunAt: () => next === null ? null : Math.max(Date.now() + 1000, next),
  });
}
