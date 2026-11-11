import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export async function notifyToolReviewChange(transaction: object, companyId: string) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.toolReviewExpiry, companyId);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.toolReviewRecovery, companyId);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.toolReviewInterruption, companyId);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.toolReviewProjection, companyId);
}

export function writeToolReviewChange<T>(db: Db, companyId: string, write: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async transaction => {
    await notifyToolReviewChange(transaction, companyId);
    return write(transaction as unknown as Db);
  });
}
