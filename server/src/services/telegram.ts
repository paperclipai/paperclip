import type { LiveEvent } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { subscribeAllLiveEvents } from "./live-events.js";
import type { Db } from "@paperclipai/db";
import { companies, projectMembers, issueComments } from "@paperclipai/db";
import { eq, and, inArray } from "drizzle-orm";

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

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

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

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

// ---------------------------------------------------------------------------
// Ops alerting (no DB required)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveChatId(
  db: Db,
  config: TelegramConfig,
  companyId: string | undefined,
): Promise<string> {
  if (companyId) {
    try {
      const rows = await db
        .select({ settings: companies.settings })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      const settings = rows[0]?.settings as Record<string, unknown> | undefined;
      const telegram = settings?.telegram as { chatId?: string } | undefined;
      const chatId = telegram?.chatId?.trim();
      if (chatId) return chatId;
    } catch {
      // best-effort
    }
  }
  return config.defaultChatId;
}

function extractUserMentions(text: string): string[] {
  const regex = /\[.*?\]\(user:\/\/([^)]+)\)/g;
  const ids: string[] = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

async function hasSuperAdminMention(
  db: Db,
  companyId: string,
  userIds: string[],
): Promise<boolean> {
  if (userIds.length === 0) return false;
  const rows = await db
    .select({ principalId: projectMembers.principalId })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.companyId, companyId),
        eq(projectMembers.role, "super_admin"),
        eq(projectMembers.principalType, "user"),
        inArray(projectMembers.principalId, userIds),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Event handler
// ---------------------------------------------------------------------------

type ActivityPayload = {
  action?: string;
  actorType?: string;
  actorId?: string;
  agentId?: string | null;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown> | null;
};

async function handleActivityLogged(
  event: LiveEvent,
  db: Db,
  config: TelegramConfig,
): Promise<void> {
  const p = event.payload as unknown as ActivityPayload;
  if (p.action !== "issue.comment_added") return;

  const details = p.details ?? {};
  const commentId = details.commentId as string | undefined;

  // Fetch full comment body, fall back to bodySnippet
  let commentBody = (details.bodySnippet as string) ?? "";
  if (commentId) {
    try {
      const rows = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.id, commentId))
        .limit(1);
      if (rows[0]?.body) commentBody = rows[0].body;
    } catch {
      // use bodySnippet fallback
    }
  }

  const mentionedUserIds = extractUserMentions(commentBody);
  if (mentionedUserIds.length === 0) return;

  const companyId = event.companyId;
  if (!companyId) return;

  const isSuperAdmin = await hasSuperAdminMention(db, companyId, mentionedUserIds);
  if (!isSuperAdmin) return;

  const identifier = (details.identifier as string) ?? p.entityId ?? "";
  const issueTitle = (details.issueTitle as string) ?? "";
  const actorLabel = p.agentId ?? p.actorId ?? "someone";

  const lines = [
    `\u{1F6A8} <b>Escalation: super admin tagged in ${escapeHtml(identifier)}</b>`,
    escapeHtml(truncate(commentBody, 300)),
    `<i>${escapeHtml(truncate(issueTitle, 100))}</i>`,
    `by ${escapeHtml(actorLabel)}`,
  ];

  const chatId = await resolveChatId(db, config, companyId);
  void sendMessage(config.botToken, chatId, lines.join("\n"));
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export function initTelegramNotifications(db: Db): boolean {
  const config = getConfig();
  if (!config) {
    logger.info("Telegram notifications disabled (TELEGRAM_BOT_TOKEN not set)");
    return false;
  }

  subscribeAllLiveEvents((event: LiveEvent) => {
    try {
      if (event.type === "activity.logged") {
        void handleActivityLogged(event, db, config);
      }
    } catch (err) {
      logger.warn({ err, eventType: event.type }, "Telegram event handler error");
    }
  });

  logger.info("Telegram escalation notifications enabled");
  return true;
}
