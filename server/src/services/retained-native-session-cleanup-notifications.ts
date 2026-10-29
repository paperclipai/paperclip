import { notifySkillVersionRetention } from "./skill-version-retention-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type RetainedNativeSessionCleanupScope = {
  companyId: string;
  runId?: string;
  issueId?: string;
  agentId?: string;
};

export async function notifyRetainedNativeSessionCleanup(tx: object, scope: RetainedNativeSessionCleanupScope) {
  await notifySkillVersionRetention(tx, scope.companyId);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.retainedNativeSessionCleanup, JSON.stringify({ companyId: scope.companyId, runId: scope.runId, issueId: scope.issueId, agentId: scope.agentId }));
}



const listeners = new WeakMap<object, Set<(scope: RetainedNativeSessionCleanupScope) => void>>();
export function onRetainedNativeSessionCleanupRelease(db: object, listener: (scope: RetainedNativeSessionCleanupScope) => void) {
  let owned = listeners.get(db);
  if (!owned) { owned = new Set(); listeners.set(db, owned); }
  owned.add(listener);
  return () => {
    owned.delete(listener);
    if (!owned.size && listeners.get(db) === owned) listeners.delete(db);
  };
}
export function releaseRetainedNativeSessionCleanup(db: object, scope: RetainedNativeSessionCleanupScope) {
  for (const listener of listeners.get(db) ?? []) listener(scope);
}
