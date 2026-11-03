import { logger } from "../middleware/logger.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import type { createSecretProposalsService } from "./secret-proposals.js";

export function registerSecretProposalExpiryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<ReturnType<typeof createSecretProposalsService>, "sweepExpiredForCompany" | "expiryDeadlines">,
  canRun: () => boolean,
) {
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.secretProposalExpiry,
    batchSize: 1,
    // Saved expiry deadlines are authoritative, including deadlines less than
    // a second away. Only actual failures require a recovery backoff.
    minimumPassIntervalMs: 0,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: (entry, companyId?: string) => companyId === undefined || entry.companyId === companyId,
    load: async (companyId?: string) => (await service.expiryDeadlines(companyId))
      .map(row => ({ ...row, id: row.companyId })),
    check: async entry => {
      const expired = await service.sweepExpiredForCompany(entry.companyId);
      if (expired > 0) logger.warn({ companyId: entry.companyId, expired }, "secret proposal expiry scrubbed proposals");
      const [next] = await service.expiryDeadlines(entry.companyId);
      return next ? { ...next, id: next.companyId } : null;
    },
  }, canRun);
}
