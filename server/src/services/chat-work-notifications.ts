import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export async function notifyChatDeliveryWork(tx: object): Promise<void> {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatInbound);
}

export async function notifyChatPublicationWork(tx: object): Promise<void> {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatPublications);
  // Receipt recovery waits for the publication owner to release its claim.
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatReceipts);
}

export const CHAT_ACTION_QUEUES = {
  provider_effect: DELIVERY_QUEUES.chatProviderEffects,
  github_webhook_ingress: DELIVERY_QUEUES.chatGitHubIngress,
  slack_session_sync: DELIVERY_QUEUES.chatSessionSyncs,
  slack_board_message: DELIVERY_QUEUES.chatBoardMessages,
  slash_task_start: DELIVERY_QUEUES.chatTaskStarts,
  receipt_reaction: DELIVERY_QUEUES.chatReceiptReactions,
  slack_session_stop: DELIVERY_QUEUES.chatSessionStops,
} as const;
export type ScheduledChatAction = keyof typeof CHAT_ACTION_QUEUES;

export async function notifyChatActionWork(tx: object, kind: ScheduledChatAction): Promise<void> {
  await notifyDeliveryWork(tx, CHAT_ACTION_QUEUES[kind]);
}

export async function notifyChatVerificationWork(tx: object): Promise<void> {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatVerification);
}

export async function notifyChatEndpointWork(tx: object): Promise<void> {
  await notifyChatDeliveryWork(tx);
  await notifyChatPublicationWork(tx);
  for (const queue of Object.values(CHAT_ACTION_QUEUES)) await notifyDeliveryWork(tx, queue);
  await notifyChatVerificationWork(tx);
}
