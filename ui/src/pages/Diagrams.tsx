import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { GitBranch } from "lucide-react";
import { heartbeatsApi } from "../api/heartbeats";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import PelergyDiagrams from "../components/PelergyDiagrams";
import type { AgentStatuses } from "../components/PelergyDiagrams";
import type { Agent } from "@paperclipai/shared";

function agentDotStatus(agent: Agent | undefined): AgentStatuses["felix"] {
  if (!agent) return "dead";
  if (agent.status === "active") return "ok";
  if (agent.status === "paused") return "warn";
  if (agent.status === "error") return "error";
  return "dead";
}

export function Diagrams() {
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();

  useEffect(() => {
    setBreadcrumbs([{ label: "Operations" }]);
  }, [setBreadcrumbs]);

  const { data: cronJobs } = useQuery({
    queryKey: ["instance", "openclaw-cron-jobs"],
    queryFn: () => heartbeatsApi.listOpenclawCronJobs(),
    refetchInterval: 30_000,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  const agentStatuses = useMemo<AgentStatuses>(() => {
    const felix = agents?.find((a) => a.name.toLowerCase().includes("felix"));
    const katya = agents?.find((a) => a.name.toLowerCase().includes("katya"));
    return {
      felix: agentDotStatus(felix),
      katya: agentDotStatus(katya),
    };
  }, [agents]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <GitBranch className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Operations</h1>
      </div>
      <PelergyDiagrams cronJobs={cronJobs} agentStatuses={agentStatuses} />
    </div>
  );
}
