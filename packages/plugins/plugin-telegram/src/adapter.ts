import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, editMessage as editTelegramMessage, escapeMarkdownV2 } from "./telegram-api.js";
import type { SendMessageOptions } from "./telegram-api.js";
import type { InlineKeyboardRow } from "./types.js";

export class TelegramAdapter {
  ctx: PluginContext;
  botToken: string;
  platformId = "telegram";

  constructor(ctx: PluginContext, botToken: string) {
    this.ctx = ctx;
    this.botToken = botToken;
  }

  async sendText(chatId: string, threadId: string, text: string, opts?: { replyTo?: string; silent?: boolean }) {
    const options: SendMessageOptions = { parseMode: "MarkdownV2" };
    if (threadId) options.messageThreadId = Number(threadId);
    if (opts?.replyTo) options.replyToMessageId = Number(opts.replyTo);
    if (opts?.silent) options.disableNotification = true;

    const messageId = await sendMessage(this.ctx, this.botToken, chatId, text, options);
    return {
      chatId,
      threadId: threadId || "",
      messageId: String(messageId ?? ""),
    };
  }

  async sendButtons(
    chatId: string,
    threadId: string,
    text: string,
    buttons: Array<{ label: string; callbackData: string }>,
  ) {
    const keyboard: InlineKeyboardRow[] = [];
    for (let i = 0; i < buttons.length; i += 2) {
      const row = buttons.slice(i, i + 2).map((b) => ({
        text: b.label,
        callback_data: b.callbackData,
      }));
      keyboard.push(row);
    }
    const options: SendMessageOptions = { parseMode: "MarkdownV2", inlineKeyboard: keyboard };
    if (threadId) options.messageThreadId = Number(threadId);

    const messageId = await sendMessage(this.ctx, this.botToken, chatId, text, options);
    return {
      chatId,
      threadId: threadId || "",
      messageId: String(messageId ?? ""),
    };
  }

  async editMessage(
    ref: { chatId: string; messageId: string },
    text: string,
    buttons?: Array<{ label: string; callbackData: string }>,
  ) {
    const keyboard: InlineKeyboardRow[] | undefined = buttons
      ? (() => {
          const rows: InlineKeyboardRow[] = [];
          for (let i = 0; i < buttons.length; i += 2) {
            const row = buttons.slice(i, i + 2).map((b) => ({
              text: b.label,
              callback_data: b.callbackData,
            }));
            rows.push(row);
          }
          return rows;
        })()
      : undefined;
    await editTelegramMessage(this.ctx, this.botToken, ref.chatId, Number(ref.messageId), text, {
      parseMode: "MarkdownV2",
      inlineKeyboard: keyboard,
    });
  }

  formatAgentLabel(agentName: string) {
    return `*\\[${escapeMarkdownV2(agentName)}\\]*`;
  }
  formatMention(userId: string) {
    return `@${escapeMarkdownV2(userId)}`;
  }
  formatCodeBlock(code: string, lang?: string) {
    return lang ? `\`\`\`${lang}\n${code}\n\`\`\`` : `\`\`\`\n${code}\n\`\`\``;
  }
}
