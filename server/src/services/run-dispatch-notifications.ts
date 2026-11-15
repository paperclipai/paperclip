import { notifyIssueRecovery, notifyIssueGraphRecovery } from "./issue-recovery-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type RunDispatchScope = { companyId: string; issueId?: string | null; runId?: string | null };

export async function notifyQueuedRunDispatch(transaction: object, scope?: RunDispatchScope) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.queuedRunDispatch,
    scope ? JSON.stringify({ companyId: scope.companyId }) : "*");
}

export async function notifyRunDispatch(transaction: object, scope?: RunDispatchScope) {
  if (scope?.issueId || scope?.runId) await notifyIssueGraphRecovery(transaction, scope);
  else await notifyIssueRecovery(transaction, scope ? { companyId: scope.companyId } : undefined);
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
