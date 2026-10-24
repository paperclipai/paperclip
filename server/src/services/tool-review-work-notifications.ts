import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export function notifyToolReviewChange(transaction: object) {
  return notifyDeliveryWork(transaction, DELIVERY_QUEUES.toolReviewExpiry);
}

export function writeToolReviewChange<T>(db: Db, write: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async transaction => {
    await notifyToolReviewChange(transaction);
    return write(transaction as unknown as Db);
  });
}
