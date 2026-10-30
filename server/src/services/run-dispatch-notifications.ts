import { notifyIssueRecovery, type IssueRecoveryScope } from "./issue-recovery-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export async function notifyRunDispatch(transaction: object, scope?: IssueRecoveryScope) {
  await notifyIssueRecovery(transaction, scope);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.scheduledRetryDispatch);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.queuedRunDispatch);
}
