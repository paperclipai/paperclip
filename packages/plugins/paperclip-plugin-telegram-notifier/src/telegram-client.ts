/**
 * Thin wrapper around the Telegram Bot API.
 *
 * - All requests go through `ctx.http.fetch` so the host can audit them.
 * - Token resolution is lazy: the field stored in plugin config is treated as
 *   a Paperclip secret reference first; if no provider resolves it the value
 *   is used verbatim. This keeps local-trusted setups one-step while letting
 *   shared deployments stash the token in a real secret provider.
 * - The Telegram envelope `{ ok, result, description }` is normalized: success
 *   returns `result`, failure throws with the API description.
 */

import type { PluginContext } from "@paperclipai/plugin-sdk";
import { TELEGRAM_API_BASE, POLL_TIMEOUT_SEC, POLL_LIMIT, BOT_COMMANDS } from "./constants.js";
import type {
  InlineKeyboard,
  TelegramApiResponse,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

export interface TelegramClient {
  getMe(): Promise<TelegramUser>;
  setMyCommands(): Promise<void>;
  getUpdates(offset: number | undefined): Promise<TelegramUpdate[]>;
  sendMessage(params: {
    chatId: string;
    text: string;
    keyboard?: InlineKeyboard;
    silent?: boolean;
    replyToMessageId?: number;
    /** When set, tells Telegram to auto-focus the input field as a reply
     *  to this message, with the given placeholder hint. Mutually exclusive
     *  with `keyboard` — Telegram allows only one reply_markup per message. */
    forceReply?: { placeholder?: string; selective?: boolean };
  }): Promise<{ message_id: number }>;
  answerCallbackQuery(params: {
    callbackQueryId: string;
    text?: string;
    showAlert?: boolean;
  }): Promise<void>;
  editMessageReplyMarkup(params: {
    chatId: string;
    messageId: number;
    keyboard?: InlineKeyboard;
  }): Promise<void>;
}

export async function createTelegramClient(
  ctx: PluginContext,
  tokenOrRef: string,
): Promise<TelegramClient> {
  const token = await resolveToken(ctx, tokenOrRef);
  const base = `${TELEGRAM_API_BASE}/bot${token}`;

  async function call<T>(method: string, body?: unknown): Promise<T> {
    const res = await ctx.http.fetch(`${base}/${method}`, {
      method: "POST",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const envelope = (await res.json()) as TelegramApiResponse<T>;
    if (!envelope.ok || envelope.result === undefined) {
      throw new Error(
        `Telegram API ${method} failed: ${envelope.description ?? `HTTP ${res.status}`}`,
      );
    }
    return envelope.result;
  }

  return {
    async getMe() {
      return call<TelegramUser>("getMe");
    },
    async setMyCommands() {
      await call<true>("setMyCommands", { commands: BOT_COMMANDS });
    },
    async getUpdates(offset) {
      return call<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout: POLL_TIMEOUT_SEC,
        limit: POLL_LIMIT,
        allowed_updates: ["message", "callback_query"],
      });
    },
    async sendMessage({
      chatId,
      text,
      keyboard,
      silent,
      replyToMessageId,
      forceReply,
    }) {
      // Telegram rejects inline-keyboard URL buttons that don't use https://
      // or tg://. Localhost / private-IP HTTP links — common in self-hosted
      // Paperclip setups — fail with "Wrong HTTP URL". Pre-strip those
      // buttons and surface the URLs as plain code-span text instead.
      const safe = sanitizeKeyboardForTelegram(text, keyboard);
      const body: Record<string, unknown> = {
        chat_id: chatId,
        text: safe.text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
        disable_notification: silent ?? false,
      };
      if (replyToMessageId !== undefined) {
        body.reply_to_message_id = replyToMessageId;
        body.allow_sending_without_reply = true;
      }
      // Telegram allows only one `reply_markup` per message, so force_reply
      // takes precedence over an inline keyboard if both are requested.
      if (forceReply) {
        body.reply_markup = {
          force_reply: true,
          input_field_placeholder: forceReply.placeholder,
          selective: forceReply.selective ?? true,
        };
      } else if (safe.keyboard && safe.keyboard.length > 0) {
        body.reply_markup = { inline_keyboard: safe.keyboard };
      }
      return call<{ message_id: number }>("sendMessage", body);
    },
    async answerCallbackQuery({ callbackQueryId, text, showAlert }) {
      const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
      if (text) body.text = text;
      if (showAlert) body.show_alert = true;
      await call<true>("answerCallbackQuery", body);
    },
    async editMessageReplyMarkup({ chatId, messageId, keyboard }) {
      const body: Record<string, unknown> = {
        chat_id: chatId,
        message_id: messageId,
      };
      if (keyboard && keyboard.length > 0) {
        body.reply_markup = { inline_keyboard: keyboard };
      } else {
        body.reply_markup = { inline_keyboard: [] };
      }
      await call<unknown>("editMessageReplyMarkup", body);
    },
  };
}

/**
 * Replace inline-keyboard URL buttons that Telegram won't accept (anything
 * other than `https://` or `tg://` — including `http://localhost`, private
 * IPs, and `.local` hostnames) with code-span URL fragments embedded in the
 * message text. Callback-data buttons and well-formed https/tg:// buttons
 * are preserved intact.
 *
 * MarkdownV2 inside `code spans` only requires `\\` and `` ` `` to be
 * escaped, so we can paste URLs verbatim and they remain tappable in the
 * Telegram client.
 */
function sanitizeKeyboardForTelegram(
  text: string,
  keyboard?: InlineKeyboard,
): { text: string; keyboard?: InlineKeyboard } {
  if (!keyboard || keyboard.length === 0) {
    return { text, keyboard: undefined };
  }
  const validRows: InlineKeyboard = [];
  const droppedLinks: Array<{ label: string; url: string }> = [];
  for (const row of keyboard) {
    const validButtons = row.filter((b) => {
      if ("callback_data" in b) return true;
      return isTelegramAcceptedUrl(b.url);
    });
    const dropped = row.filter(
      (b) => "url" in b && !isTelegramAcceptedUrl((b as { url: string }).url),
    );
    for (const b of dropped) {
      droppedLinks.push({
        label: (b as { text: string }).text,
        url: (b as { url: string }).url,
      });
    }
    if (validButtons.length > 0) validRows.push(validButtons);
  }
  if (droppedLinks.length === 0) {
    return { text, keyboard: validRows };
  }
  // Telegram silently drops the URL of an MD-V2 inline link when the URL
  // isn't public (e.g. `http://localhost`), leaving only the label as plain
  // text — which is misleading because the user has no way to open the
  // resource. Render the URL inline as a code-span instead: the URL itself
  // is visible, tappable on long-press in most clients, and Telegram does
  // recognise URLs inside code-spans for the standard open/copy menu.
  const tail = droppedLinks
    .map((l) => `${escapeMdV2Lite(l.label)}: ${escapeMdV2CodeSpan(l.url)}`)
    .join("\n");
  return {
    text: `${text}\n\n${tail}`,
    keyboard: validRows.length > 0 ? validRows : undefined,
  };
}

function escapeMdV2CodeSpan(url: string): string {
  // Inside MarkdownV2 code-spans, only `\` and `` ` `` need escaping.
  return "`" + url.replace(/[\\`]/g, (m) => `\\${m}`) + "`";
}

function isTelegramAcceptedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // Telegram only accepts https:// and tg:// for inline-keyboard URL
    // buttons. http:// is technically allowed by the schema but rejected at
    // runtime for non-public hosts (localhost, RFC1918, .local, etc.), and
    // there is no portable way to know upfront whether a given hostname is
    // reachable from the user's phone, so we restrict to https/tg.
    return u.protocol === "https:" || u.protocol === "tg:";
  } catch {
    return false;
  }
}

function escapeMdV2Lite(input: string): string {
  // Mirrors the MarkdownV2 reserved set used by format.ts. Duplicated here
  // to keep telegram-client free of cross-module imports of format helpers.
  return input.replace(/[_*\[\]()~`>#+=|{}.!\\-]/g, (m) => `\\${m}`);
}

async function resolveToken(
  ctx: PluginContext,
  ref: string,
): Promise<string> {
  const trimmed = ref.trim();
  // Heuristic: real Telegram bot tokens look like "<digits>:<base64ish>".
  // If it already looks like a token, use it verbatim — saves a doomed
  // secret-resolve call and avoids a noisy log line in local-trusted setups.
  if (/^\d+:[A-Za-z0-9_-]{20,}$/.test(trimmed)) return trimmed;
  try {
    return await ctx.secrets.resolve(trimmed);
  } catch {
    return trimmed;
  }
}
