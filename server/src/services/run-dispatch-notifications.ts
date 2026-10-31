import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type RunDispatchScope = { companyId: string };

export async function notifyRunDispatch(transaction: object, scope?: RunDispatchScope) {
  await notifyIssueRecovery(transaction, scope ? { companyId: scope.companyId } : undefined);
  const hint = scope ? JSON.stringify({ companyId: scope.companyId }) : "*";
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.scheduledRetryDispatch, hint);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.queuedRunDispatch, hint);
}
