import { useTranslation } from "@/i18n";
import type { ChatEndpoint } from "@/api/chatEndpoints";

export function slackConversationUrl(endpoint: Pick<ChatEndpoint, "providerAccountId" | "setup">, userId: string | null): string {
  const account = endpoint.setup?.slackAccount;
  return userId && account?.status === "linked" && account.paperclipUserId === userId && account.dmChannelId && endpoint.providerAccountId
    ? `https://app.slack.com/client/${encodeURIComponent(endpoint.providerAccountId)}/${encodeURIComponent(account.dmChannelId)}`
    : endpoint.setup?.providerUrl ?? "https://app.slack.com";
}
