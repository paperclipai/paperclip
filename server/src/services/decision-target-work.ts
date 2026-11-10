import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import type { decisionService } from "./decisions.js";

export function registerDecisionTargetWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<ReturnType<typeof decisionService>, "sweepInvalidTargets" | "decisionTargetsChanged" | "hasDecisionTargetWork">,
  canRun: () => boolean,
) {
  const retryMs = 30_000;
  return coordinator.register(DELIVERY_QUEUES.decisionTargets, {
    retryMs,
    pausePassiveMaintenance: true,
    onSettled: service.decisionTargetsChanged,
    run: signal => canRun() ? service.sweepInvalidTargets(new Date(), signal) : Promise.resolve(),
    hasPending: async () => canRun() && service.hasDecisionTargetWork(),
    nextRunAt: () => service.hasDecisionTargetWork() ? Date.now() + retryMs : null,
  });
}
