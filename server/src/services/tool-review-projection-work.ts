import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import type { toolReviewProjectionService } from "./tool-review-projection.js";

export function registerToolReviewProjectionWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof toolReviewProjectionService>,
  canRun: () => boolean,
) {
  const unresolvedPasses = new Map<string, number>();
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.toolReviewProjection,
    batchSize: 1,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: (entry, companyId?: string) => companyId === undefined || entry.companyId === companyId,
    load: async (companyId?: string) => {
      const rows = companyId ? [{ companyId }] : await service.companies();
      for (const scope of unresolvedPasses.keys()) {
        if (!companyId || scope === companyId) unresolvedPasses.delete(scope);
      }
      return rows.map(row => ({ ...row, id: row.companyId, dueAt: Date.now() }));
    },
    check: async (entry, signal) => {
      const result = await service.sweep(entry.companyId, { maxRows: 500, signal, shouldContinue: canRun });
      if (!result.retry) { unresolvedPasses.delete(entry.id); return null; }
      if (result.truncated) return { ...entry, dueAt: Date.now() + 1000 };
      const count = Math.min((unresolvedPasses.get(entry.id) ?? 0) + 1, 5);
      unresolvedPasses.set(entry.id, count);
      return { ...entry, dueAt: Date.now() + Math.min(300_000, 30_000 * 2 ** (count - 1)) };
    },
  }, canRun);
}
