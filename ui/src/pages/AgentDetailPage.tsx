import { useEffect } from "react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useQuery } from "@tanstack/react-query";
import { useParams, Link } from "@/lib/router";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import { PluginSlotMount, usePluginSlots } from "@/plugins/slots";
import { AgentDetail } from "./AgentDetail";

export function AgentDetailPage() {
  const { tab } = useParams<{ tab?: string }>();
  return tab?.startsWith("plugin:") ? <AgentPluginDetail /> : <AgentDetail />;
}

function AgentPluginDetail() {
  const { agentId = "", companyPrefix, tab } = useParams<{ agentId: string; companyPrefix?: string; tab: string }>();
  const { companies, selectedCompanyId } = useCompany();
  const companyId = companies.find(company => company.issuePrefix.toUpperCase() === companyPrefix?.toUpperCase())?.id ?? selectedCompanyId;
  const { data: agent, isLoading, error } = useQuery({
    queryKey: [...queryKeys.agents.detail(agentId), companyId ?? null],
    queryFn: () => agentsApi.get(agentId, companyId ?? undefined),
    enabled: Boolean(agentId && companyId),
  });
  const { slots, isLoading: slotsLoading, errorMessage } = usePluginSlots({ slotTypes: ["detailTab"], entityType: "agent", companyId: agent?.companyId, enabled: Boolean(agent) });
  const slot = slots.find(item => `plugin:${item.pluginKey}:${item.id}` === tab);
  const { setBreadcrumbs } = useBreadcrumbs();
  useEffect(() => {
    setBreadcrumbs([
      { label: "Agents", href: "/agents" },
      { label: agent?.name ?? agentId, href: `/agents/${encodeURIComponent(agentId)}/overview` },
      { label: slot?.displayName ?? "Plugin view" },
    ]);
  }, [setBreadcrumbs, agent?.name, agentId, slot?.displayName]);
  if (error) return <p role="alert">Agent unavailable</p>;
  if (!agent || isLoading || slotsLoading) return <p role="status">Loading agent view…</p>;
  return <div className="mx-auto max-w-5xl space-y-4">
    <Link to={`/agents/${encodeURIComponent(agentId)}/overview`} className="text-sm text-muted-foreground">{agent.name}</Link>
    {slot ? <PluginSlotMount slot={slot} context={{ companyId: agent.companyId, companyPrefix: companyPrefix ?? null, entityId: agent.id, entityType: "agent" }} missingBehavior="placeholder" />
      : <p role="status">{errorMessage ? "Agent view unavailable" : "This plugin view is unavailable"}</p>}
  </div>;
}
