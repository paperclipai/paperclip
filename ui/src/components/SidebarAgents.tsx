import { useMemo, useState } from "react";
import { NavLink, useLocation, useNavigate } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus, LayoutGrid, List, MessageSquare } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, agentRouteRef, agentUrl } from "../lib/utils";
import { useAgentOrder } from "../hooks/useAgentOrder";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { getRoleLevel } from "../lib/role-icons";
import { DEPARTMENT_LABELS } from "@ironworksai/shared";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Agent } from "@ironworksai/shared";

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  const [grouped, setGrouped] = useState(false);
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const navigate = useNavigate();
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

  const visibleAgents = useMemo(() => {
    const filtered = (agents ?? []).filter(
      (a: Agent) => a.status !== "terminated"
    );
    return filtered;
  }, [agents]);
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedAgents } = useAgentOrder({
    agents: visibleAgents,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;

  // Group agents by department
  const departmentGroups = useMemo(() => {
    if (!grouped) return null;
    const groups = new Map<string, Agent[]>();
    for (const agent of orderedAgents) {
      const dept = (agent as unknown as Record<string, unknown>).department as string | null;
      const key = dept ?? "__other__";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(agent);
    }
    // Sort department keys: named departments first (alphabetical), then "Other"
    const sorted: Array<{ label: string; agents: Agent[] }> = [];
    const keys = [...groups.keys()].sort((a, b) => {
      if (a === "__other__") return 1;
      if (b === "__other__") return -1;
      return a.localeCompare(b);
    });
    for (const key of keys) {
      const label = key === "__other__" ? "OTHER" : ((DEPARTMENT_LABELS as Record<string, string>)[key] ?? key).toUpperCase();
      sorted.push({ label, agents: groups.get(key)! });
    }
    return sorted;
  }, [grouped, orderedAgents]);

  const hasDepartments = useMemo(() => {
    return orderedAgents.some((a) => (a as unknown as Record<string, unknown>).department);
  }, [orderedAgents]);

  function renderAgentLink(agent: Agent) {
    const runCount = liveCountByAgent.get(agent.id) ?? 0;
    const ref = agentRouteRef(agent);
    const isActive = activeAgentId === ref;
    return (
      <div
        key={agent.id}
        className={cn(
          "group/agent-link flex items-center gap-2.5 px-3 py-1.5 text-[13px] font-medium transition-colors",
          isActive
            ? "bg-accent text-foreground"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
        )}
      >
        <NavLink
          to={activeTab ? `${agentUrl(agent)}/${activeTab}` : agentUrl(agent)}
          onClick={() => {
            if (isMobile) setSidebarOpen(false);
          }}
          className="flex items-center gap-2.5 flex-1 min-w-0 no-underline text-inherit"
        >
          <AgentIcon
            icon={agent.icon}
            className={cn(
              "shrink-0 h-3.5 w-3.5",
              getRoleLevel(agent.role) === "executive"
                ? "text-amber-500 dark:text-amber-400"
                : getRoleLevel(agent.role) === "management"
                  ? "text-blue-500 dark:text-blue-400"
                  : "text-muted-foreground",
            )}
          />
          <span className="flex-1 truncate">{agent.name}</span>
        </NavLink>

        {/* Status indicators + chat button */}
        <span className="ml-auto flex items-center gap-1 shrink-0">
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
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (isMobile) setSidebarOpen(false);
              navigate(`${agentUrl(agent)}/chat`);
            }}
            title={`Chat with ${agent.name}`}
            aria-label={`Chat with ${agent.name}`}
            className={cn(
              "flex items-center justify-center h-4 w-4 rounded transition-colors",
              activeTab === "chat" && isActive
                ? "text-foreground/70 bg-accent/50"
                : "text-muted-foreground/0 group-hover/agent-link:text-muted-foreground/60 hover:!text-foreground hover:bg-accent/50",
            )}
          >
            <MessageSquare className="h-3 w-3" />
          </button>
        </span>
      </div>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="group">
        <div className="flex items-center px-3 py-1.5">
          <CollapsibleTrigger className="flex items-center gap-1 flex-1 min-w-0">
            <ChevronRight
              className={cn(
                "h-3 w-3 text-muted-foreground/60 transition-transform md:opacity-0 md:group-hover:opacity-100",
                open && "rotate-90"
              )}
            />
            <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Agents
            </span>
          </CollapsibleTrigger>
          <div className="flex items-center gap-1">
            {hasDepartments && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setGrouped(!grouped);
                }}
                className={cn(
                  "flex items-center justify-center h-4 w-4 rounded transition-colors",
                  grouped
                    ? "text-foreground/70 bg-accent/50"
                    : "text-muted-foreground/60 hover:text-foreground hover:bg-accent/50"
                )}
                aria-label={grouped ? "Show flat list" : "Group by department"}
                title={grouped ? "Show flat list" : "Group by department"}
              >
                {grouped ? <List className="h-3 w-3" /> : <LayoutGrid className="h-3 w-3" />}
              </button>
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
      </div>

      <CollapsibleContent>
        {grouped && departmentGroups ? (
          <div className="flex flex-col gap-0.5 mt-0.5">
            {departmentGroups.map((group) => (
              <div key={group.label}>
                <div className="px-5 pt-2 pb-0.5">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                    {group.label}
                  </span>
                </div>
                {group.agents.map(renderAgentLink)}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5 mt-0.5">
            {orderedAgents.map(renderAgentLink)}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
