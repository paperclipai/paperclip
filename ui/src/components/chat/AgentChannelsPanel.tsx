import { useTranslation } from "@/i18n";
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
  github: "GitHub Code Review Bot",
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
  const { t } = useTranslation();
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
          <h2 className="text-lg font-semibold">{t("agents.AgentChannelsPanel.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("agents.AgentChannelsPanel.description")}
          </p>
        </div>
        <Button asChild size="sm">
          <Link to={`/apps?chatAgentId=${encodeURIComponent(agentId)}`}>
            <MessageSquarePlus />
            {t("agents.AgentChannelsPanel.connectChannel")}
          </Link>
        </Button>
      </div>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">{t("agents.AgentChannelsPanel.loading")}</p>
      ) : endpoints.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-5">
          <p className="text-sm font-medium">{t("agents.AgentChannelsPanel.empty")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {enabled || githubEnabled ? t("agents.AgentChannelsPanel.emptyHintConnectors") : t("agents.AgentChannelsPanel.emptyHintAgentMail")}
          </p>
          <Button asChild className="mt-3" variant="outline" size="sm">
            <Link to="/apps">{t("agents.AgentChannelsPanel.openConnectors")}</Link>
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
                    t("agents.AgentChannelsPanel.providerIdentity")}
                </p>
              </div>
              <Badge variant="outline">{endpoint.status.replace(/[_-]/g, " ")}</Badge>
              <Button asChild size="sm" variant="outline">
                <Link to={`/apps/chat/${endpoint.id}/settings`}>
                  {t("agents.AgentChannelsPanel.openConnection")} <ExternalLink />
                </Link>
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
