import { eq, and, ilike, or, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, agents, issueComments } from "@paperclipai/db";
import { loadConfig } from "../config.js";
import { logger } from "../middleware/logger.js";

const POLL_INTERVAL_MS = 3000;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from: { id: number; first_name: string };
    chat: { id: number };
    text?: string;
    reply_to_message?: { message_id: number; text?: string };
  };
}

let _lastUpdateId = 0;
let _polling = false;
let _pollTimer: ReturnType<typeof setTimeout> | null = null;

function botUrl(token: string, method: string) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

async function sendMessage(token: string, chatId: number | string, text: string, replyTo?: number) {
  await fetch(botUrl(token, "sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
      ...(replyTo ? { reply_to_message_id: replyTo } : {}),
    }),
  });
}

async function handleCommand(db: Db, token: string, chatId: number, messageId: number, text: string) {
  const trimmed = text.trim();

  // /help
  if (trimmed === "/help" || trimmed === "/start") {
    await sendMessage(token, chatId, [
      "*Paperclip Bot Commands*",
      "",
      "`/status <identifier>` — Get issue status",
      "`/issues` — List open issues",
      "`/blocked` — List blocked issues",
      "`/mine` — List issues assigned to humans",
      "`/unblock <identifier>` — Move issue to todo",
      "`/comment <identifier> <text>` — Add comment to issue",
      "`/agents` — List agents and their status",
    ].join("\n"), messageId);
    return;
  }

  // /status SPA-123
  const statusMatch = trimmed.match(/^\/status\s+(\S+)/i);
  if (statusMatch) {
    const identifier = statusMatch[1].toUpperCase();
    const [issue] = await db.select().from(issues).where(eq(issues.identifier, identifier));
    if (!issue) {
      await sendMessage(token, chatId, `Issue \`${identifier}\` not found.`, messageId);
      return;
    }
    const assignee = issue.assigneeAgentId
      ? await db.select({ name: agents.name }).from(agents).where(eq(agents.id, issue.assigneeAgentId)).then(r => r[0]?.name ?? "Unknown")
      : issue.assigneeUserId ?? "Unassigned";
    await sendMessage(token, chatId, [
      `*${issue.identifier}* — ${issue.title}`,
      `Status: \`${issue.status}\``,
      `Priority: \`${issue.priority}\``,
      `Assignee: ${assignee}`,
      issue.dueAt ? `Due: ${new Date(issue.dueAt).toISOString().slice(0, 10)}` : null,
    ].filter(Boolean).join("\n"), messageId);
    return;
  }

  // /issues
  if (trimmed === "/issues") {
    const openIssues = await db.select({
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
    }).from(issues).where(
      and(
        or(
          eq(issues.status, "todo"),
          eq(issues.status, "in_progress"),
          eq(issues.status, "in_review"),
          eq(issues.status, "blocked"),
        ),
      ),
    ).orderBy(desc(issues.updatedAt)).limit(15);

    if (openIssues.length === 0) {
      await sendMessage(token, chatId, "No open issues.", messageId);
      return;
    }
    const lines = openIssues.map(i => `\`${i.status?.padEnd(12)}\` *${i.identifier}* ${i.title?.slice(0, 40)}`);
    await sendMessage(token, chatId, `*Open Issues (${openIssues.length})*\n\n${lines.join("\n")}`, messageId);
    return;
  }

  // /blocked
  if (trimmed === "/blocked") {
    const blockedIssues = await db.select({
      identifier: issues.identifier,
      title: issues.title,
      assigneeAgentId: issues.assigneeAgentId,
    }).from(issues).where(eq(issues.status, "blocked")).orderBy(desc(issues.updatedAt)).limit(15);

    if (blockedIssues.length === 0) {
      await sendMessage(token, chatId, "No blocked issues.", messageId);
      return;
    }
    const lines = blockedIssues.map(i => `*${i.identifier}* ${i.title?.slice(0, 50)}`);
    await sendMessage(token, chatId, `*Blocked Issues (${blockedIssues.length})*\n\n${lines.join("\n")}`, messageId);
    return;
  }

  // /mine
  if (trimmed === "/mine") {
    const humanIssues = await db.select({
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
    }).from(issues).where(
      and(
        or(
          eq(issues.status, "todo"),
          eq(issues.status, "in_progress"),
          eq(issues.status, "in_review"),
          eq(issues.status, "blocked"),
        ),
        eq(issues.assigneeAgentId, null as unknown as string),
      ),
    ).orderBy(desc(issues.updatedAt)).limit(15);

    // Include issues assigned to users (not agents)
    if (humanIssues.length === 0) {
      await sendMessage(token, chatId, "No issues assigned to humans.", messageId);
      return;
    }
    const lines = humanIssues.map(i => `\`${i.status?.padEnd(12)}\` *${i.identifier}* ${i.title?.slice(0, 40)}`);
    await sendMessage(token, chatId, `*Your Issues (${humanIssues.length})*\n\n${lines.join("\n")}`, messageId);
    return;
  }

  // /unblock SPA-123
  const unblockMatch = trimmed.match(/^\/unblock\s+(\S+)/i);
  if (unblockMatch) {
    const identifier = unblockMatch[1].toUpperCase();
    const [issue] = await db.select().from(issues).where(eq(issues.identifier, identifier));
    if (!issue) {
      await sendMessage(token, chatId, `Issue \`${identifier}\` not found.`, messageId);
      return;
    }
    if (issue.status !== "blocked") {
      await sendMessage(token, chatId, `\`${identifier}\` is not blocked (status: \`${issue.status}\`).`, messageId);
      return;
    }
    await db.update(issues).set({ status: "todo", updatedAt: new Date() }).where(eq(issues.id, issue.id));
    await sendMessage(token, chatId, `*${identifier}* moved from \`blocked\` → \`todo\`.`, messageId);
    return;
  }

  // /comment SPA-123 some text here
  const commentMatch = trimmed.match(/^\/comment\s+(\S+)\s+(.+)/is);
  if (commentMatch) {
    const identifier = commentMatch[1].toUpperCase();
    const body = commentMatch[2].trim();
    const [issue] = await db.select().from(issues).where(eq(issues.identifier, identifier));
    if (!issue) {
      await sendMessage(token, chatId, `Issue \`${identifier}\` not found.`, messageId);
      return;
    }
    await db.insert(issueComments).values({
      companyId: issue.companyId,
      issueId: issue.id,
      authorUserId: "telegram-bot",
      body,
    });
    await sendMessage(token, chatId, `Comment added to *${identifier}*.`, messageId);
    return;
  }

  // /agents
  if (trimmed === "/agents") {
    const agentList = await db.select({
      name: agents.name,
      status: agents.status,
      adapterType: agents.adapterType,
    }).from(agents).orderBy(agents.name).limit(20);

    const lines = agentList.map(a => `\`${(a.status ?? "?").padEnd(8)}\` *${a.name}* (${a.adapterType})`);
    await sendMessage(token, chatId, `*Agents (${agentList.length})*\n\n${lines.join("\n")}`, messageId);
    return;
  }

  // Unknown command
  await sendMessage(token, chatId, "Unknown command. Send /help for available commands.", messageId);
}

async function pollUpdates(db: Db, token: string, allowedChatId: string) {
  try {
    const res = await fetch(botUrl(token, "getUpdates") + `?offset=${_lastUpdateId + 1}&timeout=2`, {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
    if (!data.ok || !data.result) return;

    for (const update of data.result) {
      _lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg?.text || String(msg.chat.id) !== allowedChatId) continue;
      try {
        await handleCommand(db, token, msg.chat.id, msg.message_id, msg.text);
      } catch (err) {
        logger.warn({ err, text: msg.text }, "telegram bot command failed");
        await sendMessage(token, msg.chat.id, "Error processing command.", msg.message_id).catch(() => {});
      }
    }
  } catch (err) {
    if (!(err instanceof Error && err.name === "TimeoutError")) {
      logger.warn({ err }, "telegram bot poll failed");
    }
  }
}

export function startTelegramBot(db: Db): void {
  const config = loadConfig();
  const token = config.notificationTelegramBotToken;
  const chatId = config.notificationTelegramChatId;
  const enabled = process.env.PAPERCLIP_TELEGRAM_BOT_ENABLED === "true";

  if (!enabled || !token || !chatId) {
    return;
  }

  if (_polling) return;
  _polling = true;

  logger.info("Telegram bot polling started");

  const poll = () => {
    void pollUpdates(db, token, chatId).finally(() => {
      if (_polling) {
        _pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }
    });
  };

  poll();
}

export function stopTelegramBot(): void {
  _polling = false;
  if (_pollTimer) {
    clearTimeout(_pollTimer);
    _pollTimer = null;
  }
}
