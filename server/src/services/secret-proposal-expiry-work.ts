import { logger } from "../middleware/logger.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createSecretProposalsService } from "./secret-proposals.js";

export function registerSecretProposalExpiryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<ReturnType<typeof createSecretProposalsService>, "sweepExpired" | "nextExpiryAt">,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.secretProposalExpiry, {
    retryMs: 30_000,
    canRun,
    run: async () => {
      const expired = await service.sweepExpired();
      if (expired > 0) logger.warn({ expired }, "secret proposal expiry scrubbed proposals");
    },
    next: () => service.nextExpiryAt(),
  });
}
