import type { Attachment } from "chat";
import { createHash } from "node:crypto";
import type { chatDeliveries } from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import { normalizeTelegramRichMessage } from "../../chat-telegram-rich-intake.js";
import { MAX_INBOUND_TEXT, type LifecycleActor } from "../message-lifecycle.js";


type TelegramLifecycleEvent = {
  actor: LifecycleActor;
  eventKind: "message_updated";
  messageId: string;
  providerEventId?: string;
  providerMessageSequence: number;
  providerSentAt: string;
  providerUpdateId: number | null;
  revision: string;
  text: string;
  threadId: string;
};

function telegramLifecycleActor(message: {
  from?: unknown;
  sender_chat?: unknown;
}): LifecycleActor | null {
  const candidate =
    message.from &&
    typeof message.from === "object" &&
    !Array.isArray(message.from)
      ? (message.from as Record<string, unknown>)
      : message.sender_chat &&
          typeof message.sender_chat === "object" &&
          !Array.isArray(message.sender_chat)
        ? (message.sender_chat as Record<string, unknown>)
        : null;
  if (!candidate) return null;
  const id = candidate.id;
  if (typeof id !== "string" && typeof id !== "number") return null;
  const handle =
    typeof candidate.username === "string" ? candidate.username : "";
  const displayName =
    [candidate.first_name, candidate.last_name]
      .filter(
        (value): value is string => typeof value === "string" && Boolean(value),
      )
      .join(" ") ||
    (typeof candidate.title === "string" ? candidate.title : "") ||
    handle ||
    String(id);
  return { externalId: String(id), displayName, handle };
}

export function telegramLifecycleEventFromPayload(
  payload: unknown,
): TelegramLifecycleEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const update = payload as {
    edited_message?: unknown;
    update_id?: unknown;
  };
  const edited = update.edited_message;
  if (!edited || typeof edited !== "object" || Array.isArray(edited))
    return null;
  const message = edited as {
    caption?: unknown;
    chat?: { id?: unknown };
    edit_date?: unknown;
    from?: unknown;
    message_id?: unknown;
    message_thread_id?: unknown;
    sender_chat?: unknown;
    text?: unknown;
    rich_message?: unknown;
  };
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  const editDate = message.edit_date;
  if (
    (typeof chatId !== "string" && typeof chatId !== "number") ||
    typeof messageId !== "number" ||
    !Number.isSafeInteger(messageId) ||
    messageId < 0 ||
    typeof editDate !== "number" ||
    !Number.isSafeInteger(editDate) ||
    editDate <= 0
  )
    return null;
  const topicId = message.message_thread_id;
  if (topicId !== undefined && typeof topicId !== "number") return null;
  const rich = normalizeTelegramRichMessage(message);
  const body =
    rich?.text ??
    (typeof message.text === "string"
      ? message.text
      : typeof message.caption === "string"
        ? message.caption
        : "");
  const chat = String(chatId);
  const providerUpdateId =
    typeof update.update_id === "number" &&
    Number.isSafeInteger(update.update_id) &&
    update.update_id >= 0
      ? update.update_id
      : null;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const actor = telegramLifecycleActor(message);
  if (!actor) return null;
  return {
    actor,
    eventKind: "message_updated",
    messageId: `${chat}:${messageId}`,
    ...(providerUpdateId === null
      ? {}
      : { providerEventId: `telegram:update:${providerUpdateId}` }),
    providerMessageSequence: messageId,
    providerSentAt: new Date(editDate * 1_000).toISOString(),
    providerUpdateId,
    // Bot API timestamps have one-second resolution. The update id is the
    // authoritative identity when present; retaining a content hash keeps the
    // fallback path from collapsing two distinct edits in that same second.
    revision: `${editDate}:${bodyHash}${rich ? `:${rich.mediaDigest}` : ""}`,
    text: `An external message was edited:\n\n${body.slice(0, MAX_INBOUND_TEXT)}`,
    threadId:
      topicId === undefined
        ? `telegram:${chat}`
        : `telegram:${chat}:${topicId}`,
  };
}

export function isTelegramEditedMessageRaw(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    typeof (raw as { edit_date?: unknown }).edit_date === "number"
  );
}

export function isTelegramMigrationRaw(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const value = raw as {
    migrate_from_chat_id?: unknown;
    migrate_to_chat_id?: unknown;
  };
  return (
    value.migrate_from_chat_id !== undefined ||
    value.migrate_to_chat_id !== undefined
  );
}

export function telegramMessageSequence(raw: unknown): number | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as { message_id?: unknown }).message_id;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

export function telegramMessageId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as {
    chat?: { id?: unknown };
    message_id?: unknown;
  };
  const messageId = value.message_id;
  const chatId = value.chat?.id;
  if (
    typeof messageId !== "number" ||
    !Number.isSafeInteger(messageId) ||
    messageId <= 0
  )
    return null;
  const normalizedChatId =
    typeof chatId === "number" && Number.isSafeInteger(chatId)
      ? String(chatId)
      : typeof chatId === "string" && /^-?\d+$/.test(chatId)
        ? chatId
        : null;
  return normalizedChatId ? `${normalizedChatId}:${messageId}` : null;
}

export function telegramZeroMessageId(value: unknown): boolean {
  // The pinned adapter qualifies native message IDs with the numeric chat ID.
  // Keep legacy synthetic/non-numeric IDs compatible; zero is specifically
  // the provider's non-ordinary message identity, never an admitted source.
  return typeof value === "string" && /^(?:-?\d+:)?0$/.test(value);
}

export function telegramDeliveryHasZeroMessageId(
  delivery: Pick<typeof chatDeliveries.$inferSelect, "normalizedEvent" | "providerEventId">,
  provider: ChatProvider,
): boolean {
  if (provider !== "telegram") return false;
  const normalized = delivery.normalizedEvent as {
    message?: {
      providerMessageId?: unknown;
      providerMessageSequence?: unknown;
    };
    conversation?: { externalThreadId?: unknown };
  };
  if (
    telegramZeroMessageId(normalized.message?.providerMessageId) ||
    normalized.message?.providerMessageSequence === 0
  )
    return true;
  const threadId = normalized.conversation?.externalThreadId;
  // Check the independently retained event key only inside its exact thread
  // namespace, not arbitrary IDs ending in ':0' from synthetic commands.
  return (
    typeof threadId === "string" &&
    delivery.providerEventId.startsWith(`${threadId}:`) &&
    telegramZeroMessageId(delivery.providerEventId.slice(threadId.length + 1))
  );
}

export function telegramMessageSentAt(raw: unknown): Date | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as { date?: unknown }).date;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    return null;
  const sentAt = new Date(value * 1_000);
  return Number.isFinite(sentAt.getTime()) ? sentAt : null;
}

export function telegramMarkdownAttachment(text: string): Attachment {
    const data = Buffer.from(text, "utf8");
    return {
      data,
      mimeType: "text/markdown; charset=utf-8",
      name: "paperclip-response.md",
      size: data.byteLength,
      type: "file",
    };
  }
