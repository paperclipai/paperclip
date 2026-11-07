import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type LoginCleanupQueue = typeof DELIVERY_QUEUES.adapterLoginCleanup | typeof DELIVERY_QUEUES.setupTokenCleanup;

export function writeLoginCleanup<T>(db: Db, queue: LoginCleanupQueue, write: (tx: Db) => PromiseLike<T>): Promise<T> {
  return db.transaction(async tx => {
    await notifyDeliveryWork(tx, queue);
    return write(tx as unknown as Db);
  });
}

export async function notifyLoginSessionChanged(transaction: object): Promise<void> {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.adapterLoginCleanup);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.setupTokenCleanup);
}
