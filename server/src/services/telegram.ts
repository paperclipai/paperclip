import { logger } from "../middleware/logger.js";

const TELEGRAM_API = "https://api.telegram.org";

interface TelegramConfig {
  botToken: string;
  defaultChatId: string;
}

function getConfig(): TelegramConfig | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const defaultChatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !defaultChatId) return null;
  return { botToken, defaultChatId };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendMessage(botToken: string, chatId: string, text: string): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body }, "Telegram sendMessage failed");
    }
  } catch (err) {
    logger.warn({ err }, "Telegram sendMessage request error");
  }
}

export type NotifyOpsSeverity = "info" | "warn" | "error";

const SEVERITY_PREFIX: Record<NotifyOpsSeverity, string> = {
  info: "\u2139\uFE0F [PAPERCLIP INFO]",
  warn: "\u26A0\uFE0F [PAPERCLIP WARN]",
  error: "\u{1F6A8} [PAPERCLIP ERROR]",
};

/**
 * Send an operational alert to the configured Telegram chat. Used by the
 * server's background health checks and any other "wake an operator up"
 * code path. No-ops silently when TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 * aren't set so unconfigured environments don't crash.
 */
export async function notifyOps(
  message: string,
  severity: NotifyOpsSeverity = "info",
): Promise<void> {
  const config = getConfig();
  if (!config) return;
  const prefix = SEVERITY_PREFIX[severity];
  const text = `${prefix} ${escapeHtml(message)}`;
  await sendMessage(config.botToken, config.defaultChatId, text);
}
