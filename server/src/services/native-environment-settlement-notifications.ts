import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeEnvironmentSettlementScope = { companyId: string; runId?: string; issueId?: string };
export function notifyNativeEnvironmentSettlement(tx: object, scope?: NativeEnvironmentSettlementScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeEnvironmentSettlement,
    scope ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId, issueId: scope.issueId }) : "*");
}
