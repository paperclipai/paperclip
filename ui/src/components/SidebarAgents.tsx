import { useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, agentRouteRef, agentUrl } from "../lib/utils";
import { AgentIcon } from "./AgentIconPicker";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Agent, Project } from "@paperclipai/shared";

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

function AgentNavItem({
  agent,
  runCount,
  activeAgentId,
  isMobile,
  setSidebarOpen,
  indent,
}: {
  agent: Agent;
  runCount: number;
  activeAgentId: string | null;
  isMobile: boolean;
  setSidebarOpen: (open: boolean) => void;
  indent?: boolean;
}) {
  return (
    <NavLink
      to={agentUrl(agent)}
      onClick={() => {
        if (isMobile) setSidebarOpen(false);
      }}
      className={cn(
        "flex items-center gap-2.5 py-1.5 text-[13px] font-medium transition-colors",
        indent ? "px-5" : "px-3",
        activeAgentId === agentRouteRef(agent)
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground"
      )}
    >
      <AgentIcon icon={agent.icon} className="shrink-0 h-3.5 w-3.5 text-muted-foreground" />
      <span className="flex-1 truncate">{agent.name}</span>
      {runCount > 0 && (
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
          <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">
            {runCount} live
          </span>
        </span>
      )}
    </NavLink>
  );
}

interface ProjectGroup {
  project: Project;
  agents: Agent[];
}

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialog();
  const { isMobile, setSidebarOpen } = useSidebar();
  const location = useLocation();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
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

  const visibleAgents = useMemo(() => {
    const filtered = (agents ?? []).filter(
      (a: Agent) => a.status !== "terminated"
    );
    return sortByHierarchy(filtered);
  }, [agents]);

  const { pinnedAgents, projectGroups, ungroupedAgents } = useMemo(() => {
    const pinned = visibleAgents.filter((a) => a.role === "ceo");
    const visibleProjects = (projects ?? []).filter((p: Project) => !p.archivedAt);
    const groups: ProjectGroup[] = [];
    const pinnedAgentIds = new Set(pinned.map((a) => a.id));
    const assignedAgentIds = new Set<string>(pinnedAgentIds);
    const remainingAgents = visibleAgents.filter((a) => !pinnedAgentIds.has(a.id));

    for (const project of visibleProjects) {
      const projectAgentIds = new Set(project.agentIds ?? []);
      const projectAgents = remainingAgents.filter((a) => projectAgentIds.has(a.id));
      if (projectAgents.length > 0) {
        groups.push({ project, agents: projectAgents });
        for (const a of projectAgents) assignedAgentIds.add(a.id);
      }
    }

    const ungrouped = remainingAgents.filter((a) => !assignedAgentIds.has(a.id));
    return { pinnedAgents: pinned, projectGroups: groups, ungroupedAgents: ungrouped };
  }, [visibleAgents, projects]);

  const hasGroups = projectGroups.length > 0;

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)/);
  const activeAgentId = agentMatch?.[1] ?? null;

  // Track open state for each project group
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (projectId: string) => {
    setOpenGroups((prev) => ({ ...prev, [projectId]: !(prev[projectId] ?? true) }));
  };

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
          {pinnedAgents.map((agent: Agent) => (
            <AgentNavItem
              key={agent.id}
              agent={agent}
              runCount={liveCountByAgent.get(agent.id) ?? 0}
              activeAgentId={activeAgentId}
              isMobile={isMobile}
              setSidebarOpen={setSidebarOpen}
            />
          ))}

          {/* Project groups */}
          {projectGroups.map(({ project, agents: groupAgents }) => {
            const isGroupOpen = openGroups[project.id] ?? true;
            return (
              <Collapsible
                key={project.id}
                open={isGroupOpen}
                onOpenChange={() => toggleGroup(project.id)}
              >
                <CollapsibleTrigger className="flex items-center gap-2 px-3 py-1 w-full text-left hover:bg-accent/30 transition-colors">
                  <ChevronRight
                    className={cn(
                      "h-2.5 w-2.5 text-muted-foreground/60 transition-transform",
                      isGroupOpen && "rotate-90"
                    )}
                  />
                  <span
                    className="shrink-0 h-2.5 w-2.5 rounded-sm"
                    style={{ backgroundColor: project.color ?? "#6366f1" }}
                  />
                  <span className="text-[11px] font-medium text-muted-foreground truncate">
                    {project.name}
                  </span>
                  <span className="text-[10px] text-muted-foreground/50 ml-auto shrink-0">
                    {groupAgents.length}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  {groupAgents.map((agent) => (
                    <AgentNavItem
                      key={agent.id}
                      agent={agent}
                      runCount={liveCountByAgent.get(agent.id) ?? 0}
                      activeAgentId={activeAgentId}
                      isMobile={isMobile}
                      setSidebarOpen={setSidebarOpen}
                      indent
                    />
                  ))}
                </CollapsibleContent>
              </Collapsible>
            );
          })}

          {/* Ungrouped agents */}
          {ungroupedAgents.map((agent: Agent) => (
            <AgentNavItem
              key={agent.id}
              agent={agent}
              runCount={liveCountByAgent.get(agent.id) ?? 0}
              activeAgentId={activeAgentId}
              isMobile={isMobile}
              setSidebarOpen={setSidebarOpen}
              indent={hasGroups}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
