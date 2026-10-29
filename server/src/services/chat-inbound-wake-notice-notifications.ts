import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import type { InboundWakeNoticeScope } from "./chat-channels/inbound/wakeup-notices.js";

export async function notifyChatInboundWakeNotices(tx: object, scope: InboundWakeNoticeScope) {
  const hint = JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId });
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatInboundWakeNotices, hint);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatFailedRetryNotices, hint);
}
