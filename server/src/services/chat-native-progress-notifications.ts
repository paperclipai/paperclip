import { databaseWorkCommitNotification, publishDatabaseWorkSettled } from "@paperclipai/db/work-signals";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import type { ChatRunProjectionScope } from "./chat-run-publication-policy.js";

export function notifyChatNativeProgress(tx: object, scope: ChatRunProjectionScope) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.chatNativeProgress, JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
}

export function chatNativeProgressCommitNotification(owner: object): string | null {
  return databaseWorkCommitNotification(owner, DELIVERY_QUEUES.chatNativeProgress);
}

export function publishChatNativeProgressSettled(owner: object, scope: ChatRunProjectionScope): void {
  publishDatabaseWorkSettled(owner, DELIVERY_QUEUES.chatNativeProgress, JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
}
