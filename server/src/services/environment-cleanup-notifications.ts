import { and, eq, or, sql } from "drizzle-orm";
import { environmentLeases } from "@paperclipai/db";
import { notifyLiveResourceRecovery } from "./live-run-recovery-notifications.js";
import { notifyNativeEnvironmentSettlement, type NativeEnvironmentSettlementScope } from "./native-environment-settlement-notifications.js";
import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type EnvironmentCleanupWorkScope = NativeEnvironmentSettlementScope & { leaseId?: string };

export async function notifyEnvironmentCleanup(transaction: object, scope?: EnvironmentCleanupWorkScope): Promise<void> {
  await notifyLiveResourceRecovery(transaction, scope);
  if (scope && (scope.runId || scope.leaseId) && typeof (transaction as Db).select === "function") {
    // A stopped/released allocation can still owe shutdown workspace preservation.
    // Its peer's owning release must reactivate that exact marker as well.
    const pendingShutdown = sql<boolean>`${environmentLeases.metadata}#>>'{legacyShutdownWorkspaceSettlement,schema}' = 'paperclip.legacy-shutdown-workspace-settlement.v1'
      and ${environmentLeases.metadata}#>>'{legacyShutdownWorkspaceSettlement,state}' = 'pending'
      and ${environmentLeases.metadata}#>>'{legacyShutdownWorkspaceSettlement,runId}' = ${environmentLeases.heartbeatRunId}::text`;
    const peers = await (transaction as Db).select({ id: environmentLeases.id, companyId: environmentLeases.companyId,
      status: environmentLeases.status, pendingShutdown }).from(environmentLeases).where(and(
      or(eq(environmentLeases.status, "active"), pendingShutdown),
      sql`exists (select 1 from environment_leases changed where changed.company_id = ${scope.companyId}
        and ${scope.leaseId ? sql`changed.id = ${scope.leaseId}` : sql`changed.heartbeat_run_id = ${scope.runId}`} and changed.provider_lease_id is not null
        and changed.provider = ${environmentLeases.provider} and changed.provider_lease_id = ${environmentLeases.providerLeaseId})`));
    for (const peer of peers) {
      const hint = JSON.stringify({ companyId: peer.companyId, leaseId: peer.id });
      if (peer.status === "active") await notifyDeliveryWork(transaction, DELIVERY_QUEUES.orphanActiveLeases, hint);
      if (peer.pendingShutdown) await notifyDeliveryWork(transaction, DELIVERY_QUEUES.legacyShutdownSettlement, hint);
    }
  }
  await notifyNativeEnvironmentSettlement(transaction, scope);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.environmentCleanup);
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.historicalCleanup);
}

export function writeEnvironmentCleanup<T>(db: Db, write: (tx: Db) => PromiseLike<T>, scope: EnvironmentCleanupWorkScope): Promise<T> {
  return db.transaction(async tx => {
    await notifyEnvironmentCleanup(tx, scope);
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
