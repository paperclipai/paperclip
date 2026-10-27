import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export function notifyDecisionCreated(transaction: object) {
  return notifyDeliveryWork(transaction, DELIVERY_QUEUES.decisionExpiry);
}

export async function notifyDecisionChange(transaction: object) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.decisionContinuation);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.decisionExpiry);
}

export function writeDecisionChange<T>(db: Db, write: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async transaction => {
    await notifyDecisionChange(transaction);
    await notifyDeliveryWork(transaction, DELIVERY_QUEUES.decisionEffectRecovery);
    return write(transaction as unknown as Db);
  });
}
