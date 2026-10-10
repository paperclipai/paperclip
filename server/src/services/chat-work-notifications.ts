import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export async function notifyChatDeliveryWork(tx: object): Promise<void> {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatInbound);
}

export async function notifyChatPublicationWork(tx: object): Promise<void> {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatPublications);
  // Receipt recovery waits for the publication owner to release its claim.
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatReceipts);
}

export async function notifyChatEndpointWork(tx: object): Promise<void> {
  await notifyChatDeliveryWork(tx);
  await notifyChatPublicationWork(tx);
}
