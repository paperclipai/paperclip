import { useQuery } from "@tanstack/react-query";
import { ExternalLink, MessageSquarePlus } from "lucide-react";
import { chatEndpointsApi, type ChatProvider } from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/StatusBadge";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";

const providerNames: Record<ChatProvider, string> = {
  slack: "Slack",
  github: "GitHub",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
};

export function AgentChannelsPanel({
  companyId,
  agentId,
}: {
  companyId: string;
  agentId: string;
}) {
  const query = useQuery({
    queryKey: queryKeys.chatEndpoints.list(companyId),
    queryFn: () => chatEndpointsApi.list(companyId),
  });
  const endpoints = (query.data ?? []).filter(
    (endpoint) =>
      endpoint.assignedAgentId === agentId && endpoint.status !== "archived",
  );
  return (
    <section className="max-w-3xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Channels</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Provider identities that let people chat with this agent.
          </p>
        </div>
        <Button asChild size="sm">
          <Link to={`/apps?chatAgentId=${encodeURIComponent(agentId)}`}>
            <MessageSquarePlus />
            Connect a channel
          </Link>
        </Button>
      </div>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading channels…</p>
      ) : endpoints.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-5">
          <p className="text-sm font-medium">No chat channels connected</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Connect Slack, GitHub, Microsoft Teams, or Telegram from Connectors.
          </p>
          <Button asChild className="mt-3" variant="outline" size="sm">
            <Link to="/apps">Open Connectors</Link>
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
                    "Provider identity"}
                </p>
              </div>
              <StatusBadge status={endpoint.status} />
              <Button asChild size="sm" variant="outline">
                <Link to={`/apps/chat/${endpoint.id}/settings`}>
                  Open connection <ExternalLink />
                </Link>
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
