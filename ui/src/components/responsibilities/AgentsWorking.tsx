import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { AgentAvatar } from "@/components/AgentAvatar";
import { queryKeys } from "@/lib/queryKeys";
import { describeAgentWork, type AgentAtWork } from "@/lib/responsibilities";
import { cn } from "@/lib/utils";

const EMPTY: readonly Agent[] = [];

/** The company's agents, and a lookup by id (one shared query). */
export function useAgentDirectory(companyId: string | null | undefined) {
  const query = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? "__none__"),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const agents = query.data ?? EMPTY;
  const byId = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  return { agents, byId, query };
}

/**
 * The agents working under a responsibility, compact: avatars and names, or
 * a quiet "No agents on this yet". Nobody "runs" a responsibility; agents
 * hold its tasks, routines and projects.
 */
export function AgentsWorkingLabel({
  agentIds,
  agentsById,
  className,
}: {
  agentIds: readonly string[];
  agentsById: ReadonlyMap<string, Agent>;
  className?: string;
}) {
  if (agentIds.length === 0) {
    return <span className={cn("text-xs text-muted-foreground", className)}>No agents on this yet</span>;
  }
  const names = agentIds.map((id) => agentsById.get(id)?.name ?? "An agent");
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground", className)} aria-label={`Agents on this: ${names.join(", ")}`}>
      <span className="flex shrink-0 -space-x-1" aria-hidden="true">
        {agentIds.slice(0, 3).map((id) => (
          <AgentAvatar key={id} agent={agentsById.get(id) ?? { id }} name={agentsById.get(id)?.name} size={16} />
        ))}
      </span>
      <span className="truncate text-foreground" aria-hidden="true">{names.join(", ")}</span>
    </span>
  );
}

/** The agents at work under a responsibility, each with what they hold. */
export function AgentsAtWorkList({
  agents,
  agentsById,
}: {
  agents: readonly AgentAtWork[];
  agentsById: ReadonlyMap<string, Agent>;
}) {
  if (agents.length === 0) {
    return <span className="text-sm text-muted-foreground">No agent is working on this yet. Give one a task, a routine or a project below.</span>;
  }
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {agents.map((work) => {
        const agent = agentsById.get(work.agentId);
        return (
          <li key={work.agentId} className="flex items-center gap-1.5 text-sm">
            <AgentAvatar agent={agent ?? { id: work.agentId }} name={agent?.name} size={20} />
            <span className="text-foreground">{agent?.name ?? "An agent"}</span>
            <span className="text-xs text-muted-foreground">{describeAgentWork(work)}</span>
          </li>
        );
      })}
    </ul>
  );
}
