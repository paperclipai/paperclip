import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeWorkspaceFinalizationScope = { companyId: string; runId?: string; issueId?: string };

export function notifyNativeWorkspaceFinalization(tx: object, scope?: NativeWorkspaceFinalizationScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeWorkspaceFinalization,
    scope ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId, issueId: scope.issueId }) : "*");
}



const listeners = new WeakMap<object, Set<(scope: NativeWorkspaceFinalizationScope) => void>>();
export function onNativeWorkspaceFinalizationRelease(db: object, listener: (scope: NativeWorkspaceFinalizationScope) => void) {
  let owned = listeners.get(db);
  if (!owned) { owned = new Set(); listeners.set(db, owned); }
  owned.add(listener);
  return () => {
    owned.delete(listener);
    if (!owned.size && listeners.get(db) === owned) listeners.delete(db);
  };
}
export function releaseNativeWorkspaceFinalization(db: object, scope: NativeWorkspaceFinalizationScope) {
  for (const listener of listeners.get(db) ?? []) listener(scope);
}
