import type { Message } from "chat";
import type { ChatProvider } from "@paperclipai/shared";
import { slackInboundRequestText } from "../slack/messages.js";

// Provider rendering belongs to the provider module. All persisted request
// paths select it here, separately from the SDK's routing/display text.
export function inboundRequestText(provider: ChatProvider, message: Message): string {
  return provider === "slack" ? slackInboundRequestText(message) : message.text;
}
