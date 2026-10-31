import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type MergeConfirmationScope = { companyId: string; issueId?: string; interactionId?: string };

export function notifyMergeConfirmationWork(tx: object, scope: MergeConfirmationScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.mergedPullRequestConfirmations, JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId, interactionId: scope.interactionId }));
}
