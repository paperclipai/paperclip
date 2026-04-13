/**
 * Agent Bar — horizontal strip below BreadcrumbBar on workspace routes.
 *
 * Shows available agents as icon chips with live-run indicators.
 * Clicking an agent opens chat with that agent pre-selected.
 * Includes a "Set Run" button to trigger an agent run on the current workspace.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useLocation } from "@/lib/router";
import { Play, Zap } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useWorkspace } from "../context/WorkspaceContext";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Agent } from "@paperclipai/shared";

export function AgentBar() {
  const { selected } = useWorkspace();
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const location = useLocation();

  const isWorkspaceRoute = /\/(workspace|terminal|plugins\/)/.test(location.pathname);
  if (!selected || !isWorkspaceRoute) return null;

  return <AgentBarInner companyId={selectedCompanyId} />;
}

function AgentBarInner({ companyId }: { companyId: string | null }) {
  const navigate = useNavigate();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(companyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!),
    enabled: !!companyId,
    refetchInterval: 10_000,
  });

  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [liveRuns]);

  const visibleAgents = useMemo(() => {
    return (agents ?? []).filter((a: Agent) => a.status !== "terminated");
  }, [agents]);

  if (visibleAgents.length === 0) return null;

  const openChatWithAgent = (agent: Agent) => {
    navigate(`/plugins/paperclip-chat?agent=${encodeURIComponent(agent.id)}`);
  };

  return (
    <div className="border-b border-border px-4 md:px-6 h-9 shrink-0 flex items-center gap-1 overflow-x-auto scrollbar-none">
      <span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/50 mr-1.5 shrink-0">
        Agents
      </span>
      <div className="flex items-center gap-1">
        {visibleAgents.map((agent) => {
          const runCount = liveCountByAgent.get(agent.id) ?? 0;
          return (
            <AgentChip
              key={agent.id}
              agent={agent}
              runCount={runCount}
              onClick={() => openChatWithAgent(agent)}
            />
          );
        })}
      </div>

      {/* Set Run button */}
      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium text-foreground/80 hover:bg-accent/60 hover:text-foreground transition-colors"
              onClick={() => navigate("/plugins/paperclip-chat")}
            >
              <Zap className="h-3 w-3" />
              Set Run
            </button>
          </TooltipTrigger>
          <TooltipContent>Start a new agent run on this workspace</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function AgentChip({ agent, runCount, onClick }: {
  agent: Agent;
  runCount: number;
  onClick: () => void;
}) {
  const isLive = runCount > 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={onClick}
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 rounded transition-colors shrink-0",
            isLive
              ? "bg-blue-500/10 text-blue-500 hover:bg-blue-500/20"
              : "text-muted-foreground/70 hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <AgentIcon icon={agent.icon} className="h-3.5 w-3.5" />
          <span className="text-[11px] font-medium max-w-[80px] truncate">{agent.name}</span>
          {isLive && (
            <span className="relative flex h-1.5 w-1.5 shrink-0">
              <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        {agent.name}
        {isLive ? ` — ${runCount} live run${runCount > 1 ? "s" : ""}` : " — Click to chat"}
      </TooltipContent>
    </Tooltip>
  );
}
