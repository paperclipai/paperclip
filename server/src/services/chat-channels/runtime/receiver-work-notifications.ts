import type { ChatProvider, ToolConnectionTransport } from "@paperclipai/shared";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { leasedChatProvider } from "./receiver-policy.js";

export type ReceiverScope = { kind: "endpoint" | "connection" | "company"; id: string };
export function receiverScope(hint: string): ReceiverScope | undefined {
  if (hint === "*") return undefined;
  const [kind, id, extra] = hint.split(":");
  if (!id || extra !== undefined || (kind !== "endpoint" && kind !== "connection" && kind !== "company"))
    throw new Error("Invalid receiver discovery scope");
  return { kind, id };
}
export const receiverScopeHint = (scope: ReceiverScope) => `${scope.kind}:${scope.id}`;
export async function notifyChatReceiver(transaction: object, endpoint: { id: string; provider: ChatProvider }) {
  if (leasedChatProvider(endpoint.provider))
    await notifyDeliveryWork(transaction, DELIVERY_QUEUES.chatReceivers, receiverScopeHint({ kind: "endpoint", id: endpoint.id }));
}
export async function notifyChatConnectionReceiver(transaction: object, connectionId: string, transport: ToolConnectionTransport = "chat_sdk") {
  if (transport === "chat_sdk")
    await notifyDeliveryWork(transaction, DELIVERY_QUEUES.chatReceivers, receiverScopeHint({ kind: "connection", id: connectionId }));
}
export async function notifyChatCompanyReceivers(transaction: object, companyId: string) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.chatReceivers, receiverScopeHint({ kind: "company", id: companyId }));
}
