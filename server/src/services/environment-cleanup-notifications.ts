import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export async function notifyEnvironmentCleanup(transaction: object): Promise<void> {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.environmentCleanup);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.historicalCleanup);
}

export function writeEnvironmentCleanup<T>(db: Db, write: (tx: Db) => PromiseLike<T>): Promise<T> {
  return db.transaction(async tx => {
    await notifyEnvironmentCleanup(tx);
    return write(tx as unknown as Db);
  });
}

type Flush = () => Promise<{ recovered: number; pending: number }>;
const deferred = new WeakMap<object, { flushers: Set<Flush>; listeners: Set<() => void> }>();
function state(db: object) {
  let value = deferred.get(db);
  if (!value) { value = { flushers: new Set(), listeners: new Set() }; deferred.set(db, value); }
  return value;
}
export function registerDeferredEnvironmentCleanup(db: object, flush: Flush): () => void {
  const value = state(db);
  value.flushers.add(flush);
  for (const wake of value.listeners) wake();
  return () => { value.flushers.delete(flush); };
}
export function subscribeDeferredEnvironmentCleanup(db: object, wake: () => void): () => void {
  const value = state(db);
  value.listeners.add(wake);
  return () => { value.listeners.delete(wake); };
}
export function hasDeferredEnvironmentCleanup(db: object): boolean {
  return (deferred.get(db)?.flushers.size ?? 0) > 0;
}
export async function flushDeferredEnvironmentCleanup(db: object, additional: Iterable<Flush> = []): Promise<{ recovered: number; pending: number }> {
  let recovered = 0, pending = 0, failures = 0;
  for (const flush of new Set([...(deferred.get(db)?.flushers ?? []), ...additional])) {
    try {
      const result = await flush();
      recovered += result.recovered; pending += result.pending;
    } catch { failures++; }
  }
  // Attempt every runtime before retaining the retry. Provider/spool errors may
  // contain credentials, so report only a count rather than their payloads.
  if (failures > 0) throw new Error(`Deferred orphan cleanup failed for ${failures} runtime(s)`);
  return { recovered, pending };
}
