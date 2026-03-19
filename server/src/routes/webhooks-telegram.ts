import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents, companies, projects, telegramThreadMappings, issues } from "@paperclipai/db";
import { eq, and, or, sql, inArray, desc } from "drizzle-orm";
import { issueService, heartbeatService, logActivity } from "../services/index.js";
import { createForumTopic, sendMessageToThread } from "../services/telegram.js";
import { logger } from "../middleware/logger.js";

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

function getBotToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN?.trim() || null;
}

interface TelegramEntity {
  type: string;
  offset: number;
  length: number;
  user?: { id: number; first_name?: string; username?: string; is_bot?: boolean };
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name?: string; username?: string };
  chat: { id: number; type: string; title?: string; is_forum?: boolean };
  message_thread_id?: number;
  text?: string;
  entities?: TelegramEntity[];
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number; first_name?: string };
    message?: { chat: { id: number }; message_id: number; message_thread_id?: number };
    data?: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

async function reply(
  chatId: string,
  text: string,
  threadId?: number,
  inlineKeyboard?: InlineKeyboardButton[][],
): Promise<void> {
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
        ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
      }),
    });
  } catch {
    // best-effort
  }
}

async function answerCallbackQuery(queryId: string, text?: string): Promise<void> {
  const botToken = getBotToken();
  if (!botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: queryId, text: text ?? "" }),
    });
  } catch {
    // best-effort
  }
}

async function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  inlineKeyboard?: InlineKeyboardButton[][],
): Promise<void> {
  const botToken = getBotToken();
  if (!botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {}),
      }),
    });
  } catch {
    // best-effort
  }
}

async function setMessageReaction(chatId: string | number, messageId: number, emoji: string): Promise<void> {
  const botToken = getBotToken();
  if (!botToken) return;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/setMessageReaction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji }],
      }),
    });
  } catch {
    // best-effort
  }
}

/** Build status action buttons for an issue */
function issueActionButtons(issueId: string, currentStatus?: string): InlineKeyboardButton[][] {
  const buttons: InlineKeyboardButton[] = [];
  if (currentStatus !== "done") buttons.push({ text: "\u2705 Done", callback_data: `status:${issueId}:done` });
  if (currentStatus !== "in_progress") buttons.push({ text: "\uD83D\uDD04 In Progress", callback_data: `status:${issueId}:in_progress` });
  if (currentStatus !== "blocked") buttons.push({ text: "\uD83D\uDEAB Blocked", callback_data: `status:${issueId}:blocked` });
  if (currentStatus !== "cancelled") buttons.push({ text: "\u274C Cancel", callback_data: `status:${issueId}:cancelled` });
  // Telegram limits callback_data to 64 bytes, ensure we stay within that
  return [buttons.slice(0, 4)];
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
// /list — show open issues
// ---------------------------------------------------------------------------

const OPEN_STATUSES = ["todo", "in_progress", "blocked", "in_review"];

async function cmdList(db: Db, msg: TelegramMessage, filterAgentId?: string | null): Promise<void> {
  const chatId = String(msg.chat.id);
  const company = await requireCompany(db, chatId, msg.message_thread_id);
  if (!company) return;

  const conditions = [
    eq(issues.companyId, company.id),
    inArray(issues.status, OPEN_STATUSES),
  ];
  if (filterAgentId) {
    conditions.push(eq(issues.assigneeAgentId, filterAgentId));
  }

  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(and(...conditions))
    .orderBy(desc(issues.updatedAt))
    .limit(20);

  if (rows.length === 0) {
    const label = filterAgentId ? "No open issues assigned to this agent." : "No open issues found.";
    await reply(chatId, label, msg.message_thread_id);
    return;
  }

  // Resolve agent names in bulk
  const agentIds = [...new Set(rows.map((r) => r.assigneeAgentId).filter(Boolean))] as string[];
  const agentMap = new Map<string, string>();
  if (agentIds.length > 0) {
    const agentRows = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(inArray(agents.id, agentIds));
    for (const a of agentRows) agentMap.set(a.id, a.name);
  }

  const heading = filterAgentId
    ? `\uD83D\uDCCB <b>My Issues — ${esc(company.issuePrefix)}</b>`
    : `\uD83D\uDCCB <b>Open Issues — ${esc(company.issuePrefix)}</b>`;
  const lines = [heading, ""];

  for (const r of rows) {
    const icon = STATUS_ICONS[r.status] ?? "\u2022";
    const agent = r.assigneeAgentId ? agentMap.get(r.assigneeAgentId) : null;
    const agentTag = agent ? ` \u2192 ${esc(agent)}` : "";
    lines.push(`${icon} <b>${esc(r.identifier ?? "?")}</b> ${esc((r.title ?? "").slice(0, 60))}${agentTag}`);
  }

  lines.push("");
  lines.push(`Showing ${rows.length} issue${rows.length === 1 ? "" : "s"}`);

  // Build inline keyboard — one row per issue with quick status buttons
  const keyboard: InlineKeyboardButton[][] = [];
  for (const r of rows.slice(0, 10)) {
    const row: InlineKeyboardButton[] = [];
    if (r.status !== "done") row.push({ text: `\u2705 ${r.identifier ?? "?"}`, callback_data: `status:${r.id}:done` });
    if (r.status !== "blocked") row.push({ text: `\uD83D\uDEAB ${r.identifier ?? "?"}`, callback_data: `status:${r.id}:blocked` });
    if (r.status !== "cancelled") row.push({ text: `\u274C ${r.identifier ?? "?"}`, callback_data: `status:${r.id}:cancelled` });
    if (row.length > 0) keyboard.push(row.slice(0, 3));
  }

  await reply(chatId, lines.join("\n"), msg.message_thread_id, keyboard.length > 0 ? keyboard : undefined);
}

// ---------------------------------------------------------------------------
// /my — show issues for default agent
// ---------------------------------------------------------------------------

async function cmdMy(db: Db, msg: TelegramMessage): Promise<void> {
  const chatId = String(msg.chat.id);
  const company = await requireCompany(db, chatId, msg.message_thread_id);
  if (!company) return;

  const { defaultAssigneeAgentId } = getTelegramSettings(company);
  if (!defaultAssigneeAgentId) {
    await reply(chatId, "\u26A0\uFE0F No default agent set.\n\nUse <code>/setdefault AgentName</code> first.", msg.message_thread_id);
    return;
  }

  await cmdList(db, msg, defaultAssigneeAgentId);
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

  lines.push("📎 /agents  /projects  /status  /close  /debug");

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

  // Inline buttons for the new issue
  const buttons = issueActionButtons(issue.id, "todo");

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

      const assignLine = assigneeName ? `\n\uD83E\uDD16 Assigned to <b>${esc(assigneeName)}</b>` : "";
      // Send thread intro with buttons
      const botToken2 = getBotToken();
      if (botToken2) {
        try {
          await fetch(`https://api.telegram.org/bot${botToken2}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: forumChatId,
              message_thread_id: Number(threadId),
              text: `\u2705 <b>${esc(issue.identifier ?? "")}: ${esc(title)}</b>${assignLine}\n\n\uD83D\uDCAC Reply here to comment on this issue.\nAgent responses will appear in this thread.`,
              parse_mode: "HTML",
              disable_web_page_preview: true,
              reply_markup: { inline_keyboard: buttons },
            }),
          });
        } catch {
          // fallback
          void sendMessageToThread(
            botToken, forumChatId, threadId,
            `\u2705 <b>${esc(issue.identifier ?? "")}: ${esc(title)}</b>${assignLine}\n\n\uD83D\uDCAC Reply here to comment on this issue.\nAgent responses will appear in this thread.`,
          );
        }
      }
    } else {
      const assignLine = assigneeName ? ` \u2192 <b>${esc(assigneeName)}</b>` : "";
      await reply(chatId, `\u2705 <b>${esc(issue.identifier ?? "")}</b>${assignLine}\n\n\u26A0\uFE0F Could not create topic \u2014 make the bot an <b>admin</b> (not just member) in this group.`, msg.message_thread_id, buttons);
    }
  } else {
    const assignLine = assigneeName ? ` \u2192 <b>${esc(assigneeName)}</b>` : "";
    await reply(chatId, `\u2705 <b>${esc(issue.identifier ?? "")}: ${esc(title)}</b>${assignLine}\n\n\uD83D\uDCA1 Enable Topics in group settings for per-issue threads.`, msg.message_thread_id, buttons);
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
// /status IDENTIFIER newstatus — change issue status
// ---------------------------------------------------------------------------

const VALID_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"] as const;
const STATUS_ICONS: Record<string, string> = {
  backlog: "📋", todo: "📌", in_progress: "🔄", in_review: "👀", done: "✅", blocked: "🚫", cancelled: "❌",
};

async function cmdStatus(db: Db, msg: TelegramMessage, input: string): Promise<void> {
  const chatId = String(msg.chat.id);
  const company = await requireCompany(db, chatId, msg.message_thread_id);
  if (!company) return;

  const parts = input.trim().split(/\s+/);
  if (parts.length < 2 || !parts[0]) {
    const lines = [
      `🔄 <b>Change Issue Status</b>\n`,
      `<b>Usage:</b> <code>/status IDENTIFIER newstatus</code>`,
      `<b>Example:</b> <code>/status ${esc(company.issuePrefix)}-1 done</code>\n`,
      `<b>Statuses:</b>`,
      ...VALID_STATUSES.map((s) => `  ${STATUS_ICONS[s] ?? "•"} <code>${s}</code>`),
      `\n<b>Shortcut:</b> <code>/close ${esc(company.issuePrefix)}-1</code>`,
    ];
    await reply(chatId, lines.join("\n"), msg.message_thread_id);
    return;
  }

  const identifier = parts[0].toUpperCase();
  const newStatus = parts[1].toLowerCase();

  if (!VALID_STATUSES.includes(newStatus as (typeof VALID_STATUSES)[number])) {
    await reply(chatId, `❌ Invalid status "<b>${esc(newStatus)}</b>"\n\nValid: ${VALID_STATUSES.join(", ")}`, msg.message_thread_id);
    return;
  }

  const issueRows = await db
    .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status })
    .from(issues)
    .where(and(eq(issues.companyId, company.id), sql`upper(${issues.identifier}) = ${identifier}`))
    .limit(1);

  const issue = issueRows[0];
  if (!issue) {
    await reply(chatId, `❌ Issue <b>${esc(identifier)}</b> not found.`, msg.message_thread_id);
    return;
  }

  if (issue.status === newStatus) {
    await reply(chatId, `${STATUS_ICONS[newStatus] ?? "•"} <b>${esc(issue.identifier ?? identifier)}</b> is already <b>${esc(newStatus)}</b>.`, msg.message_thread_id);
    return;
  }

  try {
    const svc = issueService(db);
    await svc.update(issue.id, { status: newStatus });

    await logActivity(db, {
      companyId: company.id,
      actorType: "user",
      actorId: `telegram:${msg.from?.id ?? "unknown"}`,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: { status: newStatus, previousStatus: issue.status, identifier: issue.identifier, source: "telegram" },
    });

    const icon = STATUS_ICONS[newStatus] ?? "\u2022";
    const buttons = issueActionButtons(issue.id, newStatus);
    await reply(chatId, `${icon} <b>${esc(issue.identifier ?? identifier)}</b> \u2192 <b>${esc(newStatus)}</b>\n<i>${esc((issue.title ?? "").slice(0, 100))}</i>`, msg.message_thread_id, buttons);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    await reply(chatId, `\u274C Failed to update: ${esc(errMsg)}`, msg.message_thread_id);
  }
}

// ---------------------------------------------------------------------------
// /close IDENTIFIER — shortcut for /status X done
// ---------------------------------------------------------------------------

async function cmdClose(db: Db, msg: TelegramMessage, input: string): Promise<void> {
  const identifier = input.trim().split(/\s+/)[0];
  if (!identifier) {
    const chatId = String(msg.chat.id);
    const company = await requireCompany(db, chatId, msg.message_thread_id);
    if (!company) return;
    await reply(chatId, `✅ <b>Close an issue</b>\n\n<b>Usage:</b> <code>/close ${esc(company.issuePrefix)}-1</code>`, msg.message_thread_id);
    return;
  }
  await cmdStatus(db, msg, `${identifier} done`);
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

  // React with checkmark to confirm comment was recorded
  void setMessageReaction(chatId, msg.message_id, "\u2705");

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
// Callback query handler — inline keyboard button presses
// ---------------------------------------------------------------------------

async function handleCallbackQuery(
  db: Db,
  query: NonNullable<TelegramUpdate["callback_query"]>,
): Promise<void> {
  const data = query.data ?? "";
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;

  // Parse callback data: "status:ISSUE_UUID:newstatus"
  const statusMatch = data.match(/^status:([0-9a-f-]+):(\w+)$/);
  if (!statusMatch) {
    await answerCallbackQuery(query.id, "Unknown action");
    return;
  }

  const issueId = statusMatch[1];
  const newStatus = statusMatch[2];

  if (!VALID_STATUSES.includes(newStatus as (typeof VALID_STATUSES)[number])) {
    await answerCallbackQuery(query.id, "Invalid status");
    return;
  }

  // Fetch the issue
  const issueRows = await db
    .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status, companyId: issues.companyId })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);

  const issue = issueRows[0];
  if (!issue) {
    await answerCallbackQuery(query.id, "Issue not found");
    return;
  }

  if (issue.status === newStatus) {
    await answerCallbackQuery(query.id, `Already ${newStatus}`);
    return;
  }

  try {
    const svc = issueService(db);
    await svc.update(issue.id, { status: newStatus });

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "user",
      actorId: `telegram:${query.from?.id ?? "unknown"}`,
      action: "issue.updated",
      entityType: "issue",
      entityId: issue.id,
      details: { status: newStatus, previousStatus: issue.status, identifier: issue.identifier, source: "telegram_button" },
    });

    const icon = STATUS_ICONS[newStatus] ?? "\u2022";
    await answerCallbackQuery(query.id, `${icon} ${issue.identifier ?? "?"} \u2192 ${newStatus}`);

    // Update the original message to reflect the new status
    if (chatId && messageId) {
      const buttons = issueActionButtons(issue.id, newStatus);
      await editMessageText(
        chatId,
        messageId,
        `${icon} <b>${esc(issue.identifier ?? "?")}</b> \u2192 <b>${esc(newStatus)}</b>\n<i>${esc((issue.title ?? "").slice(0, 100))}</i>`,
        buttons,
      );
    }

    logger.info({ issueId: issue.id, identifier: issue.identifier, newStatus, from: query.from?.id }, "Telegram callback: status updated");
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    await answerCallbackQuery(query.id, `Error: ${errMsg.slice(0, 50)}`);
  }
}

// ---------------------------------------------------------------------------
// @mention detection helper
// ---------------------------------------------------------------------------

function detectBotMention(msg: TelegramMessage): { found: boolean; textWithoutMention: string } {
  const text = msg.text ?? "";
  if (!msg.entities || msg.entities.length === 0) return { found: false, textWithoutMention: text };

  // Check for @username mention (e.g. @sixzenith_ai_bot)
  const usernameMention = msg.entities.find(
    (e) => e.type === "mention" && text.slice(e.offset, e.offset + e.length).toLowerCase() === "@sixzenith_ai_bot",
  );
  if (usernameMention) {
    const before = text.slice(0, usernameMention.offset);
    const after = text.slice(usernameMention.offset + usernameMention.length);
    return { found: true, textWithoutMention: (before + after).trim() };
  }

  // Check for text_mention entity type (mentions by name without @username, e.g. tapping on the bot's name)
  const textMention = msg.entities.find(
    (e) => e.type === "text_mention" && e.user?.is_bot === true && e.user?.username?.toLowerCase() === "sixzenith_ai_bot",
  );
  if (textMention) {
    const before = text.slice(0, textMention.offset);
    const after = text.slice(textMention.offset + textMention.length);
    return { found: true, textWithoutMention: (before + after).trim() };
  }

  return { found: false, textWithoutMention: text };
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

    // Handle callback queries (inline keyboard button presses)
    if (update.callback_query) {
      logger.info({ updateId: update.update_id, data: update.callback_query.data }, "Telegram callback_query");
      try {
        await handleCallbackQuery(db, update.callback_query);
      } catch (err) {
        logger.error({ err, updateId: update.update_id }, "Telegram callback_query error");
        void answerCallbackQuery(update.callback_query.id, "Internal error");
      }
      res.status(200).json({ ok: true });
      return;
    }

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

      const statusMatch = text.match(/^\/status(?:@\S+)?(?:\s+(.*))?$/s);
      if (statusMatch) { await cmdStatus(db, msg, statusMatch[1] ?? ""); res.status(200).json({ ok: true }); return; }

      const closeMatch = text.match(/^\/close(?:@\S+)?(?:\s+(.*))?$/s);
      if (closeMatch) { await cmdClose(db, msg, closeMatch[1] ?? ""); res.status(200).json({ ok: true }); return; }

      if (text.match(/^\/list(?:@\S+)?\s*$/)) { await cmdList(db, msg); res.status(200).json({ ok: true }); return; }
      if (text.match(/^\/my(?:@\S+)?\s*$/)) { await cmdMy(db, msg); res.status(200).json({ ok: true }); return; }

      if (text.match(/^\/agents(?:@\S+)?\s*$/)) { await cmdAgents(db, msg); res.status(200).json({ ok: true }); return; }
      if (text.match(/^\/projects(?:@\S+)?\s*$/)) { await cmdProjects(db, msg); res.status(200).json({ ok: true }); return; }
      if (text.match(/^\/debug(?:@\S+)?\s*$/)) { await cmdDebug(db, msg); res.status(200).json({ ok: true }); return; }

      // @bot mention — treat as /ask naturally (supports both @username and text_mention)
      const { found: isBotMention, textWithoutMention } = detectBotMention(msg);
      if (isBotMention && textWithoutMention) {
        logger.info({ trimmed: textWithoutMention, chatId }, "Telegram @mention \u2192 /ask");
        await cmdAsk(db, msg, textWithoutMention);
        res.status(200).json({ ok: true }); return;
      }

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
