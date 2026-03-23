import { useMemo, useState } from "react";
import type { ComponentType } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Eye, EyeOff, PauseCircle, CircleSlash } from "lucide-react";

import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { useToast } from "../context/ToastContext";

import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";

import { queryKeys } from "../lib/queryKeys";
import { cn, agentRouteRef, agentUrl } from "../lib/utils";

import { useAgentFilters } from "../hooks/useAgentFilters";

import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

import type { Agent } from "@paperclipai/shared";

// Small tooltip-wrapped icon button used for the filter toolbar
function FilterButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
          disabled={disabled}
          className={cn(
            "flex items-center justify-center h-4 w-4 rounded transition-colors",
            className,
          )}
          aria-label={label}
        >
          <Icon className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** BFS sort: roots first (no reportsTo), then their direct reports, etc. */
function sortByHierarchy(agents: Agent[]): Agent[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const childrenOf = new Map<string | null, Agent[]>();
  for (const a of agents) {
    const parent = a.reportsTo && byId.has(a.reportsTo) ? a.reportsTo : null;
    const list = childrenOf.get(parent) ?? [];
    list.push(a);
    childrenOf.set(parent, list);
  }
  const sorted: Agent[] = [];
  const queue = childrenOf.get(null) ?? [];
  while (queue.length > 0) {
    const agent = queue.shift()!;
    sorted.push(agent);
    const children = childrenOf.get(agent.id);
    if (children) queue.push(...children);
  }
  return sorted;
}

const PAUSABLE_STATUSES = new Set(["active", "running", "idle"]);

function pauseAllClassName(isPending: boolean, pausableCount: number): string {
  if (isPending) return "text-muted-foreground/40 animate-pulse";
  if (pausableCount === 0) return "text-muted-foreground/30 cursor-not-allowed";
  return "text-muted-foreground/60 hover:text-foreground hover:bg-accent/50";
}

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const { filters, updateFilter } = useAgentFilters(selectedCompanyId);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 10_000,
  });

  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [liveRuns]);

  const pausableAgents = useMemo(
    () => (agents ?? []).filter((a: Agent) => PAUSABLE_STATUSES.has(a.status)),
    [agents],
  );

  const pauseAll = useMutation({
    mutationFn: (agentsToPause: Agent[]) => {
      if (!selectedCompanyId) return Promise.resolve([] as PromiseSettledResult<Agent>[]);
      return Promise.allSettled(
        agentsToPause.map((a) => agentsApi.pause(a.id, selectedCompanyId))
      );
    },
    onSuccess: (results) => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(selectedCompanyId) });
      }
      const failures = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );
      if (failures.length > 0) {
        console.error(`Failed to pause ${failures.length} agent(s)`, failures);
        pushToast({
          title: `Failed to pause ${failures.length} agent(s)`,
          tone: "error",
        });
      }
    },
  });

  const visibleAgents = useMemo(() => {
    const filtered = (agents ?? []).filter(
      (a: Agent) =>
        a.status !== "terminated" &&
        !(filters.hideIdle && a.status === "idle") &&
        !(filters.hidePaused && a.status === "paused")
    );
    return sortByHierarchy(filtered);
  }, [agents, filters.hideIdle, filters.hidePaused]);

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;


  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                open && "rotate-90"
              )}
            />
            <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
              Agents
            </span>
          </CollapsibleTrigger>
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <FilterButton
              icon={filters.hideIdle ? EyeOff : Eye}
              label={filters.hideIdle ? "Show idle agents" : "Hide idle agents"}
              onClick={() => updateFilter("hideIdle")}
              className={
                filters.hideIdle
                  ? "text-muted-foreground/80 hover:text-foreground"
                  : "text-muted-foreground/60 hover:text-foreground hover:bg-accent/50"
              }
            />
            <FilterButton
              icon={PauseCircle}
              label="Pause all agents"
              onClick={() => pauseAll.mutate(pausableAgents)}
              disabled={pauseAll.isPending || pausableAgents.length === 0}
              className={pauseAllClassName(pauseAll.isPending, pausableAgents.length)}
            />
            <FilterButton
              icon={CircleSlash}
              label={filters.hidePaused ? "Show paused agents" : "Hide paused agents"}
              onClick={() => updateFilter("hidePaused")}
              className={
                filters.hidePaused
                  ? "text-muted-foreground/80 hover:text-foreground"
                  : "text-muted-foreground/60 hover:text-foreground hover:bg-accent/50"
              }
            />
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              openNewAgent();
            }}
            className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
            aria-label="New agent"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
      </div>

      <CollapsibleContent>
        <div className="flex flex-col gap-0.5 mt-0.5">
          {visibleAgents.map((agent: Agent) => {
            const runCount = liveCountByAgent.get(agent.id) ?? 0;
            return (
              <NavLink
                key={agent.id}
                to={activeTab ? `${agentUrl(agent)}/${activeTab}` : agentUrl(agent)}
                onClick={() => {
                  if (isMobile) setSidebarOpen(false);
                }}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
                  activeAgentId === agentRouteRef(agent)
                    ? "bg-accent text-foreground"
                    : "text-foreground/80 hover:bg-accent/50 hover:text-foreground"
                )}
              >
                <AgentIcon icon={agent.icon} className="shrink-0 h-3.5 w-3.5 text-muted-foreground" />
                <span className="flex-1 truncate">{agent.name}</span>
                {(agent.pauseReason === "budget" || runCount > 0) && (
                  <span className="ml-auto flex items-center gap-1.5 shrink-0">
                    {agent.pauseReason === "budget" ? (
                      <BudgetSidebarMarker title="Agent paused by budget" />
                    ) : null}
                    {runCount > 0 ? (
                      <span className="relative flex h-2 w-2">
                        <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
                      </span>
                    ) : null}
                    {runCount > 0 ? (
                      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
                        {runCount} live
                      </span>
                    ) : null}
                  </span>
                )}
              </NavLink>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
