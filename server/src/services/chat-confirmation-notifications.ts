import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type ChatConfirmationScope = { companyId: string; issueId?: string };

export async function notifyChatConfirmationWork(tx: object, scope: ChatConfirmationScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.chatTerminalConfirmations,
    JSON.stringify({ companyId: scope.companyId, issueId: scope.issueId }));
}

/** Interaction resolution can release a callback parked while its human input
 * was pending. Register on the owning transaction before its resolution write. */
export async function notifyChatConfirmationResolution(tx: object, interaction: ChatConfirmationScope & { kind: string }) {
  if (["request_confirmation", "request_checkbox_confirmation", "suggest_tasks", "connection_intent"].includes(interaction.kind)) {
    await notifyChatConfirmationWork(tx, interaction);
  }
}
