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
