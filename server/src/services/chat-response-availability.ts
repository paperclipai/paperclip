import { notifyExternalConversationSettlement } from "./external-conversation-settlement-notifications.js";
import { notifyNativeReviewResponse } from "./native-review-response-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type ChatResponseScope = { companyId: string; issueId?: string; deliveryId?: string; conversationId?: string };

export async function notifyChatResponseAvailability(tx: object, scope: ChatResponseScope, options: { notifySettlement?: boolean } = {}) {
  if (options.notifySettlement !== false) await notifyExternalConversationSettlement(tx, scope);
  if (scope.issueId) await notifyNativeReviewResponse(tx, { companyId: scope.companyId, issueId: scope.issueId });
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatGitHubTerminalResponses, JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId, deliveryId: scope.deliveryId, conversationId: scope.conversationId }));
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatGitHubAcknowledgements, JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId, deliveryId: scope.deliveryId, conversationId: scope.conversationId }));
}
