import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeReviewResponseScope = { companyId: string; issueId?: string; runId?: string; agentId?: string };

export function notifyNativeReviewResponse(tx: object, scope: NativeReviewResponseScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeReviewResponse,
    JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId, runId: scope.runId, agentId: scope.agentId }));
}
