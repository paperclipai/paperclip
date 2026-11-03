import type { ChatEndpoint } from "@/api/chatEndpoints";

export function slackConversationUrl(endpoint: Pick<ChatEndpoint, "providerAccountId" | "setup">): string {
  const channelId = endpoint.setup?.slackAccount?.dmChannelId;
  return channelId && endpoint.providerAccountId
    ? `https://app.slack.com/client/${encodeURIComponent(endpoint.providerAccountId)}/${encodeURIComponent(channelId)}`
    : endpoint.setup?.providerUrl ?? "https://app.slack.com";
}
