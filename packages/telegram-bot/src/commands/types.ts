import type { CodeStore } from "../state/code-store.js";
import type { ReplyStore, ReplyTarget } from "../state/reply-store.js";
import type { PaperclipClient } from "../api/paperclip-client.js";

export type IncomingMessageContext = {
  chatId: string;
  tgUserId?: string | null;
  tgUsername?: string | null;
  text: string;
  /** Telegram message id of the message this update is replying to, if any. */
  replyToMessageId?: number | null;
  /** Reply back to the user. */
  reply: (text: string) => Promise<void>;
};

export type CommandDeps = {
  client: PaperclipClient;
  codeStore: CodeStore;
  replyStore: ReplyStore;
};

export type CommandHandler = (ctx: IncomingMessageContext, deps: CommandDeps) => Promise<void>;

export type ReplyResolver = (
  chatId: string,
  messageId: number,
) => ReplyTarget | null;
