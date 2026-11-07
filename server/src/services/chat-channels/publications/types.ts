import type { chatConversations, chatPublications } from "@paperclipai/db";
import type { SafeChatPublicationPayload } from "@paperclipai/shared";
import type { EndpointRow } from "../runtime-types.js";
import type { TelegramDraftControl } from "../../chat-telegram-draft-stop.js";
import type { SlackFileUploadAcceptedReceipt } from "../../chat-sdk-runtime.js";
type ConversationRow = typeof chatConversations.$inferSelect;
export type PublicationTransportInput = {
    endpoint: EndpointRow;
    conversation: ConversationRow;
    publication: typeof chatPublications.$inferSelect;
    payload: SafeChatPublicationPayload;
    replaceProviderMessageId?: string | null;
    telegramDraftControl?: TelegramDraftControl;
    beforePhotonWrite?(): Promise<void>;
    onSlackFileUploadAccepted?: (
      receipt: SlackFileUploadAcceptedReceipt,
    ) => Promise<void>;
  };
