import type { LiveEvent } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { subscribeAllLiveEvents } from "./live-events.js";
import type { Db } from "@paperclipai/db";
import { companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";

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
// Per-company chat ID resolution (cached)
// ---------------------------------------------------------------------------

const companyChatIdCache = new Map<string, { chatId: string | null; expiresAt: number }>();
const CACHE_TTL_MS = 60_000; // 1 minute

async function getCompanyChatId(db: Db, companyId: string): Promise<string | null> {
  const cached = companyChatIdCache.get(companyId);
  if (cached && cached.expiresAt > Date.now()) return cached.chatId;

  try {
    const rows = await db
      .select({ settings: companies.settings })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const settings = rows[0]?.settings as Record<string, unknown> | undefined;
    const telegram = settings?.telegram as { chatId?: string } | undefined;
    const chatId = telegram?.chatId?.trim() || null;
    companyChatIdCache.set(companyId, { chatId, expiresAt: Date.now() + CACHE_TTL_MS });
    return chatId;
  } catch (err) {
    logger.warn({ err, companyId }, "Failed to look up company telegram chatId");
    return null;
  }
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

/** Resolve the chatId for an event (per-company override or global fallback). */
async function resolveChatId(
  db: Db,
  config: TelegramConfig,
  companyId: string | undefined,
): Promise<string> {
  if (companyId) {
    const override = await getCompanyChatId(db, companyId);
    if (override) return override;
  }
  return config.defaultChatId;
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
// Event handlers
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
  const action = p.action;
  if (!action) return;

  const details = p.details ?? {};
  const identifier = (details.identifier as string) ?? p.entityId ?? "";

  if (action === "issue.comment_added") {
    const bodySnippet = (details.bodySnippet as string) ?? "";
    const issueTitle = (details.issueTitle as string) ?? "";
    const hasMention = /\B@[^\s@,!?.]+/.test(bodySnippet);
    const mentionTag = hasMention ? " (has @mention)" : "";
    const actorLabel = p.agentId ?? p.actorId ?? "someone";
    const lines = [
      `\u{1F4AC} <b>Comment on ${escapeHtml(identifier)}</b>${mentionTag}`,
      escapeHtml(truncate(bodySnippet, 200)),
    ];
    if (issueTitle) lines.push(`<i>${escapeHtml(truncate(issueTitle, 100))}</i>`);
    lines.push(`by ${escapeHtml(actorLabel)}`);
    const chatId = await resolveChatId(db, config, event.companyId);
    void sendMessage(config.botToken, chatId, lines.join("\n"));
    return;
  }

  if (action === "issue.updated") {
    const newStatus = details.status as string | undefined;
    if (newStatus === "blocked" || newStatus === "in_review") {
      const issueTitle = (details.issueTitle as string) ?? (details.title as string) ?? "";
      const lines = [
        `\u{1F514} <b>${escapeHtml(identifier)} is now ${escapeHtml(newStatus)}</b>`,
      ];
      if (issueTitle) lines.push(`<i>${escapeHtml(truncate(issueTitle, 100))}</i>`);
      const chatId = await resolveChatId(db, config, event.companyId);
      void sendMessage(config.botToken, chatId, lines.join("\n"));
    }
    return;
  }

  if (action === "approval.created") {
    const approvalType = (details.type as string) ?? "unknown";
    const lines = [
      `\u{2705} <b>Approval requested</b>`,
      `Type: ${escapeHtml(approvalType)}`,
      `Entity: ${escapeHtml(p.entityId ?? "")}`,
    ];
    if (p.agentId) lines.push(`Requested by agent: ${escapeHtml(p.agentId)}`);
    const chatId = await resolveChatId(db, config, event.companyId);
    void sendMessage(config.botToken, chatId, lines.join("\n"));
    return;
  }

  if (action === "approval.comment_added") {
    const lines = [
      `\u{1F4AC} <b>Comment on approval ${escapeHtml(p.entityId ?? "")}</b>`,
    ];
    if (p.agentId) lines.push(`by agent: ${escapeHtml(p.agentId)}`);
    const chatId = await resolveChatId(db, config, event.companyId);
    void sendMessage(config.botToken, chatId, lines.join("\n"));
    return;
  }
}

async function handleHeartbeatRunStatus(
  event: LiveEvent,
  db: Db,
  config: TelegramConfig,
): Promise<void> {
  const p = event.payload as Record<string, unknown>;
  const status = p.status as string | undefined;
  if (status !== "failed") return;

  const agentId = (p.agentId as string) ?? "unknown";
  const runId = (p.runId as string) ?? "";
  const error = (p.error as string) ?? "";
  const errorCode = (p.errorCode as string) ?? "";

  const lines = [
    `\u{274C} <b>Run failed</b>`,
    `Agent: ${escapeHtml(agentId)}`,
    `Run: ${escapeHtml(runId.slice(0, 8))}`,
  ];
  if (errorCode) lines.push(`Code: ${escapeHtml(errorCode)}`);
  if (error) lines.push(`Error: ${escapeHtml(truncate(error, 200))}`);
  const chatId = await resolveChatId(db, config, event.companyId);
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
      switch (event.type) {
        case "activity.logged":
          void handleActivityLogged(event, db, config);
          break;
        case "heartbeat.run.status":
          void handleHeartbeatRunStatus(event, db, config);
          break;
        default:
          break;
      }
    } catch (err) {
      logger.warn({ err, eventType: event.type }, "Telegram event handler error");
    }
  });

  logger.info("Telegram notifications enabled");
  void sendMessage(config.botToken, config.defaultChatId, "\u{1F7E2} Paperclip server started — Telegram notifications active");
  return true;
}
