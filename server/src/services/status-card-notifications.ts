import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

/** Card/settings changes reconstruct deadlines; issue changes also evaluate reactive scope. */
export function notifyStatusCardEvaluation(transaction: object, companyId?: string) {
  return notifyDeliveryWork(transaction, DELIVERY_QUEUES.statusCardEvaluation, companyId ? `cards:${companyId}` : "*");
}

export function notifyStatusCardIssueChange(transaction: object, companyId?: string) {
  return notifyDeliveryWork(transaction, DELIVERY_QUEUES.statusCardEvaluation, companyId ? `changes:${companyId}` : "changes:*");
}
