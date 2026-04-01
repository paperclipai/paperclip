/**
 * Multi-tenant Telegram bridge.
 *
 * Each company that configures a Telegram bot token gets its own polling loop.
 * Messages become Issues; CEO agent responses are relayed back to Telegram.
 */

import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { messagingBridges } from "@ironworksai/db";
import { messagingBridgeService } from "../services/messaging-bridges.js";
import { issueService } from "../services/issues.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";

const TELEGRAM_API = "https://api.telegram.org";
const POLL_INTERVAL_MS = 10_000;
const MAX_TELEGRAM_MSG_LENGTH = 4000; // leave buffer under 4096 limit

// ── Types ──

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
    from?: { first_name?: string; username?: string };
  };
}

interface BotInstance {
  companyId: string;
  token: string;
  ceoAgentId: string | null;
  lastUpdateId: number;
  activeThreads: Map<string, string>; // chatId -> issueId
  lastSeenComment: Map<string, number>; // issueId -> timestamp
  abortController: AbortController;
  pollTimer: ReturnType<typeof setTimeout> | null;
  responsePollTimer: ReturnType<typeof setTimeout> | null;
}

// ── Module state ──

const bots = new Map<string, BotInstance>(); // companyId -> BotInstance

// ── Telegram API helpers ──

async function tgApi(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  try {
    const res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as { ok: boolean; result?: unknown; description?: string };
  } catch (err) {
    return { ok: false, description: (err as Error).message };
  }
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<void> {
  // Split into chunks respecting Telegram's 4096-char limit
  for (let i = 0; i < text.length; i += MAX_TELEGRAM_MSG_LENGTH) {
    const chunk = text.slice(i, i + MAX_TELEGRAM_MSG_LENGTH);
    await tgApi(token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "Markdown",
    });
  }
}

// ── Issue helpers ──

function getIssueService(db: Db) {
  return issueService(db);
}

async function createBridgeIssue(
  db: Db,
  companyId: string,
  ceoAgentId: string | null,
  title: string,
  description: string,
): Promise<{ id?: string; issueId?: string; identifier?: string; error?: string }> {
  const svc = getIssueService(db);
  try {
    const issue = await svc.create(companyId, {
      title: title.slice(0, 200),
      description,
      assigneeAgentId: ceoAgentId ?? undefined,
      status: "todo",
      originKind: "telegram_bridge",
    });
    return issue as { id?: string; issueId?: string; identifier?: string };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function addBridgeComment(
  db: Db,
  _companyId: string,
  issueId: string,
  body: string,
): Promise<{ error?: string }> {
  const svc = getIssueService(db);
  try {
    await svc.addComment(issueId, body, { userId: "telegram-bridge" });
    return {};
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function getIssueComments(
  db: Db,
  _companyId: string,
  issueId: string,
): Promise<Array<Record<string, unknown>>> {
  const svc = getIssueService(db);
  try {
    const comments = await svc.listComments(issueId, { limit: 50, order: "asc" });
    return (comments as Array<Record<string, unknown>>) ?? [];
  } catch {
    return [];
  }
}

// ── Resolve the CEO agent for a company ──

async function findCeoAgent(db: Db, companyId: string): Promise<string | null> {
  const svc = agentService(db);
  try {
    const agents = await svc.list(companyId);
    const ceo = (agents as Array<{ id: string; role?: string; title?: string }>).find(
      (a) =>
        a.role?.toLowerCase() === "ceo" ||
        a.title?.toLowerCase()?.includes("ceo"),
    );
    return ceo?.id ?? (agents as Array<{ id: string }>)[0]?.id ?? null;
  } catch {
    return null;
  }
}

// ── Resolve the bot token from a secret ──

async function resolveToken(db: Db, companyId: string, secretId: string): Promise<string | null> {
  const svc = secretService(db);
  try {
    const value = await svc.resolveSecretValue(companyId, secretId, "latest");
    return value ?? null;
  } catch {
    return null;
  }
}

// ── Polling loops ──

function startTelegramPollLoop(db: Db, bot: BotInstance): void {
  async function poll() {
    if (bot.abortController.signal.aborted) return;

    try {
      const data = await tgApi(bot.token, "getUpdates", {
        offset: bot.lastUpdateId + 1,
        timeout: 30,
        allowed_updates: ["message"],
      });

      if (!data.ok || !Array.isArray(data.result) || data.result.length === 0) {
        schedulePoll();
        return;
      }

      for (const update of data.result as TelegramUpdate[]) {
        bot.lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);
        const text = msg.text.trim();

        // Handle /start
        if (text === "/start") {
          await sendTelegram(
            bot.token,
            chatId,
            "Ironworks Bridge\n\nYour messages go directly to the CEO agent.\n\nCommands:\n/new - Start a new conversation thread\n/status - Check CEO response status",
          );
          continue;
        }

        // Handle /new
        if (text === "/new") {
          bot.activeThreads.delete(chatId);
          await sendTelegram(
            bot.token,
            chatId,
            "New thread started. Send your message and it will create a new task for the CEO.",
          );
          continue;
        }

        // Handle /status
        if (text === "/status") {
          const issueId = bot.activeThreads.get(chatId);
          if (!issueId) {
            await sendTelegram(bot.token, chatId, "No active thread. Send a message to start one.");
          } else {
            await sendTelegram(bot.token, chatId, `Active thread: ${issueId}\nWaiting for CEO response...`);
          }
          continue;
        }

        // Regular message
        const existingIssueId = bot.activeThreads.get(chatId);

        if (!existingIssueId) {
          // Create new issue
          const senderName = msg.from?.first_name ?? msg.from?.username ?? "Unknown";
          await sendTelegram(bot.token, chatId, "Creating task for CEO...");

          const issue = await createBridgeIssue(
            db,
            bot.companyId,
            bot.ceoAgentId,
            `[Telegram] ${text.slice(0, 150)}`,
            `Message from Telegram (${senderName}, chat ${chatId}):\n\n${text}`,
          );

          if (issue.error) {
            await sendTelegram(bot.token, chatId, `Error creating task: ${issue.error}`);
            continue;
          }

          const newIssueId = issue.id ?? issue.issueId ?? "";
          bot.activeThreads.set(chatId, newIssueId);
          bot.lastSeenComment.set(newIssueId, Date.now());
          await sendTelegram(
            bot.token,
            chatId,
            `Task created (${issue.identifier ?? newIssueId}). CEO will be notified on next heartbeat.\n\nI'll relay the CEO's response here.`,
          );
        } else {
          // Add comment to existing issue
          const result = await addBridgeComment(
            db,
            bot.companyId,
            existingIssueId,
            `[via Telegram]: ${text}`,
          );
          if (result.error) {
            await sendTelegram(bot.token, chatId, `Error: ${result.error}`);
          }
        }
      }
    } catch (err) {
      console.error(`[telegram-bridge] Poll error for company ${bot.companyId}:`, (err as Error).message);
    }

    schedulePoll();
  }

  function schedulePoll() {
    if (bot.abortController.signal.aborted) return;
    bot.pollTimer = setTimeout(poll, 1000);
  }

  poll();
}

function startResponsePollLoop(db: Db, bot: BotInstance): void {
  async function pollResponses() {
    if (bot.abortController.signal.aborted) return;
    if (bot.activeThreads.size === 0) {
      scheduleResponsePoll();
      return;
    }

    for (const [chatId, issueId] of bot.activeThreads.entries()) {
      try {
        const comments = await getIssueComments(db, bot.companyId, issueId);
        const lastSeen = bot.lastSeenComment.get(issueId) ?? 0;

        const newComments = comments.filter((c) => {
          const createdAt = new Date(
            (c.createdAt as string) ?? "",
          ).getTime();
          const isAgent = !!c.authorAgentId;
          const isUser = !!c.authorUserId;
          return createdAt > lastSeen && isAgent && !isUser;
        });

        for (const c of newComments) {
          const body = ((c.body as string) ?? "").trim();
          if (body) {
            await sendTelegram(bot.token, chatId, `CEO:\n${body}`);
          }
          const ts = new Date(
            (c.createdAt as string) ?? "",
          ).getTime();
          if (ts > lastSeen) bot.lastSeenComment.set(issueId, ts);
        }
      } catch (err) {
        console.error(
          `[telegram-bridge] Response poll error for ${issueId}:`,
          (err as Error).message,
        );
      }
    }

    scheduleResponsePoll();
  }

  function scheduleResponsePoll() {
    if (bot.abortController.signal.aborted) return;
    bot.responsePollTimer = setTimeout(pollResponses, POLL_INTERVAL_MS);
  }

  pollResponses();
}

// ── Public API ──

/**
 * Test a Telegram bot token by calling getMe.
 * Returns the bot username on success, or throws on failure.
 */
export async function testTelegramToken(token: string): Promise<string> {
  const result = await tgApi(token, "getMe", {});
  if (!result.ok) {
    throw new Error(result.description ?? "Invalid bot token");
  }
  const botInfo = result.result as { username?: string };
  return botInfo?.username ?? "unknown";
}

/**
 * Start a Telegram bot instance for a company.
 */
export async function startTelegramBridge(
  db: Db,
  companyId: string,
  token: string,
): Promise<void> {
  // Stop existing instance if any
  await stopTelegramBridge(companyId);

  const ceoAgentId = await findCeoAgent(db, companyId);

  const bot: BotInstance = {
    companyId,
    token,
    ceoAgentId,
    lastUpdateId: 0,
    activeThreads: new Map(),
    lastSeenComment: new Map(),
    abortController: new AbortController(),
    pollTimer: null,
    responsePollTimer: null,
  };

  bots.set(companyId, bot);

  // Update bridge status
  const bridgeSvc = messagingBridgeService(db);
  await bridgeSvc.updateStatus(companyId, "telegram", "connected");

  console.log(`[telegram-bridge] Started for company ${companyId}`);

  startTelegramPollLoop(db, bot);
  startResponsePollLoop(db, bot);
}

/**
 * Stop a Telegram bot instance for a company.
 */
export async function stopTelegramBridge(companyId: string): Promise<void> {
  const bot = bots.get(companyId);
  if (!bot) return;

  bot.abortController.abort();
  if (bot.pollTimer) clearTimeout(bot.pollTimer);
  if (bot.responsePollTimer) clearTimeout(bot.responsePollTimer);
  bots.delete(companyId);

  console.log(`[telegram-bridge] Stopped for company ${companyId}`);
}

/**
 * Check if a Telegram bridge is running for a company.
 */
export function isTelegramBridgeRunning(companyId: string): boolean {
  return bots.has(companyId);
}

/**
 * Start all configured Telegram bridges on server startup.
 */
export async function startAllTelegramBridges(db: Db): Promise<void> {
  const bridgeSvc = messagingBridgeService(db);
  const secretSvc = secretService(db);

  // Load all telegram bridges that have a secretId
  const allBridges = await db
    .select()
    .from(messagingBridges)
    .where(
      and(
        eq(messagingBridges.platform, "telegram"),
        isNotNull(messagingBridges.secretId),
      ),
    );

  for (const bridge of allBridges) {
    if (!bridge.secretId) continue;
    try {
      const token = await secretSvc.resolveSecretValue(
        bridge.companyId,
        bridge.secretId,
        "latest",
      );
      if (token) {
        await startTelegramBridge(db, bridge.companyId, token);
      }
    } catch (err) {
      console.error(
        `[telegram-bridge] Failed to start bridge for company ${bridge.companyId}:`,
        (err as Error).message,
      );
      await bridgeSvc.updateStatus(
        bridge.companyId,
        "telegram",
        "error",
        (err as Error).message,
      );
    }
  }
}
