import { Trans } from "react-i18next";
import { t, useTranslation } from "@/i18n";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, MessageSquarePlus } from "lucide-react";
import { chatEndpointsApi, type ChatProvider } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { useChatConnectorsEnabled } from "@/hooks/useChatConnectorsEnabled";
import { photonBotLabel } from "@/pages/apps/chat/photon-copy";

const providerNames: Record<ChatProvider, string> = {
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  "imessage-photon": "iMessage Photon",
  agentmail: "AgentMail",
};

export function AgentChannelsPanel({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  useTranslation();
  const { enabled } = useChatConnectorsEnabled();
  const query = useQuery({
    queryKey: queryKeys.chatEndpoints.list(companyId),
    queryFn: () => chatEndpointsApi.list(companyId),
    enabled,
  });
  if (!enabled) return null;
  const endpoints = (query.data ?? []).filter(
    (endpoint) =>
      endpoint.assignedAgentId === agentId && endpoint.status !== "archived",
  );
  return (
    <section className="max-w-3xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("chatUi.agentChannelsPanel.channels")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("sep12Connections.channelsDescription")}
          </p>
        </div>
        <Button asChild size="sm">
          <Link to={`/apps?chatAgentId=${encodeURIComponent(agentId)}`}>
            <MessageSquarePlus />{t("chatUi.agentChannelsPanel.connectAChannel")}</Link>
        </Button>
      </div>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("chatUi.agentChannelsPanel.loadingChannels")}</p>
      ) : endpoints.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-5">
          <p className="text-sm font-medium">{t("sep12Connections.noChannels")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("sep12Connections.connectChannels")}
          </p>
          <Button asChild className="mt-3" variant="outline" size="sm">
            <Link to="/apps">{t("chatUi.agentChannelsPanel.openConnectors")}</Link>
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
                  {photonBotLabel(endpoint) ??
                    endpoint.providerAccountLabel ??
                    t("chatUi.agentChannelsPanel.providerIdentity")}
                </p>
              </div>
              <StatusBadge status={endpoint.status} />
              <Button asChild size="sm" variant="outline">
                <Link to={`/apps/chat/${endpoint.id}/settings`}><Trans i18nKey="chatUi.agentChannelsPanel.openConnection" components={{ externallink0: <ExternalLink  /> }} /></Link>
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
