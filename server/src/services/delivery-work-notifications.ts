import { signalDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db";

/** Topics for existing durable queues; register intent before their writes. */
export const DELIVERY_QUEUES = {
  chatBoardMessages: "chat-board-messages",
  chatTaskStarts: "chat-task-starts",
  chatReceiptReactions: "chat-receipt-reactions",
  chatSessionStops: "chat-session-stops",
  chatProviderEffects: "chat-provider-effects",
  chatGitHubIngress: "chat-github-ingress",
  chatFailedRunRetries: "chat-failed-run-retries",
  chatTelegramMaintenance: "chat-telegram-maintenance",
  chatTelegramSubscriptions: "chat-telegram-subscriptions",
  chatSessionSyncs: "chat-session-syncs",
  chatVerification: "chat-verification",
  chatInbound: "chat-inbound",
  chatPublications: "chat-publications",
  chatReceipts: "chat-slack-receipts",
  browser: "browser-use",
  email: "email-channels",
  fastResponse: "fast-responses",
  feedback: "feedback-exports",
  chatCompletion: "chat-completions",
  connection: "connection-continuations",
  question: "question-responses",
  pluginLifecycle: "plugin-resource-lifecycle",
  toolAction: "tool-action-receipts",
} as const;
export type DeliveryQueue = typeof DELIVERY_QUEUES[keyof typeof DELIVERY_QUEUES];

export async function notifyDeliveryWork(transaction: object, queue: DeliveryQueue, hint?: string): Promise<void> {
  await signalDatabaseWork(transaction, queue, hint);
}
// Public delivery notification observers only see settled work. The coordinator
// uses the lower-level lifecycle subscription to also fence in-flight writes.
export function subscribeDeliveryWork(owner: object, queue: DeliveryQueue, wake: () => void): () => void {
  return subscribeDatabaseWork(owner, queue, event => {
    if (event === "settled") wake();
  });
}
