import { createHash } from "node:crypto";
import type { chatDeliveries } from "@paperclipai/db";
import type { ChatProvider } from "@paperclipai/shared";
import type { Author } from "chat";
import { normalizeMicrosoftTeamsExternalPrincipalId } from "../chat-teams-credentials.js";
import { normalizeTelegramRichMessage } from "../chat-telegram-rich-intake.js";
import type { ChatEndpointRuntime } from "../voice/voice-runtime.js";

// Provider message identity and chronology only. Callers retain authentication,
// authorization, durable admission, and delivery ownership.
export const MAX_INBOUND_TEXT = 100_000;

export function stableExternalPrincipalId(
  provider: ChatProvider,
  author: Author,
  raw?: unknown,
): string {
  if (provider !== "microsoft-teams" || !raw || typeof raw !== "object")
    return author.userId;
  const from = (raw as { from?: unknown }).from;
  if (!from || typeof from !== "object") return author.userId;
  const aadObjectId = (from as { aadObjectId?: unknown }).aadObjectId;
  return normalizeMicrosoftTeamsExternalPrincipalId(aadObjectId, author.userId);
}

export type GitHubLifecycleEvent = {
  actor?: LifecycleActor;
  isBotMessage?: true;
  eventKind: "message_updated" | "message_deleted";
  messageId: string;
  providerEventId?: string;
  providerMessageSequence: number | null;
  providerSentAt: string | null;
  revision: string;
  text: string;
  threadId: string;
};

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

export type LifecycleActor = {
  displayName: string;
  externalId: string;
  handle: string;
};

type MicrosoftTeamsLifecycleEvent = {
  actor?: LifecycleActor;
  eventKind: "message_updated" | "message_deleted" | "message_restored";
  messageId: string;
  providerSentAt: string | null;
  raw?: unknown;
  revision: string;
  text: string;
  threadId: string;
};

export function lifecycleActorFromAuthor(
  provider: ChatProvider,
  author: Author,
  raw?: unknown,
): LifecycleActor {
  return {
    externalId: stableExternalPrincipalId(provider, author, raw),
    displayName: author.fullName,
    handle: author.userName,
  };
}

export function slackLifecycleFilesDigest(raw: unknown): string {
  const files =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).files
      : undefined;
  // Match the pinned Slack adapter's content-change projection. Transport
  // locators/unfurls are not content identity and must never enter durable keys.
  const projection = Array.isArray(files)
    ? files.map((file) => {
        const row =
          file && typeof file === "object" && !Array.isArray(file)
            ? (file as Record<string, unknown>)
            : {};
        return [
          ...["id", "name", "mimetype"].map((key) =>
            typeof row[key] === "string" ? row[key] : null,
          ),
          ...["size", "original_w", "original_h"].map((key) =>
            typeof row[key] === "number" && Number.isFinite(row[key])
              ? row[key]
              : null,
          ),
        ];
      })
    : [];
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

export function discordLifecycleFilesDigest(raw: unknown): string {
  const attachments =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).attachments
      : undefined;
  // Match the pinned Gateway adapter's flattened, ordered file projection.
  // Rotating CDN URLs are transport authority, never source revision identity.
  const projection = Array.isArray(attachments)
    ? attachments.map((attachment) => {
        const row =
          attachment &&
          typeof attachment === "object" &&
          !Array.isArray(attachment)
            ? (attachment as Record<string, unknown>)
            : {};
        return [
          ...["id", "filename", "content_type"].map((key) =>
            typeof row[key] === "string" ? row[key] : null,
          ),
          typeof row.size === "number" && Number.isFinite(row.size)
            ? row.size
            : null,
        ];
      })
    : [];
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

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

export function microsoftTeamsLifecycleEventFromPayload(
  payload: unknown,
  endpointRuntime: Pick<ChatEndpointRuntime, "parseMicrosoftTeamsMessage">,
): MicrosoftTeamsLifecycleEvent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const activity = payload as {
    channelData?: { eventType?: unknown };
    timestamp?: unknown;
    type?: unknown;
  };
  const eventType = activity.channelData?.eventType;
  const isEdit =
    activity.type === "messageUpdate" && eventType === "editMessage";
  const isRestore =
    activity.type === "messageUpdate" && eventType === "undeleteMessage";
  const isDelete =
    activity.type === "messageDelete" && eventType === "softDeleteMessage";
  if (!isEdit && !isRestore && !isDelete) return null;
  const message = endpointRuntime.parseMicrosoftTeamsMessage(payload);
  if (!message?.id || !message.threadId) return null;
  const body = message.text.slice(0, MAX_INBOUND_TEXT);
  const providerSentAt =
    typeof activity.timestamp === "string" &&
    Number.isFinite(Date.parse(activity.timestamp))
      ? new Date(activity.timestamp).toISOString()
      : null;
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const revision = providerSentAt ? `${providerSentAt}:${bodyHash}` : bodyHash;
  return {
    ...(!isDelete
      ? {
          actor: lifecycleActorFromAuthor(
            "microsoft-teams",
            message.author,
            message.raw,
          ),
        }
      : {}),
    eventKind: isDelete
      ? "message_deleted"
      : isRestore
        ? "message_restored"
        : "message_updated",
    messageId: message.id,
    providerSentAt,
    raw: message.raw,
    revision,
    text: isDelete
      ? "An external message in this conversation was deleted."
      : isRestore
        ? `An external message was restored:\n\n${body}`
        : `An external message was edited:\n\n${body}`,
    threadId: message.threadId,
  };
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

export function slackMessageSentAt(raw: unknown, messageId: string): Date | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const ts = (raw as { ts?: unknown }).ts;
  if (
    ts !== messageId ||
    typeof ts !== "string" ||
    !/^[1-9][0-9]{0,12}\.[0-9]{6}$/.test(ts)
  )
    return null;
  const date = new Date(Number(ts) * 1_000);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function teamsActivitySentAt(raw: unknown): Date | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = (raw as { timestamp?: unknown }).timestamp;
  // The SDK may supply a Date, but its missing-timestamp display fallback is
  // only on Message.metadata. Never use that fallback as provider chronology.
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null;
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,7})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    )
  )
    return null;
  // Date.parse otherwise normalizes nonexistent dates such as February 30.
  const day = value.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00.000Z`);
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.toISOString().slice(0, 10) !== day
  )
    return null;
  const sentAt = new Date(value);
  return Number.isFinite(sentAt.getTime()) ? sentAt : null;
}

export async function githubLifecycleEventFromRequest(
  request: Request,
): Promise<GitHubLifecycleEvent | null> {
  const eventType = request.headers.get("x-github-event");
  const deliveryId = request.headers.get("x-github-delivery")?.trim() || null;
  if (
    eventType !== "issue_comment" &&
    eventType !== "pull_request_review_comment"
  )
    return null;
  const payload = (await request.json()) as {
    action?: unknown;
    comment?: {
      id?: unknown;
      in_reply_to_id?: unknown;
      body?: unknown;
      updated_at?: unknown;
      user?: { type?: unknown };
    };
    issue?: { number?: unknown; pull_request?: unknown };
    pull_request?: { number?: unknown };
    repository?: { name?: unknown; owner?: { login?: unknown } };
    sender?: { id?: unknown; login?: unknown; type?: unknown };
  };
  if (payload.action !== "edited" && payload.action !== "deleted") return null;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const messageId = payload.comment?.id;
  if (
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    (typeof messageId !== "string" && typeof messageId !== "number")
  )
    return null;
  let threadId: string;
  if (eventType === "issue_comment") {
    const number = payload.issue?.number;
    if (typeof number !== "number") return null;
    threadId = payload.issue?.pull_request
      ? `github:${owner}/${repo}:${number}`
      : `github:${owner}/${repo}:issue:${number}`;
  } else {
    const number = payload.pull_request?.number;
    const rootCommentId =
      payload.comment?.in_reply_to_id ?? payload.comment?.id;
    if (
      typeof number !== "number" ||
      (typeof rootCommentId !== "string" && typeof rootCommentId !== "number")
    )
      return null;
    threadId = `github:${owner}/${repo}:${number}:rc:${rootCommentId}`;
  }
  const eventKind =
    payload.action === "edited" ? "message_updated" : "message_deleted";
  const body =
    typeof payload.comment?.body === "string"
      ? payload.comment.body.slice(0, MAX_INBOUND_TEXT)
      : "";
  const providerRevision =
    typeof payload.comment?.updated_at === "string"
      ? payload.comment.updated_at
      : payload.action;
  const parsedProviderSentAt = new Date(providerRevision);
  const providerSentAt = Number.isFinite(parsedProviderSentAt.getTime())
    ? parsedProviderSentAt.toISOString()
    : null;
  const numericMessageId =
    typeof messageId === "number"
      ? messageId
      : typeof messageId === "string" && /^\d+$/.test(messageId)
        ? Number(messageId)
        : null;
  const providerMessageSequence =
    numericMessageId !== null &&
    Number.isSafeInteger(numericMessageId) &&
    numericMessageId >= 0
      ? numericMessageId
      : null;
  const senderId = payload.sender?.id;
  const senderLogin = payload.sender?.login;
  const actor =
    (typeof senderId === "string" || typeof senderId === "number") &&
    typeof senderLogin === "string" &&
    senderLogin.length > 0
      ? {
          externalId: String(senderId),
          displayName: senderLogin,
          handle: senderLogin,
        }
      : undefined;
  return {
    ...(actor ? { actor } : {}),
    ...(payload.comment?.user?.type === "Bot" || payload.sender?.type === "Bot"
      ? { isBotMessage: true as const }
      : {}),
    eventKind,
    messageId: String(messageId),
    ...(deliveryId ? { providerEventId: `github:delivery:${deliveryId}` } : {}),
    providerMessageSequence,
    providerSentAt,
    // GitHub's updated_at value can have coarser resolution than a quick
    // sequence of edits. Include the normalized body so distinct edits at the
    // same timestamp remain durable while an exact webhook redelivery still
    // deduplicates.
    revision:
      eventKind === "message_updated"
        ? `${providerRevision}:${createHash("sha256").update(body).digest("hex")}`
        : providerRevision,
    text:
      eventKind === "message_updated"
        ? `An external message was edited:\n\n${body}`
        : "An external message in this conversation was deleted.",
    threadId,
  };
}
