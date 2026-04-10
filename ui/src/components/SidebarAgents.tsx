import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, useLocation } from "@/lib/router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, CornerDownRight, Plus } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { queryKeys } from "../lib/queryKeys";
import { cn, agentRouteRef, agentUrl } from "../lib/utils";
import { useAgentOrder } from "../hooks/useAgentOrder";
import {
  buildSidebarAgentTree,
  collectExpandableSidebarAgentIds,
  normalizeExpandedSidebarAgentIds,
  type SidebarAgentTreeNode,
} from "../lib/sidebar-agent-tree";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type { Agent } from "@paperclipai/shared";

const SIDEBAR_AGENT_TREE_STORAGE_PREFIX = "paperclip.sidebarAgentTree";

function getSidebarAgentTreeStorageKey(companyId: string) {
  return `${SIDEBAR_AGENT_TREE_STORAGE_PREFIX}:${companyId}`;
}

function readExpandedSidebarAgentIds(storageKey: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

function writeExpandedSidebarAgentIds(storageKey: string, expandedIds: string[]) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(expandedIds));
  } catch {
    // Ignore storage failures in restricted browser contexts.
  }
}

type SidebarAgentTreeListProps = {
  nodes: SidebarAgentTreeNode[];
  depth?: number;
  activeAgentId: string | null;
  activeTab: string | null;
  isMobile: boolean;
  onNavigate: () => void;
  liveCountByAgent: Map<string, number>;
  expandedAgentIds: Set<string>;
  onToggleExpanded: (agentId: string) => void;
};

function SidebarAgentTreeList({
  nodes,
  depth = 0,
  activeAgentId,
  activeTab,
  isMobile,
  onNavigate,
  liveCountByAgent,
  expandedAgentIds,
  onToggleExpanded,
}: SidebarAgentTreeListProps) {
  return (
    <>
      {nodes.map((node) => (
        <SidebarAgentTreeItem
          key={node.agent.id}
          node={node}
          depth={depth}
          activeAgentId={activeAgentId}
          activeTab={activeTab}
          isMobile={isMobile}
          onNavigate={onNavigate}
          liveCountByAgent={liveCountByAgent}
          expandedAgentIds={expandedAgentIds}
          onToggleExpanded={onToggleExpanded}
        />
      ))}
    </>
  );
}

type SidebarAgentTreeItemProps = Omit<SidebarAgentTreeListProps, "nodes" | "depth"> & {
  node: SidebarAgentTreeNode;
  depth: number;
};

function SidebarAgentTreeItem({
  node,
  depth,
  activeAgentId,
  activeTab,
  isMobile,
  onNavigate,
  liveCountByAgent,
  expandedAgentIds,
  onToggleExpanded,
}: SidebarAgentTreeItemProps) {
  const { agent, children } = node;
  const hasChildren = children.length > 0;
  const expanded = hasChildren && expandedAgentIds.has(agent.id);
  const runCount = liveCountByAgent.get(agent.id) ?? 0;

  return (
    <>
      <div
        className={cn(
          "flex items-center gap-2.5 pl-3 text-[13px] font-medium transition-colors",
          activeAgentId === agentRouteRef(agent)
            ? "bg-accent text-foreground"
            : "text-foreground/80 hover:bg-accent/50 hover:text-foreground"
        )}
        style={{ paddingLeft: `${depth * 14 + 12}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={expanded ? `Collapse ${agent.name}` : `Expand ${agent.name}`}
            aria-expanded={expanded}
            className="flex h-3.5 w-3.5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground/60 hover:bg-accent/60 hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpanded(agent.id);
            }}
          >
            <ChevronRight className={cn("h-3 w-3 transition-transform", expanded && "rotate-90")} />
          </button>
        ) : depth > 0 ? (
          <span className="flex h-3.5 w-3.5 items-center justify-center text-muted-foreground/35">
            <CornerDownRight className="h-3 w-3" />
          </span>
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" />
        )}
        <NavLink
          to={activeTab ? `${agentUrl(agent)}/${activeTab}` : agentUrl(agent)}
          onClick={() => {
            if (isMobile) onNavigate();
          }}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-3"
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
      </div>
      {hasChildren && expanded ? (
        <SidebarAgentTreeList
          nodes={children}
          depth={depth + 1}
          activeAgentId={activeAgentId}
          activeTab={activeTab}
          isMobile={isMobile}
          onNavigate={onNavigate}
          liveCountByAgent={liveCountByAgent}
          expandedAgentIds={expandedAgentIds}
          onToggleExpanded={onToggleExpanded}
        />
      ) : null}
    </>
  );
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
  const treeAgents = useMemo(() => buildSidebarAgentTree(orderedAgents), [orderedAgents]);
  const expandableAgentIds = useMemo(
    () => collectExpandableSidebarAgentIds(treeAgents),
    [treeAgents],
  );

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;
  const storageKey = selectedCompanyId ? getSidebarAgentTreeStorageKey(selectedCompanyId) : null;
  const [expandedAgentIds, setExpandedAgentIds] = useState<string[]>([]);

  useEffect(() => {
    const baseExpandedIds = storageKey
      ? readExpandedSidebarAgentIds(storageKey)
      : expandableAgentIds;
    const seededExpandedIds = baseExpandedIds.length > 0 ? baseExpandedIds : expandableAgentIds;
    const nextExpandedIds = normalizeExpandedSidebarAgentIds(
      treeAgents,
      seededExpandedIds,
      activeAgentId,
    );

    setExpandedAgentIds((current) => {
      if (
        current.length === nextExpandedIds.length &&
        current.every((id, index) => id === nextExpandedIds[index])
      ) {
        return current;
      }
      return nextExpandedIds;
    });
  }, [activeAgentId, expandableAgentIds, storageKey, treeAgents]);

  const expandedAgentIdSet = useMemo(() => new Set(expandedAgentIds), [expandedAgentIds]);

  const toggleExpandedAgent = useCallback((agentId: string) => {
    const nextExpandedIds = normalizeExpandedSidebarAgentIds(
      treeAgents,
      expandedAgentIds.includes(agentId)
        ? expandedAgentIds.filter((id) => id !== agentId)
        : [...expandedAgentIds, agentId],
      activeAgentId,
    );

    setExpandedAgentIds(nextExpandedIds);
    if (storageKey) {
      writeExpandedSidebarAgentIds(storageKey, nextExpandedIds);
    }
  }, [activeAgentId, expandedAgentIds, storageKey, treeAgents]);

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
          <SidebarAgentTreeList
            nodes={treeAgents}
            activeAgentId={activeAgentId}
            activeTab={activeTab}
            isMobile={isMobile}
            onNavigate={() => setSidebarOpen(false)}
            liveCountByAgent={liveCountByAgent}
            expandedAgentIds={expandedAgentIdSet}
            onToggleExpanded={toggleExpandedAgent}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
