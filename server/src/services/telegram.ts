import { randomUUID } from "node:crypto";
import { Bot } from "grammy";
import { run as grammyRun, type RunnerHandle } from "@grammyjs/runner";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentTelegramConfigs, chatSessions } from "@paperclipai/db";
import type { AgentTelegramConfig, AgentTelegramTestResult } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { subscribeCompanyLiveEvents } from "./live-events.js";
import { chatService } from "./chat.js";
import { heartbeatService } from "./heartbeat.js";
import { agentService } from "./agents.js";
import {
  parseLogLines,
  buildTranscript,
  buildAssistantReply,
  resolveStdoutParser,
  isTerminalRunStatus,
} from "./chat-transcript.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;
const STREAM_POLL_INTERVAL_MS = 1500;
const STREAM_MAX_POLLS = 400; // ~10 min max

interface BotInstance {
  bot: Bot;
  runner: RunnerHandle;
  agentId: string;
  companyId: string;
  unsubscribeLiveEvents: () => void;
}

const pendingRetries = new Set<string>();
const MAX_409_RETRIES = 3;

type ConfigRow = typeof agentTelegramConfigs.$inferSelect;

function toApiConfig(row: ConfigRow): AgentTelegramConfig {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    botUsername: row.botUsername,
    enabled: row.enabled,
    ownerChatId: row.ownerChatId,
    allowedUserIds: (row.allowedUserIds as string[]) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MESSAGE_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MESSAGE_LIMIT) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", TELEGRAM_MESSAGE_LIMIT);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", TELEGRAM_MESSAGE_LIMIT);
    if (splitAt <= 0) splitAt = TELEGRAM_MESSAGE_LIMIT;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

export function telegramService(db: Db) {
  const activeBots = new Map<string, BotInstance>();
  const chat = chatService(db);
  const heartbeat = heartbeatService(db);

  async function getConfig(agentId: string): Promise<ConfigRow | null> {
    return db
      .select()
      .from(agentTelegramConfigs)
      .where(eq(agentTelegramConfigs.agentId, agentId))
      .then((rows) => rows[0] ?? null);
  }

  async function getConfigApi(agentId: string): Promise<AgentTelegramConfig | null> {
    const row = await getConfig(agentId);
    return row ? toApiConfig(row) : null;
  }

  async function upsertConfig(input: {
    agentId: string;
    companyId: string;
    botToken: string;
    enabled?: boolean;
    allowedUserIds?: string[];
  }): Promise<AgentTelegramConfig> {
    const existing = await getConfig(input.agentId);
    const now = new Date();

    if (existing) {
      const [updated] = await db
        .update(agentTelegramConfigs)
        .set({
          botToken: input.botToken,
          enabled: input.enabled ?? existing.enabled,
          allowedUserIds: input.allowedUserIds ?? existing.allowedUserIds,
          updatedAt: now,
        })
        .where(eq(agentTelegramConfigs.id, existing.id))
        .returning();
      if (!updated) throw new Error("Failed to update telegram config");

      await onConfigChange(input.agentId);
      return toApiConfig(updated);
    }

    const [created] = await db
      .insert(agentTelegramConfigs)
      .values({
        companyId: input.companyId,
        agentId: input.agentId,
        botToken: input.botToken,
        enabled: input.enabled ?? false,
        allowedUserIds: input.allowedUserIds ?? [],
      })
      .returning();
    if (!created) throw new Error("Failed to create telegram config");

    await onConfigChange(input.agentId);
    return toApiConfig(created);
  }

  async function updateConfig(input: {
    agentId: string;
    botToken?: string;
    enabled?: boolean;
    ownerChatId?: string | null;
    allowedUserIds?: string[];
  }): Promise<AgentTelegramConfig | null> {
    const existing = await getConfig(input.agentId);
    if (!existing) return null;

    const patch: Partial<typeof agentTelegramConfigs.$inferInsert> = { updatedAt: new Date() };
    if (input.botToken !== undefined) patch.botToken = input.botToken;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.ownerChatId !== undefined) patch.ownerChatId = input.ownerChatId;
    if (input.allowedUserIds !== undefined) patch.allowedUserIds = input.allowedUserIds;

    const [updated] = await db
      .update(agentTelegramConfigs)
      .set(patch)
      .where(eq(agentTelegramConfigs.id, existing.id))
      .returning();
    if (!updated) return null;

    await onConfigChange(input.agentId);
    return toApiConfig(updated);
  }

  async function deleteConfig(agentId: string): Promise<boolean> {
    await stopBot(agentId);
    const rows = await db
      .delete(agentTelegramConfigs)
      .where(eq(agentTelegramConfigs.agentId, agentId))
      .returning();
    return rows.length > 0;
  }

  async function testToken(token: string): Promise<AgentTelegramTestResult> {
    const testBot = new Bot(token);
    const me = await testBot.api.getMe();
    return {
      ok: true,
      botId: me.id,
      botUsername: me.username,
      firstName: me.first_name,
    };
  }

  async function findOrCreateTelegramSession(input: {
    agentId: string;
    companyId: string;
    telegramChatId: string;
  }) {
    const taskKey = `telegram:${input.telegramChatId}`;

    // Find any session with this taskKey (active or archived)
    const match = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.agentId, input.agentId),
          eq(chatSessions.companyId, input.companyId),
          eq(chatSessions.taskKey, taskKey),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (match && !match.archivedAt) {
      // Active session — backfill telegramChatId if missing
      if (!match.telegramChatId) {
        await db
          .update(chatSessions)
          .set({ telegramChatId: input.telegramChatId, updatedAt: new Date() })
          .where(eq(chatSessions.id, match.id));
      }
      return match;
    }

    if (match && match.archivedAt) {
      // Archived session blocking the taskKey slot — rename it to free the constraint
      await db
        .update(chatSessions)
        .set({ taskKey: `${taskKey}:archived:${match.archivedAt.getTime()}` })
        .where(eq(chatSessions.id, match.id));
    }

    const sessionId = randomUUID();
    const [created] = await db
      .insert(chatSessions)
      .values({
        id: sessionId,
        companyId: input.companyId,
        agentId: input.agentId,
        taskKey,
        title: "Telegram chat",
        telegramChatId: input.telegramChatId,
      })
      .returning();
    return created!;
  }

  const agentsSvc = agentService(db);

  async function archiveTelegramSession(agentId: string, telegramChatId: string) {
    const existing = await db
      .select()
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.agentId, agentId),
          eq(chatSessions.telegramChatId, telegramChatId),
          isNull(chatSessions.archivedAt),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      const now = new Date();
      await db
        .update(chatSessions)
        .set({
          archivedAt: now,
          updatedAt: now,
          taskKey: `${existing.taskKey}:archived:${now.getTime()}`,
        })
        .where(eq(chatSessions.id, existing.id));
    }
  }

  async function streamRunToTelegram(
    bot: Bot,
    chatId: number,
    runId: string,
    agentId: string,
  ): Promise<void> {
    const agentRow = await agentsSvc.getById(agentId);
    const parser = resolveStdoutParser(agentRow?.adapterType);

    const placeholder = await bot.api.sendMessage(chatId, "Thinking\u2026");
    const msgId = placeholder.message_id;

    let offset = 0;
    let remainder = "";
    let lastSentText = "";
    const allChunks: import("./chat-transcript.js").ChatLogChunk[] = [];

    for (let poll = 0; poll < STREAM_MAX_POLLS; poll++) {
      const run = await heartbeat.getRun(runId);
      if (!run) {
        await bot.api.editMessageText(chatId, msgId, "The run could not be found.").catch(() => {});
        return;
      }

      const log = await heartbeat.readLog(runId, { offset, limitBytes: 64_000 }).catch(() => null);
      if (log && log.content.length > 0) {
        const parsed = parseLogLines(log.content, remainder);
        remainder = parsed.remainder;
        offset += Buffer.byteLength(log.content, "utf8");
        allChunks.push(...parsed.chunks);

        if (parsed.chunks.length > 0) {
          const transcript = buildTranscript(allChunks, parser);
          const currentText = transcript
            .filter((e) => e.kind === "assistant")
            .map((e) => e.text.trim())
            .filter(Boolean)
            .join("\n\n")
            .trim();

          if (currentText && currentText !== lastSentText) {
            const displayText = currentText.length > TELEGRAM_MESSAGE_LIMIT
              ? currentText.slice(0, TELEGRAM_MESSAGE_LIMIT - 4) + "\u2026"
              : currentText;
            await bot.api.editMessageText(chatId, msgId, displayText).catch((err) => {
              logger.debug({ err }, "telegram: editMessageText failed");
            });
            lastSentText = currentText;
          }
        }
      }

      if (isTerminalRunStatus(run.status)) {
        // Drain any remaining log content
        const finalLog = await heartbeat.readLog(runId, { offset, limitBytes: 256_000 }).catch(() => null);
        if (finalLog && finalLog.content.length > 0) {
          const parsed = parseLogLines(finalLog.content, remainder);
          allChunks.push(...parsed.chunks);
        }

        const transcript = buildTranscript(allChunks, parser);
        const runError = typeof (run as Record<string, unknown>).error === "string"
          ? (run as Record<string, unknown>).error as string
          : null;
        let finalText = buildAssistantReply(transcript, { status: run.status, error: runError });

        if (!finalText) {
          finalText = "The agent finished but did not produce a response.";
        }

        if (finalText.length <= TELEGRAM_MESSAGE_LIMIT) {
          if (finalText !== lastSentText) {
            await bot.api.editMessageText(chatId, msgId, finalText).catch(() => {});
          }
        } else {
          await bot.api.deleteMessage(chatId, msgId).catch(() => {});
          const parts = splitMessage(finalText);
          for (const part of parts) {
            await bot.api.sendMessage(chatId, part);
          }
        }
        return;
      }

      await bot.api.sendChatAction(chatId, "typing").catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, STREAM_POLL_INTERVAL_MS));
    }

    await bot.api.editMessageText(chatId, msgId, "The agent is taking too long. Please try again later.").catch(() => {});
  }

  function startBot(config: ConfigRow): void {
    if (activeBots.has(config.agentId)) return;

    const bot = new Bot(config.botToken);
    const agentId = config.agentId;
    const companyId = config.companyId;
    const allowedUserIds = new Set((config.allowedUserIds as string[]) ?? []);

    bot.command("start", async (ctx) => {
      const agentRow = await db
        .select({ name: agents.name, title: agents.title })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0]);
      const name = agentRow?.name ?? "Agent";
      const title = agentRow?.title ? ` — ${agentRow.title}` : "";
      await ctx.reply(`Hello! I'm ${name}${title}. Send me a message and I'll get to work.`);
    });

    bot.command("help", async (ctx) => {
      await ctx.reply(
        "Available commands:\n" +
        "/start — Introduction\n" +
        "/help — This message\n" +
        "/status — Check if the agent is available\n" +
        "/reset — Start a new conversation\n\n" +
        "Prefix any message with /new to start a fresh conversation.",
      );
    });

    bot.command("status", async (ctx) => {
      const agentRow = await db
        .select({ status: agents.status, name: agents.name })
        .from(agents)
        .where(eq(agents.id, agentId))
        .then((rows) => rows[0]);
      if (!agentRow) {
        await ctx.reply("Agent not found.");
        return;
      }
      await ctx.reply(`${agentRow.name} is currently: ${agentRow.status}`);
    });

    bot.command("reset", async (ctx) => {
      const telegramChatId = String(ctx.chat.id);
      await archiveTelegramSession(agentId, telegramChatId);
      await ctx.reply("Conversation reset. Send a new message to start fresh.");
    });

    bot.on("message:text", async (ctx) => {
      const senderId = String(ctx.from.id);
      const telegramChatId = String(ctx.chat.id);

      if (allowedUserIds.size > 0 && !allowedUserIds.has(senderId)) {
        await ctx.reply("You are not authorized to use this bot.");
        return;
      }

      // Auto-capture ownerChatId from the first person to message the bot
      const currentConfig = await getConfig(agentId);
      if (currentConfig && !currentConfig.ownerChatId) {
        await db
          .update(agentTelegramConfigs)
          .set({ ownerChatId: telegramChatId, updatedAt: new Date() })
          .where(eq(agentTelegramConfigs.id, currentConfig.id));
      }

      const rawText = ctx.message.text;
      let messageText = rawText;
      let forceNewSession = false;

      if (rawText.trimStart().toLowerCase().startsWith("/new")) {
        forceNewSession = true;
        messageText = rawText.trimStart().slice(4).trim();
      }

      try {
        if (forceNewSession) {
          await archiveTelegramSession(agentId, telegramChatId);

          if (!messageText) {
            await ctx.reply("New conversation started. Send your first message.");
            return;
          }
        }

        await ctx.api.sendChatAction(ctx.chat.id, "typing");

        const session = await findOrCreateTelegramSession({
          agentId,
          companyId,
          telegramChatId,
        });

        const result = await chat.createMessage({
          agentId,
          sessionId: session.id,
          content: messageText,
          actor: { actorType: "system", actorId: `telegram:${senderId}` },
        });

        if (!result.runId) {
          await ctx.reply("The agent could not be woken. Please try again later.");
          return;
        }

        await streamRunToTelegram(bot, ctx.chat.id, result.runId, agentId);
      } catch (err) {
        logger.error({ err, agentId, telegramChatId }, "telegram: failed to process message");
        try {
          await ctx.reply("Something went wrong. Please try again.");
        } catch {
          // ignore send failure
        }
      }
    });

    bot.catch((err) => {
      logger.error({ err: err.error, agentId }, "telegram: bot error");
    });

    const runner = grammyRun(bot);

    runner.task()?.catch(async (err) => {
      const is409 = err && typeof err === "object" && "error_code" in err && err.error_code === 409;
      if (is409) {
        activeBots.delete(agentId);
        runner.isRunning() && (await runner.stop().catch(() => {}));

        if (pendingRetries.has(agentId)) {
          logger.warn({ agentId }, "telegram: 409 retry already in progress, skipping");
          return;
        }
        pendingRetries.add(agentId);

        for (let attempt = 1; attempt <= MAX_409_RETRIES; attempt++) {
          const delay = attempt * 30_000;
          logger.warn({ agentId, attempt, delayMs: delay }, "telegram: 409 conflict, waiting before retry");
          await new Promise((resolve) => setTimeout(resolve, delay));

          if (activeBots.has(agentId)) {
            logger.info({ agentId }, "telegram: bot already restarted by another path, aborting retry");
            break;
          }

          const freshConfig = await getConfig(agentId);
          if (!freshConfig?.enabled || !freshConfig.botToken) {
            logger.info({ agentId }, "telegram: config disabled/missing, aborting retry");
            break;
          }

          logger.info({ agentId, attempt }, "telegram: retrying bot start after 409");
          try {
            startBot(freshConfig);
            break;
          } catch (retryErr) {
            logger.warn({ err: retryErr, agentId, attempt }, "telegram: retry attempt failed");
          }
        }
        pendingRetries.delete(agentId);
      } else {
        logger.error({ err, agentId }, "telegram: runner crashed");
      }
    });

    const unsubscribeLiveEvents = subscribeCompanyLiveEvents(companyId, () => {
      // live event listener placeholder for future streaming
    });

    activeBots.set(agentId, { bot, runner, agentId, companyId, unsubscribeLiveEvents });

    void testToken(config.botToken)
      .then(async (info) => {
        if (info.botUsername && info.botUsername !== config.botUsername) {
          await db
            .update(agentTelegramConfigs)
            .set({ botUsername: info.botUsername, updatedAt: new Date() })
            .where(eq(agentTelegramConfigs.agentId, agentId));
        }
        logger.info({ agentId, botUsername: info.botUsername }, "telegram: bot started");
      })
      .catch((err) => {
        logger.warn({ err, agentId }, "telegram: failed to fetch bot info on startup");
      });
  }

  async function stopBot(agentId: string): Promise<void> {
    const instance = activeBots.get(agentId);
    if (!instance) return;

    instance.unsubscribeLiveEvents();
    if (instance.runner.isRunning()) {
      await instance.runner.stop();
    }
    activeBots.delete(agentId);
    logger.info({ agentId }, "telegram: bot stopped");
  }

  async function onConfigChange(agentId: string): Promise<void> {
    await stopBot(agentId);
    const config = await getConfig(agentId);
    if (config?.enabled && config.botToken) {
      startBot(config);
    }
  }

  async function syncAllBots(): Promise<{ started: number; errors: number }> {
    const configs = await db
      .select()
      .from(agentTelegramConfigs)
      .where(eq(agentTelegramConfigs.enabled, true));

    let started = 0;
    let errors = 0;

    for (const config of configs) {
      if (!config.botToken) continue;
      try {
        startBot(config);
        started++;
      } catch (err) {
        logger.error({ err, agentId: config.agentId }, "telegram: failed to start bot on sync");
        errors++;
      }
    }

    return { started, errors };
  }

  async function stopAllBots(): Promise<void> {
    const agentIds = Array.from(activeBots.keys());
    for (const agentId of agentIds) {
      await stopBot(agentId);
    }
  }

  function getActiveBot(agentId: string): BotInstance | undefined {
    return activeBots.get(agentId);
  }

  function getActiveBotCount(): number {
    return activeBots.size;
  }

  async function sendNotification(
    agentId: string,
    text: string,
    opts?: { sessionId?: string },
  ): Promise<boolean> {
    const config = await getConfig(agentId);
    if (!config?.enabled) return false;

    const instance = activeBots.get(agentId);
    if (!instance) return false;

    let targetChatId: string | null = null;

    if (opts?.sessionId) {
      const session = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, opts.sessionId))
        .then((rows) => rows[0] ?? null);
      if (session?.telegramChatId) {
        targetChatId = session.telegramChatId;
      }
    }

    if (!targetChatId) {
      targetChatId = config.ownerChatId;
    }

    if (!targetChatId) return false;

    const parts = splitMessage(text);
    for (const part of parts) {
      await instance.bot.api.sendMessage(Number(targetChatId), part);
    }
    return true;
  }

  return {
    getConfig: getConfigApi,
    upsertConfig,
    updateConfig,
    deleteConfig,
    testToken,
    startBot,
    stopBot,
    syncAllBots,
    stopAllBots,
    onConfigChange,
    getActiveBot,
    getActiveBotCount,
    sendNotification,
  };
}
