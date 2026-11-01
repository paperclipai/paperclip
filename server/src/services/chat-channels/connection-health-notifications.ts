import type { ChatProvider } from "@paperclipai/shared";
import { notifyToolConnectionHealth } from "../tool-connection-health-notifications.js";
import { chatConnectionTransport } from "./provider-catalog.js";

export async function notifyChatConnectionHealth(transaction: object, endpoint: { companyId: string; connectionId: string; provider: ChatProvider }) {
  if (chatConnectionTransport(endpoint.provider) === "chat_sdk") return;
  await notifyToolConnectionHealth(transaction, { companyId: endpoint.companyId, id: endpoint.connectionId });
}
