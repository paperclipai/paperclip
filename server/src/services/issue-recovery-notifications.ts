import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type IssueRecoveryScope = { companyId: string };

export async function notifyIssueRecovery(transaction: object, scope?: IssueRecoveryScope) {
  const hint = scope ? JSON.stringify({ companyId: scope.companyId }) : "*";
  for (const queue of [DELIVERY_QUEUES.orphanBlockers, DELIVERY_QUEUES.activeRecoveryActions, DELIVERY_QUEUES.strandedAssignments, DELIVERY_QUEUES.resolvedDependencies,
    DELIVERY_QUEUES.taskWatchdogs, DELIVERY_QUEUES.staleIssueLocks]) {
    await notifyDeliveryWork(transaction, queue, hint);
  }
}
