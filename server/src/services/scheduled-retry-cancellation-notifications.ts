import { notifyScheduledRetryDispatch } from "./run-dispatch-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type ScheduledRetryCancellationScope = { companyId: string; runId?: string };

export async function notifyScheduledRetryCancellation(transaction: object, scope?: ScheduledRetryCancellationScope) {
  await notifyScheduledRetryDispatch(transaction, scope);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.scheduledRetryCancellation, scope ? JSON.stringify(scope) : "*");
}
