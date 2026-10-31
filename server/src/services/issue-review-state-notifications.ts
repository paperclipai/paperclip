import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { notifyExternalConversationSettlement } from "./external-conversation-settlement-notifications.js";
import { notifyNativeReviewResponse } from "./native-review-response-notifications.js";
import { notifyNativeStatusReassessment } from "./native-status-reassessment-notifications.js";

export async function notifyIssueReviewState(tx: object, scope: { companyId: string; issueId?: string; runId?: string; agentId?: string }) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.issueMonitors);
  await notifyExternalConversationSettlement(tx, scope);
  await notifyNativeReviewResponse(tx, scope);
  await notifyNativeStatusReassessment(tx, scope);
}
