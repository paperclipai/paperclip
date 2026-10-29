import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import type { ExternalConversationSettlementScope } from "./slack-conversation-lifecycle.js";

export function notifyExternalConversationSettlement(tx: object, scope?: ExternalConversationSettlementScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.externalConversationSettlement,
    scope ? JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }) : "*");
}
