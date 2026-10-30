import { forbidden } from "../../../errors.js";

import type { EndpointRow } from "../runtime-types.js";
import type { chatConversations, chatDeliveries } from "@paperclipai/db";
export function assertSlackWakeMention(endpoint: EndpointRow, conversation: Pick<typeof chatConversations.$inferSelect, "isDirectMessage">, delivery: Pick<typeof chatDeliveries.$inferSelect, "normalizedEvent">): void {
  if (
    endpoint.requireAtMention &&
    !conversation.isDirectMessage &&
    delivery.normalizedEvent.trigger !== "mention" &&
    (delivery.normalizedEvent.message as { mentionedBot?: boolean } | undefined)?.mentionedBot !== true
  ) {
    throw forbidden("Message did not @mention the bot", {
      code: "chat_action_authorization_changed",
    });
  }
}
