import { t, useTranslation } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, MessageSquarePlus } from "lucide-react";
import { chatEndpointsApi, type ChatProvider } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { useChatConnectorsEnabled, chatProviderVisible } from "@/hooks/useChatConnectorsEnabled";

const providerNames: Record<ChatProvider, string> = {
  speko: "Speko",
  slack: "Slack",
  get github() { return t("final-configuration:githubReviewBot"); },
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  "imessage-photon": "iMessage Photon",
  agentmail: "AgentMail",
};

const endpointStatusKeys: Record<string, string> = {
  "draft": "final-configuration:channelStatus_draft",
  "verifying": "final-configuration:channelStatus_verifying",
  "active": "final-configuration:channelStatus_active",
  "paused": "final-configuration:channelStatus_paused",
  "attention": "final-configuration:channelStatus_attention",
  "revoked": "final-configuration:channelStatus_revoked",
  "archived": "final-configuration:channelStatus_archived"
};

export function AgentChannelsPanel({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  useTranslation("task-components");
  const { enabled, githubEnabled } = useChatConnectorsEnabled();
  const query = useQuery({
    queryKey: queryKeys.chatEndpoints.list(companyId),
    queryFn: () => chatEndpointsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const endpoints = (query.data ?? []).filter(
    (endpoint) =>
      endpoint.assignedAgentId === agentId && endpoint.status !== "archived" && chatProviderVisible(endpoint.provider, enabled, githubEnabled),
  );
  return (
    <section className="max-w-3xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("task-components:channels_4c8906cf")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("task-components:chatAndEmailIdentitiesConnectedToThis_1a1a7a34")}</p>
        </div>
        <Button asChild size="sm">
          <Link to={`/apps?chatAgentId=${encodeURIComponent(agentId)}`}>
            <MessageSquarePlus />{t("task-components:connectAChannel_283fa1a6")}</Link>
        </Button>
      </div>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("task-components:loadingChannels_b09d106b")}</p>
      ) : endpoints.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-5">
          <p className="text-sm font-medium">{t("task-components:noChannelsConnected_ce30a041")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {enabled || githubEnabled ? t("task-components:connectAnAgentIdentityFromConnectors_f60f50b7") : t("task-components:connectAgentmailFromConnectors_dfa2bbda")}
          </p>
          <Button asChild className="mt-3" variant="outline" size="sm">
            <Link to="/apps">{t("task-components:openConnectors_d985974b")}</Link>
          </Button>
        </div>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {endpoints.map((endpoint) => (
            <div
              key={endpoint.id}
              className="flex flex-wrap items-center gap-3 py-4"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {providerNames[endpoint.provider]}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {endpoint.botLabel ??
                    endpoint.providerAccountLabel ??
                    t("task-components:providerIdentity_656eefd9")}
                </p>
              </div>
              <Badge variant="outline">{Object.hasOwn(endpointStatusKeys, endpoint.status) ? t(endpointStatusKeys[endpoint.status]) : endpoint.status}</Badge>
              <Button asChild size="sm" variant="outline">
                <Link to={`/apps/chat/${endpoint.id}/settings`}>{t("task-components:openConnection_bfb179e9")}{" "}<ExternalLink />
                </Link>
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
