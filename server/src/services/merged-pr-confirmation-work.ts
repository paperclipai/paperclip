import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { MergeConfirmationProviderUnavailableError } from "./github-pull-request-merge.js";
import type { issueThreadInteractionService } from "./issue-thread-interactions.js";
import type { MergeConfirmationScope } from "./merged-pr-confirmation-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";

export const MERGE_CONFIRMATION_RECONCILE_MS = 5 * 60_000;

export function registerMergeConfirmationWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: Pick<ReturnType<typeof issueThreadInteractionService>,
    "mergedPullRequestConfirmationCandidates" | "mergedPullRequestConfirmationPage" | "sweepMergedPullRequestConfirmations">,
  canRun: () => boolean,
) {
  const cursors = new Map<string, string>();
  const retryByCompany = new Map<string, number>();
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.mergedPullRequestConfirmations,
    decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint) as MergeConfirmationScope,
    matches: (entry, scope?: MergeConfirmationScope) => !scope || (entry.companyId === scope.companyId &&
      (!scope.issueId || entry.issueId === scope.issueId) && (!scope.interactionId || entry.id === scope.interactionId)),
    load: async (scope?: MergeConfirmationScope) => {
      const checkedAt = Date.now();
      for (const [companyId, retryAt] of retryByCompany) {
        if (retryAt <= checkedAt) retryByCompany.delete(companyId);
      }
      const key = scope ? JSON.stringify(scope) : "*";
      const page = await service.mergedPullRequestConfirmationPage(scope, cursors.get(key));
      if (page.complete) cursors.delete(key);
      else cursors.set(key, page.after!);
      return { complete: page.complete, rows: page.rows.map(({ interaction }) => ({
        id: interaction.id, companyId: interaction.companyId, issueId: interaction.issueId, dueAt: Date.now(),
      })) };
    },
    check: async (entry, signal) => {
      const scope = { companyId: entry.companyId, issueId: entry.issueId, interactionId: entry.id };
      const scheduledRetry = retryByCompany.get(entry.companyId);
      if (scheduledRetry !== undefined && scheduledRetry > Date.now()) return { ...entry, dueAt: scheduledRetry };
      retryByCompany.delete(entry.companyId);

      const result = await service.sweepMergedPullRequestConfirmations([], scope, signal).catch((error: unknown) => {
        if (!signal?.aborted && error instanceof MergeConfirmationProviderUnavailableError && error.retryAtMs !== undefined) {
          retryByCompany.set(entry.companyId, error.retryAtMs);
        }
        throw error;
      });
      if (signal?.aborted) return entry;
      if (result.retryAtMs !== undefined) retryByCompany.set(entry.companyId, result.retryAtMs);
      const remaining = await service.mergedPullRequestConfirmationCandidates(scope);
      return remaining.length
        ? { ...entry, dueAt: result.retryAtMs ?? Date.now() + MERGE_CONFIRMATION_RECONCILE_MS }
        : null;
    },
  }, canRun);
}
