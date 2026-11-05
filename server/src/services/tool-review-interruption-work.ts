import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createToolGatewayService } from "./tool-gateway.js";

export function registerToolReviewInterruptionWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  gateway: Pick<ReturnType<typeof createToolGatewayService>, "settleInterruptedActionReviews" | "nextActionReviewInterruptionAt">,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.toolReviewInterruption, {
    retryMs: 30_000, notificationCoalesceMs: 30_000, canRun,
    run: () => gateway.settleInterruptedActionReviews(),
    next: () => gateway.nextActionReviewInterruptionAt(),
  });
}
