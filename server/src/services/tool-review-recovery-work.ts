import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createToolGatewayService } from "./tool-gateway.js";

export function registerToolReviewRecoveryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  gateway: Pick<ReturnType<typeof createToolGatewayService>, "recoverApprovedActionReviews">,
  canRun: () => boolean,
) {
  let next: number | null = null;
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.toolReviewRecovery, {
    retryMs: 30_000, canRun,
    run: async () => {
      const result = await gateway.recoverApprovedActionReviews();
      next = result.retry ? Date.now() + 30_000 : null;
    },
    next: async () => next,
  });
}
