import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeRunProjectionScope = { companyId: string; issueId?: string; runId?: string };

export async function notifyNativeRunProjection(tx: object, scope?: NativeRunProjectionScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeRunProjection,
    scope ? JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId, runId: scope.runId }) : "*");
}
