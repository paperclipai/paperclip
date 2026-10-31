import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";


export function registerDatabaseBackupWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  options: {
    intervalMs: number;
    run: () => Promise<unknown>;
    // Anchors the first run to the previous dump, so restarts closer together
    // than the interval cannot starve backups. Resolved off the startup path;
    // the startup-relative deadline stands until it settles, and on null/error.
    resolveFirstRunAt?: () => Promise<number | null>;
  },
) {
  const { intervalMs } = options;


  let nextAt = Date.now() + intervalMs;
  const startupDeadline = nextAt;
  const worker = coordinator.register(DELIVERY_QUEUES.databaseBackups, {
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
  void options.resolveFirstRunAt?.().then(firstRunAt => {
    // Only pull the first deadline earlier, and never after a run has moved it.
    if (firstRunAt === null || nextAt !== startupDeadline || firstRunAt >= nextAt) return;
    nextAt = firstRunAt;
    worker.wake();
  }, () => {});
  return worker;
}
