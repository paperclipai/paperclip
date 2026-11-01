import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerDeadlineWork } from "./deadline-work.js";
import type { decisionService } from "./decisions.js";

export function registerDecisionContinuationWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<ReturnType<typeof decisionService>, "sweepContinuations">,
  canRun: () => boolean,
) {
  let next: number | null = null;
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.decisionContinuation, {
    retryMs: 30_000, notificationCoalesceMs: 30_000, canRun,
    run: async signal => {
      const result = await service.sweepContinuations(100, signal);
      next = result.retry ? Date.now() + 30_000 : null;
    },
    next: async () => next,
  });
}
