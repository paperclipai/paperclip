import { logger } from "../middleware/logger.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { environmentCustomImageService } from "./environment-custom-images.js";

export function registerCustomImageCleanupWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<ReturnType<typeof environmentCustomImageService>, "cleanupExpiredSetupSessions" | "nextSetupCleanupAt">,
  canRun: () => boolean,
  retryMs = 30_000,
) {
  let requested = 1, reconciled = 0;
  let next: number | null = null;
  let earliest = 0;
  return coordinator.register(DELIVERY_QUEUES.customImageExpiry, {
    retryMs,
    pausePassiveMaintenance: true,
    onSettled: () => { requested++; },
    run: async () => {
      if (!canRun()) { requested++; return; }
      if (Date.now() < earliest) { next = earliest; return; }
      const generation = ++requested;
      earliest = Date.now() + retryMs;
      const result = await service.cleanupExpiredSetupSessions();
      if (result.timedOut > 0 || result.failed > 0) logger.warn(result, "environment customImage setup cleanup changed sessions");
      const deadline = await service.nextSetupCleanupAt();
      next = deadline === null ? null : Math.max(earliest, deadline);
      reconciled = generation;
    },
    hasPending: async () => requested !== reconciled,
    nextRunAt: () => next,
  });
}
