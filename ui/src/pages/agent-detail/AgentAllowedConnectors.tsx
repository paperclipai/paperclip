import { useTranslation } from "@/i18n";
import { useMemo } from "react";
import { ArrowUpRight } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { toolsApi } from "@/api/tools";
import { AgentPanel } from "@/components/agent-detail/AgentPanels";
import { Button } from "@/components/ui/button";
import { Link } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { AppLogo } from "../apps/AppLogo";

const SHOWN_LOGOS = 3;

export function AgentAllowedConnectors({ agentId, companyId }: { agentId: string; companyId: string }) {
  const { t: translateAgentPage } = useTranslation("agents");
  const effective = useQuery({
    queryKey: queryKeys.tools.effectiveProfilesForAgent(companyId, agentId),
    queryFn: () => toolsApi.getEffectiveProfilesForAgent(companyId, agentId),
  });
  const connections = useQuery({
    queryKey: queryKeys.tools.connections(companyId),
    queryFn: () => toolsApi.listConnections(companyId),
  });
  const applications = useQuery({
    queryKey: queryKeys.tools.applications(companyId),
    queryFn: () => toolsApi.listApplications(companyId),
  });

  const apps = useMemo(() => {
    const connectionApp = new Map((connections.data?.connections ?? []).map((connection) => [connection.id, connection.applicationId]));
    const appById = new Map((applications.data?.applications ?? []).map((application) => [application.id, application]));
    const seen = new Map<string, { id: string; name: string; key?: string }>();
    for (const tool of effective.data?.allowedTools ?? []) {
      const applicationId = connectionApp.get(tool.connectionId);
      const application = applicationId ? appById.get(applicationId) : undefined;
      if (!application || seen.has(application.id)) continue;
      seen.set(application.id, { id: application.id, name: application.name, key: application.applicationKey });
    }
    return [...seen.values()];
  }, [applications.data?.applications, connections.data?.connections, effective.data?.allowedTools]);

  const loading = effective.isLoading || connections.isLoading || applications.isLoading;
  const failed = effective.error || connections.error || applications.error;

  return (
    <AgentPanel
      title={translateAgentPage("agents:allowed_connectors")}
      aria-label={translateAgentPage("agents:allowed_connectors")}
      action={
        <Button variant="ghost" size="icon-xs" asChild>
          <Link to="/apps?source=installed" aria-label={translateAgentPage("agents:manage_connectors")} title={translateAgentPage("agents:manage_connectors")}>
            <ArrowUpRight className="size-4" />
          </Link>
        </Button>
      }
    >
      <div className="flex min-w-0 flex-1 flex-col justify-center px-(--agent-detail-module-inset) pb-(--agent-detail-module-inset)">
        {loading ? (
          <p role="status" className="text-xs text-muted-foreground">{translateAgentPage("agents:resolving_access")}</p>
        ) : failed ? (
          <p role="alert" className="text-xs text-destructive">{translateAgentPage("agents:couldn_t_load_this_agent_s_connectors")}</p>
        ) : apps.length === 0 ? (
          <p className="text-xs text-muted-foreground">{translateAgentPage("agents:no_connectors_are_allowed_yet")}</p>
        ) : (
          <ul aria-label={translateAgentPage("agents:connectors")} className="flex max-h-(--agent-detail-logo-rows-h) flex-wrap gap-3 overflow-hidden">
            {apps.slice(0, SHOWN_LOGOS).map((app) => (
              <li key={app.id} className="flex shrink-0" title={app.name}>
                <AppLogo name={app.name} brandKey={app.key} size={24} compact />
              </li>
            ))}
          </ul>
        )}
      </div>
    </AgentPanel>
  );
}
