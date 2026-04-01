import { useMemo, useRef, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronRight, Eye, Pause, Play, Plus, ToggleLeft, ToggleRight } from "lucide-react";
import { AGENT_PAUSABLE_STATUSES, AGENT_ACTIONABLE_STATUSES } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { useAgentStatusMutations } from "../hooks/useAgentStatusMutations";
import { cn, agentRouteRef, agentUrl } from "../lib/utils";
import { useAgentOrder } from "../hooks/useAgentOrder";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Agent } from "@paperclipai/shared";

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

export function SidebarAgents() {
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem("paperclip:sidebar-agents-open") !== "false";
    } catch {
      return true;
    }
  });
  const [showPaused, setShowPaused] = useState(() => {
    try {
      return localStorage.getItem("paperclip:sidebar-show-paused") !== "false";
    } catch {
      return true;
    }
  });
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
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

  // Single-pass partition of non-terminated agents into active, paused, and toggleable lists.
  const { activeAgents, pausedAgents, toggleableAgents } = useMemo(() => {
    const sorted = sortByHierarchy(
      (agents ?? []).filter((a: Agent) => a.status !== "terminated"),
    );
    const active: Agent[] = [];
    const paused: Agent[] = [];
    const toggleable: Agent[] = [];
    for (const a of sorted) {
      if (a.status === "paused") {
        paused.push(a);
        toggleable.push(a);
      } else {
        active.push(a);
        if (AGENT_PAUSABLE_STATUSES.has(a.status)) {
          toggleable.push(a);
        }
      }
    }
    return { activeAgents: active, pausedAgents: paused, toggleableAgents: toggleable };
  }, [agents]);
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedAgents } = useAgentOrder({
    agents: activeAgents,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });

  const allPaused = toggleableAgents.length > 0 && toggleableAgents.every((a) => a.status === "paused");

  // Keep a ref so bulk mutation always reads the latest snapshot.
  const toggleableRef = useRef(toggleableAgents);
  toggleableRef.current = toggleableAgents;
  const allPausedRef = useRef(allPaused);
  allPausedRef.current = allPaused;

  const { pauseAgent, resumeAgent, invalidate, onError: onMutationError } = useAgentStatusMutations({
    companyId: selectedCompanyId!,
  });

  const bulkToggle = useMutation({
    mutationFn: async () => {
      const currentAllPaused = allPausedRef.current;
      const currentToggleable = toggleableRef.current;
      const targets = currentToggleable.filter((a) =>
        currentAllPaused ? a.status === "paused" : AGENT_PAUSABLE_STATUSES.has(a.status),
      );
      const action = currentAllPaused ? agentsApi.resume : agentsApi.pause;
      const results = await Promise.allSettled(
        targets.map((a) => action(a.id, selectedCompanyId!)),
      );
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        const succeeded = results.length - failures.length;
        throw new Error(
          `${failures.length} of ${results.length} agents failed to ${currentAllPaused ? "resume" : "pause"}` +
            (succeeded > 0 ? ` (${succeeded} succeeded)` : ""),
        );
      }
    },
    onSuccess: invalidate,
    onError: onMutationError,
  });

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;

  const renderAgentRow = (agent: Agent, dimmed = false) => {
    const runCount = liveCountByAgent.get(agent.id) ?? 0;
    const isPaused = agent.status === "paused";
    const canToggle = AGENT_ACTIONABLE_STATUSES.has(agent.status);

    return (
      <div key={agent.id} className="flex items-center">
        <NavLink
          to={activeTab ? `${agentUrl(agent)}/${activeTab}` : agentUrl(agent)}
          onClick={() => {
            if (isMobile) setSidebarOpen(false);
          }}
          className={cn(
            "flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors flex-1 min-w-0",
            activeAgentId === agentRouteRef(agent)
              ? "bg-accent text-foreground"
              : dimmed
                ? "text-muted-foreground/60 hover:bg-accent/50 hover:text-foreground"
                : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
          )}
        >
          <AgentIcon
            icon={agent.icon}
            className={cn("shrink-0 h-3.5 w-3.5", dimmed ? "text-muted-foreground/40" : "text-muted-foreground")}
          />
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
        {canToggle && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (isPaused) {
                    resumeAgent.mutate(agent.id);
                  } else {
                    pauseAgent.mutate(agent.id);
                  }
                }}
                disabled={pauseAgent.isPending || resumeAgent.isPending}
                className={cn(
                  "flex items-center justify-center h-5 w-5 mr-1.5 rounded shrink-0 transition-colors",
                  isPaused
                    ? "text-orange-500 hover:text-orange-600 hover:bg-orange-100 dark:hover:bg-orange-500/20"
                    : "text-muted-foreground/40 hover:text-foreground hover:bg-accent/50",
                )}
                aria-label={isPaused ? `Resume ${agent.name}` : `Pause ${agent.name}`}
              >
                {isPaused ? <Play className="h-2.5 w-2.5" /> : <Pause className="h-2.5 w-2.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>{isPaused ? "Resume" : "Pause"}</p>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    );
  };

  return (
    <Collapsible open={open} onOpenChange={(v) => { setOpen(v); try { localStorage.setItem("paperclip:sidebar-agents-open", String(v)); } catch {} }}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 transition-transform opacity-0 group-hover:opacity-100",
                open && "rotate-90",
              )}
            />
            <span className="text-[10px] font-medium uppercase tracking-widest font-mono text-muted-foreground/60">
              Agents
            </span>
          </CollapsibleTrigger>
          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to="/agents"
                onClick={() => {
                  if (isMobile) setSidebarOpen(false);
                }}
                className="flex items-center justify-center h-4 w-4 rounded text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 transition-colors"
                aria-label="View all agents"
              >
                <Eye className="h-3 w-3" />
              </NavLink>
            </TooltipTrigger>
            <TooltipContent side="top">
              <p>View all agents</p>
            </TooltipContent>
          </Tooltip>
          {toggleableAgents.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    bulkToggle.mutate();
                  }}
                  disabled={bulkToggle.isPending}
                  className={cn(
                    "flex items-center justify-center h-4 w-4 rounded transition-colors",
                    allPaused
                      ? "text-orange-500 hover:text-orange-600 hover:bg-orange-100 dark:hover:bg-orange-500/20"
                      : "text-muted-foreground/60 hover:text-foreground hover:bg-accent/50",
                  )}
                  aria-label={allPaused ? "Resume all agents" : "Pause all agents"}
                >
                  {allPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>
                  {allPaused
                    ? "Resume all agents"
                    : `Pause all agents${pausedAgents.length > 0 ? ` (${pausedAgents.length} paused)` : ""}`}
                </p>
              </TooltipContent>
            </Tooltip>
          )}
          {pausedAgents.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowPaused((prev) => {
                      const next = !prev;
                      try { localStorage.setItem("paperclip:sidebar-show-paused", String(next)); } catch {}
                      return next;
                    });
                  }}
                  className={cn(
                    "flex items-center justify-center h-4 w-4 rounded transition-colors",
                    showPaused
                      ? "text-foreground/80 hover:text-foreground hover:bg-accent/50"
                      : "text-muted-foreground/60 hover:text-foreground hover:bg-accent/50",
                  )}
                  aria-label={showPaused ? "Hide paused agents" : "Show paused agents"}
                >
                  {showPaused ? <ToggleRight className="h-3 w-3" /> : <ToggleLeft className="h-3 w-3" />}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{showPaused ? "Hide paused" : `Show paused (${pausedAgents.length})`}</p>
              </TooltipContent>
            </Tooltip>
          )}
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
          {orderedAgents.map((agent: Agent) => renderAgentRow(agent))}
        </div>
        {showPaused && pausedAgents.length > 0 && (
          <div className="flex flex-col gap-0.5 mt-0.5">
            {pausedAgents.map((agent: Agent) => renderAgentRow(agent, true))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
