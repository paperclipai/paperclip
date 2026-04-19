import type { PluginContext } from "@paperclipai/plugin-sdk";
import { sendMessage, escapeMarkdownV2, sendChatAction } from "./telegram-api.js";
import { METRIC_NAMES } from "./constants.js";
import { getSessions } from "./acp-bridge.js";
import type { TelegramMessage, TelegramPhotoSize, TelegramApiResponse } from "./types.js";

const TELEGRAM_API = "https://api.telegram.org";

export async function handleMediaMessage(
  ctx: PluginContext,
  token: string,
  msg: TelegramMessage,
  config: { briefAgentId: string; briefAgentChatIds: string[]; transcriptionApiKeyRef: string },
  companyId: string,
): Promise<boolean> {
  const chatId = String(msg.chat.id);
  const threadId = msg.message_thread_id;

  const isIntakeChannel = config.briefAgentChatIds.includes(chatId);
  const hasActiveSession = threadId
    ? (await getSessions(ctx, chatId, threadId)).some((s) => s.status === "active")
    : false;

  if (!isIntakeChannel && !hasActiveSession) return false;

  await sendChatAction(ctx, token, chatId);

  const fileId = extractFileId(msg);
  if (!fileId) return false;

  const isAudio = !!(msg.voice || msg.audio || msg.video_note);
  let textContent = msg.caption ?? "";

  if (isAudio && config.transcriptionApiKeyRef) {
    try {
      const transcription = await transcribeAudio(ctx, token, fileId, config.transcriptionApiKeyRef);
      if (transcription) {
        textContent = transcription;
        await sendMessage(
          ctx,
          token,
          chatId,
          `${escapeMarkdownV2("\u{1f3a4}")} *Transcription:*\n${escapeMarkdownV2(textContent.slice(0, 500))}${textContent.length > 500 ? escapeMarkdownV2("...") : ""}`,
          {
            parseMode: "MarkdownV2",
            messageThreadId: threadId,
            replyToMessageId: msg.message_id,
          },
        );
      }
    } catch (err) {
      ctx.logger.error("Transcription failed", { error: String(err) });
      textContent = msg.caption ?? "[Audio - transcription failed]";
    }
  }

  if (isIntakeChannel && config.briefAgentId) {
    try {
      const prompt = buildBriefPrompt(msg, textContent);
      const { runId } = await ctx.agents.invoke(config.briefAgentId, companyId, {
        prompt,
        reason: "media_intake",
      });
      await sendMessage(
        ctx,
        token,
        chatId,
        `${escapeMarkdownV2("\u{1f4dd}")} Media sent to Brief Agent \\(run: \`${escapeMarkdownV2(runId)}\`\\)`,
        {
          parseMode: "MarkdownV2",
          messageThreadId: threadId,
          replyToMessageId: msg.message_id,
        },
      );
      ctx.logger.info("Media routed to brief agent", { runId, briefAgentId: config.briefAgentId });
    } catch (err) {
      ctx.logger.error("Failed to invoke brief agent", { error: String(err) });
      await sendMessage(ctx, token, chatId, `Failed to route media to brief agent: ${String(err)}`, {
        messageThreadId: threadId,
      });
    }
  } else if (hasActiveSession && threadId) {
    const sessions = await getSessions(ctx, chatId, threadId);
    const activeSessions = sessions.filter((s) => s.status === "active");
    const target = activeSessions.sort(
      (a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime(),
    )[0];

    if (target) {
      const mediaLabel = isAudio ? "Audio message" : msg.photo ? "Photo" : "Document";
      const prompt = `[${mediaLabel}] ${textContent || "(no caption)"}`;

      if (target.transport === "native") {
        try {
          await ctx.agents.sessions.sendMessage(target.sessionId, companyId, {
            prompt,
            reason: "media_message",
          });
        } catch (err) {
          ctx.logger.error("Failed to send media to native session", { error: String(err) });
        }
      } else {
        ctx.events.emit("acp-spawn", companyId, {
          type: "message",
          sessionId: target.sessionId,
          chatId,
          threadId,
          text: prompt,
        });
      }
    }
  }

  await ctx.metrics.write(METRIC_NAMES.mediaProcessed, 1);
  return true;
}

function extractFileId(msg: TelegramMessage): string | null {
  if (msg.voice) return msg.voice.file_id;
  if (msg.audio) return msg.audio.file_id;
  if (msg.video_note) return msg.video_note.file_id;
  if (msg.document) return msg.document.file_id;
  if (msg.photo && msg.photo.length > 0) {
    return msg.photo.sort((a: TelegramPhotoSize, b: TelegramPhotoSize) => b.width * b.height - a.width * a.height)[0]
      .file_id;
  }
  return null;
}

async function transcribeAudio(
  ctx: PluginContext,
  botToken: string,
  fileId: string,
  transcriptionApiKeyRef: string,
): Promise<string | null> {
  const fileRes = await ctx.http.fetch(`${TELEGRAM_API}/bot${botToken}/getFile?file_id=${fileId}`, { method: "GET" });
  const fileData = (await fileRes.json()) as TelegramApiResponse<{ file_path: string }>;
  if (!fileData.ok || !fileData.result?.file_path) {
    ctx.logger.error("Failed to get file path from Telegram", { fileId });
    return null;
  }

  const downloadUrl = `${TELEGRAM_API}/file/bot${botToken}/${fileData.result.file_path}`;
  const audioRes = await ctx.http.fetch(downloadUrl, { method: "GET" });
  const audioBlob = await audioRes.blob();

  const apiKey = await ctx.secrets.resolve(transcriptionApiKeyRef);
  const formData = new FormData();
  formData.append("file", audioBlob, "audio.ogg");
  formData.append("model", "whisper-1");

  const whisperRes = await ctx.http.fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });
  const whisperData = (await whisperRes.json()) as { text?: string };
  return whisperData.text ?? null;
}

function buildBriefPrompt(msg: TelegramMessage, textContent: string): string {
  const parts: string[] = [];
  if (msg.voice) parts.push(`[Voice message, ${msg.voice.duration}s]`);
  else if (msg.audio) parts.push(`[Audio: ${msg.audio.title ?? "untitled"}, ${msg.audio.duration}s]`);
  else if (msg.video_note) parts.push(`[Video note, ${msg.video_note.duration}s]`);
  else if (msg.document) parts.push(`[Document: ${msg.document.file_name ?? "unknown"}]`);
  else if (msg.photo) parts.push("[Photo]");
  if (textContent) parts.push(textContent);
  const sender = msg.from?.username ?? msg.from?.first_name ?? "unknown";
  parts.push(`\nFrom: ${sender}`);
  return parts.join("\n");
}
