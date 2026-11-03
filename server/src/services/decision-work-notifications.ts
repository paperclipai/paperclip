import { notifyAttentionRetentionWork } from "./retention-work-notifications.js";
import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

type DecisionWorkScope = { companyId: string; sourceId?: string };

export async function notifyDecisionCreated(transaction: object, scope: DecisionWorkScope) {
  await notifyAttentionRetentionWork(transaction, { ...scope, sourceKind: "decision" });
  return notifyDeliveryWork(transaction, DELIVERY_QUEUES.decisionExpiry);
}

export async function notifyDecisionChange(transaction: object, scope: DecisionWorkScope) {
  await notifyAttentionRetentionWork(transaction, { ...scope, sourceKind: "decision" });
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.decisionContinuation);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.decisionExpiry);
}

export function writeDecisionChange<T>(db: Db, write: (transaction: Db) => Promise<T>, scope: DecisionWorkScope): Promise<T> {
  return db.transaction(async transaction => {
    await notifyDecisionChange(transaction, scope);
    await notifyDeliveryWork(transaction, DELIVERY_QUEUES.decisionEffectRecovery);
    return write(transaction as unknown as Db);
  });
}
