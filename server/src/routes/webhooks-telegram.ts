import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents, companies, telegramThreadMappings, issues } from "@paperclipai/db";
import { eq, and, or, sql } from "drizzle-orm";
import { issueService, heartbeatService, logActivity } from "../services/index.js";
import { createForumTopic, sendMessageToThread } from "../services/telegram.js";
import { logger } from "../middleware/logger.js";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

function getBotToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string; title?: string; is_forum?: boolean };
  message_thread_id?: number;
  text?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function replyToChat(chatId: string, text: string, threadId?: number): Promise<void> {
  const botToken = getBotToken();
  if (!botToken) return;
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(threadId ? { message_thread_id: threadId } : {}),
      }),
    });
  } catch {
    // best-effort
  }
}

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

async function resolveAgentByName(
  db: Db,
  companyId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(
      and(
        eq(agents.companyId, companyId),
        sql`lower(${agents.name}) = ${name.toLowerCase()}`,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// /register CompanyName — links this chat to a Paperclip company
// ---------------------------------------------------------------------------

async function handleRegisterCommand(
  db: Db,
  msg: TelegramMessage,
  companyName: string,
): Promise<void> {
  const chatId = String(msg.chat.id);
  const name = companyName.trim();

  if (!name) {
    await replyToChat(chatId, "Usage: /register CompanyName");
    return;
  }

  // Find company by name (case-insensitive)
  const rows = await db
    .select({ id: companies.id, name: companies.name, settings: companies.settings })
    .from(companies)
    .where(sql`lower(${companies.name}) = ${name.toLowerCase()}`)
    .limit(1);

  const company = rows[0];
  if (!company) {
    // List available companies to help the user
    const allRows = await db
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.status, "active"));
    const names = allRows.map((r) => r.name).join(", ");
    await replyToChat(chatId, `Company "${name}" not found.\nAvailable: ${names}`);
    return;
  }

  // Update company settings: set forumChatId and chatId to this group
  const currentSettings = (company.settings ?? {}) as Record<string, unknown>;
  const currentTelegram = (currentSettings.telegram ?? {}) as Record<string, unknown>;
  const newSettings = {
    ...currentSettings,
    telegram: {
      ...currentTelegram,
      chatId,
      forumChatId: chatId,
    },
  };

  await db
    .update(companies)
    .set({ settings: newSettings })
    .where(eq(companies.id, company.id));

  const isForum = msg.chat.is_forum ? " (forum topics enabled)" : " (forum topics NOT detected — enable Topics in group settings)";
  await replyToChat(
    chatId,
    `Linked this chat to <b>${company.name}</b>${isForum}\nChat ID: <code>${chatId}</code>\n\nYou can now use /issue to create issues.`,
  );

  logger.info({ companyId: company.id, companyName: company.name, chatId }, "Telegram /register: linked chat to company");
}

// ---------------------------------------------------------------------------
// /setdefault @AgentName — sets default assignee for Telegram-created issues
// ---------------------------------------------------------------------------

async function handleSetDefaultCommand(
  db: Db,
  msg: TelegramMessage,
  agentName: string,
): Promise<void> {
  const chatId = String(msg.chat.id);
  const name = agentName.replace(/^@/, "").trim();

  if (!name) {
    await replyToChat(chatId, "Usage: /setdefault AgentName");
    return;
  }

  const company = await resolveCompanyFromChat(db, chatId);
  if (!company) {
    await replyToChat(chatId, "This chat is not linked to a company. Use /register CompanyName first.");
    return;
  }

  const agent = await resolveAgentByName(db, company.id, name);
  if (!agent) {
    // List available agents
    const agentRows = await db
      .select({ name: agents.name })
      .from(agents)
      .where(and(eq(agents.companyId, company.id), eq(agents.status, "idle")));
    const names = agentRows.map((r) => r.name).join(", ");
    await replyToChat(chatId, `Agent "${name}" not found.\nAvailable: ${names}`);
    return;
  }

  const currentSettings = (company.settings ?? {}) as Record<string, unknown>;
  const currentTelegram = (currentSettings.telegram ?? {}) as Record<string, unknown>;
  const newSettings = {
    ...currentSettings,
    telegram: {
      ...currentTelegram,
      defaultAssigneeAgentId: agent.id,
    },
  };

  await db
    .update(companies)
    .set({ settings: newSettings })
    .where(eq(companies.id, company.id));

  await replyToChat(chatId, `Default assignee set to <b>${agent.name}</b> for issues created from this chat.`);
  logger.info({ companyId: company.id, agentId: agent.id, agentName: agent.name }, "Telegram /setdefault: updated default assignee");
}

// ---------------------------------------------------------------------------
// /issue [@AgentName] <title> — create issue + forum topic
// ---------------------------------------------------------------------------

async function handleIssueCommand(
  db: Db,
  msg: TelegramMessage,
  commandText: string,
): Promise<void> {
  const botToken = getBotToken();
  if (!botToken) return;

  const chatId = String(msg.chat.id);
  const company = await resolveCompanyFromChat(db, chatId);
  if (!company) {
    await replyToChat(chatId, "This chat is not linked to a company.\nUse /register CompanyName first.");
    return;
  }

  const telegramSettings = (company.settings as Record<string, unknown>)?.telegram as
    | { forumChatId?: string; defaultAssigneeAgentId?: string }
    | undefined;
  const forumChatId = telegramSettings?.forumChatId ?? chatId;

  // Parse optional @AgentName from beginning of title
  let title = commandText.trim();
  let assigneeAgentId: string | null = null;

  const mentionMatch = title.match(/^@(\S+)\s+(.+)$/s);
  if (mentionMatch) {
    const agent = await resolveAgentByName(db, company.id, mentionMatch[1]);
    if (agent) {
      assigneeAgentId = agent.id;
      title = mentionMatch[2].trim();
    }
  }

  // Fall back to default assignee
  if (!assigneeAgentId) {
    assigneeAgentId = telegramSettings?.defaultAssigneeAgentId ?? null;
  }

  if (!title) {
    await replyToChat(chatId, "Usage: /issue Title of the issue\nor: /issue @AgentName Title");
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

  // Create forum topic (only if group has Topics enabled)
  if (msg.chat.is_forum) {
    const topicName = `${issue.identifier}: ${title}`.slice(0, 128);
    const messageThreadId = await createForumTopic(botToken, forumChatId, topicName);
    if (messageThreadId) {
      await db.insert(telegramThreadMappings).values({
        companyId: company.id,
        chatId: forumChatId,
        messageThreadId,
        issueId: issue.id,
      });

      // Resolve agent name for confirmation
      let assigneeLabel = "";
      if (assigneeAgentId) {
        const agentRows = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, assigneeAgentId)).limit(1);
        assigneeLabel = agentRows[0]?.name ? ` → assigned to <b>${agentRows[0].name}</b>` : " → assigned to agent";
      }

      void sendMessageToThread(
        botToken,
        forumChatId,
        messageThreadId,
        `Issue <b>${issue.identifier}</b> created${assigneeLabel}.\nReplies in this thread become comments on the issue.`,
      );

      logger.info(
        { issueId: issue.id, identifier: issue.identifier, chatId: forumChatId, messageThreadId },
        "Telegram /issue: created issue + forum topic",
      );
    } else {
      // Topic creation failed — still created the issue, just no thread
      await replyToChat(chatId, `Issue <b>${issue.identifier}</b> created, but failed to create forum topic. Is the bot an admin with "Manage topics" permission?`);
    }
  } else {
    // No forum mode — just confirm in chat
    let assigneeLabel = "";
    if (assigneeAgentId) {
      const agentRows = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, assigneeAgentId)).limit(1);
      assigneeLabel = agentRows[0]?.name ? ` → ${agentRows[0].name}` : "";
    }
    await replyToChat(chatId, `Issue <b>${issue.identifier}: ${title}</b> created${assigneeLabel}.\n\nEnable Topics in group settings for thread-based conversations.`);
  }

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
}

// ---------------------------------------------------------------------------
// Thread reply — add comment + wake agent
// ---------------------------------------------------------------------------

async function handleThreadReply(
  db: Db,
  msg: TelegramMessage,
): Promise<void> {
  if (!msg.message_thread_id || !msg.text) return;

  const chatId = String(msg.chat.id);
  const threadId = String(msg.message_thread_id);

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
  if (!mapping) return;

  const svc = issueService(db);
  const userId = `telegram:${msg.from?.id ?? "unknown"}`;

  const comment = await svc.addComment(mapping.issueId, msg.text, { userId });

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

  logger.info({ issueId: mapping.issueId, commentId: comment.id }, "Telegram thread reply: added comment");
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

    const chatId = String(msg.chat.id);
    logger.info(
      { updateId: update.update_id, chatId, chatType: msg.chat.type, isForum: msg.chat.is_forum, text: msg.text.slice(0, 80) },
      "Telegram webhook: incoming message",
    );

    try {
      // /register CompanyName
      const registerMatch = msg.text.match(/^\/register(?:@\S+)?\s+(.+)$/s);
      if (registerMatch) {
        await handleRegisterCommand(db, msg, registerMatch[1]);
        res.status(200).json({ ok: true });
        return;
      }

      // /setdefault AgentName
      const setDefaultMatch = msg.text.match(/^\/setdefault(?:@\S+)?\s+(.+)$/s);
      if (setDefaultMatch) {
        await handleSetDefaultCommand(db, msg, setDefaultMatch[1]);
        res.status(200).json({ ok: true });
        return;
      }

      // /issue [@AgentName] <title>
      const issueMatch = msg.text.match(/^\/issue(?:@\S+)?\s+(.+)$/s);
      if (issueMatch) {
        await handleIssueCommand(db, msg, issueMatch[1]);
        res.status(200).json({ ok: true });
        return;
      }

      // /debug — reply with chat info (useful for setup)
      if (msg.text.match(/^\/debug(?:@\S+)?$/)) {
        await replyToChat(
          chatId,
          `Chat ID: <code>${chatId}</code>\nType: ${msg.chat.type}\nForum: ${msg.chat.is_forum ?? false}\nTitle: ${msg.chat.title ?? "N/A"}`,
          msg.message_thread_id,
        );
        res.status(200).json({ ok: true });
        return;
      }

      // Thread reply (plain text in a forum topic)
      if (msg.message_thread_id) {
        await handleThreadReply(db, msg);
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error({ err, updateId: update.update_id, chatId }, "Telegram webhook handler error");
      res.status(200).json({ ok: true });
    }
  });

  return router;
}
