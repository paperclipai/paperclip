import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { createToolGatewayService } from "./tool-gateway.js";

export function registerGatewayCredentialExpiryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  gateway: Pick<ReturnType<typeof createToolGatewayService>, "cleanupExpiredSessions" | "nextCredentialExpiryAt">,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.gatewayCredentialExpiry, {
    retryMs: 30_000,
    notificationCoalesceMs: 30_000,
    canRun,
    run: () => gateway.cleanupExpiredSessions({ singleBatch: true }),
    next: () => gateway.nextCredentialExpiryAt(),
  });
}
