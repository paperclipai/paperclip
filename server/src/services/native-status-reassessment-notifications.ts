import { notifyIssueAttentionRetentionWork } from "./retention-work-notifications.js";
import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type NativeStatusReassessmentScope = { companyId: string; issueId?: string; runId?: string; agentId?: string };

export async function notifyNativeStatusReassessment(tx: object, scope: NativeStatusReassessmentScope) {
  await notifyIssueAttentionRetentionWork(tx, { companyId: scope.companyId, issueId: scope.issueId, runId: scope.runId });
  await notifyStatusCardIssueChange(tx, scope.companyId);
  await notifyIssueRecovery(tx, scope ? { companyId: scope.companyId } : undefined);
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeStatusReassessment,
    JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId, runId: scope.runId, agentId: scope.agentId }));
}
