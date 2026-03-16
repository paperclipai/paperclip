import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents, companies, telegramThreadMappings, issues } from "@paperclipai/db";
import { eq, and, or, sql } from "drizzle-orm";
import { issueService, heartbeatService, logActivity } from "../services/index.js";
import { createForumTopic, sendMessageToThread } from "../services/telegram.js";
import { logger } from "../middleware/logger.js";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string };
  message_thread_id?: number;
  text?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

/**
 * Resolve company from a Telegram chat ID.
 * Checks both settings.telegram.forumChatId and settings.telegram.chatId.
 */
async function resolveCompanyFromChat(
  db: Db,
  chatId: string,
): Promise<{ id: string; settings: Record<string, unknown>; issuePrefix: string } | null> {
  const rows = await db
    .select({
      id: companies.id,
      settings: companies.settings,
      issuePrefix: companies.issuePrefix,
    })
    .from(companies)
    .where(
      or(
        sql`${companies.settings}->'telegram'->>'forumChatId' = ${chatId}`,
        sql`${companies.settings}->'telegram'->>'chatId' = ${chatId}`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Resolve agent by name (case-insensitive) within a company. */
async function resolveAgentByName(
  db: Db,
  companyId: string,
  name: string,
): Promise<string | null> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        sql`lower(${agents.name}) = ${name.toLowerCase()}`,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Handle /issue command — create issue + forum topic + thread mapping. */
async function handleIssueCommand(
  db: Db,
  msg: TelegramMessage,
  commandText: string,
): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!botToken) return;

  const chatId = String(msg.chat.id);
  const company = await resolveCompanyFromChat(db, chatId);
  if (!company) {
    logger.warn({ chatId }, "Telegram /issue: no company found for chat");
    return;
  }

  const telegramSettings = company.settings?.telegram as
    | { forumChatId?: string; defaultAssigneeAgentId?: string }
    | undefined;
  const forumChatId = telegramSettings?.forumChatId ?? chatId;

  // Parse optional @AgentName from beginning of title
  let title = commandText.trim();
  let assigneeAgentId: string | null = null;

  const mentionMatch = title.match(/^@(\S+)\s+(.+)$/s);
  if (mentionMatch) {
    const agentName = mentionMatch[1];
    const resolved = await resolveAgentByName(db, company.id, agentName);
    if (resolved) {
      assigneeAgentId = resolved;
      title = mentionMatch[2].trim();
    }
    // If agent not found, keep the full text as title
  }

  // Fall back to default assignee
  if (!assigneeAgentId) {
    assigneeAgentId = telegramSettings?.defaultAssigneeAgentId ?? null;
  }

  if (!title) {
    logger.warn({ chatId }, "Telegram /issue: empty title");
    return;
  }

  // Create issue
  const svc = issueService(db);
  const issue = await svc.create(company.id, {
    title,
    status: "todo",
    assigneeAgentId: assigneeAgentId ?? undefined,
  });

  // Log activity
  await logActivity(db, {
    companyId: company.id,
    actorType: "user",
    actorId: `telegram:${msg.from?.id ?? "unknown"}`,
    action: "issue.created",
    entityType: "issue",
    entityId: issue.id,
    details: {
      title: issue.title,
      identifier: issue.identifier,
      source: "telegram",
    },
  });

  // Create forum topic
  const topicName = `${issue.identifier}: ${title}`.slice(0, 128);
  const messageThreadId = await createForumTopic(botToken, forumChatId, topicName);
  if (!messageThreadId) {
    logger.warn({ chatId: forumChatId, issueId: issue.id }, "Failed to create forum topic");
    return;
  }

  // Insert thread mapping
  await db.insert(telegramThreadMappings).values({
    companyId: company.id,
    chatId: forumChatId,
    messageThreadId,
    issueId: issue.id,
  });

  // Send confirmation in the new topic
  const assigneeLabel = assigneeAgentId ? ` (assigned to agent)` : "";
  void sendMessageToThread(
    botToken,
    forumChatId,
    messageThreadId,
    `Issue <b>${issue.identifier}</b> created${assigneeLabel}.\nReplies in this thread will be added as comments.`,
  );

  // Wake assigned agent
  if (assigneeAgentId) {
    const heartbeat = heartbeatService(db);
    void heartbeat.wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue.id, source: "telegram" },
      requestedByActorType: "user",
      requestedByActorId: `telegram:${msg.from?.id ?? "unknown"}`,
      contextSnapshot: {
        issueId: issue.id,
        taskId: issue.id,
        source: "telegram.issue_command",
        wakeReason: "issue_assigned",
      },
    });
  }

  logger.info(
    { issueId: issue.id, identifier: issue.identifier, chatId: forumChatId, messageThreadId },
    "Telegram /issue: created issue + forum topic",
  );
}

/** Handle plain text reply in a forum thread — add comment + wake agent. */
async function handleThreadReply(
  db: Db,
  msg: TelegramMessage,
): Promise<void> {
  if (!msg.message_thread_id || !msg.text) return;

  const chatId = String(msg.chat.id);
  const threadId = String(msg.message_thread_id);

  // Look up thread mapping
  const rows = await db
    .select({
      issueId: telegramThreadMappings.issueId,
      companyId: telegramThreadMappings.companyId,
    })
    .from(telegramThreadMappings)
    .where(
      and(
        eq(telegramThreadMappings.chatId, chatId),
        eq(telegramThreadMappings.messageThreadId, threadId),
      ),
    )
    .limit(1);

  const mapping = rows[0];
  if (!mapping) return; // Not a tracked thread

  const svc = issueService(db);
  const userId = `telegram:${msg.from?.id ?? "unknown"}`;

  // Add comment
  const comment = await svc.addComment(mapping.issueId, msg.text, {
    userId,
  });

  // Log activity with telegramOrigin flag to prevent notification loop
  await logActivity(db, {
    companyId: mapping.companyId,
    actorType: "user",
    actorId: userId,
    action: "issue.comment_added",
    entityType: "issue",
    entityId: mapping.issueId,
    details: {
      commentId: comment.id,
      bodySnippet: comment.body.slice(0, 120),
      telegramOrigin: true,
      source: "telegram",
    },
  });

  // Look up issue to find assigned agent
  const issueRows = await db
    .select({ assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(eq(issues.id, mapping.issueId))
    .limit(1);

  const assigneeAgentId = issueRows[0]?.assigneeAgentId;
  if (assigneeAgentId) {
    const heartbeat = heartbeatService(db);
    void heartbeat.wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId: mapping.issueId,
        commentId: comment.id,
        source: "telegram",
      },
      requestedByActorType: "user",
      requestedByActorId: userId,
      contextSnapshot: {
        issueId: mapping.issueId,
        taskId: mapping.issueId,
        commentId: comment.id,
        source: "telegram.thread_reply",
        wakeReason: "issue_commented",
      },
    });
  }

  logger.info(
    { issueId: mapping.issueId, commentId: comment.id },
    "Telegram thread reply: added comment",
  );
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function telegramWebhookRoutes(db: Db) {
  const router = Router();

  router.post("/webhooks/telegram", async (req, res) => {
    // Verify secret token
    if (WEBHOOK_SECRET) {
      const headerSecret = req.headers["x-telegram-bot-api-secret-token"] as string | undefined;
      if (headerSecret !== WEBHOOK_SECRET) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
    }

    const update = req.body as TelegramUpdate;
    const msg = update.message;
    if (!msg || !msg.text) {
      res.status(200).json({ ok: true });
      return;
    }

    try {
      // Check for /issue command (also handle /issue@botname)
      const issueMatch = msg.text.match(/^\/issue(?:@\S+)?\s+(.+)$/s);
      if (issueMatch) {
        await handleIssueCommand(db, msg, issueMatch[1]);
        res.status(200).json({ ok: true });
        return;
      }

      // If message is in a forum thread, handle as reply
      if (msg.message_thread_id) {
        await handleThreadReply(db, msg);
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error({ err, updateId: update.update_id }, "Telegram webhook handler error");
      // Always return 200 to Telegram to avoid retries
      res.status(200).json({ ok: true });
    }
  });

  return router;
}
