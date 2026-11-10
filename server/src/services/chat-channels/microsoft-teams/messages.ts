import { teamsThreadRootMessageId } from "../inbound/surfaces.js";
import { createHash } from "node:crypto";
import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";
import { MAX_INBOUND_TEXT, lifecycleActorFromAuthor, type LifecycleActor } from "../message-lifecycle.js";


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

export function teamsOrphanFollowUp(threadId: string, messageId: string): boolean {
  const rootMessageId = teamsThreadRootMessageId(threadId);
  return Boolean(rootMessageId) && rootMessageId !== messageId;
}

export function teamsAttachmentReferenceText(count: number, providerUrl: string | null): string {
  return `Shared ${count} Microsoft Teams file reference${count === 1 ? "" : "s"}.${providerUrl ? ` Open in Microsoft Teams: ${providerUrl}` : ""}`;
}

export function teamsWebhookLifecycleEventFromPayload(
  payload: unknown,
  endpointRuntime: Pick<ChatEndpointRuntime, "acceptsProviderScope" | "parseMicrosoftTeamsMessage">,
): MicrosoftTeamsLifecycleEvent | null {
  if (!payload || !endpointRuntime.acceptsProviderScope(payload)) return null;
  return microsoftTeamsLifecycleEventFromPayload(payload, endpointRuntime);
}

export function teamsRootMentionCanEnableSetupDestination(
  resource: { type: string } | null | undefined,
): boolean {
  return resource?.type === "channel";
}
