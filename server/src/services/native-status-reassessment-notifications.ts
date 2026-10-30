import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
import { notifyAttentionRetentionWork } from "./retention-work-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeStatusReassessmentScope = { companyId: string; issueId?: string; runId?: string; agentId?: string };

export async function notifyNativeStatusReassessment(tx: object, scope: NativeStatusReassessmentScope) {
  await notifyStatusCardIssueChange(tx, scope.companyId);
  await notifyAttentionRetentionWork(tx, { companyId: scope.companyId });
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeStatusReassessment,
    JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId, runId: scope.runId, agentId: scope.agentId }));
}
