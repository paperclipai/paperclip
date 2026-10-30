import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type RunDispatchScope = { companyId: string };

export async function notifyRunDispatch(transaction: object, scope?: RunDispatchScope) {
  const hint = scope ? JSON.stringify(scope) : "*";
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.scheduledRetryDispatch, hint);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.queuedRunDispatch, hint);
}
