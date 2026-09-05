import type { ChatProvider } from "@paperclipai/shared";

type ProviderLinkInput = {
  provider: ChatProvider;
  providerAccountId?: string | null;
  botUsername?: string | null;
  threadId: string;
  providerMessageId: string;
  raw?: unknown;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function nestedString(
  value: unknown,
  ...path: readonly string[]
): string | null {
  let current: unknown = value;
  for (const key of path) current = object(current)?.[key];
  return typeof current === "string" && current.trim() ? current.trim() : null;
}

function decodeBase64Url(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function teamsConversationLink(input: ProviderLinkInput): string | null {
  const parts = input.threadId.split(":");
  if (parts[0] !== "teams" || (parts.length !== 3 && parts.length !== 4))
    return null;
  const encodedConversationId = parts[1];
  if (!encodedConversationId) return null;
  const encoded = decodeBase64Url(encodedConversationId);
  if (!encoded) return null;
  const [chatOrChannelId, encodedRootMessageId] = encoded.split(
    ";messageid=",
    2,
  );
  if (!chatOrChannelId) return null;
  const raw = object(input.raw);
  const conversationType =
    parts[3] ?? nestedString(raw, "conversation", "conversationType");
  const messageId =
    encodedRootMessageId ||
    nestedString(raw, "replyToId") ||
    nestedString(raw, "id") ||
    input.providerMessageId;
  if (!messageId) return null;

  if (conversationType === "personal" || conversationType === "groupChat") {
    const context = encodeURIComponent(JSON.stringify({ contextType: "chat" }));
    return `https://teams.microsoft.com/l/message/${encodeURIComponent(chatOrChannelId)}/${encodeURIComponent(messageId)}?context=${context}`;
  }

  const tenantId =
    nestedString(raw, "conversation", "tenantId") ||
    nestedString(raw, "channelData", "tenant", "id") ||
    input.providerAccountId?.trim() ||
    null;
  const groupId =
    nestedString(raw, "channelData", "team", "aadGroupId") ||
    nestedString(raw, "channelData", "team", "id");
  const channelId =
    nestedString(raw, "channelData", "channel", "id") || chatOrChannelId;
  if (!tenantId || !groupId || !channelId) return null;
  const params = new URLSearchParams({
    tenantId,
    groupId,
    parentMessageId: messageId,
    createdTime: messageId,
  });
  const teamName = nestedString(raw, "channelData", "team", "name");
  const channelName = nestedString(raw, "channelData", "channel", "name");
  if (teamName) params.set("teamName", teamName);
  if (channelName) params.set("channelName", channelName);
  return `https://teams.microsoft.com/l/message/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}?${params.toString()}`;
}

function telegramConversationLink(input: ProviderLinkInput): string | null {
  const parts = input.threadId.split(":");
  if (parts[0] !== "telegram" || parts.length < 2 || parts.length > 3)
    return null;
  const chatId = parts[1];
  const topicId = parts[2];
  const raw = object(input.raw);
  const chat = object(raw?.chat);
  const username =
    (typeof chat?.username === "string" ? chat.username.trim() : "") || null;
  const messageId =
    typeof raw?.message_id === "number" || typeof raw?.message_id === "string"
      ? String(raw.message_id)
      : input.providerMessageId;
  if (username && messageId) {
    return topicId
      ? `https://t.me/${encodeURIComponent(username)}/${encodeURIComponent(topicId)}/${encodeURIComponent(messageId)}`
      : `https://t.me/${encodeURIComponent(username)}/${encodeURIComponent(messageId)}`;
  }
  if (chatId?.startsWith("-100") && messageId) {
    const channel = chatId.slice(4);
    return topicId
      ? `https://t.me/c/${encodeURIComponent(channel)}/${encodeURIComponent(topicId)}/${encodeURIComponent(messageId)}`
      : `https://t.me/c/${encodeURIComponent(channel)}/${encodeURIComponent(messageId)}`;
  }
  const botUsername = input.botUsername?.replace(/^@/, "").trim();
  return botUsername ? `https://t.me/${encodeURIComponent(botUsername)}` : null;
}

/** Produces only documented HTTPS provider links from stable, verified IDs. */
export function chatProviderConversationUrl(
  input: ProviderLinkInput,
): string | null {
  if (input.provider === "github") {
    const rawUrl = nestedString(input.raw, "comment", "html_url");
    if (rawUrl) {
      try {
        const url = new URL(rawUrl);
        if (
          url.protocol === "https:" &&
          url.hostname === "github.com" &&
          /^\/[^/]+\/[^/]+\/(issues|pull)\/\d+/.test(url.pathname)
        ) {
          return url.toString();
        }
      } catch {
        // Fall through to a URL derived from the verified native identifiers.
      }
    }
    const issue = /^github:([^/]+)\/([^:]+):issue:(\d+)$/.exec(input.threadId);
    if (issue)
      return `https://github.com/${encodeURIComponent(issue[1])}/${encodeURIComponent(issue[2])}/issues/${encodeURIComponent(issue[3])}#issuecomment-${encodeURIComponent(input.providerMessageId)}`;
    const review = /^github:([^/]+)\/([^:]+):(\d+)(?::rc:\d+)?$/.exec(
      input.threadId,
    );
    if (review) {
      const anchor = input.threadId.includes(":rc:")
        ? `discussion_r${input.providerMessageId}`
        : `issuecomment-${input.providerMessageId}`;
      return `https://github.com/${encodeURIComponent(review[1])}/${encodeURIComponent(review[2])}/pull/${encodeURIComponent(review[3])}#${anchor}`;
    }
    return null;
  }
  if (input.provider === "slack" && input.providerAccountId) {
    const match = /^slack:([^:]+):(.+)$/.exec(input.threadId);
    if (!match) return null;
    return `https://app.slack.com/client/${encodeURIComponent(input.providerAccountId)}/${encodeURIComponent(match[1])}/thread/${encodeURIComponent(`${match[1]}-${match[2].replace(".", "")}`)}`;
  }
  if (input.provider === "microsoft-teams") return teamsConversationLink(input);
  if (input.provider === "telegram") return telegramConversationLink(input);
  return null;
}
