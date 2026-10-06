import { t } from "@/i18n";
import type { ChatEndpoint } from "@/api/chatEndpoints";

/** Only canonical first-party wrappers are translated; provider identities stay raw. */
export function photonBotLabel(endpoint: Pick<ChatEndpoint, "provider" | "photonAllocation" | "providerAccountLabel" | "botLabel">): string | null | undefined {
  if (endpoint.provider === "imessage-photon" && endpoint.photonAllocation === "shared" &&
      endpoint.providerAccountLabel && endpoint.botLabel === `${endpoint.providerAccountLabel} (DM only)`) {
    return t("communityPhoton.sharedBotLabel", { projectName: endpoint.providerAccountLabel });
  }
  return endpoint.botLabel;
}

export function photonHealthMessage(provider: ChatEndpoint["provider"] | undefined, message: string | null | undefined): string | null | undefined {
  if (provider !== "imessage-photon") return message;
  if (message === "Photon receiver connected") return t("communityPhoton.receiverConnected");
  if (message === "Photon connection interrupted; reconnecting") return t("communityPhoton.receiverReconnecting");
  return message;
}

export function photonResourceType(type: string): string {
  if (type === "direct_message") return t("communityPhoton.directMessage");
  if (type === "group_chat") return t("communityPhoton.groupChat");
  return type;
}
