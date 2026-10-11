import { signalDatabaseWork, subscribeDatabaseWork } from "@paperclipai/db";

/** Topics for existing durable queues; register intent before their writes. */
export const DELIVERY_QUEUES = {
  chatBoardMessages: "chat-board-messages",
  chatTaskStarts: "chat-task-starts",
  chatReceiptReactions: "chat-receipt-reactions",
  chatSessionStops: "chat-session-stops",
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
  toolAction: "tool-action-receipts",
} as const;
export type DeliveryQueue = typeof DELIVERY_QUEUES[keyof typeof DELIVERY_QUEUES];

export async function notifyDeliveryWork(transaction: object, queue: DeliveryQueue): Promise<void> {
  await signalDatabaseWork(transaction, queue);
}
// Public delivery notification observers only see settled work. The coordinator
// uses the lower-level lifecycle subscription to also fence in-flight writes.
export function subscribeDeliveryWork(owner: object, queue: DeliveryQueue, wake: () => void): () => void {
  return subscribeDatabaseWork(owner, queue, event => {
    if (event === "settled") wake();
  });
}
