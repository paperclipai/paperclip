import { notifyAgentRecovery, notifyCompanyRecovery, notifyIssueRecovery, notifyIssueGraphRecovery } from "./issue-recovery-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

/** `everyTask` re-checks every task of the company; see IssueRecoveryScope. */
export type RunDispatchScope = { companyId: string; issueId?: string | null; runId?: string | null; everyTask?: boolean };

export async function notifyQueuedRunDispatch(transaction: object, scope?: RunDispatchScope) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.queuedRunDispatch,
    scope ? JSON.stringify({ companyId: scope.companyId }) : "*");
}

export async function notifyRunDispatch(transaction: object, scope?: RunDispatchScope) {
  if (scope?.issueId || scope?.runId) await notifyIssueGraphRecovery(transaction, scope);
  else await notifyIssueRecovery(transaction, scope ? { companyId: scope.companyId, everyTask: scope.everyTask } : undefined);
  await notifyDispatchQueues(transaction, scope);
}

export async function notifyAgentConfigurationDispatch(transaction: object, scope: { companyId: string }) {
  await notifyCompanyRecovery(transaction, scope.companyId);
  await notifyDispatchQueues(transaction, scope);
}

/** An agent status change re-checks that agent's tasks, not the whole company. */
export async function notifyAgentStatusDispatch(transaction: object, scope: { companyId: string; agentId: string }) {
  await notifyAgentRecovery(transaction, scope);
  await notifyDispatchQueues(transaction, scope);
}

async function notifyDispatchQueues(transaction: object, scope?: RunDispatchScope) {
  const hint = scope ? JSON.stringify({ companyId: scope.companyId }) : "*";
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.nativeProcessSessions, hint);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.executionReplacement, hint);
  await notifyQueuedRunDispatch(transaction, scope);
}

/** Only a retry row or deadline change needs to re-read the saved retry schedule. */
export async function notifyScheduledRetryDispatch(transaction: object, scope?: RunDispatchScope) {
  await notifyRunDispatch(transaction, scope);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.scheduledRetryDispatch);
}
