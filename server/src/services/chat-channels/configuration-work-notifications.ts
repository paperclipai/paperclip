import { notifyVoiceChange } from "../voice/voice-recovery-notifications.js";
import { notifyChatReceiver, notifyChatConnectionReceiver, notifyChatCompanyReceivers } from "./runtime/receiver-work-notifications.js";
import type { ChatProvider, ToolConnectionTransport } from "@paperclipai/shared";
import { notifyDiscordCommandRegistration } from "./discord/command-work-notifications.js";

export async function notifyChatEndpointConfiguration(transaction: object, endpoint: { id: string; provider: ChatProvider }) {
  if (endpoint.provider === "speko") await notifyVoiceChange(transaction, { kind: "endpoint", id: endpoint.id });
  await notifyChatReceiver(transaction, endpoint);
  if (endpoint.provider === "discord") {
    await notifyDiscordCommandRegistration(transaction, { kind: "endpoint", id: endpoint.id });
  }
}

export async function notifyChatConnectionConfiguration(transaction: object, connectionId: string, transport: ToolConnectionTransport = "chat_sdk") {
  if (transport === "chat_sdk" || transport === "voice") await notifyVoiceChange(transaction, { kind: "connection", id: connectionId });
  await notifyChatConnectionObservation(transaction, connectionId, transport);
}

export async function notifyChatConnectionObservation(transaction: object, connectionId: string, transport: ToolConnectionTransport) {
  await notifyChatConnectionReceiver(transaction, connectionId, transport);
  if (transport === "chat_sdk") {
    await notifyDiscordCommandRegistration(transaction, { kind: "connection", id: connectionId });
  }
}

export async function notifyChatCompanyConfiguration(transaction: object, companyId: string) {
  await notifyVoiceChange(transaction, { kind: "company", id: companyId });
  await notifyChatCompanyReceivers(transaction, companyId);
  await notifyDiscordCommandRegistration(transaction, { kind: "company", id: companyId });
}
