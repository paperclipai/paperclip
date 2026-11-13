import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type ObsoletePolicyReviewScope = { companyId: string; issueId: string };

export async function notifyObsoletePolicyReviews(transaction: object, scope: ObsoletePolicyReviewScope) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.obsoletePolicyReviews, JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
}
