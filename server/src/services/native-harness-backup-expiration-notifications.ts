import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeHarnessBackupExpirationScope = { companyId: string; scopeDigest?: string };

export function notifyNativeHarnessBackupExpiration(tx: object, scope?: NativeHarnessBackupExpirationScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeHarnessBackupExpiration, scope ? JSON.stringify(scope) : "*");
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
