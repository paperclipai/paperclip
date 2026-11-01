import { slackThreadChannelId } from "../slack/messages.js";

import type { EndpointRow } from "../runtime-types.js";

import { baseTeamsConversationId } from "../microsoft-teams/resources.js";
import { slackResourceLabelIsFallback } from "../slack/resources.js";
import { telegramResourceLabelIsFallback } from "../telegram/resources.js";

import {
  canonicalTeamsThreadId,
  teamsConversationId,
} from "../../chat-control-chronology.js";

import {
  chatEndpointResources,
} from "@paperclipai/db";
import type {
  ChatProvider,
} from "@paperclipai/shared";

import type {
  Thread,
} from "chat";

type ResourceRow = typeof chatEndpointResources.$inferSelect;


type ChatSurfaceKind = "direct_message" | "linear_group" | "native_thread";

function providerResourceType(
  provider: ChatProvider,
  surfaceKind: ChatSurfaceKind,
): string {
  if (surfaceKind === "direct_message") return "direct_message";
  if (provider === "github") return "repository";
  if (provider === "imessage-photon") return "group_chat";
  if (provider === "discord") return "channel";
  if (provider === "microsoft-teams")
    return surfaceKind === "linear_group" ? "group_chat" : "channel";
  // Telegram topics are task/thread boundaries inside one group resource. The
  // operator grants access to the chat once rather than having to rediscover
  // and enable every topic independently.
  if (provider === "telegram") return "chat";
  return "channel";
}


function sameTeamsThreadIdentity(left: string, right: string): boolean {
  const leftConversationId = teamsConversationId(left);
  const rightConversationId = teamsConversationId(right);
  return (
    leftConversationId !== null &&
    rightConversationId !== null &&
    leftConversationId === rightConversationId
  );
}


function durableExternalThreadIdentity(threadId: string): string {
  return canonicalTeamsThreadId(threadId) ?? threadId;
}

function teamsThreadRootMessageId(threadId: string): string | null {
  const conversationId = teamsConversationId(threadId);
  if (!conversationId) return null;
  return /;messageid=([^;]+)/i.exec(conversationId)?.[1] ?? null;
}

function canonicalProviderResourceId(
  provider: ChatProvider,
  thread: Pick<Thread, "channelId" | "id">,
): string {
  if (provider === "slack") return thread.channelId.replace(/^slack:/, "");
  if (provider === "github")
    return thread.channelId.replace(/^github:/, "").toLowerCase();
  if (provider === "discord") {
    const parts = thread.channelId.split(":");
    return parts[2] ?? thread.channelId;
  }
  if (provider === "microsoft-teams") {
    const conversationId =
      teamsConversationId(thread.channelId) ?? teamsConversationId(thread.id);
    return conversationId
      ? baseTeamsConversationId(conversationId)
      : baseTeamsConversationId(thread.channelId);
  }
  if (provider === "telegram")
    return thread.channelId.replace(/^telegram:/, "");
  return thread.channelId;
}

function providerResourceLabelFromThread(
  provider: ChatProvider,
  thread: Pick<Thread, "channelId" | "id" | "channel">,
): { label: string; fallback: boolean } {
  const providerResourceId = canonicalProviderResourceId(provider, thread);
  const candidate = thread.channel.name?.trim();
  if (!candidate) return { label: providerResourceId, fallback: true };
  if (
    (provider === "slack" &&
      slackResourceLabelIsFallback(providerResourceId, candidate)) ||
    (provider === "telegram" &&
      telegramResourceLabelIsFallback(providerResourceId, candidate))
  ) {
    return { label: providerResourceId, fallback: true };
  }
  return { label: candidate, fallback: false };
}

/**
 * Native channel threads keep one issue forever. Linear surfaces instead
 * advance through Paperclip task generations because their provider id is
 * reused after a task completes or the user explicitly starts a new task.
 */
function chatSurfaceKind(
  provider: ChatProvider,
  thread: Thread,
): ChatSurfaceKind {
  if (thread.isDM) return "direct_message";
  if (provider === "imessage-photon") return "linear_group";
  if (provider === "telegram") {
    return /^telegram:[^:]+:[^:]+$/.test(thread.id)
      ? "native_thread"
      : "linear_group";
  }
  if (provider === "microsoft-teams") {
    const conversationId = teamsConversationId(thread.id);
    return conversationId?.includes(";messageid=")
      ? "native_thread"
      : "linear_group";
  }
  return "native_thread";
}

/**
 * Teams group chats are admitted as a class: installation at the provider and
 * the endpoint's group-chat toggle are the two gates the operator can
 * actually control. Teams channels, and every other non-DM destination,
 * retain the explicit per-resource enablement gate shown in Settings.
 */
function nonDirectDestinationAllowed(
  endpoint: EndpointRow,
  resource: ResourceRow | null | undefined,
): boolean {
  if (!resource || resource.availability !== "available") return false;
  if (
    endpoint.provider === "microsoft-teams" &&
    resource.type === "group_chat"
  ) {
    return endpoint.allowGroupChats;
  }
  return resource.enabled;
}

function linearControlCommand(text: string): "new" | "close" | "status" | null {
  const match = /^\/(new|close|status)(?:@[\w.-]+)?\s*$/i.exec(text.trim());
  return (
    (match?.[1]?.toLowerCase() as "new" | "close" | "status" | undefined) ??
    null
  );
}

function actionThreadMatchesConversation(
  provider: ChatProvider,
  actionThreadId: string,
  conversationThreadId: string,
): boolean {
  if (provider === "microsoft-teams") {
    return sameTeamsThreadIdentity(actionThreadId, conversationThreadId);
  }
  if (provider !== "slack") return actionThreadId === conversationThreadId;
  const actionChannelId = slackThreadChannelId(actionThreadId);
  return (
    actionChannelId !== null &&
    actionChannelId === slackThreadChannelId(conversationThreadId)
  );
}

export { providerResourceType, sameTeamsThreadIdentity, durableExternalThreadIdentity, teamsThreadRootMessageId, canonicalProviderResourceId, providerResourceLabelFromThread, chatSurfaceKind, nonDirectDestinationAllowed, linearControlCommand, actionThreadMatchesConversation };
export type { ChatSurfaceKind };
