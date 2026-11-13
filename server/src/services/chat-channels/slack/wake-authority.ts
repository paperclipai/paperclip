import { forbidden } from "../../../errors.js";
import { slackMessageMeetsMentionRequirement } from "./messages.js";

import type { EndpointRow } from "../runtime-types.js";
import type { chatConversations, chatDeliveries } from "@paperclipai/db";

type SlackDeliveryEvent = typeof chatDeliveries.$inferSelect["normalizedEvent"];

export function slackDeliveryMeetsMentionRequirement(
  endpoint: Pick<EndpointRow, "requireAtMention">,
  event: SlackDeliveryEvent,
  isDirectMessage?: boolean,
): boolean {
  const conversation = event.conversation as {
    externalThreadId?: unknown;
    isDirectMessage?: boolean;
  } | undefined;
  const message = event.message as {
    providerMessageId?: unknown;
    mentionedBot?: boolean;
  } | undefined;
  return slackMessageMeetsMentionRequirement(
    endpoint,
    {
      id: typeof conversation?.externalThreadId === "string" ? conversation.externalThreadId : "",
      isDM: isDirectMessage ?? conversation?.isDirectMessage === true,
    },
    event.trigger === "mention" ? "mention" : "subscribed_message",
    {
      id: typeof message?.providerMessageId === "string" ? message.providerMessageId : "",
      isMention: message?.mentionedBot === true,
    },
  );
}

export function assertSlackWakeMention(
  endpoint: EndpointRow,
  conversation: Pick<typeof chatConversations.$inferSelect, "isDirectMessage">,
  delivery: Pick<typeof chatDeliveries.$inferSelect, "normalizedEvent">,
): void {
  if (!slackDeliveryMeetsMentionRequirement(endpoint, delivery.normalizedEvent, conversation.isDirectMessage)) {
    throw forbidden("Message did not @mention the bot", {
      code: "chat_action_authorization_changed",
    });
  }
}
