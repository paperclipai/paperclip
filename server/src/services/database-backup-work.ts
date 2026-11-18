import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";


export function registerDatabaseBackupWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  options: { intervalMs: number; run: () => Promise<unknown> },
) {
  const { intervalMs } = options;


  let nextAt = Date.now() + intervalMs;
  return coordinator.register(DELIVERY_QUEUES.databaseBackups, {
    retryMs: intervalMs,
    pausePassiveMaintenance: true,
    hasPending: async () => false,
    nextRunAt: () => nextAt,
    run: async () => {
      if (Date.now() < nextAt) return;
      try {
        await options.run();
      } finally {


        nextAt += Math.max(1, Math.floor((Date.now() - nextAt) / intervalMs) + 1) * intervalMs;
      }
    },
  });
}
