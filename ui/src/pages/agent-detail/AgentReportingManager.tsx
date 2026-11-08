import { Pencil, UserRound } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { QueryErrorState, useQueryView } from "@/components/QueryView";
import { ReportsToPicker } from "@/components/ReportsToPicker";
import { AgentIdentityChipContent, agentIdentityChipClass } from "@/components/agents/AgentIdentityChip";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { agentDetailHref } from "../agent-detail-navigation";

/** A manager cannot be the agent itself or any member of its reporting subtree. */
export function invalidManagerIds(agentId: string, agents: Agent[]): string[] {
  const invalid = new Set([agentId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const agent of agents) {
      if (agent.reportsTo && invalid.has(agent.reportsTo) && !invalid.has(agent.id)) {
        invalid.add(agent.id);
        changed = true;
      }
    }
  }
  return [...invalid];
}

export function AgentReportingManager({ agent }: { agent: Agent }) {
  const client = useQueryClient();
  const directory = useQuery({
    queryKey: queryKeys.agents.list(agent.companyId),
    queryFn: () => agentsApi.list(agent.companyId),
  });
  const directoryView = useQueryView(directory);
  const update = useMutation({
    mutationFn: (reportsTo: string | null) => agentsApi.update(agent.id, { reportsTo }, agent.companyId),
    onSuccess: () => client.invalidateQueries({ queryKey: ["agents"] }),
  });
  const agents = directory.data ?? [];
  const manager = agents.find((candidate) => candidate.id === agent.reportsTo);
  const disabled = !directory.data || directoryView.kind === "error" || update.isPending;
  return <div className="flex flex-col gap-1.5 px-(--agent-detail-module-inset) py-1.5 text-sm">
    <span className="text-muted-foreground">Reports to:</span>
    <div className="flex items-center gap-1.5">
      {manager ? <Link to={agentDetailHref(agentRouteRef(manager))} className={`${agentIdentityChipClass} no-underline`}>
        <AgentIdentityChipContent agent={manager} />
      </Link> : null}
      <ReportsToPicker
        agents={agents}
        value={agent.reportsTo}
        onChange={(id) => update.mutate(id)}
        disabled={disabled}
        disabledAgentIds={invalidManagerIds(agent.id, agents)}
        trigger={<button type="button" disabled={disabled} aria-label={manager ? "Change manager" : "Choose manager"}
          className={`${manager ? "agent-identity-chip inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-accent hover:text-foreground transition-colors" : agentIdentityChipClass} disabled:cursor-not-allowed disabled:opacity-50`}>
          {manager ? <Pencil className="size-3.5" aria-hidden /> : <><UserRound className="size-5 text-muted-foreground" aria-hidden /><span>{agent.reportsTo ? "Manager unavailable" : "No manager"}</span></>}
        </button>}
      />
    </div>
    {directoryView.kind === "error" ? <QueryErrorState error={directoryView.error} size="inline" action="load agents" onRetry={directoryView.retry} retrying={directoryView.isFetching} /> : null}
    {update.error ? <QueryErrorState error={update.error} size="inline" action="change manager" /> : null}
  </div>;
}
