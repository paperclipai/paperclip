import type { PluginContext } from "@paperclipai/plugin-sdk";
import { getFileInfo, downloadFile, postMessage } from "./slack-api.js";

const AUDIO_MIMETYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/flac",
]);
const VIDEO_MIMETYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);
export function isMediaFile(mimetype: string): boolean {
  return AUDIO_MIMETYPES.has(mimetype) || VIDEO_MIMETYPES.has(mimetype);
}
export function isAudioFile(mimetype: string): boolean {
  return AUDIO_MIMETYPES.has(mimetype);
}
export interface MediaIntakeResult {
  fileId: string;
  fileName: string;
  mimetype: string;
  transcription?: string;
  briefRunId?: string;
}
export async function processMediaFile(
  ctx: PluginContext,
  token: string,
  companyId: string,
  fileId: string,
  channelId: string,
  threadTs: string,
  briefAgentId?: string,
): Promise<MediaIntakeResult | null> {
  // Step 1: Get file info from Slack
  const fileInfo = await getFileInfo(ctx, token, fileId);
  if (!fileInfo) {
    ctx.logger.warn("Could not get file info from Slack", { fileId });
    return null;
  }
  if (!isMediaFile(fileInfo.mimetype)) {
    ctx.logger.info("File is not a media type, skipping", { fileId, mimetype: fileInfo.mimetype });
    return null;
  }
  // Post processing indicator
  await postMessage(ctx, token, channelId, {
    text: "Processing media file...",
    blocks: [
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `:hourglass: Processing *${fileInfo.name}* (${fileInfo.mimetype})...` },
        ],
      },
    ],
  }, { threadTs });
  const result: MediaIntakeResult = {
    fileId,
    fileName: fileInfo.name,
    mimetype: fileInfo.mimetype,
  };
  // Step 2: Download the file
  const fileData = await downloadFile(ctx, token, fileInfo.url);
  if (!fileData) {
    ctx.logger.warn("Could not download media file", { fileId, url: fileInfo.url });
    return result;
  }
  // Step 3: Transcribe audio via Whisper (using agent invoke for transcription)
  if (isAudioFile(fileInfo.mimetype)) {
    try {
      const transcriptionResult = await ctx.agents.invoke("whisper-transcriber", companyId, {
        prompt: `Transcribe this audio file: ${fileInfo.name}`,
        reason: `Media pipeline: transcribe ${fileInfo.name} from Slack ${channelId}/${threadTs}`,
      });
      result.transcription = `[Transcription job started: ${transcriptionResult.runId}]`;
      result.briefRunId = transcriptionResult.runId;
      ctx.logger.info("Whisper transcription invoked", {
        fileId,
        runId: transcriptionResult.runId,
      });
    }
    catch (err) {
      ctx.logger.warn("Whisper transcription failed, posting raw", { fileId, err });
      result.transcription = "[Transcription unavailable]";
    }
  }
  // Step 4: If brief agent is configured, invoke it with transcription
  if (briefAgentId && result.transcription) {
    try {
      const briefResult = await ctx.agents.invoke(briefAgentId, companyId, {
        prompt: `Summarize this transcription from Slack:\n\n${result.transcription}`,
        reason: `Media pipeline: brief for ${fileInfo.name}`,
      });
      result.briefRunId = briefResult.runId;
      ctx.logger.info("Brief agent invoked", {
        fileId,
        briefAgentId,
        runId: briefResult.runId,
      });
    }
    catch (err) {
      ctx.logger.warn("Brief agent invocation failed", { fileId, briefAgentId, err });
    }
  }
  // Step 5: Post result back to thread
  const blocks: Array<Record<string, unknown>> = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:microphone: *Media processed:* ${fileInfo.name}`,
      },
    },
  ];
  if (result.transcription) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Transcription:*\n${result.transcription.slice(0, 2800)}`,
      },
    });
  }
  if (result.briefRunId) {
    blocks.push({
      type: "context",
      elements: [
        { type: "mrkdwn", text: `Brief agent run: \`${result.briefRunId}\`` },
      ],
    });
  }
  await postMessage(ctx, token, channelId, {
    text: `Media processed: ${fileInfo.name}`,
    blocks,
  }, { threadTs });
  await ctx.metrics.write("slack.media.processed", 1, { mimetype: fileInfo.mimetype });
  return result;
}
