import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents, companies, projects, telegramThreadMappings, issues } from "@paperclipai/db";
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

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function reply(chatId: string, text: string, threadId?: number): Promise<void> {
  const botToken = getBotToken();
  if (!botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
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

async function resolveCompany(
  db: Db,
  chatId: string,
): Promise<{ id: string; settings: Record<string, unknown>; issuePrefix: string } | null> {
  const rows = await db
    .select({ id: companies.id, settings: companies.settings, issuePrefix: companies.issuePrefix })
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

function getTelegramSettings(company: { settings: Record<string, unknown> }) {
  const tg = (company.settings?.telegram ?? {}) as Record<string, unknown>;
  return {
    forumChatId: (tg.forumChatId as string) ?? null,
    defaultAssigneeAgentId: (tg.defaultAssigneeAgentId as string) ?? null,
  };
}

async function requireCompany(db: Db, chatId: string, threadId?: number) {
  const company = await resolveCompany(db, chatId);
  if (!company) {
    await reply(chatId, "⚠️ This chat is not linked to any company.\n\nUse /register to connect it.", threadId);
  }
  return company;
}

async function resolveAgentByName(
  db: Db,
  companyId: string,
  name: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), sql`lower(${agents.name}) = ${name.toLowerCase()}`))
    .limit(1);
  return rows[0] ?? null;
}

async function getCompanyAgents(db: Db, companyId: string) {
  return db
    .select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status })
    .from(agents)
    .where(eq(agents.companyId, companyId));
}

function formatAgentLine(a: { id: string; name: string; role: string | null; status: string }, defaultId: string | null): string {
  const icon = a.status === "idle" ? "🟢" : a.status === "paused" ? "⏸️" : "⚪";
  const def = a.id === defaultId ? " ⭐" : "";
  const role = a.role ? ` — ${esc(a.role)}` : "";
  return `  ${icon} <b>${esc(a.name)}</b>${def}${role}`;
}

// ---------------------------------------------------------------------------
// /register CompanyName
// ---------------------------------------------------------------------------

async function cmdRegister(db: Db, msg: TelegramMessage, input: string): Promise<void> {
  const chatId = String(msg.chat.id);
  const name = input.trim();

  if (!name) {
    const allRows = await db.select({ name: companies.name }).from(companies).where(eq(companies.status, "active"));
    const list = allRows.map((r) => `  • ${esc(r.name)}`).join("\n");
    await reply(chatId, `📋 <b>Available companies:</b>\n${list}\n\n<b>Usage:</b> <code>/register CompanyName</code>`, msg.message_thread_id);
    return;
  }

  const rows = await db
    .select({ id: companies.id, name: companies.name, settings: companies.settings })
    .from(companies)
    .where(sql`lower(${companies.name}) = ${name.toLowerCase()}`)
    .limit(1);

  if (!rows[0]) {
    const allRows = await db.select({ name: companies.name }).from(companies).where(eq(companies.status, "active"));
    const list = allRows.map((r) => `  • ${esc(r.name)}`).join("\n");
    await reply(chatId, `❌ Company "<b>${esc(name)}</b>" not found.\n\n📋 <b>Available:</b>\n${list}`, msg.message_thread_id);
    return;
  }

  const company = rows[0];
  const curr = ((company.settings ?? {}) as Record<string, unknown>).telegram ?? {};
  await db.update(companies).set({
    settings: { ...((company.settings ?? {}) as Record<string, unknown>), telegram: { ...(curr as Record<string, unknown>), chatId, forumChatId: chatId } },
  }).where(eq(companies.id, company.id));

  const forum = msg.chat.is_forum ? "✅ Forum topics enabled" : "⚠️ Forum topics not enabled — enable Topics in group settings for per-issue threads";
  await reply(chatId, `🔗 <b>Linked to ${esc(company.name)}</b>\n\n${forum}\n\nType /issue to get started.`, msg.message_thread_id);
  logger.info({ companyId: company.id, chatId }, "Telegram /register: linked");
}

// ---------------------------------------------------------------------------
// /setdefault AgentName
// ---------------------------------------------------------------------------

async function cmdSetDefault(db: Db, msg: TelegramMessage, input: string): Promise<void> {
  const chatId = String(msg.chat.id);
  const company = await requireCompany(db, chatId, msg.message_thread_id);
  if (!company) return;

  const name = input.replace(/^@/, "").trim();
  if (!name) {
    const agentRows = await getCompanyAgents(db, company.id);
    const list = agentRows.map((a) => `  • <b>${esc(a.name)}</b>`).join("\n");
    await reply(chatId, `📋 <b>Available agents:</b>\n${list}\n\n<b>Usage:</b> <code>/setdefault AgentName</code>`, msg.message_thread_id);
    return;
  }

  const agent = await resolveAgentByName(db, company.id, name);
  if (!agent) {
    const agentRows = await getCompanyAgents(db, company.id);
    const list = agentRows.map((a) => `  • <b>${esc(a.name)}</b>`).join("\n");
    await reply(chatId, `❌ Agent "<b>${esc(name)}</b>" not found.\n\n📋 <b>Available:</b>\n${list}`, msg.message_thread_id);
    return;
  }

  const curr = ((company.settings ?? {}) as Record<string, unknown>).telegram ?? {};
  await db.update(companies).set({
    settings: { ...((company.settings ?? {}) as Record<string, unknown>), telegram: { ...(curr as Record<string, unknown>), defaultAssigneeAgentId: agent.id } },
  }).where(eq(companies.id, company.id));

  await reply(chatId, `⭐ Default assignee set to <b>${esc(agent.name)}</b>\n\nAll new /issue commands will auto-assign to this agent.`, msg.message_thread_id);
}

// ---------------------------------------------------------------------------
// /agents
// ---------------------------------------------------------------------------

async function cmdAgents(db: Db, msg: TelegramMessage): Promise<void> {
  const chatId = String(msg.chat.id);
  const company = await requireCompany(db, chatId, msg.message_thread_id);
  if (!company) return;

  const { defaultAssigneeAgentId } = getTelegramSettings(company);
  const rows = await getCompanyAgents(db, company.id);

  if (rows.length === 0) {
    await reply(chatId, "No agents configured for this company.", msg.message_thread_id);
    return;
  }

  const lines = [`🤖 <b>Agents — ${esc(company.issuePrefix)}</b>\n`];
  for (const a of rows) lines.push(formatAgentLine(a, defaultAssigneeAgentId));
  lines.push("");
  lines.push("⭐ = default assignee");
  lines.push("");
  lines.push("<b>Assign:</b> <code>/issue @AgentName title</code>");
  lines.push("<b>Change default:</b> <code>/setdefault AgentName</code>");

  await reply(chatId, lines.join("\n"), msg.message_thread_id);
}

// ---------------------------------------------------------------------------
// /projects
// ---------------------------------------------------------------------------

async function cmdProjects(db: Db, msg: TelegramMessage): Promise<void> {
  const chatId = String(msg.chat.id);
  const company = await requireCompany(db, chatId, msg.message_thread_id);
  if (!company) return;

  const rows = await db
    .select({ id: projects.id, name: projects.name, status: projects.status })
    .from(projects)
    .where(eq(projects.companyId, company.id));

  if (rows.length === 0) {
    await reply(chatId, "No projects found for this company.", msg.message_thread_id);
    return;
  }

  const lines = [`📁 <b>Projects — ${esc(company.issuePrefix)}</b>\n`];
  for (const p of rows) {
    const icon = p.status === "active" ? "🟢" : p.status === "planned" ? "📋" : "📦";
    lines.push(`  ${icon} <b>${esc(p.name)}</b> — ${esc(p.status)}`);
  }
  await reply(chatId, lines.join("\n"), msg.message_thread_id);
}

// ---------------------------------------------------------------------------
// /issue (no args) — help
// ---------------------------------------------------------------------------

async function cmdIssueHelp(db: Db, msg: TelegramMessage): Promise<void> {
  const chatId = String(msg.chat.id);
  const company = await requireCompany(db, chatId, msg.message_thread_id);
  if (!company) return;

  const { defaultAssigneeAgentId } = getTelegramSettings(company);
  const agentRows = await getCompanyAgents(db, company.id);

  const lines: string[] = [];
  lines.push(`📝 <b>Create Issue — ${esc(company.issuePrefix)}</b>`);
  lines.push("");

  // Quick create
  lines.push("▸ <b>Quick create</b>");
  lines.push("  <code>/issue Fix the login bug</code>");
  if (defaultAssigneeAgentId) {
    const def = agentRows.find((a) => a.id === defaultAssigneeAgentId);
    if (def) lines.push(`  ↳ auto-assigned to <b>${esc(def.name)}</b>`);
  }
  lines.push("");

  // Assign to agent
  lines.push("▸ <b>Assign to agent</b>");
  if (agentRows.length > 0) {
    const ex = agentRows[0].name.replace(/\s+/g, "");
    lines.push(`  <code>/issue @${esc(ex)} Fix the login bug</code>`);
  } else {
    lines.push("  <code>/issue @AgentName title</code>");
  }
  lines.push("");

  // Ask without issue
  lines.push("▸ <b>Quick question (no issue)</b>");
  if (agentRows.length > 0) {
    const ex = agentRows[0].name.replace(/\s+/g, "");
    lines.push(`  <code>/ask @${esc(ex)} How does auth work?</code>`);
  } else {
    lines.push("  <code>/ask @AgentName question</code>");
  }
  lines.push("");

  // Agent list
  if (agentRows.length > 0) {
    lines.push(`🤖 <b>Agents</b>`);
    for (const a of agentRows) lines.push(formatAgentLine(a, defaultAssigneeAgentId));
    lines.push("");
  }

  lines.push("📎 /agents  /projects  /setdefault  /debug");

  await reply(chatId, lines.join("\n"), msg.message_thread_id);
}

// ---------------------------------------------------------------------------
// /issue [@Agent] title — create issue + forum topic
// ---------------------------------------------------------------------------

async function cmdIssue(db: Db, msg: TelegramMessage, input: string): Promise<void> {
  const botToken = getBotToken();
  if (!botToken) return;

  const chatId = String(msg.chat.id);
  const company = await requireCompany(db, chatId, msg.message_thread_id);
  if (!company) return;

  const { forumChatId: fChatId, defaultAssigneeAgentId } = getTelegramSettings(company);
  const forumChatId = fChatId ?? chatId;

  // Parse optional @AgentName
  let title = input.trim();
  let assigneeAgentId: string | null = null;

  const mentionMatch = title.match(/^@(\S+)\s+(.+)$/s);
  if (mentionMatch) {
    const agent = await resolveAgentByName(db, company.id, mentionMatch[1]);
    if (agent) {
      assigneeAgentId = agent.id;
      title = mentionMatch[2].trim();
    }
  }
  if (!assigneeAgentId) assigneeAgentId = defaultAssigneeAgentId;

  if (!title) {
    await cmdIssueHelp(db, msg);
    return;
  }

  const svc = issueService(db);
  const issue = await svc.create(company.id, {
    title,
    status: "todo",
    assigneeAgentId: assigneeAgentId ?? undefined,
  });

  await logActivity(db, {
    companyId: company.id,
    actorType: "user",
    actorId: `telegram:${msg.from?.id ?? "unknown"}`,
    action: "issue.created",
    entityType: "issue",
    entityId: issue.id,
    details: { title: issue.title, identifier: issue.identifier, source: "telegram" },
  });

  // Resolve assignee name
  let assigneeName = "";
  if (assigneeAgentId) {
    const r = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, assigneeAgentId)).limit(1);
    assigneeName = r[0]?.name ?? "";
  }

  // Create forum topic
  if (msg.chat.is_forum) {
    const topicName = `${issue.identifier}: ${title}`.slice(0, 128);
    const threadId = await createForumTopic(botToken, forumChatId, topicName);
    if (threadId) {
      await db.insert(telegramThreadMappings).values({
        companyId: company.id,
        chatId: forumChatId,
        messageThreadId: threadId,
        issueId: issue.id,
      });

      const assignLine = assigneeName ? `\n🤖 Assigned to <b>${esc(assigneeName)}</b>` : "";
      void sendMessageToThread(
        botToken, forumChatId, threadId,
        `✅ <b>${esc(issue.identifier ?? "")}: ${esc(title)}</b>${assignLine}\n\n💬 Reply here to comment on this issue.\nAgent responses will appear in this thread.`,
      );
    } else {
      const assignLine = assigneeName ? ` → <b>${esc(assigneeName)}</b>` : "";
      await reply(chatId, `✅ <b>${esc(issue.identifier ?? "")}</b>${assignLine}\n\n⚠️ Could not create topic — make the bot an <b>admin</b> (not just member) in this group.`, msg.message_thread_id);
    }
  } else {
    const assignLine = assigneeName ? ` → <b>${esc(assigneeName)}</b>` : "";
    await reply(chatId, `✅ <b>${esc(issue.identifier ?? "")}: ${esc(title)}</b>${assignLine}\n\n💡 Enable Topics in group settings for per-issue threads.`, msg.message_thread_id);
  }

  // Wake agent
  if (assigneeAgentId) {
    void heartbeatService(db).wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue.id, source: "telegram" },
      requestedByActorType: "user",
      requestedByActorId: `telegram:${msg.from?.id ?? "unknown"}`,
      contextSnapshot: { issueId: issue.id, taskId: issue.id, source: "telegram.issue_command", wakeReason: "issue_assigned" },
    });
  }

  logger.info({ issueId: issue.id, identifier: issue.identifier, chatId }, "Telegram /issue: created");
}

// ---------------------------------------------------------------------------
// /ask [@Agent] question — open a topic for a question without creating issue
// ---------------------------------------------------------------------------

async function cmdAsk(db: Db, msg: TelegramMessage, input: string): Promise<void> {
  const botToken = getBotToken();
  if (!botToken) return;

  const chatId = String(msg.chat.id);
  const company = await requireCompany(db, chatId, msg.message_thread_id);
  if (!company) return;

  const { forumChatId: fChatId, defaultAssigneeAgentId } = getTelegramSettings(company);
  const forumChatId = fChatId ?? chatId;

  // Parse optional @AgentName
  let question = input.trim();
  let targetAgentId: string | null = null;
  let targetAgentName: string | null = null;

  const mentionMatch = question.match(/^@(\S+)\s+(.+)$/s);
  if (mentionMatch) {
    const agent = await resolveAgentByName(db, company.id, mentionMatch[1]);
    if (agent) {
      targetAgentId = agent.id;
      targetAgentName = agent.name;
      question = mentionMatch[2].trim();
    }
  }
  if (!targetAgentId) {
    targetAgentId = defaultAssigneeAgentId;
    if (targetAgentId) {
      const r = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, targetAgentId)).limit(1);
      targetAgentName = r[0]?.name ?? null;
    }
  }

  if (!question) {
    const agentRows = await getCompanyAgents(db, company.id);
    const lines = [`❓ <b>Ask a quick question</b>\n`];
    lines.push("<b>Usage:</b>");
    if (agentRows.length > 0) {
      const ex = agentRows[0].name.replace(/\s+/g, "");
      lines.push(`  <code>/ask @${esc(ex)} How does the auth work?</code>`);
      lines.push(`  <code>/ask What's the deployment status?</code>`);
    } else {
      lines.push("  <code>/ask @AgentName Your question</code>");
    }
    lines.push("\nNo issue is created — just a conversation topic.");
    await reply(chatId, lines.join("\n"), msg.message_thread_id);
    return;
  }

  if (!msg.chat.is_forum) {
    await reply(chatId, "⚠️ /ask requires forum topics to be enabled.\nEnable Topics in group settings, or use /issue to create a tracked issue instead.", msg.message_thread_id);
    return;
  }

  // Create forum topic for the question
  const agentLabel = targetAgentName ? `@${targetAgentName}` : "Q";
  const topicName = `${agentLabel}: ${question}`.slice(0, 128);
  const threadId = await createForumTopic(botToken, forumChatId, topicName);
  if (!threadId) {
    await reply(chatId, "⚠️ Could not create topic — make the bot an <b>admin</b> in this group.", msg.message_thread_id);
    return;
  }

  // Create a lightweight issue to track the conversation
  const svc = issueService(db);
  const issue = await svc.create(company.id, {
    title: `[Q] ${question}`,
    status: "todo",
    assigneeAgentId: targetAgentId ?? undefined,
  });

  // Map thread to issue so replies work
  await db.insert(telegramThreadMappings).values({
    companyId: company.id,
    chatId: forumChatId,
    messageThreadId: threadId,
    issueId: issue.id,
  });

  await logActivity(db, {
    companyId: company.id,
    actorType: "user",
    actorId: `telegram:${msg.from?.id ?? "unknown"}`,
    action: "issue.created",
    entityType: "issue",
    entityId: issue.id,
    details: { title: issue.title, identifier: issue.identifier, source: "telegram_ask" },
  });

  const agentLine = targetAgentName ? `\n🤖 <b>${esc(targetAgentName)}</b> will respond here.` : "";
  void sendMessageToThread(
    botToken, forumChatId, threadId,
    `❓ <b>${esc(question)}</b>${agentLine}\n\n💬 Reply in this thread to continue the conversation.`,
  );

  // Wake agent
  if (targetAgentId) {
    void heartbeatService(db).wakeup(targetAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: issue.id, source: "telegram_ask" },
      requestedByActorType: "user",
      requestedByActorId: `telegram:${msg.from?.id ?? "unknown"}`,
      contextSnapshot: { issueId: issue.id, taskId: issue.id, source: "telegram.ask_command", wakeReason: "issue_assigned" },
    });
  }

  logger.info({ issueId: issue.id, question: question.slice(0, 80), chatId }, "Telegram /ask: created question topic");
}

// ---------------------------------------------------------------------------
// /debug
// ---------------------------------------------------------------------------

async function cmdDebug(db: Db, msg: TelegramMessage): Promise<void> {
  const chatId = String(msg.chat.id);
  const company = await resolveCompany(db, chatId);

  const lines = ["🔧 <b>Debug Info</b>\n"];
  lines.push(`<b>Chat:</b> ${esc(msg.chat.title ?? "N/A")}`);
  lines.push(`<b>Chat ID:</b> <code>${chatId}</code>`);
  lines.push(`<b>Type:</b> ${msg.chat.type}`);
  lines.push(`<b>Forum:</b> ${msg.chat.is_forum ? "✅ Yes" : "❌ No"}`);
  lines.push("");
  if (company) {
    lines.push(`<b>Company:</b> ${esc(company.issuePrefix)}`);
    const { defaultAssigneeAgentId } = getTelegramSettings(company);
    if (defaultAssigneeAgentId) {
      const r = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, defaultAssigneeAgentId)).limit(1);
      lines.push(`<b>Default agent:</b> ${r[0]?.name ? esc(r[0].name) : defaultAssigneeAgentId.slice(0, 8)}`);
    }
  } else {
    lines.push("⚠️ Not linked to any company. Use /register");
  }

  await reply(chatId, lines.join("\n"), msg.message_thread_id);
}

// ---------------------------------------------------------------------------
// Thread reply — add comment + wake agent
// ---------------------------------------------------------------------------

async function handleThreadReply(db: Db, msg: TelegramMessage): Promise<void> {
  if (!msg.message_thread_id || !msg.text) return;

  const chatId = String(msg.chat.id);
  const threadId = String(msg.message_thread_id);

  const rows = await db
    .select({ issueId: telegramThreadMappings.issueId, companyId: telegramThreadMappings.companyId })
    .from(telegramThreadMappings)
    .where(and(eq(telegramThreadMappings.chatId, chatId), eq(telegramThreadMappings.messageThreadId, threadId)))
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
    details: { commentId: comment.id, bodySnippet: comment.body.slice(0, 120), telegramOrigin: true, source: "telegram" },
  });

  const issueRows = await db
    .select({ assigneeAgentId: issues.assigneeAgentId })
    .from(issues)
    .where(eq(issues.id, mapping.issueId))
    .limit(1);

  const assigneeAgentId = issueRows[0]?.assigneeAgentId;
  if (assigneeAgentId) {
    void heartbeatService(db).wakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: { issueId: mapping.issueId, commentId: comment.id, source: "telegram" },
      requestedByActorType: "user",
      requestedByActorId: userId,
      contextSnapshot: { issueId: mapping.issueId, taskId: mapping.issueId, commentId: comment.id, source: "telegram.thread_reply", wakeReason: "issue_commented" },
    });
  }
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function telegramWebhookRoutes(db: Db) {
  const router = Router();

  router.post("/webhooks/telegram", async (req, res) => {
    if (WEBHOOK_SECRET) {
      const hdr = req.headers["x-telegram-bot-api-secret-token"] as string | undefined;
      if (hdr !== WEBHOOK_SECRET) { res.status(403).json({ error: "Forbidden" }); return; }
    }

    const update = req.body as TelegramUpdate;
    const msg = update.message;
    if (!msg || !msg.text) { res.status(200).json({ ok: true }); return; }

    const chatId = String(msg.chat.id);
    logger.info({ updateId: update.update_id, chatId, text: msg.text.slice(0, 80) }, "Telegram webhook");

    try {
      const text = msg.text;

      // Commands with args
      const registerMatch = text.match(/^\/register(?:@\S+)?(?:\s+(.*))?$/s);
      if (registerMatch) { await cmdRegister(db, msg, registerMatch[1] ?? ""); res.status(200).json({ ok: true }); return; }

      const setDefaultMatch = text.match(/^\/setdefault(?:@\S+)?(?:\s+(.*))?$/s);
      if (setDefaultMatch) { await cmdSetDefault(db, msg, setDefaultMatch[1] ?? ""); res.status(200).json({ ok: true }); return; }

      const issueMatch = text.match(/^\/issue(?:@\S+)?(?:\s+(.+))?$/s);
      if (issueMatch) {
        if (issueMatch[1]) { await cmdIssue(db, msg, issueMatch[1]); }
        else { await cmdIssueHelp(db, msg); }
        res.status(200).json({ ok: true }); return;
      }

      const askMatch = text.match(/^\/ask(?:@\S+)?(?:\s+(.*))?$/s);
      if (askMatch) { await cmdAsk(db, msg, askMatch[1] ?? ""); res.status(200).json({ ok: true }); return; }

      if (text.match(/^\/agents(?:@\S+)?\s*$/)) { await cmdAgents(db, msg); res.status(200).json({ ok: true }); return; }
      if (text.match(/^\/projects(?:@\S+)?\s*$/)) { await cmdProjects(db, msg); res.status(200).json({ ok: true }); return; }
      if (text.match(/^\/debug(?:@\S+)?\s*$/)) { await cmdDebug(db, msg); res.status(200).json({ ok: true }); return; }

      // Thread reply
      if (msg.message_thread_id) { await handleThreadReply(db, msg); }

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error({ err, updateId: update.update_id, chatId }, "Telegram webhook error");
      res.status(200).json({ ok: true });
    }
  });

  return router;
}
