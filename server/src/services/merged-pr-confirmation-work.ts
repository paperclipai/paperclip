import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
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
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.mergedPullRequestConfirmations,
    decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint) as MergeConfirmationScope,
    matches: (entry, scope?: MergeConfirmationScope) => !scope || (entry.companyId === scope.companyId &&
      (!scope.issueId || entry.issueId === scope.issueId) && (!scope.interactionId || entry.id === scope.interactionId)),
    load: async (scope?: MergeConfirmationScope) => {
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
      await service.sweepMergedPullRequestConfirmations([], scope, signal);
      if (signal?.aborted) return entry;
      const remaining = await service.mergedPullRequestConfirmationCandidates(scope);
      return remaining.length ? { ...entry, dueAt: Date.now() + MERGE_CONFIRMATION_RECONCILE_MS } : null;
    },
  }, canRun);
}
