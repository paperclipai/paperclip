import { notifyRoutineExecutionStatus } from "./routine-execution-status-notifications.js";
import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
import { notifyRunDispatch } from "./run-dispatch-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { notifyExternalConversationSettlement } from "./external-conversation-settlement-notifications.js";
import { notifyNativeReviewResponse } from "./native-review-response-notifications.js";
import { notifyNativeStatusReassessment } from "./native-status-reassessment-notifications.js";

export async function notifyIssueReviewState(tx: object, scope: { companyId: string; issueId?: string; runId?: string; agentId?: string }) {
  await notifyRoutineExecutionStatus(tx, scope.issueId, scope.companyId);
  await notifyStatusCardIssueChange(tx, scope.companyId);
  await notifyRunDispatch(tx, scope);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
  await notifyExternalConversationSettlement(tx, scope);
  await notifyNativeReviewResponse(tx, scope);
  await notifyNativeStatusReassessment(tx, scope);
}
