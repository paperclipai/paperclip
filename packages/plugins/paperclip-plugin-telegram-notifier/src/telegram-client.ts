/**
 * Thin wrapper around the Telegram Bot API.
 *
 * - All requests go through `ctx.http.fetch` so the host can audit them.
 * - The token is stored only as a Paperclip secret reference. `resolveToken`
 *   resolves it per company at use time; a literal token in config is refused
 *   (see `botTokenConfigError`).
 * - The Telegram envelope `{ ok, result, description }` is normalized: success
 *   returns `result`, failure throws with the API description.
 */

import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";
import { TELEGRAM_API_BASE, POLL_TIMEOUT_SEC, POLL_LIMIT, BOT_COMMANDS } from "./constants.js";
import type {
  InlineKeyboard,
  TelegramApiResponse,
  TelegramUpdate,
  TelegramUser,
} from "./types.js";

export interface TelegramClient {
  /** Numeric bot id — the non-secret prefix of the token before `:`. */
  botId: string;
  getMe(): Promise<TelegramUser>;
  setMyCommands(): Promise<void>;
  /** Long poll: Telegram answers at once when an update exists, else after `timeoutSec`. */
  getUpdates(offset: number | undefined, timeoutSec?: number): Promise<TelegramUpdate[]>;
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
  /**
   * Replace both the text and (optionally) the inline-keyboard of a previously
   * sent message. Used to close out a confirmation message after Approve /
   * Decline so the chat history shows the resolution and the buttons stop
   * accepting input.
   */
  editMessageText(params: {
    chatId: string;
    messageId: number;
    text: string;
    keyboard?: InlineKeyboard;
  }): Promise<void>;
}

/** `token` is the resolved bot token from `loadConfig`, never a stored value. */
export async function createTelegramClient(
  ctx: PluginContext,
  token: string,
): Promise<TelegramClient> {
  const base = `${TELEGRAM_API_BASE}/bot${token}`;

  async function call<T>(method: string, body?: unknown): Promise<T> {
    let res: Response;
    let envelope: TelegramApiResponse<T>;
    try {
      res = await ctx.http.fetch(`${base}/${method}`, {
        method: "POST",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      envelope = (await res.json()) as TelegramApiResponse<T>;
    } catch (err) {
      // A host fetch error can quote the request URL, and the URL holds the token.
      throw new Error(`Telegram API ${method} request failed: ${errorText(err, token)}`);
    }
    if (!envelope.ok || envelope.result === undefined) {
      throw new Error(
        redactBotToken(
          `Telegram API ${method} failed: ${envelope.description ?? `HTTP ${res.status}`}`,
          token,
        ),
      );
    }
    return envelope.result;
  }

  return {
    botId: botIdFromToken(token),
    async getMe() {
      return call<TelegramUser>("getMe");
    },
    async setMyCommands() {
      await call<true>("setMyCommands", { commands: BOT_COMMANDS });
    },
    async getUpdates(offset, timeoutSec = POLL_TIMEOUT_SEC) {
      return call<TelegramUpdate[]>("getUpdates", {
        offset,
        timeout: timeoutSec,
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
    async editMessageText({ chatId, messageId, text, keyboard }) {
      // Reuse the same URL-sanitization rules as sendMessage so a confirmation
      // closeout message can't accidentally contain a localhost URL button.
      const safe = sanitizeKeyboardForTelegram(text, keyboard);
      const body: Record<string, unknown> = {
        chat_id: chatId,
        message_id: messageId,
        text: safe.text,
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      };
      if (safe.keyboard && safe.keyboard.length > 0) {
        body.reply_markup = { inline_keyboard: safe.keyboard };
      } else {
        body.reply_markup = { inline_keyboard: [] };
      }
      await call<unknown>("editMessageText", body);
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

/**
 * The numeric bot id from a resolved token (`<bot id>:<secret>`). The id is
 * public (it is part of the bot's identity), so it is safe to use as a state
 * key. Values that do not look like a token map to a stable placeholder.
 */
export function botIdFromToken(token: string): string {
  const match = token.trim().match(/^(\d+):/);
  return match ? match[1]! : "unknown";
}

const REDACTED = "<redacted>";

/**
 * `/bot<id>:<secret>` in a Bot API URL. Only the token shape matches, so
 * ordinary paths such as `/bots/handler.ts` or `/bot123/readme` stay intact.
 */
const BOT_URL_TOKEN_PATTERN = /\/bot\d+(?::|%3A)[A-Za-z0-9_-]+/gi;

/**
 * Mask the bot token in error text that is logged, stored, returned or sent:
 * the exact token when the caller holds it (raw and URI-encoded), and the
 * `/bot<token>` segment of any Bot API URL. Never run it on user content.
 */
export function redactBotToken(text: string, token?: string): string {
  let out = text;
  if (token) {
    const forms = [token];
    try {
      forms.push(encodeURI(token));
    } catch {
      // A lone surrogate cannot be URI-encoded; the raw form is still masked.
    }
    for (const form of forms) out = out.split(form).join(REDACTED);
  }
  return out.replace(BOT_URL_TOKEN_PATTERN, `/bot${REDACTED}`);
}

/** `err`'s message with the bot token masked; use it wherever an error becomes text. */
export function errorText(err: unknown, token?: string): string {
  return redactBotToken(err instanceof Error ? err.message : String(err), token);
}

const LITERAL_TOKEN_PATTERN = /\d+:[A-Za-z0-9_-]{30,}/;

/** Shown to the operator when `botToken` is not a Paperclip secret reference. */
export const BOT_TOKEN_SECRET_REQUIRED_MESSAGE =
  "The Telegram bot token must be stored as a Paperclip secret. Create a company secret that holds the token, then select that secret in the Telegram Notifier settings. A literal token in plugin config is not accepted.";

export function isSecretRefBinding(value: unknown): value is EnvSecretRefBinding {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as { type?: unknown }).type === "secret_ref"
    && typeof (value as { secretId?: unknown }).secretId === "string";
}

/**
 * Check a stored `botToken`. Returns the operator-facing error, or null when
 * the value is empty or a secret reference. The message never echoes the value.
 */
export function botTokenConfigError(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (isSecretRefBinding(value)) return null;
  if (typeof value === "string" && LITERAL_TOKEN_PATTERN.test(value)) {
    return BOT_TOKEN_SECRET_REQUIRED_MESSAGE;
  }
  return `botToken must be a Paperclip secret reference. ${BOT_TOKEN_SECRET_REQUIRED_MESSAGE}`;
}

/** Shown to the operator when the bound secret cannot be resolved. */
export const BOT_TOKEN_UNRESOLVED_MESSAGE =
  "The Telegram bot token secret could not be resolved. Check that the secret still exists and is enabled, then select it again in the Telegram Notifier settings.";

/**
 * True when the host refused a secret resolution because the plugin hit its
 * per-company limit (30 per minute, `RateLimitExceededError`). Only the
 * message may survive the worker RPC, so both are checked.
 */
export function isRateLimitError(err: unknown): boolean {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /rate.?limit/i.test(text);
}

/**
 * Resolve the configured secret reference for the company that owns the
 * config row. The token is resolved at call time and returned to the caller
 * only; it is never cached, stored or logged.
 */
export async function resolveToken(
  ctx: PluginContext,
  ref: EnvSecretRefBinding,
  companyId: string,
): Promise<string> {
  return (await ctx.secrets.resolve(ref, { companyId, configPath: "botToken" })).trim();
}
