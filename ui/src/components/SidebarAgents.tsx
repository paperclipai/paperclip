import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, NavLink, useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  CornerDownRight,
  MoreHorizontal,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { useToastActions } from "../context/ToastContext";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
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
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Agent } from "@paperclipai/shared";

type AgentPauseAction = "pause" | "resume";

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
  pendingAgentIds: Set<string>;
  onPauseResume: (agent: Agent, action: AgentPauseAction) => void;
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
  pendingAgentIds,
  onPauseResume,
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
          pendingAgentIds={pendingAgentIds}
          onPauseResume={onPauseResume}
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
  pendingAgentIds,
  onPauseResume,
}: SidebarAgentTreeItemProps) {
  const { agent, children } = node;
  const hasChildren = children.length > 0;
  const expanded = hasChildren && expandedAgentIds.has(agent.id);
  const runCount = liveCountByAgent.get(agent.id) ?? 0;
  const editHref = `${agentUrl(agent)}/configuration`;
  const disabled = pendingAgentIds.has(agent.id);
  const isPaused = agent.status === "paused";
  const isBudgetPaused = isPaused && agent.pauseReason === "budget";
  const pauseResumeLabel = isPaused ? "Resume agent" : "Pause agent";
  const pauseResumeDisabled = disabled || agent.status === "pending_approval" || isBudgetPaused;
  const pauseResumeDisabledLabel = disabled
    ? "Updating..."
    : isBudgetPaused
      ? "Budget paused"
      : pauseResumeLabel;

  return (
    <>
      <div
        className={cn(
          "group/agent relative flex items-center gap-2.5 pl-3 text-[13px] font-medium transition-colors",
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
          state={SIDEBAR_SCROLL_RESET_STATE}
          onClick={() => {
            if (isMobile) onNavigate();
          }}
          className="flex min-w-0 flex-1 items-center gap-2.5 py-1.5 pr-8"
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

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                "absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 transition-opacity data-[state=open]:pointer-events-auto data-[state=open]:opacity-100",
                isMobile
                  ? "opacity-100"
                  : "pointer-events-none opacity-0 group-hover/agent:pointer-events-auto group-hover/agent:opacity-100 group-focus-within/agent:pointer-events-auto group-focus-within/agent:opacity-100",
              )}
              aria-label={`Open actions for ${agent.name}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem asChild>
              <Link
                to={editHref}
                onClick={() => {
                  if (isMobile) onNavigate();
                }}
              >
                <Pencil className="size-4" />
                <span>Edit agent</span>
              </Link>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                if (pauseResumeDisabled) return;
                onPauseResume(agent, isPaused ? "resume" : "pause");
              }}
              disabled={pauseResumeDisabled}
              title={isBudgetPaused ? "Agent was paused by budget limits" : undefined}
            >
              {isPaused ? <PlayCircle className="size-4" /> : <PauseCircle className="size-4" />}
              <span>{pauseResumeDisabledLabel}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
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
          pendingAgentIds={pendingAgentIds}
          onPauseResume={onPauseResume}
        />
      ) : null}
    </>
  );
}

export function SidebarAgents() {
  const [open, setOpen] = useState(true);
  const [pendingAgentIds, setPendingAgentIds] = useState<Set<string>>(() => new Set());
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialogActions();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { pushToast } = useToastActions();
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

  const pauseResumeAgent = useMutation({
    mutationFn: ({ agent, action }: { agent: Agent; action: AgentPauseAction }) =>
      action === "pause"
        ? agentsApi.pause(agent.id, selectedCompanyId ?? undefined)
        : agentsApi.resume(agent.id, selectedCompanyId ?? undefined),
    onMutate: ({ agent }) => {
      setPendingAgentIds((current) => {
        const next = new Set(current);
        next.add(agent.id);
        return next;
      });
    },
    onSuccess: async (_agent, { agent, action }) => {
      if (selectedCompanyId) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.liveRuns(selectedCompanyId) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) }),
        ]);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agent.id) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentRouteRef(agent)) }),
      ]);
      pushToast({
        title: action === "pause" ? "Agent paused" : "Agent resumed",
        body: agent.name,
        tone: "success",
      });
    },
    onError: (error, { agent, action }) => {
      pushToast({
        title: action === "pause" ? "Could not pause agent" : "Could not resume agent",
        body: error instanceof Error ? error.message : agent.name,
        tone: "error",
      });
    },
    onSettled: (_data, _error, { agent }) => {
      setPendingAgentIds((current) => {
        const next = new Set(current);
        next.delete(agent.id);
        return next;
      });
    },
  });

  const handlePauseResume = useCallback(
    (agent: Agent, action: AgentPauseAction) => {
      pauseResumeAgent.mutate({ agent, action });
    },
    [pauseResumeAgent],
  );

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
            pendingAgentIds={pendingAgentIds}
            onPauseResume={handlePauseResume}
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
