import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeRunProjectionScope = { companyId: string; issueId?: string; runId?: string };

export function notifyNativeRunProjection(tx: object, scope?: NativeRunProjectionScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeRunProjection,
    scope ? JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId, runId: scope.runId }) : "*");
}
