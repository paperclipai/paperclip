import type { createDeliveryWorkCoordinator } from "../../delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "../../scoped-deadline-work.js";
import type { githubWebhookRecoverySchedule, GitHubWebhookRecoveryDeadline } from "./webhook-recovery-schedule.js";
import type { GitHubWebhookRecoveryScope } from "./webhook-recovery-notifications.js";

export function registerGitHubWebhookRecoveryWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof githubWebhookRecoverySchedule>,
  canRun: () => boolean,
) {
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.chatGitHubWebhookRecovery,
    batchSize: 5,
    decodeScope: (hint: string): GitHubWebhookRecoveryScope | undefined => hint === "*" ? undefined : JSON.parse(hint),
    matches: (entry: GitHubWebhookRecoveryDeadline, scope?: GitHubWebhookRecoveryScope) => !scope ||
      (scope.kind === "endpoint" ? entry.id : scope.kind === "company" ? entry.companyId : entry.connectionId) === scope.id,
    load: (scope, signal) => service.load(scope, canRun, signal),
    check: (entry, signal) => service.check(entry.id, canRun, signal),
  }, canRun);
}
