import { linearControlCommand, type chatSurfaceKind } from "../inbound/surfaces.js";
import type { EndpointRow, RuntimeContext } from "../runtime-types.js";

import {
  telegramMessageId,
  telegramMessageSentAt,
} from "./messages.js";

import { type ChatRuntime } from "../../chat-runtime.js";
import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";

import {
  createHash,
} from "node:crypto";

import {
  type ChatSdkCallbackEvent,
  type ChatSdkMessageCallbackEvent,
  type ChatSdkRuntime,
} from "../../chat-sdk-runtime.js";

import type {
  Message,
  SlashCommandEvent,
} from "chat";

import type { EndpointRecord } from "../runtime-types.js";

export function telegramGuidanceCommand(
  text: string,
): "start" | "task" | "unknown" | null {
  const match = /^\/([a-z][\w-]*)(?:@[\w.-]+)?(?:\s|$)/i.exec(text.trim());
  const command = match?.[1]?.toLowerCase();
  if (
    !command ||
    command === "new" ||
    command === "close" ||
    command === "status"
  )
    return null;
  if (command === "start") return "start";
  if (command === "task") return "task";
  return "unknown";
}

type TelegramCommandsOptions = {
  runtime: Pick<ChatSdkRuntime | ChatRuntime, "get">;
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  handleSdkMessage: (event: ChatSdkMessageCallbackEvent, context: RuntimeContext) => Promise<void>;
};

export function createTelegramCommands(options: TelegramCommandsOptions) {
  const { runtime, runtimeFor, handleSdkMessage } = options;
  async function handleTelegramSlashCommand(event: ChatSdkCallbackEvent<SlashCommandEvent>, runtimeContext: RuntimeContext, record: EndpointRecord, command: string, text: string) {
      const endpointRuntime =
        runtime.get(event.endpointId) ?? (await runtimeFor(record.endpoint));
      const thread = endpointRuntime.thread(event.event.channel.id);
      const parsedCommandMessage =
        endpointRuntime.parseTelegramCommandMessage?.(event.event.raw) ?? null;
      const synthetic = {
        id:
          telegramMessageId(event.event.raw) ??
          event.event.triggerId ??
          createHash("sha256")
            .update(
              JSON.stringify({
                command,
                raw: event.event.raw,
                userId: event.event.user.userId,
              }),
            )
            .digest("hex"),
        threadId: thread.id,
        // Telegram privacy mode does not deliver an ordinary @mention in a
        // group. /task@bot <request> is therefore the provider-native root
        // activation path; direct replies and later /task commands can
        // continue the same active group/topic task.
        text: command === "/task" && text ? text : command,
        formatted: { type: "root", children: [] },
        raw: event.event.raw,
        author: event.event.user,
        metadata: {
          // Telegram slash commands carry the original message as `raw`.
          // Preserve its whole-second provider clock so the durable drain can
          // use message_id to order a command and the next rapid DM correctly.
          dateSent: telegramMessageSentAt(event.event.raw) ?? new Date(),
          edited: false,
        },
        // Telegram routes a captioned file command through onSlashCommand
        // instead of the ordinary message callback. Preserve the provider's
        // parsed attachment descriptors so the durable delivery worker can
        // rehydrate and ingest them exactly like non-command media.
        attachments: parsedCommandMessage?.attachments ?? [],
        links: [],
        isMention: true,
      } as unknown as Message;
      await handleSdkMessage(
        {
          endpointId: event.endpointId,
          provider: event.provider,
          thread,
          message: synthetic,
          trigger: thread.isDM ? "direct_message" : "mention",
        },
        runtimeContext,
      );
      return;
    }
  return { handleTelegramSlashCommand };
}

export function telegramGuidanceResponse(
  guidanceCommand: NonNullable<ReturnType<typeof telegramGuidanceCommand>>,
  botUsername: string | null,
  assignedAgentName: string | null,
): string {
  return guidanceCommand === "start"
            ? `Send a direct message to start work with ${assignedAgentName}. In a group, use /task@${botUsername ?? "your_bot"} followed by your request. Use /status, /new, or /close to manage the active task in this chat.`
            : guidanceCommand === "task"
              ? `Please include a request after /task@${botUsername ?? "your_bot"}.`
              : `Available commands: /task@${botUsername ?? "your_bot"} followed by your request, /status, /new, and /close.`;
}

export function telegramForumControlResponse(command: "new" | "close", taskLabel: string, hasIssue: boolean, hasConversation: boolean): string {
  if (command === "new") return hasIssue
    ? `${taskLabel} stays bound to this forum topic. Open a new Telegram forum topic to start a new Paperclip task.`
    : "Open a new Telegram forum topic to start a new Paperclip task.";
  return hasConversation
    ? "This chat conversation is closed. A later message here will continue the same Paperclip task."
    : "No task is active. Send a message to start one.";
}

export function telegramInboundControls(text: string, surfaceKind: ReturnType<typeof chatSurfaceKind>) {
  // Telegram exposes its small command vocabulary in forum topics too.
  // A forum topic is a native provider thread and therefore stays bound to
  // one immutable Paperclip task, but the command must still be consumed
  // as control-plane input instead of becoming a task comment/wakeup.
  const controlCommand = linearControlCommand(text);
  const guidanceCommand = telegramGuidanceCommand(text);
  const isForumTopic = surfaceKind === "native_thread";
  const bypassesControlChronology = controlCommand === "status" ||
    (controlCommand === "new" && isForumTopic) || guidanceCommand !== null;
  return { controlCommand, guidanceCommand, isForumTopic, bypassesControlChronology };
}
