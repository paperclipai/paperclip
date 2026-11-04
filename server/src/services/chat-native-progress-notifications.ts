import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import type { ChatRunProjectionScope } from "./chat-run-publication-policy.js";

export function notifyChatNativeProgress(tx: object, scope: ChatRunProjectionScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.chatNativeProgress, JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
}
