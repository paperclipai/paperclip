import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { decisionService } from "./decisions.js";

export function registerDecisionExpiryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<ReturnType<typeof decisionService>, "sweepTtlExpiry" | "nextExpiryAt">,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.decisionExpiry, {
    retryMs: 30_000, continuationMs: 1000, canRun,
    run: signal => service.sweepTtlExpiry(new Date(), signal),
    next: service.nextExpiryAt,
  });
}
