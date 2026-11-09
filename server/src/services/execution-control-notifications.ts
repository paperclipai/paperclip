import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork, type DeliveryQueue } from "./delivery-work-notifications.js";

export async function notifyExecutionRunWork(transaction: object) {
  for (const queue of [DELIVERY_QUEUES.executionStatus, DELIVERY_QUEUES.executionFinalization,
    DELIVERY_QUEUES.executionReplacement, DELIVERY_QUEUES.executionDisposition]) {
    await notifyDeliveryWork(transaction, queue);
  }
}

export function writeExecutionControl<T>(
  db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
  queue: DeliveryQueue | readonly DeliveryQueue[],
  write: (tx: Db) => PromiseLike<T>,
): Promise<T> {
  return db.transaction(async transaction => {
    for (const topic of typeof queue === "string" ? [queue] : queue) await notifyDeliveryWork(transaction, topic);
    return write(transaction as unknown as Db);
  });
}
