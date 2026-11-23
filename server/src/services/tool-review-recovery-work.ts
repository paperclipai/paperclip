import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import type { createToolGatewayService } from "./tool-gateway.js";

export function registerToolReviewRecoveryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  gateway: Pick<ReturnType<typeof createToolGatewayService>, "recoverApprovedActionReviews" | "approvedActionReviewCompanies">,
  canRun: () => boolean,
) {
  // Dispatch failures are reported by the domain owner, not thrown. Preserve
  // their retry deadline when another write reloads the same company's work.
  const retries = new Map<string, number>();
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.toolReviewRecovery,
    batchSize: 1,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: (entry, companyId?: string) => companyId === undefined || entry.companyId === companyId,
    load: async (companyId?: string) => {
      const rows = await gateway.approvedActionReviewCompanies(companyId);
      const retained = new Set(rows.map(row => row.companyId));
      for (const id of retries.keys()) if ((companyId === undefined || id === companyId) && !retained.has(id)) retries.delete(id);
      return rows.map(row => ({ ...row, id: row.companyId, dueAt: retries.get(row.companyId) ?? Date.now() }));
    },
    check: async entry => {
      const result = await gateway.recoverApprovedActionReviews(entry.companyId);
      if (!result.retry) { retries.delete(entry.companyId); return null; }
      const dueAt = Date.now() + 30_000;
      retries.set(entry.companyId, dueAt);
      return { ...entry, dueAt };
    },
  }, canRun);
}
