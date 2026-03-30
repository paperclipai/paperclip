import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { Bot, InputFile } from "grammy";
import { run as grammyRun, type RunnerHandle } from "@grammyjs/runner";
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentTelegramConfigs, chatSessions } from "@paperclipai/db";
import type { AgentTelegramConfig, AgentTelegramTestResult, SendTelegramNotificationOptions } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
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

const TELEGRAM_MEDIA_TEXT_MAX_BYTES = 100 * 1024; // 100 KB
const TEXT_EXTRACTABLE_EXTENSIONS = new Set([".md", ".txt", ".text"]);
const TEXT_EXTRACTABLE_MIME_PREFIXES = ["text/plain", "text/markdown"];

/** Download a file from Telegram to a local path. Returns the destination path. */
async function downloadTelegramFile(
  botToken: string,
  filePath: string,
  destPath: string,
): Promise<void> {
  const url = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  return new Promise((resolve, reject) => {
    const fileStream = createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode !== 200) {
        fileStream.destroy();
        reject(new Error(`Telegram file download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(fileStream);
      fileStream.on("finish", () => { fileStream.close(); resolve(); });
      fileStream.on("error", reject);
    }).on("error", reject);
  });
}

/** Resolve the media storage directory for an agent.
 *  Uses agent's adapterConfig.cwd if set, otherwise falls back to instance storage. */
async function resolveAgentMediaDir(db: Db, agentId: string): Promise<string> {
  const row = await db
    .select({ adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);

  const cwd = typeof row?.adapterConfig?.["cwd"] === "string"
    ? (row.adapterConfig["cwd"] as string).trim()
    : "";

  const baseDir = cwd
    ? cwd
    : path.join(resolvePaperclipInstanceRoot(), "data", "storage");

  return path.join(baseDir, "telegram-media");
}

/** For small text-like files, read and return content. Returns null otherwise. */
async function maybeExtractTextContent(
  filePath: string,
  mimeType: string | undefined,
  fileSize: number | undefined,
): Promise<string | null> {
  if (fileSize !== undefined && fileSize > TELEGRAM_MEDIA_TEXT_MAX_BYTES) return null;

  const ext = path.extname(filePath).toLowerCase();
  const isTextExt = TEXT_EXTRACTABLE_EXTENSIONS.has(ext);
  const isTextMime = mimeType
    ? TEXT_EXTRACTABLE_MIME_PREFIXES.some((p) => mimeType.startsWith(p))
    : false;

  if (!isTextExt && !isTextMime) return null;

  try {
    const content = await fs.readFile(filePath, "utf8");
    // Guard against surprisingly large files (e.g. fileSize was undefined)
    if (Buffer.byteLength(content, "utf8") > TELEGRAM_MEDIA_TEXT_MAX_BYTES) return null;
    return content;
  } catch {
    return null;
  }
}

const TELEGRAM_MESSAGE_LIMIT = 4096;
const STREAM_POLL_INTERVAL_MS = 1500;
const STREAM_MAX_POLLS = 400; // ~10 min max

const THINKING_MESSAGES = [
  "Thinking\u2026",
  "Mulling it over\u2026",
  "Percolating\u2026",
  "Just getting those tokens, boss\u2026",
  "GPUs are humming\u2026",
  "Laying the bricks\u2026",
  "Give me a sec\u2026",
  "Working on it\u2026",
  "Crunching the numbers\u2026",
  "Connecting the dots\u2026",
  "Almost there\u2026",
  "Brewing up a response\u2026",
  "Neurons firing\u2026",
  "Pondering deeply\u2026",
  "On it\u2026",
];
/** Number of poll cycles before rotating to the next thinking message */
const THINKING_ROTATE_POLLS = 3;

interface BotInstance {
  bot: Bot;
  runner: RunnerHandle;
  agentId: string;
  companyId: string;
  unsubscribeLiveEvents: () => void;
  startedAt: Date;
  lastMessageAt: Date | null;
  messageCount: number;
}

const activeBots = new Map<string, BotInstance>();
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
    requireMention: row.requireMention,
    mentionPatterns: (row.mentionPatterns as string[]) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns true when a group message passes the gating check.
 *  Also strips the trigger text from rawText and returns the cleaned message. */
function applyGroupGating(opts: {
  rawText: string;
  chatType: string;
  requireMention: boolean;
  mentionPatterns: string[];
  botUsername: string | null | undefined;
  replyToUsername: string | undefined;
}): { allowed: boolean; cleanedText: string } {
  const { rawText, chatType, requireMention, mentionPatterns, botUsername, replyToUsername } = opts;
  const isGroup = chatType === "group" || chatType === "supergroup";

  if (!isGroup || !requireMention) {
    return { allowed: true, cleanedText: rawText };
  }

  const botMention = botUsername ? `@${botUsername}` : null;
  const isMentioned = botMention ? rawText.includes(botMention) : false;
  const isReplyToBot = !!botUsername && replyToUsername === botUsername;

  const matchedPattern = mentionPatterns.find((pattern) => {
    try {
      return new RegExp(pattern, "i").test(rawText);
    } catch {
      return false;
    }
  });

  if (!isMentioned && !isReplyToBot && !matchedPattern) {
    return { allowed: false, cleanedText: rawText };
  }

  // Strip trigger from message text
  let cleanedText = rawText;
  if (isMentioned && botMention) {
    cleanedText = rawText.replace(new RegExp(escapeRegex(botMention), "g"), "").trim();
  } else if (matchedPattern) {
    try {
      cleanedText = rawText.replace(new RegExp(matchedPattern, "i"), "").trim();
    } catch {
      // keep original if regex fails
    }
  }
  if (!cleanedText) cleanedText = rawText;

  return { allowed: true, cleanedText };
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
    requireMention?: boolean;
    mentionPatterns?: string[];
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
          requireMention: input.requireMention ?? existing.requireMention,
          mentionPatterns: input.mentionPatterns ?? existing.mentionPatterns,
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
        requireMention: input.requireMention ?? true,
        mentionPatterns: input.mentionPatterns ?? [],
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
    requireMention?: boolean;
    mentionPatterns?: string[];
  }): Promise<AgentTelegramConfig | null> {
    const existing = await getConfig(input.agentId);
    if (!existing) return null;

    const patch: Partial<typeof agentTelegramConfigs.$inferInsert> = { updatedAt: new Date() };
    if (input.botToken !== undefined) patch.botToken = input.botToken;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.ownerChatId !== undefined) patch.ownerChatId = input.ownerChatId;
    if (input.allowedUserIds !== undefined) patch.allowedUserIds = input.allowedUserIds;
    if (input.requireMention !== undefined) patch.requireMention = input.requireMention;
    if (input.mentionPatterns !== undefined) patch.mentionPatterns = input.mentionPatterns;

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

    const placeholder = await bot.api.sendMessage(chatId, THINKING_MESSAGES[0]);
    const msgId = placeholder.message_id;

    let offset = 0;
    let remainder = "";
    let lastSentText = "";
    let hasRealContent = false;
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
            hasRealContent = true;
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

      // Cycle through fun thinking messages while waiting for real content
      if (!hasRealContent && poll > 0 && poll % THINKING_ROTATE_POLLS === 0) {
        const msgIndex = (poll / THINKING_ROTATE_POLLS) % THINKING_MESSAGES.length;
        const thinkingText = THINKING_MESSAGES[msgIndex];
        await bot.api.editMessageText(chatId, msgId, thinkingText).catch(() => {});
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

      // Group chat gating
      const gating = applyGroupGating({
        rawText,
        chatType: ctx.chat.type,
        requireMention: currentConfig?.requireMention ?? true,
        mentionPatterns: (currentConfig?.mentionPatterns as string[]) ?? [],
        botUsername: currentConfig?.botUsername ?? ctx.me?.username,
        replyToUsername: ctx.message.reply_to_message?.from?.username,
      });
      if (!gating.allowed) return;

      const instance = activeBots.get(agentId);
      if (instance) {
        instance.lastMessageAt = new Date();
        instance.messageCount++;
      }

      let messageText = gating.cleanedText;
      let forceNewSession = false;

      if (messageText.trimStart().toLowerCase().startsWith("/new")) {
        forceNewSession = true;
        messageText = messageText.trimStart().slice(4).trim();
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

    /** Shared helper: process a Telegram media file, download it, inject context, and wake the agent. */
    async function processTelegramMedia(opts: {
      chatId: number;
      chatType: string;
      senderId: string;
      fileId: string;
      fileName: string;
      mimeType: string | undefined;
      fileSize: number | undefined;
      captionText: string;
      replyToUsername?: string;
      reply: (text: string) => Promise<unknown>;
    }): Promise<void> {
      const { chatId, chatType, senderId, fileId, fileName, mimeType, fileSize, captionText, replyToUsername, reply } = opts;
      const telegramChatId = String(chatId);

      if (allowedUserIds.size > 0 && !allowedUserIds.has(senderId)) {
        await reply("You are not authorized to use this bot.");
        return;
      }

      const currentConfig = await getConfig(agentId);

      // Group chat gating for media messages
      const gating = applyGroupGating({
        rawText: captionText,
        chatType,
        requireMention: currentConfig?.requireMention ?? true,
        mentionPatterns: (currentConfig?.mentionPatterns as string[]) ?? [],
        botUsername: currentConfig?.botUsername,
        replyToUsername,
      });
      if (!gating.allowed) return;

      if (currentConfig && !currentConfig.ownerChatId) {
        await db
          .update(agentTelegramConfigs)
          .set({ ownerChatId: telegramChatId, updatedAt: new Date() })
          .where(eq(agentTelegramConfigs.id, currentConfig.id));
      }

      const instance = activeBots.get(agentId);
      if (instance) {
        instance.lastMessageAt = new Date();
        instance.messageCount++;
      }

      try {
        await bot.api.sendChatAction(chatId, "typing");

        // Resolve file info and download
        const telegramFile = await bot.api.getFile(fileId);
        const tgFilePath = telegramFile.file_path;

        let messageContent = captionText;

        if (tgFilePath) {
          const mediaDir = await resolveAgentMediaDir(db, agentId);
          const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
          const destPath = path.join(mediaDir, safeFileName);

          try {
            await downloadTelegramFile(config.botToken, tgFilePath, destPath);

            const textContent = await maybeExtractTextContent(destPath, mimeType, fileSize);
            if (textContent) {
              // Inject text file content inline
              const header = captionText
                ? `${captionText}\n\n[Attached file: ${safeFileName}]\n\`\`\`\n`
                : `[Attached file: ${safeFileName}]\n\`\`\`\n`;
              messageContent = `${header}${textContent}\n\`\`\``;
            } else {
              // Reference saved file path for images and binary docs
              const fileRef = `[Attached file saved to: ${destPath}]`;
              messageContent = captionText ? `${captionText}\n\n${fileRef}` : fileRef;
            }

            logger.info({ agentId, destPath, mimeType }, "telegram: media file downloaded");
          } catch (downloadErr) {
            logger.warn({ err: downloadErr, agentId, fileName }, "telegram: media download failed");
            messageContent = captionText
              ? `${captionText}\n\n[Attached file: ${safeFileName} (download failed)]`
              : `[Attached file: ${safeFileName} (download failed)]`;
          }
        }

        const session = await findOrCreateTelegramSession({
          agentId,
          companyId,
          telegramChatId,
        });

        const result = await chat.createMessage({
          agentId,
          sessionId: session.id,
          content: messageContent,
          actor: { actorType: "system", actorId: `telegram:${senderId}` },
        });

        if (!result.runId) {
          await reply("The agent could not be woken. Please try again later.");
          return;
        }

        await streamRunToTelegram(bot, chatId, result.runId, agentId);
      } catch (err) {
        logger.error({ err, agentId, telegramChatId }, "telegram: failed to process media message");
        try {
          await reply("Something went wrong processing your file. Please try again.");
        } catch {
          // ignore send failure
        }
      }
    }

    bot.on("message:photo", async (ctx) => {
      // photo is an array of PhotoSize; last entry is the highest resolution
      const photo = ctx.message.photo;
      const largest = photo[photo.length - 1];
      if (!largest) return;

      await processTelegramMedia({
        chatId: ctx.chat.id,
        chatType: ctx.chat.type,
        senderId: String(ctx.from.id),
        fileId: largest.file_id,
        fileName: `photo_${largest.file_unique_id}.jpg`,
        mimeType: "image/jpeg",
        fileSize: largest.file_size,
        captionText: ctx.message.caption ?? "",
        replyToUsername: ctx.message.reply_to_message?.from?.username,
        reply: (text) => ctx.reply(text),
      });
    });

    bot.on("message:document", async (ctx) => {
      const doc = ctx.message.document;
      await processTelegramMedia({
        chatId: ctx.chat.id,
        chatType: ctx.chat.type,
        senderId: String(ctx.from.id),
        fileId: doc.file_id,
        fileName: doc.file_name ?? `document_${doc.file_unique_id}`,
        mimeType: doc.mime_type,
        fileSize: doc.file_size,
        captionText: ctx.message.caption ?? "",
        replyToUsername: ctx.message.reply_to_message?.from?.username,
        reply: (text) => ctx.reply(text),
      });
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

    activeBots.set(agentId, {
      bot, runner, agentId, companyId, unsubscribeLiveEvents,
      startedAt: new Date(), lastMessageAt: null, messageCount: 0,
    });

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

  async function getTelemetry(agentId: string): Promise<{
    botRunning: boolean;
    startedAt: string | null;
    lastMessageAt: string | null;
    messageCount: number;
    activeSessionCount: number;
    retrying: boolean;
  }> {
    const instance = activeBots.get(agentId);

    const sessionRows = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(
        and(
          eq(chatSessions.agentId, agentId),
          isNull(chatSessions.archivedAt),
        ),
      );
    const telegramSessions = sessionRows.length;

    return {
      botRunning: !!instance,
      startedAt: instance?.startedAt?.toISOString() ?? null,
      lastMessageAt: instance?.lastMessageAt?.toISOString() ?? null,
      messageCount: instance?.messageCount ?? 0,
      activeSessionCount: telegramSessions,
      retrying: pendingRetries.has(agentId),
    };
  }

  async function resolveTargetChatId(
    config: ConfigRow,
    sessionId: string | undefined,
  ): Promise<string | null> {
    if (sessionId) {
      const session = await db
        .select()
        .from(chatSessions)
        .where(eq(chatSessions.id, sessionId))
        .then((rows) => rows[0] ?? null);
      if (session?.telegramChatId) return session.telegramChatId;
    }
    return config.ownerChatId;
  }

  async function sendNotification(
    agentId: string,
    text: string | undefined,
    opts?: SendTelegramNotificationOptions,
  ): Promise<boolean> {
    const config = await getConfig(agentId);
    if (!config?.enabled) return false;

    const instance = activeBots.get(agentId);
    if (!instance) return false;

    const targetChatId = await resolveTargetChatId(config, opts?.sessionId);
    if (!targetChatId) return false;

    const chatId = Number(targetChatId);

    // Media send path
    if (opts?.mediaType) {
      const caption = opts.caption;
      if (opts.mediaType === "photo") {
        if (opts.mediaUrl) {
          await instance.bot.api.sendPhoto(chatId, opts.mediaUrl, caption ? { caption } : undefined);
        } else if (opts.mediaPath) {
          const fileData = await fs.readFile(opts.mediaPath);
          const fileName = path.basename(opts.mediaPath);
          await instance.bot.api.sendPhoto(
            chatId,
            new InputFile(fileData, fileName),
            caption ? { caption } : undefined,
          );
        }
        // Send trailing text caption separately if also provided
        if (text) {
          const parts = splitMessage(text);
          for (const part of parts) {
            await instance.bot.api.sendMessage(chatId, part);
          }
        }
        return true;
      }

      if (opts.mediaType === "document") {
        const fileName = opts.mediaPath ? path.basename(opts.mediaPath) : "document";
        if (opts.mediaUrl) {
          await instance.bot.api.sendDocument(chatId, opts.mediaUrl, caption ? { caption } : undefined);
        } else if (opts.mediaPath) {
          const fileData = await fs.readFile(opts.mediaPath);
          await instance.bot.api.sendDocument(
            chatId,
            new InputFile(fileData, fileName),
            caption ? { caption } : undefined,
          );
        }
        if (text) {
          const parts = splitMessage(text);
          for (const part of parts) {
            await instance.bot.api.sendMessage(chatId, part);
          }
        }
        return true;
      }
    }

    // Text-only path
    if (!text) return false;
    const parts = splitMessage(text);
    for (const part of parts) {
      await instance.bot.api.sendMessage(chatId, part);
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
    getTelemetry,
    sendNotification,
  };
}
