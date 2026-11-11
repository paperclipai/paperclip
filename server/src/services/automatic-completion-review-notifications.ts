import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type AutomaticCompletionReviewScope = { companyId: string; issueId: string };

export async function notifyAutomaticCompletionReviews(transaction: object, scope: AutomaticCompletionReviewScope) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.automaticCompletionReviews,
    JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
}
