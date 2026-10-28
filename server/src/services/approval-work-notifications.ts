import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export const notifyApprovalQueueWork = (transaction: object, companyId: string) => notifyDeliveryWork(transaction, DELIVERY_QUEUES.approvalQueueSeeding, companyId);

export async function notifyApprovalWork(transaction: object, companyId: string) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.approvalRetention);
  await notifyApprovalQueueWork(transaction, companyId);
}

export function writeApprovalChange<T>(db: Db, companyId: string, write: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await notifyApprovalWork(tx, companyId);
    return write(tx as unknown as Db);
  });
}
