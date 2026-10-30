import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";

export type CommandRegistrationScope =
  | { kind: "endpoint"; id: string }
  | { kind: "connection"; id: string }
  | { kind: "company"; id: string };

export async function notifyDiscordCommandRegistration(transaction: object, scope: CommandRegistrationScope) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.chatCommandRegistration, `${scope.kind}:${scope.id}`);
}
