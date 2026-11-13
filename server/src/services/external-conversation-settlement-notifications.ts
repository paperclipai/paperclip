import { notifyIssueRecovery } from "./issue-recovery-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import type { ExternalConversationSettlementScope } from "./slack-conversation-lifecycle.js";

export async function notifyExternalConversationSettlement(tx: object, scope?: ExternalConversationSettlementScope) {
  await notifyIssueRecovery(tx, scope);
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.externalConversationSettlement,
    scope ? JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }) : "*");
}
