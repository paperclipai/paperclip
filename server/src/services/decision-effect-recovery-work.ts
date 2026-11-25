import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { decisionService } from "./decisions.js";

export function registerDecisionEffectRecoveryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<ReturnType<typeof decisionService>, "recoverEffects" | "nextEffectRecoveryAt">,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.decisionEffectRecovery, {
    retryMs: 30_000, canRun,
    notificationCoalesceMs: 1000,
    run: signal => service.recoverEffects(new Date(), undefined, signal),
    next: service.nextEffectRecoveryAt,
  });
}
