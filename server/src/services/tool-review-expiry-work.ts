import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import type { createToolGatewayService } from "./tool-gateway.js";

export function registerToolReviewExpiryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  gateway: Pick<ReturnType<typeof createToolGatewayService>, "sweepExpiredActionReviewsForCompany" | "actionReviewExpiryDeadlines">,
  canRun: () => boolean,
) {
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.toolReviewExpiry,
    batchSize: 1,
    minimumPassIntervalMs: 0,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: (entry, companyId?: string) => companyId === undefined || entry.companyId === companyId,
    load: async (companyId?: string) => (await gateway.actionReviewExpiryDeadlines(companyId))
      .map(row => ({ ...row, id: row.companyId })),
    check: async entry => {
      await gateway.sweepExpiredActionReviewsForCompany(entry.companyId);
      const [next] = await gateway.actionReviewExpiryDeadlines(entry.companyId);
      return next ? { ...next, id: next.companyId } : null;
    },
  }, canRun);
}
