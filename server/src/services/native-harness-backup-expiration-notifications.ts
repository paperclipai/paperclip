import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeHarnessBackupExpirationScope = {
  companyId: string; scopeDigest?: string; leaseId?: string; runId?: string; issueId?: string; agentId?: string; sessionId?: string;
};

export function nativeHarnessBackupScopeHint(scope: NativeHarnessBackupExpirationScope) {
  return JSON.stringify({ companyId: scope.companyId, scopeDigest: scope.scopeDigest, leaseId: scope.leaseId,
    runId: scope.runId, issueId: scope.issueId, agentId: scope.agentId, sessionId: scope.sessionId });
}

export function notifyNativeHarnessBackupExpiration(tx: object, scope?: NativeHarnessBackupExpirationScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeHarnessBackupExpiration, scope ? nativeHarnessBackupScopeHint(scope) : "*");
}

const listeners = new WeakMap<object, Set<(scope: NativeHarnessBackupExpirationScope) => void>>();
export function onNativeHarnessBackupChange(db: object, listener: (scope: NativeHarnessBackupExpirationScope) => void) {
  let owned = listeners.get(db);
  if (!owned) { owned = new Set(); listeners.set(db, owned); }
  owned.add(listener);
  return () => { owned.delete(listener); if (!owned.size) listeners.delete(db); };
}

export function noteNativeHarnessBackupChange(db: object, scope: NativeHarnessBackupExpirationScope) {
  for (const listener of listeners.get(db) ?? []) listener(scope);
}
