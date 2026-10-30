import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeStatusReassessmentScope = { companyId: string; issueId?: string; runId?: string; agentId?: string };

export function notifyNativeStatusReassessment(tx: object, scope: NativeStatusReassessmentScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeStatusReassessment,
    JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId, runId: scope.runId, agentId: scope.agentId }));
}
