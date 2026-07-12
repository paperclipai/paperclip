import { useMemo, useState, useRef, useCallback, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useVisibilityRefetchInterval } from "@/lib/polling";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import type { ActivityEvent, Agent } from "@paperclipai/shared";
import { activityApi } from "../api/activity";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { useCompany } from "../context/CompanyContext";
import { FeedCard } from "./FeedCard";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ListFilter, Layers, ChevronDown, ChevronRight, User, Settings } from "lucide-react";
import { AgentIcon } from "./AgentIconPicker";
import { timeAgo } from "../lib/timeAgo";

/* ------------------------------------------------------------------ */
/*  Event Tier Classification                                          */
/* ------------------------------------------------------------------ */

type EventTier = 1 | 2 | 3;

/** Tier 1 = cards (high weight), Tier 2 = one-liners, Tier 3 = hidden by default */
const ACTION_TIER: Record<string, EventTier> = {
  // Tier 1 — Cards
  "issue.created": 1,
  "issue.document_created": 1,
  "approval.created": 1,
  "approval.approved": 1,
  "approval.rejected": 1,
  "approval.revision_requested": 1,
  "agent.created": 1,

  "issue.work_product_created": 1,

  // Tier 2 — One-liners
  "issue.updated": 2,
  "issue.work_product_updated": 2,
  "issue.work_product_deleted": 2,
  "issue.checked_out": 2,
  "issue.comment_added": 2,
  "issue.commented": 2,
  "heartbeat.invoked": 2,
  "heartbeat.cancelled": 2,
  "agent.paused": 2,
  "agent.resumed": 2,
  "agent.updated": 2,

  // Tier 3 — Hidden
  "issue.read_marked": 3,
  "issue.read_unmarked": 3,
  "issue.inbox_archived": 3,
  "issue.inbox_unarchived": 3,
  "issue.released": 3,
  "issue.attachment_added": 3,
  "issue.attachment_removed": 3,
  "issue.document_deleted": 3,
  "issue.document_updated": 2,
  "issue.deleted": 3,
  "issue.feedback_vote_saved": 3,
  "agent.key_created": 3,
  "agent.budget_updated": 3,
  "agent.runtime_session_reset": 3,
  "agent.skills_synced": 3,
  "agent.terminated": 2,
  "approval.requester_wakeup_queued": 3,
  "approval.requester_wakeup_failed": 3,
  "company.created": 3,
  "company.updated": 3,
  "company.archived": 3,
  "company.budget_updated": 3,
  "company.skill_created": 3,
  "company.skill_deleted": 3,
  "project.created": 2,
  "project.updated": 3,
  "project.deleted": 3,
  "goal.created": 2,
  "goal.updated": 3,
  "goal.deleted": 3,
  "cost.reported": 3,
  "cost.recorded": 3,
};

function getEventTier(event: ActivityEvent): EventTier {
  // Special case: issue.updated with status → in_review is tier 1
  if (event.action === "issue.updated" && event.details) {
    const details = event.details as Record<string, unknown>;
    if (details.status === "in_review") return 1;
  }
  return ACTION_TIER[event.action] ?? 3;
}

/* ------------------------------------------------------------------ */
/*  Filter & Group Types                                               */
/* ------------------------------------------------------------------ */

type FilterValue = "all" | "in-progress" | "for-review" | "completed";
type GroupMode = "flat" | "by-task";

const FILTER_OPTIONS: Array<{ value: FilterValue; label: string }> = [
  { value: "all", label: "All" },
  { value: "in-progress", label: "In Progress" },
  { value: "for-review", label: "In Review" },
  { value: "completed", label: "Done" },
];

const FILTER_ACTIONS: Record<FilterValue, Set<string> | null> = {
  all: null,
  "in-progress": new Set(["issue.created", "issue.checked_out", "heartbeat.invoked"]),
  "for-review": new Set(["approval.created", "issue.document_created", "issue.document_updated"]),
  completed: new Set(["approval.approved"]),
};

const STATUS_FILTER_MAP: Record<FilterValue, Set<string> | null> = {
  all: null,
  "in-progress": new Set(["in_progress"]),
  "for-review": new Set(["in_review"]),
  completed: new Set(["done"]),
};

function matchesFilter(event: ActivityEvent, filter: FilterValue): boolean {
  if (filter === "all") return true;
  const actions = FILTER_ACTIONS[filter];
  if (actions?.has(event.action)) return true;
  if (event.action === "issue.updated" && event.details) {
    const statusSet = STATUS_FILTER_MAP[filter];
    const details = event.details as Record<string, unknown>;
    if (statusSet && typeof details.status === "string" && statusSet.has(details.status)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Collapse Sequential Events                                         */
/* ------------------------------------------------------------------ */

interface CollapsedGroup {
  type: "collapsed";
  events: ActivityEvent[];
  entityId: string;
  entityType: string;
  latestEvent: ActivityEvent;
}

type FeedItem = ActivityEvent | CollapsedGroup;

const COLLAPSE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function collapseSequential(events: ActivityEvent[]): FeedItem[] {
  if (events.length === 0) return [];

  const result: FeedItem[] = [];
  let currentGroup: ActivityEvent[] = [events[0]];
  let currentKey = `${events[0].entityType}:${events[0].entityId}`;

  for (let i = 1; i < events.length; i++) {
    const evt = events[i];
    const key = `${evt.entityType}:${evt.entityId}`;
    const prevTime = new Date(currentGroup[currentGroup.length - 1].createdAt).getTime();
    const thisTime = new Date(evt.createdAt).getTime();
    const withinWindow = Math.abs(prevTime - thisTime) <= COLLAPSE_WINDOW_MS;

    // Only collapse tier-2 events, never collapse tier-1 cards
    const tier = getEventTier(evt);

    if (key === currentKey && withinWindow && tier >= 2) {
      currentGroup.push(evt);
    } else {
      flushGroup(currentGroup, result);
      currentGroup = [evt];
      currentKey = key;
    }
  }
  flushGroup(currentGroup, result);
  return result;
}

function flushGroup(group: ActivityEvent[], result: FeedItem[]) {
  if (group.length <= 2) {
    // Don't collapse 1-2 items
    for (const evt of group) result.push(evt);
  } else {
    result.push({
      type: "collapsed",
      events: group,
      entityId: group[0].entityId,
      entityType: group[0].entityType,
      latestEvent: group[0],
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Recency Helpers                                                    */
/* ------------------------------------------------------------------ */

const FIVE_MINUTES = 5 * 60 * 1000;

function isRecent(createdAt: Date | string): boolean {
  return Date.now() - new Date(createdAt).getTime() < FIVE_MINUTES;
}

/* ------------------------------------------------------------------ */
/*  Animation keyframes (injected once via style tag)                   */
/* ------------------------------------------------------------------ */

const FEED_ANIMATION_CSS = `
@keyframes feed-slide-in {
  from {
    opacity: 0;
    transform: translateY(-8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.feed-item-new {
  animation: feed-slide-in 300ms ease-out;
}
`;

const INITIAL_VISIBLE = 50;
const LOAD_MORE_COUNT = 30;

/* ------------------------------------------------------------------ */
/*  Collapsed Group Component                                          */
/* ------------------------------------------------------------------ */

function CollapsedFeedGroup({
  group,
  agentMap,
  entityNameMap,
  entityTitleMap,
}: {
  group: CollapsedGroup;
  agentMap: Map<string, Agent>;
  entityNameMap: Map<string, string>;
  entityTitleMap: Map<string, string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const actor = group.latestEvent.actorType === "agent"
    ? agentMap.get(group.latestEvent.actorId)
    : null;
  const actorName = actor?.name
    ?? (group.latestEvent.actorType === "system" ? "System"
      : group.latestEvent.actorType === "user" ? "Board"
      : "Unknown");
  const entityName = entityNameMap.get(`${group.entityType}:${group.entityId}`);

  return (
    <div>
      {/* design-allow(card-pattern): interactive <button> card; Card renders a div and would break button semantics (C5a Run 3) */}
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        data-fc="card"
        className={cn(
          "group ml-3 mr-3 md:ml-0 my-2 flex w-(--sz-calc-1) md:w-(--sz-calc-2) items-center gap-2 rounded-lg border bg-card p-(--sz-18px) text-left text-xs transition-(--tp-background-color-border-color) duration-150",
          "cursor-pointer hover:bg-accent hover:border-muted-foreground/30",
        )}
      >
        {expanded
          ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        }
        {group.latestEvent.actorType === "agent"
          ? <AgentIcon icon={actor?.icon ?? null} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          : group.latestEvent.actorType === "user"
            ? <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            : <Settings className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        }
        <span className="flex-1 min-w-0 truncate">
          <span data-fc="actor" className="font-medium text-(--hex-959596) group-hover:text-white">{actorName}</span>
          <span data-fc="verb" className="ml-1 text-(--hex-959596)">made {group.events.length} updates to</span>
          <span data-fc="title" className="ml-1 text-(--hex-959596) group-hover:text-white">{entityName ?? group.entityId}</span>
        </span>
        <span data-fc="time" className="text-muted-foreground shrink-0">
          {timeAgo(group.latestEvent.createdAt)}
        </span>
      </button>
      {expanded && (
        <div className="ml-8">
          {group.events.map((evt) => (
            <FeedCard
              key={evt.id}
              event={evt}
              agentMap={agentMap}
              entityNameMap={entityNameMap}
              entityTitleMap={entityTitleMap}
              isMuted
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

interface ActivityFeedProps {
  className?: string;
}

export function ActivityFeed({ className }: ActivityFeedProps) {
  const { selectedCompanyId } = useCompany();
  const [filter, setFilter] = useState<FilterValue>("all");
  const [groupMode, setGroupMode] = useState<GroupMode>("flat");
  const [showAllActivity, setShowAllActivity] = useState(false);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const seenIdsRef = useRef<Set<string>>(new Set());
  const initialLoadRef = useRef(true);

  // Inject animation CSS once
  useEffect(() => {
    const id = "feed-animation-styles";
    if (document.getElementById(id)) return;
    const style = document.createElement("style");
    style.id = id;
    style.textContent = FEED_ANIMATION_CSS;
    document.head.appendChild(style);
  }, []);

  // Fetch company-level activity. Poll ~5s when the tab is focused; slow/stop in the
  // background so restored tabs don't storm the activity endpoint (PAP-12556).
  const activityRefetchInterval = useVisibilityRefetchInterval({ visibleMs: 5000 });
  const activityQueryKey = queryKeys.activity(selectedCompanyId ?? "");
  const sharedActivity = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "activity",
    queryKey: activityQueryKey,
    enabled: !!selectedCompanyId,
    refetchInterval: activityRefetchInterval,
    leaderOnly: true,
  });
  const { data: activity, dataUpdatedAt: activityUpdatedAt } = useQuery({
    queryKey: activityQueryKey,
    queryFn: ({ signal }) => activityApi.list(selectedCompanyId!, undefined, { signal }),
    enabled: sharedActivity.enabled,
    refetchInterval: sharedActivity.refetchInterval,
  });
  usePublishSharedQueryData(sharedActivity, activity, activityUpdatedAt);

  // Fetch agents for name resolution + empty state
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId ?? ""),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Fetch issues for name resolution
  const { data: issues } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId ?? ""),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, Agent>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  const entityNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agents ?? []) map.set(`agent:${a.id}`, a.name);
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.identifier ?? i.id);
    return map;
  }, [agents, issues]);

  const entityTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.title);
    return map;
  }, [issues]);

  const entityStatusMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const i of issues ?? []) map.set(`issue:${i.id}`, i.status);
    return map;
  }, [issues]);

  // Filter, tier, sort events
  const processedItems = useMemo(() => {
    const events = (activity ?? [])
      .filter((evt) => {
        const tier = getEventTier(evt);
        if (!showAllActivity && tier === 3) return false;
        return matchesFilter(evt, filter);
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return collapseSequential(events);
  }, [activity, filter, showAllActivity]);

  const visibleItems = processedItems.slice(0, visibleCount);
  const hasMore = processedItems.length > visibleCount;

  // Track seen IDs for entrance animation
  useEffect(() => {
    if (!activity) return;
    if (initialLoadRef.current) {
      // On first load, mark all as seen (no animation for initial batch)
      for (const evt of activity) seenIdsRef.current.add(evt.id);
      initialLoadRef.current = false;
    }
  }, [activity]);

  const isNewItem = useCallback((id: string) => {
    if (initialLoadRef.current) return false;
    if (seenIdsRef.current.has(id)) return false;
    seenIdsRef.current.add(id);
    return true;
  }, []);

  // Reset visible count when filter changes
  useEffect(() => {
    setVisibleCount(INITIAL_VISIBLE);
  }, [filter]);

  // Load more on scroll to bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !hasMore) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 100) {
      setVisibleCount((prev) => prev + LOAD_MORE_COUNT);
    }
  }, [hasMore]);

  // Check for active heartbeat runs (recent invoked without cancelled)
  const activeHeartbeatEntityIds = useMemo(() => {
    const ids = new Set<string>();
    for (const evt of activity ?? []) {
      if (evt.action === "heartbeat.invoked" && isRecent(evt.createdAt)) {
        ids.add(evt.entityId);
      }
    }
    // Remove any that have been cancelled
    for (const evt of activity ?? []) {
      if (evt.action === "heartbeat.cancelled") {
        ids.delete(evt.entityId);
      }
    }
    return ids;
  }, [activity]);

  /* ---------------------------------------------------------------- */
  /*  Render helpers                                                   */
  /* ---------------------------------------------------------------- */

  const renderItem = (item: FeedItem, index: number, items: FeedItem[]) => {
    // Insert recency separator
    let separator: React.ReactNode = null;
    if (index > 0) {
      const prevCreatedAt = "type" in item
        ? item.latestEvent.createdAt
        : item.createdAt;
      const prevItem = items[index - 1];
      const prevPrevCreatedAt = "type" in prevItem
        ? prevItem.latestEvent.createdAt
        : prevItem.createdAt;

      const prevIsRecent = isRecent(prevPrevCreatedAt);
      const thisIsRecent = isRecent(prevCreatedAt);
      if (prevIsRecent && !thisIsRecent) {
        separator = (
          <div className="flex items-center gap-2 px-4 py-1.5" key={`sep-${index}`}>
            <div className="h-px flex-1 bg-border" />
            <span className="text-(length:--text-nano) font-medium text-muted-foreground uppercase tracking-wider">
              Earlier
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>
        );
      }
    }

    if ("type" in item && item.type === "collapsed") {
      const animClass = isNewItem(item.latestEvent.id) ? "feed-item-new" : "";
      return (
        <div key={`group-${item.latestEvent.id}`}>
          {separator}
          <div className={animClass}>
            <CollapsedFeedGroup
              group={item}
              agentMap={agentMap}
              entityNameMap={entityNameMap}
              entityTitleMap={entityTitleMap}
            />
          </div>
        </div>
      );
    }

    const evt = item as ActivityEvent;
    const tier = getEventTier(evt);
    const animClass = isNewItem(evt.id) ? "feed-item-new" : "";
    const isActiveHeartbeat = activeHeartbeatEntityIds.has(evt.entityId) && evt.action === "heartbeat.invoked";

    if (tier === 1) {
      return (
        <div key={evt.id}>
          {separator}
          <div className={animClass || undefined}>
            <FeedCard
              event={evt}
              agentMap={agentMap}
              entityNameMap={entityNameMap}
              entityTitleMap={entityTitleMap}
              entityStatusMap={entityStatusMap}
              isActive={isActiveHeartbeat}
            />
          </div>
        </div>
      );
    }

    // Tier 2 (and tier 3 if showAll)
    return (
      <div key={evt.id}>
        {separator}
        <div className={animClass || undefined}>
          <FeedCard
            event={evt}
            agentMap={agentMap}
            entityNameMap={entityNameMap}
            entityTitleMap={entityTitleMap}
            entityStatusMap={entityStatusMap}
            isActive={isActiveHeartbeat}
            isMuted
          />
        </div>
      </div>
    );
  };

  const renderGrouped = () => {
    // Group by issue entityId
    const groups = new Map<string, FeedItem[]>();
    for (const item of visibleItems) {
      const key = "type" in item ? item.entityId : (item.entityType === "issue" ? item.entityId : "__other__");
      const existing = groups.get(key) ?? [];
      existing.push(item);
      groups.set(key, existing);
    }

    return Array.from(groups.entries()).map(([groupKey, items]) => {
      const isOther = groupKey === "__other__";
      const issueName = entityNameMap.get(`issue:${groupKey}`);
      const issueTitle = entityTitleMap.get(`issue:${groupKey}`);
      const label = isOther
        ? "Other activity"
        : `${issueName ?? groupKey}${issueTitle ? ` — ${issueTitle}` : ""}`;

      return (
        <div key={groupKey} className="mb-2">
          <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b px-4 py-1.5">
            <p className="text-xs font-medium text-muted-foreground truncate">{label}</p>
          </div>
          {items.map((item, i) => renderItem(item, i, items))}
        </div>
      );
    });
  };

  /* ---------------------------------------------------------------- */
  /*  Empty state                                                      */
  /* ---------------------------------------------------------------- */

  const emptyMessage = useMemo(() => {
    if (!agents) return null;
    if (agents.length === 0) {
      return {
        text: "No agents set up yet. Add an agent to get started.",
        showPulse: false,
      };
    }
    const allPaused = agents.every((a) => a.status === "paused");
    if (allPaused) {
      return {
        text: "All agents are paused. Resume agents from the sidebar to see activity.",
        showPulse: false,
      };
    }
    return {
      text: "Your agents are running — activity will appear here shortly.",
      showPulse: true,
    };
  }, [agents]);

  const isEmpty = visibleItems.length === 0;

  return (
    <aside className={cn("flex min-h-0 min-w-0 flex-1 flex-col bg-background", className)}>
      {/* Header */}
      <div className="relative flex shrink-0 items-start justify-between gap-2 px-4 py-3">
        {/* Bottom rule: extends through the 12px resize handle on desktop so
             it visually meets the vertical divider between the chat pane
             and this feed. On mobile there's no handle, so left-0 is fine. */}
        <div
          className="pointer-events-none absolute bottom-0 right-0 left-0 h-px bg-border md:-left-3"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Agent Feed</h3>
          <p className="text-xs text-muted-foreground">
            Live activity from your agents
          </p>
        </div>
        <div className="flex items-center gap-1">
          {/* Group toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant={groupMode === "by-task" ? "secondary" : "ghost"}
                size="icon-sm"
                className="shrink-0 text-muted-foreground"
                aria-label="group by task"
                onClick={() => setGroupMode((m) => (m === "flat" ? "by-task" : "flat"))}
              >
                <Layers className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {groupMode === "flat" ? "Group by task" : "Show flat"}
            </TooltipContent>
          </Tooltip>

          {/* Filter dropdown */}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant={filter !== "all" || showAllActivity ? "secondary" : "ghost"}
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground"
                    aria-label="filter by"
                  >
                    <ListFilter className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom">Filter by</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuRadioGroup
                value={filter}
                onValueChange={(v) => setFilter(v as FilterValue)}
              >
                {FILTER_OPTIONS.map(({ value, label }) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={showAllActivity}
                onCheckedChange={(v) => setShowAllActivity(!!v)}
              >
                Show all activity
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Feed body */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto"
        onScroll={handleScroll}
      >
        {isEmpty ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 h-full">
            <div className="flex flex-col items-center gap-2 max-w-(--sz-16rem)">
              {emptyMessage?.showPulse && (
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/40" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-primary/60" />
                </span>
              )}
              <p className="text-center text-sm text-muted-foreground">
                {emptyMessage?.text ?? "Activity from your agents will appear here."}
              </p>
            </div>
          </div>
        ) : groupMode === "flat" ? (
          <div className="py-2">{visibleItems.map((item, i) => renderItem(item, i, visibleItems))}</div>
        ) : (
          renderGrouped()
        )}
      </div>
    </aside>
  );
}
