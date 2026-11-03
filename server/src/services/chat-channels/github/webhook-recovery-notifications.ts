import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";

export type GitHubWebhookRecoveryScope = { kind: "endpoint" | "connection" | "company"; id: string };

export async function notifyGitHubWebhookRecovery(transaction: object, scope: GitHubWebhookRecoveryScope) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.chatGitHubWebhookRecovery, JSON.stringify(scope));
}
