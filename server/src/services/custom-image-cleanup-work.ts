import { logger } from "../middleware/logger.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { environmentCustomImageService } from "./environment-custom-images.js";

export function registerCustomImageCleanupWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<ReturnType<typeof environmentCustomImageService>, "cleanupExpiredSetupSessions" | "nextSetupCleanupAt">,
  canRun: () => boolean,
  retryMs = 30_000,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.customImageExpiry, {
    retryMs,
    canRun,
    run: async () => {
      const result = await service.cleanupExpiredSetupSessions();
      if (result.timedOut > 0 || result.failed > 0) logger.warn(result, "environment customImage setup cleanup changed sessions");
    },
    next: () => service.nextSetupCleanupAt(),
  });
}
