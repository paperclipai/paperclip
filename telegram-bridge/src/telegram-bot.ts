/**
 * Telegram bot wrapper — grammy long-poll, message routing, send-with-chunking.
 * Lifted patterns from ~/nanoclaw/v2/telegram.ts and ~/nanoclaw/v2/channels/.
 *
 * Bridge owns the inbound + outbound translation between Telegram and
 * Paperclip. This module is the grammy adapter layer; orchestration logic
 * (mapping → issue → wakeup; comment poll → reply) lives in index.ts.
 */

import { Bot, type Context } from "grammy";
import { readFileSync, unlinkSync } from "fs";
import type { InboundMessage } from "./types.js";
import { chunkMarkdownForTelegram } from "./chunking.js";
import { downloadTelegramFile, transcribeAudio } from "./voice.js";
import { downloadPhoto, downloadDocument, formatAttachmentsForIssue, type DownloadedAttachment } from "./attachments.js";
import type { CommandDeps } from "./commands.js";

export type BotDeps = {
  /**
   * Called for every inbound text/voice/photo/document message after
   * transcription / download. Implementation lives in index.ts and
   * routes to Paperclip.
   */
  onMessage: (msg: InboundMessage) => Promise<void>;
  /**
   * Called when bot encounters an unrecoverable error during inbound handling.
   * Implementation logs and optionally pages.
   */
  onError?: (err: unknown, where: string) => void;
  /**
   * Command dependencies — passed through to registerCommands().
   * If provided, slash commands are registered on the bot.
   */
  commandDeps?: CommandDeps;
};

const TOKEN_PATH = `${process.env.HOME}/.nanoclaw/credentials/telegram-bot-token`;
// During Phase 7 mattclaw rename, this path moves to ~/.mattclaw/credentials/.
// Bridge tries both during the transition window.
const TOKEN_PATH_FUTURE = `${process.env.HOME}/.mattclaw/credentials/telegram-bot-token`;

function readToken(): string {
  for (const p of [TOKEN_PATH_FUTURE, TOKEN_PATH]) {
    try {
      const t = readFileSync(p, "utf-8").trim();
      if (t) return t;
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `Telegram bot token not found. Looked in ${TOKEN_PATH_FUTURE} and ${TOKEN_PATH}.`,
  );
}

export function createTelegramBot(deps: BotDeps): Bot {
  const token = readToken();
  const bot = new Bot(token);

  bot.on("message:text", async (ctx) => {
    const msg = textMessageFromCtx(ctx);
    if (!msg) return;
    const m = ctx.message;
    const chatId = String(ctx.chat?.id ?? "");
    const messageId = m?.message_id;

    // Show the native "typing..." indicator immediately.
    // This auto-expires after 5s; the bridge refreshes it via
    // startTypingIndicator() until the first outbound reply lands.
    if (chatId) {
      try {
        await bot.api.sendChatAction(chatId, "typing");
      } catch {
        /* best-effort */
      }
    }

    // Ack the message immediately so Matt sees it was received.
    // ✍ writing → 👀 thinking on dispatch → 👍 done / 😢 failed once
    // the task finishes. Bridge can't observe completion synchronously
    // here (the worker runs out-of-process via Paperclip's heartbeat)
    // so we set ✍ on receipt and rely on the outbound poller /
    // ack-watcher for terminal reactions.
    if (chatId && messageId) {
      try {
        await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: "✍" }]);
      } catch {
        /* reactions are best-effort */
      }
    }

    try {
      await deps.onMessage(msg);
      // Step up to 👀 once the issue + wakeup are dispatched (onMessage returned)
      if (chatId && messageId) {
        try {
          await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: "👀" }]);
        } catch {
          /* ignore */
        }
      }
    } catch (err) {
      deps.onError?.(err, "text-message");
      if (chatId && messageId) {
        try {
          await bot.api.setMessageReaction(chatId, messageId, [{ type: "emoji", emoji: "😢" }]);
        } catch {
          /* ignore */
        }
      }
    }
  });

  bot.on("message:voice", async (ctx) => {
    const m = ctx.message;
    const chatId = String(ctx.chat?.id ?? "");
    // Show native typing indicator
    if (chatId) {
      try { await bot.api.sendChatAction(chatId, "typing"); } catch { /* best-effort */ }
    }
    try {
      await handleVoice(ctx, bot, token, deps);
    } catch (err) {
      deps.onError?.(err, "voice-message");
      try {
        await ctx.reply("Couldn't process that voice message. Try again or type it out.");
      } catch {
        /* ignore */
      }
    }
  });

  // Photo handler — download largest resolution, pass to onMessage with attachment info
  bot.on("message:photo", async (ctx) => {
    const chatId = String(ctx.chat?.id ?? "");
    // Show native typing indicator
    if (chatId) {
      try { await bot.api.sendChatAction(chatId, "typing"); } catch { /* best-effort */ }
    }
    try {
      await handlePhoto(ctx, bot, token, deps);
    } catch (err) {
      deps.onError?.(err, "photo-message");
      try {
        await ctx.reply("Couldn't process that photo. Try sending it as a document.");
      } catch {
        /* ignore */
      }
    }
  });

  // Document handler — download file, pass to onMessage with attachment info
  bot.on("message:document", async (ctx) => {
    const chatId = String(ctx.chat?.id ?? "");
    // Show native typing indicator
    if (chatId) {
      try { await bot.api.sendChatAction(chatId, "typing"); } catch { /* best-effort */ }
    }
    try {
      await handleDocument(ctx, bot, token, deps);
    } catch (err) {
      deps.onError?.(err, "document-message");
      try {
        await ctx.reply("Couldn't process that file.");
      } catch {
        /* ignore */
      }
    }
  });

  // Register slash commands if deps provided
  if (deps.commandDeps) {
    const { registerCommands } = require("./commands.js") as typeof import("./commands.js");
    registerCommands(bot, deps.commandDeps);
  }

  bot.catch((err) => {
    deps.onError?.(err, "grammy-uncaught");
  });

  return bot;
}

function extractReplyTo(m: { reply_to_message?: any } | undefined): InboundMessage["replyTo"] {
  const r = m?.reply_to_message;
  if (!r) return undefined;
  return {
    messageId: r.message_id,
    fromUserId: r.from?.id,
    fromUsername: r.from?.username,
    fromFirstName: r.from?.first_name,
    isBot: r.from?.is_bot,
    text: r.text ?? r.caption,
  };
}

function textMessageFromCtx(ctx: Context): InboundMessage | null {
  const m = ctx.message;
  if (!m || !m.text) return null;
  const chatId = String(ctx.chat?.id ?? "");
  const fromUserId = ctx.from?.id ?? 0;
  if (!chatId || !fromUserId) return null;
  return {
    chatId,
    threadId: (m as { message_thread_id?: number }).message_thread_id,
    messageId: m.message_id,
    fromUserId,
    text: m.text,
    receivedAt: new Date().toISOString(),
    replyTo: extractReplyTo(m as { reply_to_message?: any }),
  };
}

async function handleVoice(
  ctx: Context,
  bot: Bot,
  token: string,
  deps: BotDeps,
): Promise<void> {
  const m = ctx.message;
  const voice = m?.voice;
  if (!m || !voice) return;
  const chatId = String(ctx.chat?.id ?? "");
  const fromUserId = ctx.from?.id ?? 0;
  if (!chatId || !fromUserId) return;

  // React with "typing" emoji for visual feedback
  try {
    await bot.api.setMessageReaction(chatId, m.message_id, [{ type: "emoji", emoji: "✍" }]);
  } catch {
    /* ignore */
  }

  const download = await downloadTelegramFile(bot.api, token, voice.file_id);
  if ("error" in download) {
    await ctx.reply("Couldn't download voice message.");
    return;
  }
  const result = await transcribeAudio(download.localPath);
  try {
    unlinkSync(download.localPath);
  } catch {
    /* ignore */
  }
  if (result.error || !result.text) {
    await ctx.reply("Couldn't transcribe that voice message. Try again or type it out.");
    return;
  }

  // Update reaction to "thinking"
  try {
    await bot.api.setMessageReaction(chatId, m.message_id, [{ type: "emoji", emoji: "👀" }]);
  } catch {
    /* ignore */
  }

  const msg: InboundMessage = {
    chatId,
    threadId: (m as { message_thread_id?: number }).message_thread_id,
    messageId: m.message_id,
    fromUserId,
    text: result.text,
    voiceFileId: voice.file_id,
    receivedAt: new Date().toISOString(),
    replyTo: extractReplyTo(m as { reply_to_message?: any }),
  };
  await deps.onMessage(msg);
}

/**
 * Send a markdown-formatted message to Telegram with chunking + Markdown
 * fallback (matches v2/channels/telegram-delivery.ts behavior).
 *
 * If `replyToMessageId` is provided, the first chunk is sent as a reply
 * to that message (threading the conversation visually in the Telegram UI).
 *
 * Returns the Telegram message_id of the FIRST chunk on success.
 */
export async function sendMarkdownMessage(
  bot: Bot,
  chatId: string,
  text: string,
  threadId?: number,
  replyToMessageId?: number,
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const chunks = chunkMarkdownForTelegram(text);
  if (chunks.length === 0) return { ok: true };

  let firstId: number | undefined;
  for (const [i, chunk] of chunks.entries()) {
    // Only the first chunk replies to the original message — subsequent
    // chunks are continuations and don't need a reply link.
    const replyTo = i === 0 ? replyToMessageId : undefined;
    const result = await sendOneChunk(bot, chatId, chunk, threadId, replyTo);
    if (!result.ok) return result;
    if (i === 0) firstId = result.messageId;
  }
  return { ok: true, messageId: firstId };
}

async function sendOneChunk(
  bot: Bot,
  chatId: string,
  text: string,
  threadId?: number,
  replyToMessageId?: number,
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  const opts: Parameters<Bot["api"]["sendMessage"]>[2] = { parse_mode: "Markdown" };
  if (threadId != null) opts.message_thread_id = threadId;
  if (replyToMessageId != null) {
    opts.reply_parameters = { message_id: replyToMessageId };
  }
  try {
    const res = await bot.api.sendMessage(chatId, text, opts);
    return { ok: true, messageId: res.message_id };
  } catch (err: any) {
    // Markdown parse failure: retry as plain text
    const msg = String(err?.message || err);
    if (/parse|markdown/i.test(msg)) {
      try {
        const opts2: Parameters<Bot["api"]["sendMessage"]>[2] = {};
        if (threadId != null) opts2.message_thread_id = threadId;
        if (replyToMessageId != null) {
          opts2.reply_parameters = { message_id: replyToMessageId };
        }
        const res = await bot.api.sendMessage(chatId, text, opts2);
        return { ok: true, messageId: res.message_id };
      } catch (err2: any) {
        return { ok: false, error: String(err2?.message || err2) };
      }
    }
    return { ok: false, error: msg };
  }
}

/**
 * Handle inbound photo — download largest resolution, build InboundMessage
 * with attachment metadata so index.ts can include it in the issue description.
 */
async function handlePhoto(
  ctx: Context,
  bot: Bot,
  token: string,
  deps: BotDeps,
): Promise<void> {
  const m = ctx.message;
  if (!m?.photo) return;
  const chatId = String(ctx.chat?.id ?? "");
  const fromUserId = ctx.from?.id ?? 0;
  if (!chatId || !fromUserId) return;

  // React ✍ on receipt
  try {
    await bot.api.setMessageReaction(chatId, m.message_id, [{ type: "emoji", emoji: "✍" }]);
  } catch { /* ignore */ }

  // Get largest photo (last in array is highest resolution)
  const sizes = m.photo;
  const largest = sizes[sizes.length - 1];
  if (!largest) return;

  const result = await downloadPhoto(bot.api, token, largest.file_id);
  if ("error" in result) {
    await ctx.reply(`Photo download failed: ${result.error}`);
    return;
  }

  const caption = m.caption ?? "";
  const attachmentText = formatAttachmentsForIssue([result]);
  const text = caption ? `${caption}${attachmentText}` : `Photo received${attachmentText}`;

  try {
    await deps.onMessage({
      chatId,
      threadId: (m as any).message_thread_id,
      messageId: m.message_id,
      fromUserId,
      text,
      photoFileIds: sizes.map((s) => s.file_id),
      receivedAt: new Date().toISOString(),
      replyTo: extractReplyTo(m as { reply_to_message?: any }),
    });
    try {
      await bot.api.setMessageReaction(chatId, m.message_id, [{ type: "emoji", emoji: "👀" }]);
    } catch { /* ignore */ }
  } catch (err) {
    deps.onError?.(err, "photo-message");
    try {
      await bot.api.setMessageReaction(chatId, m.message_id, [{ type: "emoji", emoji: "😢" }]);
    } catch { /* ignore */ }
  }
}

/**
 * Handle inbound document — download file, build InboundMessage
 * with attachment metadata.
 */
async function handleDocument(
  ctx: Context,
  bot: Bot,
  token: string,
  deps: BotDeps,
): Promise<void> {
  const m = ctx.message;
  const doc = m?.document;
  if (!m || !doc) return;
  const chatId = String(ctx.chat?.id ?? "");
  const fromUserId = ctx.from?.id ?? 0;
  if (!chatId || !fromUserId) return;

  try {
    await bot.api.setMessageReaction(chatId, m.message_id, [{ type: "emoji", emoji: "✍" }]);
  } catch { /* ignore */ }

  const result = await downloadDocument(bot.api, token, doc.file_id, doc.file_name, doc.mime_type);
  if ("error" in result) {
    await ctx.reply(`File download failed: ${result.error}`);
    return;
  }

  const caption = m.caption ?? "";
  const attachmentText = formatAttachmentsForIssue([result]);
  const text = caption ? `${caption}${attachmentText}` : `Document: ${doc.file_name ?? "file"}${attachmentText}`;

  try {
    await deps.onMessage({
      chatId,
      threadId: (m as any).message_thread_id,
      messageId: m.message_id,
      fromUserId,
      text,
      attachmentFileIds: [doc.file_id],
      receivedAt: new Date().toISOString(),
      replyTo: extractReplyTo(m as { reply_to_message?: any }),
    });
    try {
      await bot.api.setMessageReaction(chatId, m.message_id, [{ type: "emoji", emoji: "👀" }]);
    } catch { /* ignore */ }
  } catch (err) {
    deps.onError?.(err, "document-message");
    try {
      await bot.api.setMessageReaction(chatId, m.message_id, [{ type: "emoji", emoji: "😢" }]);
    } catch { /* ignore */ }
  }
}
