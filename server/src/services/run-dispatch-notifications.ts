import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export async function notifyRunDispatch(transaction: object) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.scheduledRetryDispatch);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.queuedRunDispatch);
}
