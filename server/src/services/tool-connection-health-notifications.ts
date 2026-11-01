import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

type HealthChange = string | { companyId: string; id: string } | { companyId: string; applicationId: string };
export type HealthScope = { companyId?: string; connectionId?: string; applicationId?: string };

export function healthScope(hint: string): HealthScope {
  if (hint === "*") return {};
  const [companyId, kind, id, extra] = hint.split(":");
  if (companyId && kind === undefined) return { companyId };
  if (companyId && id && extra === undefined) {
    if (kind === "connection") return { companyId, connectionId: id };
    if (kind === "application") return { companyId, applicationId: id };
  }
  throw new Error("Invalid tool connection health scope");
}

export const notifyToolConnectionHealth = (transaction: object, target: HealthChange) =>
  notifyDeliveryWork(transaction, DELIVERY_QUEUES.toolConnectionHealth, typeof target === "string" ? target
    : "id" in target ? `${target.companyId}:connection:${target.id}` : `${target.companyId}:application:${target.applicationId}`);

export function writeToolConnectionHealthChange<T>(db: Db, target: HealthChange, write: (transaction: Db) => Promise<T>): Promise<T> {
  return db.transaction(async tx => {
    await notifyToolConnectionHealth(tx, target);
    return write(tx as unknown as Db);
  });
}
