import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { DECISION_ARCHIVE_RETRY_MS } from "./decision-archive-delivery.js";
import type { decisionRetentionService } from "./decision-retention.js";

export function registerDecisionArchiveDeliveryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<ReturnType<typeof decisionRetentionService>, "deliverNotifications" | "nextArchiveNotificationAt">,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.decisionArchiveDelivery, {
    retryMs: DECISION_ARCHIVE_RETRY_MS, canRun,
    run: () => service.deliverNotifications(),
    next: service.nextArchiveNotificationAt,
  });
}
