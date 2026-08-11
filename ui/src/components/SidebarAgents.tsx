import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MoreHorizontal,
  Loader2,
  LogOut,
  PauseCircle,
  Pencil,
  PlayCircle,
  Plus,
  Star,
  Users,
  AlertTriangle,
} from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { useToastActions } from "../context/ToastContext";
import { agentsApi } from "../api/agents";
import { builtInAgentsApi, type BuiltInAgentStatus } from "../api/builtInAgents";
import { BuiltInLifecycleChip } from "./BuiltInAgentBadges";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { SIDEBAR_SCROLL_RESET_STATE } from "../lib/navigation-scroll";
import { queryKeys } from "../lib/queryKeys";
import { cn, agentRouteRef, agentUrl, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { useAgentOrder } from "../hooks/useAgentOrder";
import {
  isStarred,
  resourceMembershipState,
  starredResourceIds,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import {
  AGENT_SORT_MODE_UPDATED_EVENT,
  getAgentSortModeStorageKey,
  readAgentSortMode,
  type AgentSortModeUpdatedDetail,
  type AgentSidebarSortMode,
  writeAgentSortMode,
} from "../lib/agent-order";
import { AgentIcon } from "./AgentIconPicker";
import { BudgetSidebarMarker } from "./BudgetSidebarMarker";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarSection, type SidebarSectionRadioChoice } from "./SidebarSection";
import { StarToggle } from "./StarToggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Agent } from "@paperclipai/shared";

/**
 * When no agent is running, the sidebar falls back to showing at most this many
 * recently-active agents plus a "See all agents" link (IA Phase 5).
 */
const RECENT_AGENT_LIMIT = 3;
const LIVE_AGENT_LINGER_MS = 120_000;

const AGENT_SORT_CHOICES: SidebarSectionRadioChoice[] = [
  { value: "top", label: "Top" },
  { value: "alphabetical", label: "Alphabetical" },
  { value: "recent", label: "Recent" },
];

function agentTimestamp(agent: Agent, field: "lastHeartbeatAt" | "updatedAt" | "createdAt"): number {
  const raw = agent[field];
  if (!raw) return 0;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : 0;
}

function sortAgents(agents: Agent[], sortMode: AgentSidebarSortMode): Agent[] {
  if (sortMode === "top") return agents;
  const sorted = [...agents];
  if (sortMode === "alphabetical") {
    sorted.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
    return sorted;
  }
  sorted.sort((left, right) => {
    const heartbeatDiff = agentTimestamp(right, "lastHeartbeatAt") - agentTimestamp(left, "lastHeartbeatAt");
    if (heartbeatDiff !== 0) return heartbeatDiff;

    const updatedDiff = agentTimestamp(right, "updatedAt") - agentTimestamp(left, "updatedAt");
    if (updatedDiff !== 0) return updatedDiff;

    const createdDiff = agentTimestamp(right, "createdAt") - agentTimestamp(left, "createdAt");
    return createdDiff !== 0
      ? createdDiff
      : left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  return sorted;
}

// Sidebar star reveals with the agent row's own group, not the shared group.
const AGENT_STAR_ROW_REVEAL =
  "opacity-0 transition-opacity group-hover/agent:opacity-100 group-focus-within/agent:opacity-100";

function SidebarAgentItem({
  activeAgentId,
  activeTab,
  agent,
  disabled,
  isMobile,
  leaving,
  onLeaveAgent,
  onPauseResume,
  rail,
  runCount,
  setSidebarOpen,
  builtInStatus,
  starred = false,
  onToggleStar,
  starPending = false,
}: {
  activeAgentId: string | null;
  activeTab: string | null;
  agent: Agent;
  disabled: boolean;
  isMobile: boolean;
  leaving: boolean;
  onLeaveAgent: (agent: Agent) => void;
  onPauseResume: (agent: Agent, action: "pause" | "resume") => void;
  rail: boolean;
  runCount: number;
  setSidebarOpen: (open: boolean) => void;
  builtInStatus?: BuiltInAgentStatus;
  starred?: boolean;
  onToggleStar?: (agent: Agent, starred: boolean) => void;
  starPending?: boolean;
}) {
  const routeRef = agentRouteRef(agent);
  const href = activeTab ? `${agentUrl(agent)}/${activeTab}` : agentUrl(agent);
  const editHref = `${agentUrl(agent)}/configuration`;
  const isActive = activeAgentId === routeRef;
  const isPaused = agent.status === "paused";
  const isBudgetPaused = isPaused && agent.pauseReason === "budget";
  const hasInvalidOrgChain = agent.orgChainHealth?.status === "invalid_org_chain";
  const pauseResumeLabel = isPaused ? "Resume agent" : "Pause agent";
  const pauseResumeDisabled = disabled || agent.status === "pending_approval" || isBudgetPaused || (isPaused && hasInvalidOrgChain);
  const pauseResumeDisabledLabel = disabled
    ? "Updating..."
    : isBudgetPaused
      ? "Budget paused"
      : isPaused && hasInvalidOrgChain
        ? "Invalid org chain"
      : pauseResumeLabel;
  const showBuiltInLifecycle = builtInStatus === "needs_setup" || builtInStatus === "pending_approval";
  const trailingLabel = [
    showBuiltInLifecycle ? `Built-in agent ${builtInStatus.replace(/_/g, " ")}` : null,
    hasInvalidOrgChain ? "Invalid reporting chain" : null,
  ].filter(Boolean).join(", ") || undefined;

  // C11 (DECISION-SHEET.md): the row itself is a SidebarNavItem, so agent rows
  // share the nav-row chrome (type, active state, rail tooltip, live dot).
  const navItem = (
    <SidebarNavItem
      to={href}
      label={agent.name}
      iconNode={<AgentIcon icon={agent.icon} className="shrink-0 h-4 w-4" />}
      active={isActive}
      liveCount={runCount}
      labelClassName={showBuiltInLifecycle ? "min-w-(--sz-4_5rem) flex-initial" : undefined}
      className={cn(
        "min-w-0 flex-1",
        // Reserve room for the hover ⋯ menu; starred rows widen it for the
        // inline unstar star.
        starred && !isMobile ? "pr-14" : "pr-8",
      )}
      trailing={
        showBuiltInLifecycle || hasInvalidOrgChain ? (
          <span className="ml-1 flex shrink-0 items-center gap-1">
            {showBuiltInLifecycle ? <BuiltInLifecycleChip status={builtInStatus} compact /> : null}
            {hasInvalidOrgChain ? (
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Invalid reporting chain" />
            ) : null}
          </span>
        ) : undefined
      }
      trailingLabel={trailingLabel}
      liveAccessory={
        agent.pauseReason === "budget" ? <BudgetSidebarMarker title="Agent paused by budget" /> : undefined
      }
    />
  );

  // Rail: the star/menu overlays are hidden, so render the nav item bare (it
  // supplies its own rail tooltip) and let it fill the column like every other
  // rail row.
  if (rail) return navItem;

  return (
    <div className="group/agent relative flex items-center">
      {navItem}

      {starred && !isMobile && onToggleStar ? (
        // Desktop: quiet inline unstar, left of the ⋯ menu, revealed on hover/focus.
        <span className="absolute right-10 top-1/2 -translate-y-1/2">
          <StarToggle
            size="row"
            quiet
            starred
            pending={starPending}
            resourceName={agent.name}
            onToggle={() => onToggleStar(agent, false)}
            revealClassName={AGENT_STAR_ROW_REVEAL}
          />
        </span>
      ) : null}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              "absolute right-3 top-1/2 h-6 w-6 -translate-y-1/2 transition-opacity data-[state=open]:pointer-events-auto data-[state=open]:opacity-100",
              isMobile
                ? "opacity-100"
                : "pointer-events-none opacity-0 group-hover/agent:pointer-events-auto group-hover/agent:opacity-100 group-focus-within/agent:pointer-events-auto group-focus-within/agent:opacity-100",
            )}
            aria-label={`Open actions for ${agent.name}`}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {onToggleStar ? (
            <>
              <DropdownMenuItem
                onClick={() => {
                  if (starPending) return;
                  onToggleStar(agent, !starred);
                }}
                disabled={starPending}
              >
                {starPending ? (
                  <Loader2 className="size-4 motion-safe:animate-spin" />
                ) : (
                  <Star className={cn("size-4", starred && "fill-amber-500 text-amber-500")} />
                )}
                <span>{starred ? "Remove from starred" : "Star agent"}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem asChild>
            <Link
              to={editHref}
              onClick={() => {
                if (isMobile) setSidebarOpen(false);
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
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              if (leaving) return;
              onLeaveAgent(agent);
            }}
            disabled={leaving}
          >
            {leaving ? <Loader2 className="size-4 motion-safe:animate-spin" /> : <LogOut className="size-4" />}
            <span>{leaving ? "Leaving..." : "Leave agent"}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function SidebarAgents({ streamlined = false }: { streamlined?: boolean } = {}) {
  const [open, setOpen] = useState(true);
  const [pendingAgentIds, setPendingAgentIds] = useState<Set<string>>(() => new Set());
  const [liveLingerVersion, setLiveLingerVersion] = useState(0);
  const lastSeenLiveAtRef = useRef<Map<string, number>>(new Map());
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { openNewAgent } = useDialogActions();
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const { pushToast } = useToastActions();
  const location = useLocation();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: builtInAgents } = useQuery({
    queryKey: queryKeys.builtInAgents.list(selectedCompanyId!),
    queryFn: () => builtInAgentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const builtInStatusByAgentId = useMemo(() => {
    const map = new Map<string, BuiltInAgentStatus>();
    for (const entry of builtInAgents ?? []) {
      if (entry.agentId) map.set(entry.agentId, entry.status);
    }
    return map;
  }, [builtInAgents]);
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const membershipMutation = useResourceMembershipMutation(selectedCompanyId);

  const liveRunsQueryKey = queryKeys.liveRuns(selectedCompanyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!selectedCompanyId,
    // Event-sourced via LiveUpdatesProvider (issue 9627); no interval poll needed.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);

  const liveCountByAgent = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of liveRuns ?? []) {
      counts.set(run.agentId, (counts.get(run.agentId) ?? 0) + 1);
    }
    return counts;
  }, [liveRuns]);
  const liveAgentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [agentId, count] of liveCountByAgent) {
      if (count > 0) ids.add(agentId);
    }
    return ids;
  }, [liveCountByAgent]);

  const visibleAgents = useMemo(() => {
    const filtered = (agents ?? []).filter(
      (a: Agent) =>
        a.status !== "terminated" &&
        (
          !membershipsQuery.isSuccess ||
          resourceMembershipState(membershipsQuery.data, "agent", a.id) !== "left"
        )
    );
    return filtered;
  }, [agents, membershipsQuery.data, membershipsQuery.isSuccess]);
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const sortModeStorageKey = useMemo(() => {
    if (!selectedCompanyId) return null;
    return getAgentSortModeStorageKey(selectedCompanyId, currentUserId);
  }, [currentUserId, selectedCompanyId]);
  const [sortMode, setSortMode] = useState<AgentSidebarSortMode>(() => {
    if (!sortModeStorageKey) return "top";
    return readAgentSortMode(sortModeStorageKey);
  });
  const { orderedAgents } = useAgentOrder({
    agents: visibleAgents,
    companyId: selectedCompanyId,
    userId: currentUserId,
  });
  const sortedAgents = useMemo(
    () => sortAgents(orderedAgents, sortMode),
    [orderedAgents, sortMode],
  );
  const sortedAgentIdSet = useMemo(
    () => new Set(sortedAgents.map((agent: Agent) => agent.id)),
    [sortedAgents],
  );

  useEffect(() => {
    const now = Date.now();
    for (const agentId of liveAgentIds) {
      lastSeenLiveAtRef.current.set(agentId, now);
    }
    for (const agentId of lastSeenLiveAtRef.current.keys()) {
      if (!sortedAgentIdSet.has(agentId)) {
        lastSeenLiveAtRef.current.delete(agentId);
      }
    }
  }, [liveAgentIds, sortedAgentIdSet]);

  // IA Phase 5 (streamlined): if any agent has a live run, show only those
  // active agents. Agents that just stopped running linger briefly so clustered
  // run boundaries do not make rows pop out and the section does not immediately
  // swap to the recent fallback during short all-idle gaps. Otherwise fall back
  // to up to RECENT_AGENT_LIMIT agents. Either way a "See all agents" link is
  // shown so the full list is always reachable.
  // Classic mode (PAP-89, flag OFF) restores the show-all behavior.
  const runningAgents = useMemo(() => {
    const nowForLiveLinger = Date.now();
    const lastSeenLiveAtByAgent = lastSeenLiveAtRef.current;
    return sortedAgents.filter((agent: Agent) => {
      if ((liveCountByAgent.get(agent.id) ?? 0) > 0) return true;
      const lastSeenLiveAt = lastSeenLiveAtByAgent.get(agent.id);
      return lastSeenLiveAt !== undefined && nowForLiveLinger - lastSeenLiveAt <= LIVE_AGENT_LINGER_MS;
    });
  }, [liveCountByAgent, liveLingerVersion, sortedAgents]);
  const hasActiveAgents = runningAgents.length > 0;
  const displayedAgents = !streamlined
    ? sortedAgents
    : hasActiveAgents
      ? runningAgents
      : sortedAgents.slice(0, RECENT_AGENT_LIMIT);
  // Always expose "See all agents" whenever the displayed list is a subset of all
  // agents, so users never lose the entry point to the full list. In classic mode
  // every agent is already shown, so the link is unnecessary.
  const showSeeAllLink = streamlined && sortedAgents.length > 0;

  const agentMatch = location.pathname.match(/^\/(?:[^/]+\/)?agents\/([^/]+)(?:\/([^/]+))?/);
  const activeAgentId = agentMatch?.[1] ?? null;
  const activeTab = agentMatch?.[2] ?? null;

  useEffect(() => {
    if (!sortModeStorageKey) {
      setSortMode("top");
      return;
    }
    setSortMode(readAgentSortMode(sortModeStorageKey));
  }, [sortModeStorageKey]);

  useEffect(() => {
    if (!sortModeStorageKey) return;

    const onStorage = (event: StorageEvent) => {
      if (event.key !== sortModeStorageKey) return;
      setSortMode(readAgentSortMode(sortModeStorageKey));
    };
    const onCustomEvent = (event: Event) => {
      const detail = (event as CustomEvent<AgentSortModeUpdatedDetail>).detail;
      if (!detail || detail.storageKey !== sortModeStorageKey) return;
      setSortMode(detail.sortMode);
    };

    window.addEventListener("storage", onStorage);
    window.addEventListener(AGENT_SORT_MODE_UPDATED_EVENT, onCustomEvent);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(AGENT_SORT_MODE_UPDATED_EVENT, onCustomEvent);
    };
  }, [sortModeStorageKey]);

  useEffect(() => {
    if (!streamlined) return;

    const now = Date.now();
    let nextExpiryAt: number | null = null;
    for (const agent of sortedAgents) {
      if ((liveCountByAgent.get(agent.id) ?? 0) > 0) continue;
      const lastSeenLiveAt = lastSeenLiveAtRef.current.get(agent.id);
      if (lastSeenLiveAt === undefined) continue;
      const expiresAt = lastSeenLiveAt + LIVE_AGENT_LINGER_MS;
      if (expiresAt < now) continue;
      nextExpiryAt = nextExpiryAt === null ? expiresAt : Math.min(nextExpiryAt, expiresAt);
    }
    if (nextExpiryAt === null) return;

    const timeoutId = window.setTimeout(() => {
      setLiveLingerVersion((version) => version + 1);
    }, Math.max(0, nextExpiryAt - now + 1));

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [streamlined, sortedAgents, liveCountByAgent, liveLingerVersion]);

  const persistSortMode = useCallback(
    (value: string) => {
      const nextSortMode: AgentSidebarSortMode =
        value === "alphabetical" || value === "recent" ? value : "top";
      setSortMode(nextSortMode);
      if (sortModeStorageKey) {
        writeAgentSortMode(sortModeStorageKey, nextSortMode);
      }
    },
    [sortModeStorageKey],
  );

  const pauseResumeAgent = useMutation({
    mutationFn: ({ agent, action }: { agent: Agent; action: "pause" | "resume" }) =>
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

  const leaveAgent = useCallback(
    (agent: Agent) => membershipMutation.mutate({
      resourceType: "agent",
      resourceId: agent.id,
      resourceName: agent.name,
      state: "left",
    }),
    [membershipMutation],
  );
  const agentLeaving = useCallback(
    (agent: Agent) =>
      membershipMutation.isPending &&
      membershipMutation.variables?.resourceType === "agent" &&
      membershipMutation.variables.resourceId === agent.id,
    [membershipMutation.isPending, membershipMutation.variables],
  );

  const toggleStarAgent = useCallback(
    (agent: Agent, starred: boolean) => membershipMutation.mutate({
      resourceType: "agent",
      resourceId: agent.id,
      resourceName: agent.name,
      starred,
    }),
    [membershipMutation],
  );
  const agentStarPending = useCallback(
    (agent: Agent) =>
      membershipMutation.isPending &&
      membershipMutation.variables?.resourceType === "agent" &&
      membershipMutation.variables.resourceId === agent.id &&
      membershipMutation.variables.starred !== undefined,
    [membershipMutation.isPending, membershipMutation.variables],
  );

  // Starred agents pin to the top of the section (name order), and are deduped
  // out of the active/recent subset so no agent appears twice.
  const starredAgentIdSet = useMemo(
    () => new Set(starredResourceIds(membershipsQuery.data, "agent")),
    [membershipsQuery.data],
  );
  const starredAgents = useMemo(
    () => sortAgents(visibleAgents.filter((agent: Agent) => starredAgentIdSet.has(agent.id)), "alphabetical"),
    [visibleAgents, starredAgentIdSet],
  );
  const dedupedDisplayedAgents = useMemo(
    () => displayedAgents.filter((agent: Agent) => !starredAgentIdSet.has(agent.id)),
    [displayedAgents, starredAgentIdSet],
  );

  const renderAgentRow = (agent: Agent, isStarredRow: boolean) => (
    <SidebarAgentItem
      key={agent.id}
      activeAgentId={activeAgentId}
      activeTab={activeTab}
      agent={agent}
      disabled={pendingAgentIds.has(agent.id)}
      isMobile={isMobile}
      leaving={agentLeaving(agent)}
      onLeaveAgent={leaveAgent}
      onPauseResume={(targetAgent, action) => pauseResumeAgent.mutate({ agent: targetAgent, action })}
      rail={rail}
      runCount={liveCountByAgent.get(agent.id) ?? 0}
      setSidebarOpen={setSidebarOpen}
      builtInStatus={builtInStatusByAgentId.get(agent.id)}
      starred={isStarredRow || isStarred(membershipsQuery.data, "agent", agent.id)}
      onToggleStar={toggleStarAgent}
      starPending={agentStarPending(agent)}
    />
  );

  return (
    <SidebarSection
      label="Agents"
      collapsible={{ open, onOpenChange: setOpen }}
      headerAction={{
        ariaLabel: "New agent",
        icon: Plus,
        onClick: openNewAgent,
      }}
      menu={{
        ariaLabel: "Agents section actions",
        actions: [
          { type: "item", label: "Browse agents", icon: Users, href: "/agents/all" },
          { type: "separator" },
        ],
        radioLabel: "Agent sort",
        radioChoices: AGENT_SORT_CHOICES,
        radioValue: sortMode,
        onRadioValueChange: persistSortMode,
      }}
    >
      {starredAgents.map((agent: Agent) => renderAgentRow(agent, true))}
      {dedupedDisplayedAgents.map((agent: Agent) => renderAgentRow(agent, false))}
      {showSeeAllLink && (() => {
        // Deliberately NOT a SidebarNavItem: this is a quiet muted affordance
        // (plain Link) that must not adopt nav-row active-route highlighting.
        const seeAllLink = (
          <Link
            to="/agents/all"
            state={SIDEBAR_SCROLL_RESET_STATE}
            aria-label={rail ? "See all agents" : undefined}
            onClick={() => {
              if (isMobile) setSidebarOpen(false);
            }}
            className="flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            <Users className="shrink-0 h-4 w-4" />
            <span className={rail ? SIDEBAR_RAIL_HIDDEN_LABEL : undefined}>See all agents</span>
          </Link>
        );
        return rail ? (
          <Tooltip>
            <TooltipTrigger asChild>{seeAllLink}</TooltipTrigger>
            <TooltipContent side="right">See all agents</TooltipContent>
          </Tooltip>
        ) : (
          seeAllLink
        );
      })()}
    </SidebarSection>
  );
}
