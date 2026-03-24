import type { LiveEvent, TelegramNotificationLevel } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { subscribeAllLiveEvents } from "./live-events.js";
import type { Db } from "@paperclipai/db";
import { companies, telegramThreadMappings, agents, heartbeatRuns, issues } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";

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
// Per-company telegram settings resolution (cached)
// ---------------------------------------------------------------------------

interface CompanyTelegramCache {
  chatId: string | null;
  notificationLevel: TelegramNotificationLevel;
  expiresAt: number;
}

const companyChatIdCache = new Map<string, CompanyTelegramCache>();
const CACHE_TTL_MS = 60_000; // 1 minute

async function getCompanyTelegramSettings(
  db: Db,
  companyId: string,
): Promise<{ chatId: string | null; notificationLevel: TelegramNotificationLevel }> {
  const cached = companyChatIdCache.get(companyId);
  if (cached && cached.expiresAt > Date.now()) {
    return { chatId: cached.chatId, notificationLevel: cached.notificationLevel };
  }

  try {
    const rows = await db
      .select({ settings: companies.settings })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const settings = rows[0]?.settings as Record<string, unknown> | undefined;
    const telegram = settings?.telegram as {
      chatId?: string;
      notificationLevel?: TelegramNotificationLevel;
    } | undefined;
    const chatId = telegram?.chatId?.trim() || null;
    const notificationLevel = telegram?.notificationLevel ?? "important";
    companyChatIdCache.set(companyId, {
      chatId,
      notificationLevel,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return { chatId, notificationLevel };
  } catch (err) {
    logger.warn({ err, companyId }, "Failed to look up company telegram settings");
    return { chatId: null, notificationLevel: "important" };
  }
}

async function getCompanyChatId(db: Db, companyId: string): Promise<string | null> {
  const { chatId } = await getCompanyTelegramSettings(db, companyId);
  return chatId;
}

async function getCompanyNotificationLevel(
  db: Db,
  companyId: string | undefined,
): Promise<TelegramNotificationLevel> {
  if (!companyId) return "important";
  const { notificationLevel } = await getCompanyTelegramSettings(db, companyId);
  return notificationLevel;
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

/** Send a message into a specific forum topic thread. */
export async function sendMessageToThread(
  botToken: string,
  chatId: string,
  messageThreadId: string,
  text: string,
): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_thread_id: Number(messageThreadId),
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body, chatId, messageThreadId }, "Telegram sendMessageToThread failed");
    }
  } catch (err) {
    logger.warn({ err }, "Telegram sendMessageToThread request error");
  }
}

/** Create a forum topic in a supergroup. Returns the message_thread_id. */
export async function createForumTopic(
  botToken: string,
  chatId: string,
  name: string,
): Promise<string | null> {
  const url = `${TELEGRAM_API}/bot${botToken}/createForumTopic`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        name: name.slice(0, 128), // Telegram limit
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.warn({ status: res.status, body, chatId, name }, "Telegram createForumTopic failed");
      return null;
    }
    const json = (await res.json()) as { ok: boolean; result?: { message_thread_id: number } };
    if (!json.ok || !json.result) return null;
    return String(json.result.message_thread_id);
  } catch (err) {
    logger.warn({ err }, "Telegram createForumTopic request error");
    return null;
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

/** Resolve the forum chatId for a company (forumChatId or chatId fallback). */
async function resolveForumChatId(
  db: Db,
  config: TelegramConfig,
  companyId: string,
): Promise<string> {
  try {
    const rows = await db
      .select({ settings: companies.settings })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    const settings = rows[0]?.settings as Record<string, unknown> | undefined;
    const telegram = settings?.telegram as Record<string, unknown> | undefined;
    const forumChatId = (telegram?.forumChatId as string)?.trim();
    if (forumChatId) return forumChatId;
    const chatId = (telegram?.chatId as string)?.trim();
    if (chatId) return chatId;
  } catch {
    // best-effort
  }
  return config.defaultChatId;
}

type ThreadTarget = { chatId: string; threadId: string } | null;

/**
 * Resolve an existing thread for an issue, or lazily create one.
 * Returns { chatId, threadId } if a thread exists/was created, null otherwise.
 */
async function resolveOrCreateIssueThread(
  db: Db,
  config: TelegramConfig,
  companyId: string,
  issueId: string,
  issueIdentifier: string,
  issueTitle: string,
): Promise<ThreadTarget> {
  // Check for existing mapping
  const existing = await db
    .select({
      chatId: telegramThreadMappings.chatId,
      messageThreadId: telegramThreadMappings.messageThreadId,
    })
    .from(telegramThreadMappings)
    .where(eq(telegramThreadMappings.issueId, issueId))
    .limit(1);

  if (existing[0]) {
    return { chatId: existing[0].chatId, threadId: existing[0].messageThreadId };
  }

  // No thread yet — try to auto-create in forum chat
  const forumChatId = await resolveForumChatId(db, config, companyId);
  const topicName = `${issueIdentifier}: ${issueTitle}`.slice(0, 128);
  const threadId = await createForumTopic(config.botToken, forumChatId, topicName);
  if (!threadId) return null; // Chat might not be a forum, or bot isn't admin

  // Save the mapping
  try {
    await db.insert(telegramThreadMappings).values({
      companyId,
      chatId: forumChatId,
      messageThreadId: threadId,
      issueId,
    });
  } catch {
    // unique constraint violation = another process created it
  }

  return { chatId: forumChatId, threadId };
}

/**
 * Send an issue-related notification: route to per-issue thread if possible,
 * fall back to general chat.
 */
async function sendIssueNotification(
  db: Db,
  config: TelegramConfig,
  companyId: string | undefined,
  issueId: string | undefined,
  issueIdentifier: string,
  issueTitle: string,
  text: string,
): Promise<void> {
  // Try to route to issue thread
  if (companyId && issueId) {
    try {
      const thread = await resolveOrCreateIssueThread(
        db, config, companyId, issueId, issueIdentifier, issueTitle,
      );
      if (thread) {
        void sendMessageToThread(config.botToken, thread.chatId, thread.threadId, text);
        return;
      }
    } catch (err) {
      logger.warn({ err, issueId }, "Failed to resolve/create issue thread, falling back to general");
    }
  }
  // Fallback: send to general chat
  const chatId = await resolveChatId(db, config, companyId);
  void sendMessage(config.botToken, chatId, text);
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
// Agent response relay — sends agent comments to Telegram forum threads
// ---------------------------------------------------------------------------

async function relayAgentCommentToThread(
  event: LiveEvent,
  db: Db,
  config: TelegramConfig,
  details: Record<string, unknown>,
): Promise<void> {
  const issueId = event.payload?.entityId as string | undefined;
  if (!issueId) return;

  // Look up thread mapping for this issue
  const rows = await db
    .select({
      chatId: telegramThreadMappings.chatId,
      messageThreadId: telegramThreadMappings.messageThreadId,
    })
    .from(telegramThreadMappings)
    .where(eq(telegramThreadMappings.issueId, issueId))
    .limit(1);

  const mapping = rows[0];
  if (!mapping) return;

  // Resolve agent name
  const p = event.payload as Record<string, unknown>;
  const agentId = p.agentId as string | undefined;
  let agentName = "Agent";
  if (agentId) {
    const agentRows = await db
      .select({ name: agents.name })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (agentRows[0]?.name) agentName = agentRows[0].name;
  }

  const bodySnippet = (details.bodySnippet as string) ?? "";
  const text = `<b>${escapeHtml(agentName)}</b>:\n${escapeHtml(truncate(bodySnippet, 500))}`;
  void sendMessageToThread(config.botToken, mapping.chatId, mapping.messageThreadId, text);
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

  const notificationLevel = await getCompanyNotificationLevel(db, event.companyId);
  const details = p.details ?? {};
  const identifier = (details.identifier as string) ?? p.entityId ?? "";

  if (action === "issue.comment_added") {
    // Anti-loop: skip relay for comments originating from Telegram
    const telegramOrigin = details.telegramOrigin as boolean | undefined;

    if (!telegramOrigin) {
      // If this is an agent comment, try to relay to the forum thread
      if (p.actorType === "agent" || p.agentId) {
        try {
          await relayAgentCommentToThread(event, db, config, details);
        } catch (err) {
          logger.warn({ err, entityId: p.entityId }, "Failed to relay agent comment to Telegram thread");
        }
      }
    }

    // --- Notification filtering for comment notifications ---
    // "critical" level: never send comment notifications
    if (notificationLevel === "critical") return;

    const bodySnippet = (details.bodySnippet as string) ?? "";
    const issueTitle = (details.issueTitle as string) ?? "";
    const hasMention = /\B@[^\s@,!?.]+/.test(bodySnippet);

    // Extract user://userId mentions from the comment body
    const userMentionRegex = /\[.*?\]\(user:\/\/([^)]+)\)/g;
    const mentionedUserIds: string[] = [];
    let userMentionMatch;
    while ((userMentionMatch = userMentionRegex.exec(bodySnippet)) !== null) {
      mentionedUserIds.push(userMentionMatch[1]);
    }
    const hasUserMention = mentionedUserIds.length > 0;

    // "important" level (default): only notify when a human is involved
    if (notificationLevel !== "all") {
      // Check if the comment actor is a human
      const isHumanActor = p.actorType === "user";
      // Check if a human is watching the issue (assigneeUserId set)
      let hasHumanAssignee = false;
      if (p.entityId) {
        try {
          const issueRows = await db
            .select({ assigneeUserId: issues.assigneeUserId })
            .from(issues)
            .where(eq(issues.id, p.entityId))
            .limit(1);
          hasHumanAssignee = !!issueRows[0]?.assigneeUserId;
        } catch {
          // best-effort lookup
        }
      }
      const isHumanInvolved = isHumanActor || hasHumanAssignee || hasMention || hasUserMention;
      if (!isHumanInvolved) return;
    }

    const mentionTag = (hasMention || hasUserMention) ? " (has @mention)" : "";
    const actorLabel = p.agentId ?? p.actorId ?? "someone";
    const lines = [
      `\u{1F4AC} <b>Comment on ${escapeHtml(identifier)}</b>${mentionTag}`,
      escapeHtml(truncate(bodySnippet, 200)),
    ];
    if (issueTitle) lines.push(`<i>${escapeHtml(truncate(issueTitle, 100))}</i>`);
    lines.push(`by ${escapeHtml(actorLabel)}`);
    void sendIssueNotification(db, config, event.companyId, p.entityId, identifier, issueTitle, lines.join("\n"));
    return;
  }

  if (action === "issue.updated") {
    const newStatus = details.status as string | undefined;
    if (newStatus === "blocked" || newStatus === "in_review") {
      // "critical" level: only blocked issues pass through
      if (notificationLevel === "critical" && newStatus !== "blocked") return;

      const issueTitle = (details.issueTitle as string) ?? (details.title as string) ?? "";
      const lines = [
        `\u{1F514} <b>${escapeHtml(identifier)} is now ${escapeHtml(newStatus)}</b>`,
      ];
      if (issueTitle) lines.push(`<i>${escapeHtml(truncate(issueTitle, 100))}</i>`);
      void sendIssueNotification(db, config, event.companyId, p.entityId, identifier, issueTitle, lines.join("\n"));
    }

    // Notify when an issue is assigned to a human user
    const newAssigneeUserId = details.assigneeUserId as string | null | undefined;
    const prevAssigneeUserId = (details._previous as Record<string, unknown> | undefined)?.assigneeUserId as string | null | undefined;
    if (newAssigneeUserId && newAssigneeUserId !== prevAssigneeUserId) {
      if (notificationLevel !== "critical") {
        const issueTitle = (details.issueTitle as string) ?? (details.title as string) ?? "";
        const lines = [
          `\u{1F4CB} <b>${escapeHtml(identifier)} assigned to a team member</b>`,
        ];
        if (issueTitle) lines.push(`<i>${escapeHtml(truncate(issueTitle, 100))}</i>`);
        void sendIssueNotification(db, config, event.companyId, p.entityId, identifier, issueTitle, lines.join("\n"));
      }
    }
    return;
  }

  if (action === "approval.created") {
    // Approvals are always sent at "important" and above; always sent at "critical"
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
    // "critical" level: skip approval comments
    if (notificationLevel === "critical") return;

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

  const notificationLevel = await getCompanyNotificationLevel(db, event.companyId);

  // "critical" level: skip run failure notifications entirely
  if (notificationLevel === "critical") return;

  const runId = (p.runId as string) ?? "";

  // "important" level (default): only notify for failures tied to an issue
  if (notificationLevel !== "all" && runId) {
    try {
      const runRows = await db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);
      const ctx = runRows[0]?.contextSnapshot as Record<string, unknown> | null | undefined;
      const issueId = ctx?.issueId as string | undefined;
      // Skip notification for routine heartbeat failures without issue context
      if (!issueId) return;
    } catch {
      // best-effort lookup; if we can't check, send the notification
    }
  }

  const agentId = (p.agentId as string) ?? "unknown";
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
