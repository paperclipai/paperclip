import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type DirectoryCleanupScope = { companyId: string; runId?: string };

export async function notifyDirectoryCleanup(transaction: object, scope?: DirectoryCleanupScope) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.directoryCleanup, scope ? JSON.stringify(scope) : "*");
}
