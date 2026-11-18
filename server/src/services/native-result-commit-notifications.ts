import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeResultCommitScope = { companyId: string; runId?: string; issueId?: string };

export function notifyNativeResultCommit(tx: object, scope?: NativeResultCommitScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeResultCommit,
    scope ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId, issueId: scope.issueId }) : "*");
}
