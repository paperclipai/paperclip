import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export async function notifyToolReviewChange(transaction: object) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.toolReviewExpiry);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.toolReviewRecovery);
}

export function writeToolReviewChange<T>(db: Db, write: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async transaction => {
    await notifyToolReviewChange(transaction);
    return write(transaction as unknown as Db);
  });
}
