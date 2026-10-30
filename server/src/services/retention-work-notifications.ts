import { notifyApprovalWork } from "./approval-work-notifications.js";
import type { Db } from "@paperclipai/db";
import type { AttentionSourceKind } from "@paperclipai/shared";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export async function notifyRetentionWork(transaction: object, kind: AttentionSourceKind) {
  if (kind === "approval") await notifyDeliveryWork(transaction, DELIVERY_QUEUES.approvalRetention);
  if (kind === "join_request") await notifyDeliveryWork(transaction, DELIVERY_QUEUES.joinRequestRetention);
}

export async function notifyCompanyRetentionWork(transaction: object, companyId: string) {
  await notifyApprovalWork(transaction, companyId);
  await notifyRetentionWork(transaction, "join_request");
}

export function writeJoinRequestChange<T>(db: Db, write: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await notifyRetentionWork(tx, "join_request");
    return write(tx as unknown as Db);
  });
}
