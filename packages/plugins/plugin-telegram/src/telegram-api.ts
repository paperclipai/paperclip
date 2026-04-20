import type { PluginContext } from "@paperclipai/plugin-sdk";
import { METRIC_NAMES } from "./constants.js";
import type { TelegramApiResponse, EditMessageOptions, InlineKeyboardRow } from "./types.js";

const TELEGRAM_API = "https://api.telegram.org";

export interface SendMessageOptions {
  parseMode?: "MarkdownV2";
  replyToMessageId?: number;
  messageThreadId?: number;
  disableNotification?: boolean;
  inlineKeyboard?: InlineKeyboardRow[];
}

export async function sendMessage(
  ctx: PluginContext,
  token: string,
  chatId: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<number | null> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };

  if (options.parseMode) body.parse_mode = options.parseMode;
  if (options.replyToMessageId) body.reply_to_message_id = options.replyToMessageId;
  if (options.messageThreadId) body.message_thread_id = options.messageThreadId;
  if (options.disableNotification) body.disable_notification = true;
  if (options.inlineKeyboard) {
    body.reply_markup = { inline_keyboard: options.inlineKeyboard };
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as TelegramApiResponse<{ message_id: number }>;

      if (!data.ok) {
        if (data.parameters?.retry_after && attempt < 2) {
          const wait = data.parameters.retry_after * 1000;
          ctx.logger.warn("Telegram rate limited, retrying", {
            retryAfter: data.parameters.retry_after,
            attempt,
          });
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        if (options.parseMode === "MarkdownV2") {
          ctx.logger.warn("MarkdownV2 send failed, retrying as plain text", {
            error: data.description,
          });
          return sendMessage(ctx, token, chatId, stripMarkdown(text), {
            ...options,
            parseMode: undefined,
          });
        }
        ctx.logger.error("Telegram sendMessage failed", { error: data.description });
        await ctx.metrics.write(METRIC_NAMES.failed, 1);
        return null;
      }

      await ctx.metrics.write(METRIC_NAMES.sent, 1);
      return data.result?.message_id ?? null;
    } catch (err) {
      ctx.logger.error("Telegram API error", { error: String(err) });
      await ctx.metrics.write(METRIC_NAMES.failed, 1);
      return null;
    }
  }
  return null;
}

export async function editMessage(
  ctx: PluginContext,
  token: string,
  chatId: string,
  messageId: number,
  text: string,
  options: EditMessageOptions = {},
): Promise<boolean> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };

  if (options.parseMode) body.parse_mode = options.parseMode;
  if (options.inlineKeyboard) {
    body.reply_markup = { inline_keyboard: options.inlineKeyboard };
  } else {
    body.reply_markup = { inline_keyboard: [] };
  }

  try {
    const res = await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as TelegramApiResponse;
    return data.ok;
  } catch (err) {
    ctx.logger.error("Telegram editMessage failed", { error: String(err) });
    return false;
  }
}

export async function answerCallbackQuery(
  ctx: PluginContext,
  token: string,
  callbackQueryId: string,
  text: string,
): Promise<void> {
  try {
    await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
      }),
    });
  } catch (err) {
    ctx.logger.error("Telegram answerCallbackQuery failed", { error: String(err) });
  }
}

export async function setMyCommands(
  ctx: PluginContext,
  token: string,
  commands: Array<{ command: string; description: string }>,
): Promise<boolean> {
  try {
    const res = await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    const data = (await res.json()) as TelegramApiResponse;
    return data.ok;
  } catch (err) {
    ctx.logger.error("Telegram setMyCommands failed", { error: String(err) });
    return false;
  }
}

export async function sendChatAction(
  ctx: PluginContext,
  token: string,
  chatId: string,
  action = "typing",
): Promise<void> {
  try {
    await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action }),
    });
  } catch {
    // Typing indicator failures are non-critical
  }
}

// MarkdownV2 requires escaping these characters
const MD_ESCAPE_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(text: string): string {
  return text.replace(MD_ESCAPE_CHARS, "\\$1");
}

export function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const truncated = text.slice(0, maxLen);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.7 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

function stripMarkdown(text: string): string {
  return text.replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1").replace(/[*_`~]/g, "");
}
