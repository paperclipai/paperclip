import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createToolGatewayService } from "./tool-gateway.js";

export function registerToolReviewExpiryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  gateway: Pick<ReturnType<typeof createToolGatewayService>, "sweepExpiredActionReviews" | "nextActionReviewExpiryAt">,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.toolReviewExpiry, {
    retryMs: 30_000, canRun,
    run: () => gateway.sweepExpiredActionReviews(),
    next: () => gateway.nextActionReviewExpiryAt(),
  });
}
