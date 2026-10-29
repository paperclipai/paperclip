import { notifyExternalConversationSettlement } from "./external-conversation-settlement-notifications.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import type { InboundWakeNoticeScope } from "./chat-channels/inbound/wakeup-notices.js";

export async function notifyChatInboundWakeNotices(tx: object, scope: InboundWakeNoticeScope, options: { notifySettlement?: boolean } = {}) {
  if (options.notifySettlement !== false) await notifyExternalConversationSettlement(tx, scope);
  const hint = JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId });
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatInboundWakeNotices, hint);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatFailedRetryNotices, hint);
}
