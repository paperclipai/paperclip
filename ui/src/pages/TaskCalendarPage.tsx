import { useEffect, useMemo, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import { Link, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { ArrowDown, ArrowUp, CalendarDays, ChevronLeft, ChevronRight, CircleDot, Plus } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { issuesApi } from "../api/issues";
import { EmptyState } from "../components/EmptyState";
import { IssueAssigneeIcon } from "../components/IssueAssigneeIcon";
import { IssueDueBadge } from "../components/IssueDueBadge";
import { PriorityIcon } from "../components/PriorityIcon";
import { StatusIcon } from "../components/StatusIcon";
import { TaskScopeToggle, type TaskScope } from "../components/TaskScopeToggle";
import { Button } from "@/components/ui/button";
import { useToast } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import {
  addMonths,
  dateLongLabel,
  firstOfMonth,
  formatDateOnly,
  monthGrid,
  monthLabel,
  visibleMonthRange,
} from "../lib/issue-date-ranges";
import { isIssueAssignedToCurrentActor } from "../lib/assignees";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";

const ACTIVE_DATED_STATUS_FILTER = "backlog,todo,in_progress,in_review,blocked";
const MAX_VISIBLE_DAY_TASKS = 3;
const CALENDAR_DISPLAY_MODE_STORAGE_KEY = "paperclip.taskCalendar.displayMode";
const weekdayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const issuePriorityOrder = ["critical", "high", "medium", "low"] as const;

export type CalendarDisplayMode = "all" | "three";

type AgentOption = {
  id: string;
  name: string;
  icon?: string | null;
};

type CalendarDragProps = Pick<
  ReturnType<typeof useDraggable>,
  "attributes" | "listeners" | "setNodeRef" | "isDragging"
> & {
  style?: CSSProperties;
};

function readScope(searchParams: URLSearchParams): TaskScope {
  return searchParams.get("scope") === "my" ? "my" : "all";
}

function replaceScope(scope: TaskScope) {
  const url = new URL(window.location.href);
  if (scope === "my") url.searchParams.set("scope", "my");
  else url.searchParams.delete("scope");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function readCalendarDisplayMode(): CalendarDisplayMode {
  if (typeof window === "undefined") return "all";
  return window.localStorage.getItem(CALENDAR_DISPLAY_MODE_STORAGE_KEY) === "three" ? "three" : "all";
}

function saveCalendarDisplayMode(mode: CalendarDisplayMode) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CALENDAR_DISPLAY_MODE_STORAGE_KEY, mode);
}

function priorityRank(priority: string) {
  const rank = issuePriorityOrder.indexOf(priority as (typeof issuePriorityOrder)[number]);
  return rank === -1 ? issuePriorityOrder.indexOf("medium") : rank;
}

export function nextHigherPriority(priority: string): string | null {
  const rank = priorityRank(priority);
  return rank > 0 ? issuePriorityOrder[rank - 1] : null;
}

export function nextLowerPriority(priority: string): string | null {
  const rank = priorityRank(priority);
  return rank < issuePriorityOrder.length - 1 ? issuePriorityOrder[rank + 1] : null;
}

export function sortCalendarIssues(issues: Issue[]) {
  return [...issues].sort((a, b) => {
    if (a.priority !== b.priority) return priorityRank(a.priority) - priorityRank(b.priority);
    return a.title.localeCompare(b.title);
  });
}

export function visibleCalendarIssues(issues: Issue[], mode: CalendarDisplayMode) {
  return mode === "three" ? issues.slice(0, MAX_VISIBLE_DAY_TASKS) : issues;
}

export function groupIssuesByDueDate(issues: Issue[]) {
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!issue.dueDate) continue;
    const group = groups.get(issue.dueDate) ?? [];
    group.push(issue);
    groups.set(issue.dueDate, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => {
      if (a.priority !== b.priority) return priorityRank(a.priority) - priorityRank(b.priority);
      return a.title.localeCompare(b.title);
    });
  }
  return groups;
}

function CalendarTaskCard({
  issue,
  agents,
  isLive = false,
  isOverlay = false,
  currentUserId,
  currentActorAgentIds,
  dragProps,
  onPriorityChange,
  onMarkDone,
}: {
  issue: Issue;
  agents?: AgentOption[];
  isLive?: boolean;
  isOverlay?: boolean;
  currentUserId?: string | null;
  currentActorAgentIds?: string[];
  onPriorityChange?: (id: string, priority: string) => void;
  onMarkDone?: (issue: Issue) => void;
  dragProps?: {
    setNodeRef: CalendarDragProps["setNodeRef"];
    attributes: CalendarDragProps["attributes"];
    listeners?: CalendarDragProps["listeners"];
    style?: CalendarDragProps["style"];
    isDragging?: CalendarDragProps["isDragging"];
  };
}) {
  const higherPriority = nextHigherPriority(issue.priority);
  const lowerPriority = nextLowerPriority(issue.priority);
  const showPriorityControls = !isOverlay && Boolean(onPriorityChange) && (higherPriority || lowerPriority);
  const assignedToCurrentUser = isIssueAssignedToCurrentActor(issue, {
    currentUserId,
    currentAgentIds: currentActorAgentIds,
  });

  function handlePriorityChange(event: MouseEvent<HTMLButtonElement>, priority: string) {
    event.preventDefault();
    event.stopPropagation();
    onPriorityChange?.(issue.id, priority);
  }

  function stopPriorityPointer(event: PointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
  }

  return (
    <div
      ref={dragProps?.setNodeRef}
      style={dragProps?.style}
      {...dragProps?.attributes}
      {...dragProps?.listeners}
      data-assigned-to-current-user={assignedToCurrentUser ? "true" : undefined}
      className={cn(
        "rounded-md border border-border bg-card px-2 py-1.5 text-left text-xs transition-shadow",
        assignedToCurrentUser && "border-cyan-500/70 border-l-4 border-l-cyan-500 bg-cyan-500/15 ring-1 ring-cyan-500/50 dark:border-cyan-300/60 dark:border-l-cyan-300 dark:bg-cyan-400/15 dark:ring-cyan-300/40",
        dragProps && "cursor-grab active:cursor-grabbing",
        dragProps?.isDragging && !isOverlay && "opacity-30",
        isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:bg-accent/40",
        assignedToCurrentUser && !isOverlay && "hover:bg-cyan-500/20 dark:hover:bg-cyan-400/20",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <CalendarStatusButton issue={issue} onMarkDone={isOverlay ? undefined : onMarkDone} />
        <Link
          to={`/issues/${issue.identifier ?? issue.id}`}
          disableIssueQuicklook
          className="flex min-w-0 flex-1 items-center gap-1.5 text-inherit no-underline"
          onClick={(event) => {
            if (dragProps?.isDragging) event.preventDefault();
          }}
        >
          <PriorityIcon priority={issue.priority} />
          <span className="min-w-0 flex-1 truncate">{issue.title}</span>
          {isLive ? (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
          ) : null}
          <IssueAssigneeIcon issue={issue} agents={agents} currentUserId={currentUserId} className="-mr-0.5" />
        </Link>
        {showPriorityControls ? (
          <span className="flex shrink-0 items-center gap-0.5">
            {higherPriority ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="h-5 w-5 text-muted-foreground hover:text-foreground"
                title="Raise priority"
                aria-label={`Raise priority for ${issue.title}`}
                onPointerDown={stopPriorityPointer}
                onMouseDown={stopPriorityPointer}
                onClick={(event) => handlePriorityChange(event, higherPriority)}
              >
                <ArrowUp className="h-3 w-3" />
              </Button>
            ) : null}
            {lowerPriority ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="h-5 w-5 text-muted-foreground hover:text-foreground"
                title="Lower priority"
                aria-label={`Lower priority for ${issue.title}`}
                onPointerDown={stopPriorityPointer}
                onMouseDown={stopPriorityPointer}
                onClick={(event) => handlePriorityChange(event, lowerPriority)}
              >
                <ArrowDown className="h-3 w-3" />
              </Button>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function DraggableCalendarTask({
  issue,
  agents,
  isLive,
  currentUserId,
  currentActorAgentIds,
  onPriorityChange,
  onMarkDone,
}: {
  issue: Issue;
  agents?: AgentOption[];
  isLive?: boolean;
  currentUserId?: string | null;
  currentActorAgentIds?: string[];
  onPriorityChange?: (id: string, priority: string) => void;
  onMarkDone: (issue: Issue) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: issue.id,
    data: { issue },
  });
  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined;

  return (
    <CalendarTaskCard
      issue={issue}
      agents={agents}
      isLive={isLive}
      currentUserId={currentUserId}
      currentActorAgentIds={currentActorAgentIds}
      onPriorityChange={onPriorityChange}
      onMarkDone={onMarkDone}
      dragProps={{ attributes, listeners, setNodeRef, style, isDragging }}
    />
  );
}

function CalendarDayCell({
  day,
  issues,
  agents,
  liveIssueIds,
  currentUserId,
  currentActorAgentIds,
  selected,
  displayMode,
  onSelectDate,
  onAddTask,
  onPriorityChange,
  onMarkDone,
}: {
  day: ReturnType<typeof monthGrid>[number];
  issues: Issue[];
  agents?: AgentOption[];
  liveIssueIds?: Set<string>;
  currentUserId?: string | null;
  currentActorAgentIds?: string[];
  selected: boolean;
  displayMode: CalendarDisplayMode;
  onSelectDate: (date: string) => void;
  onAddTask: (date: string) => void;
  onPriorityChange: (id: string, priority: string) => void;
  onMarkDone: (issue: Issue) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `date:${day.date}` });
  const visibleIssues = visibleCalendarIssues(issues, displayMode);
  const hiddenCount = Math.max(0, issues.length - visibleIssues.length);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "group min-h-[132px] border-b border-r border-border p-1.5 transition-colors md:min-h-[148px]",
        !day.inCurrentMonth && "bg-muted/10 text-muted-foreground",
        isOver && "bg-accent/50",
        selected && "ring-1 ring-inset ring-primary/50",
      )}
    >
      <div className="mb-1 flex items-center justify-between gap-1">
        <button
          type="button"
          className={cn(
            "flex h-6 min-w-6 items-center justify-center rounded-sm px-1 text-xs font-medium",
            day.isToday ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
          onClick={() => onSelectDate(day.date)}
          aria-label={dateLongLabel(day.date)}
        >
          {day.dayOfMonth}
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6 text-muted-foreground opacity-70 transition-opacity hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100"
          title={`Add task due ${dateLongLabel(day.date)}`}
          aria-label={`Add task due ${dateLongLabel(day.date)}`}
          onClick={() => onAddTask(day.date)}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
      <div className="space-y-1">
        {visibleIssues.map((issue) => (
          <DraggableCalendarTask
            key={issue.id}
            issue={issue}
            agents={agents}
            isLive={liveIssueIds?.has(issue.id) === true}
            currentUserId={currentUserId}
            currentActorAgentIds={currentActorAgentIds}
            onPriorityChange={onPriorityChange}
            onMarkDone={onMarkDone}
          />
        ))}
        {hiddenCount > 0 ? (
          <button
            type="button"
            className="w-full rounded-sm px-2 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
            onClick={() => onSelectDate(day.date)}
          >
            +{hiddenCount} more
          </button>
        ) : null}
      </div>
    </div>
  );
}

function CalendarAgendaTaskRow({
  issue,
  currentUserId,
  currentActorAgentIds,
  onPriorityChange,
  onMarkDone,
}: {
  issue: Issue;
  currentUserId?: string | null;
  currentActorAgentIds?: string[];
  onPriorityChange: (id: string, priority: string) => void;
  onMarkDone: (issue: Issue) => void;
}) {
  const higherPriority = nextHigherPriority(issue.priority);
  const lowerPriority = nextLowerPriority(issue.priority);
  const assignedToCurrentUser = isIssueAssignedToCurrentActor(issue, {
    currentUserId,
    currentAgentIds: currentActorAgentIds,
  });

  function handlePriorityChange(event: MouseEvent<HTMLButtonElement>, priority: string) {
    event.preventDefault();
    event.stopPropagation();
    onPriorityChange(issue.id, priority);
  }

  return (
    <div
      data-assigned-to-current-user={assignedToCurrentUser ? "true" : undefined}
      className={cn(
        "flex min-w-0 items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-accent/50",
        assignedToCurrentUser && "border-l-4 border-l-cyan-500 bg-cyan-500/15 ring-1 ring-inset ring-cyan-500/50 hover:bg-cyan-500/20 dark:border-l-cyan-300 dark:bg-cyan-400/15 dark:ring-cyan-300/40 dark:hover:bg-cyan-400/20",
      )}
    >
      <CalendarStatusButton issue={issue} onMarkDone={onMarkDone} />
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        className="flex min-w-0 flex-1 items-center gap-2 text-inherit no-underline"
      >
        <PriorityIcon priority={issue.priority} />
        <span className="min-w-0 flex-1 truncate">{issue.title}</span>
        <IssueDueBadge issue={issue} compact />
      </Link>
      {higherPriority ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          title="Raise priority"
          aria-label={`Raise priority for ${issue.title}`}
          onClick={(event) => handlePriorityChange(event, higherPriority)}
        >
          <ArrowUp className="h-3 w-3" />
        </Button>
      ) : null}
      {lowerPriority ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="h-6 w-6 text-muted-foreground hover:text-foreground"
          title="Lower priority"
          aria-label={`Lower priority for ${issue.title}`}
          onClick={(event) => handlePriorityChange(event, lowerPriority)}
        >
          <ArrowDown className="h-3 w-3" />
        </Button>
      ) : null}
    </div>
  );
}

function CalendarStatusButton({
  issue,
  onMarkDone,
}: {
  issue: Issue;
  onMarkDone?: (issue: Issue) => void;
}) {
  if (!onMarkDone || issue.status === "done") return <StatusIcon status={issue.status} />;

  function stopStatusPointer(event: PointerEvent<HTMLButtonElement> | MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
  }

  function handleMarkDone(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    onMarkDone?.(issue);
  }

  return (
    <button
      type="button"
      className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      title={`Mark ${issue.title} as done`}
      aria-label={`Mark ${issue.title} as done`}
      onPointerDown={stopStatusPointer}
      onMouseDown={stopStatusPointer}
      onClick={handleMarkDone}
    >
      <StatusIcon status={issue.status} />
    </button>
  );
}

export function TaskCalendarPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const { openNewIssue } = useDialog();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const today = formatDateOnly();
  const [scope, setScope] = useState<TaskScope>(() => readScope(searchParams));
  const [displayMode, setDisplayMode] = useState<CalendarDisplayMode>(() => readCalendarDisplayMode());
  const [monthDate, setMonthDate] = useState(() => firstOfMonth(today));
  const [selectedDate, setSelectedDate] = useState(today);
  const [activeIssueId, setActiveIssueId] = useState<string | null>(null);
  const effectiveScope: TaskScope = scope;
  const gridDays = useMemo(() => monthGrid(monthDate, today), [monthDate, today]);
  const range = useMemo(() => visibleMonthRange(monthDate, today), [monthDate, today]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    setScope(readScope(searchParams));
  }, [searchParams]);

  useEffect(() => {
    setBreadcrumbs([{ label: "Calendar" }]);
  }, [setBreadcrumbs]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const showMyScope = Boolean(currentUserId);
  const visibleScope: TaskScope = effectiveScope === "my" && showMyScope ? "my" : "all";

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const currentActorAgentIds = useMemo(() => agents.map((agent) => agent.id), [agents]);

  const calendarQueryKey = useMemo(
    () => [
      ...queryKeys.issues.list(selectedCompanyId ?? "__no-company__"),
      "calendar",
      range.from,
      range.to,
      visibleScope,
    ] as const,
    [range.from, range.to, selectedCompanyId, visibleScope],
  );

  const filters = useMemo(
    () => ({
      status: ACTIVE_DATED_STATUS_FILTER,
      dueFrom: range.from,
      dueTo: range.to,
      ...(visibleScope === "my" ? { assigneeUserId: "me" } : {}),
    }),
    [range.from, range.to, visibleScope],
  );

  const { data: issues = [], isLoading, error } = useQuery({
    queryKey: calendarQueryKey,
    queryFn: () => issuesApi.list(selectedCompanyId!, filters),
    enabled: !!selectedCompanyId,
  });

  const moveDueDate = useMutation({
    mutationFn: ({ id, dueDate }: { id: string; dueDate: string }) =>
      issuesApi.update(id, { dueDate }),
    onMutate: async ({ id, dueDate }) => {
      await queryClient.cancelQueries({ queryKey: calendarQueryKey });
      const previous = queryClient.getQueryData<Issue[]>(calendarQueryKey);
      queryClient.setQueryData<Issue[]>(calendarQueryKey, (current) =>
        (current ?? []).map((issue) => (issue.id === id ? { ...issue, dueDate } : issue)),
      );
      return { previous };
    },
    onError: (err, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(calendarQueryKey, context.previous);
      pushToast({
        title: "Due date update failed",
        body: err instanceof Error ? err.message : "Could not move the task.",
        tone: "error",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: calendarQueryKey });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
      }
    },
  });

  const updatePriority = useMutation({
    mutationFn: ({ id, priority }: { id: string; priority: string }) =>
      issuesApi.update(id, { priority }),
    onMutate: async ({ id, priority }) => {
      await queryClient.cancelQueries({ queryKey: calendarQueryKey });
      const previous = queryClient.getQueryData<Issue[]>(calendarQueryKey);
      const nextPriority = priority as Issue["priority"];
      queryClient.setQueryData<Issue[]>(calendarQueryKey, (current) =>
        (current ?? []).map((issue) => (issue.id === id ? { ...issue, priority: nextPriority } : issue)),
      );
      return { previous };
    },
    onError: (err, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(calendarQueryKey, context.previous);
      pushToast({
        title: "Priority update failed",
        body: err instanceof Error ? err.message : "Could not update the task priority.",
        tone: "error",
      });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: calendarQueryKey });
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
      }
    },
  });

  const markIssueDone = useMutation({
    mutationFn: ({ issue }: { issue: Issue }) =>
      issuesApi.update(issue.id, { status: "done" }),
    onMutate: async ({ issue }) => {
      await queryClient.cancelQueries({ queryKey: calendarQueryKey });
      const previous = queryClient.getQueryData<Issue[]>(calendarQueryKey);
      queryClient.setQueryData<Issue[]>(calendarQueryKey, (current) =>
        (current ?? []).filter((candidate) => candidate.id !== issue.id),
      );
      return { previous };
    },
    onError: (err, _variables, context) => {
      if (context?.previous) queryClient.setQueryData(calendarQueryKey, context.previous);
      pushToast({
        title: "Status update failed",
        body: err instanceof Error ? err.message : "Could not mark the task done.",
        tone: "error",
      });
    },
    onSettled: (_data, _err, variables) => {
      queryClient.invalidateQueries({ queryKey: calendarQueryKey });
      if (variables?.issue.id) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(variables.issue.id) });
      }
      if (variables?.issue.identifier) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(variables.issue.identifier) });
      }
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(selectedCompanyId) });
      }
    },
  });

  const issuesByDate = useMemo(() => groupIssuesByDueDate(issues), [issues]);
  const activeIssue = useMemo(
    () => (activeIssueId ? issues.find((issue) => issue.id === activeIssueId) ?? null : null),
    [activeIssueId, issues],
  );
  const selectedIssues = issuesByDate.get(selectedDate) ?? [];

  function handleDragStart(event: DragStartEvent) {
    setActiveIssueId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveIssueId(null);
    const overId = event.over?.id;
    if (!overId || typeof overId !== "string" || !overId.startsWith("date:")) return;
    const targetDate = overId.slice("date:".length);
    const issue = event.active.data.current?.issue as Issue | undefined;
    if (!issue || issue.dueDate === targetDate) return;
    moveDueDate.mutate({ id: issue.id, dueDate: targetDate });
  }

  function handleDisplayModeChange(mode: CalendarDisplayMode) {
    setDisplayMode(mode);
    saveCalendarDisplayMode(mode);
  }

  function handleAddTask(date: string) {
    openNewIssue({ dueDate: date });
    setSelectedDate(date);
  }

  function handlePriorityChange(id: string, priority: string) {
    updatePriority.mutate({ id, priority });
  }

  function handleMarkDone(issue: Issue) {
    markIssueDone.mutate({ issue });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={CalendarDays} message="Select a company to view the task calendar." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setMonthDate((current) => addMonths(current, -1))}
            aria-label="Previous month"
            title="Previous month"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setMonthDate(firstOfMonth(today))}
            aria-label="Current month"
            title="Current month"
          >
            <CircleDot className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setMonthDate((current) => addMonths(current, 1))}
            aria-label="Next month"
            title="Next month"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <h1 className="ml-2 text-xl font-bold">{monthLabel(monthDate)}</h1>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border bg-muted/30 p-0.5" aria-label="Calendar task density">
            {([
              ["all", "All"],
              ["three", "3"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={cn(
                  "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                  displayMode === value
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
                title={value === "all" ? "Show all tasks per date" : "Show 3 tasks per date"}
                aria-pressed={displayMode === value}
                onClick={() => handleDisplayModeChange(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <TaskScopeToggle
            value={visibleScope}
            showMy={showMyScope}
            onChange={(nextScope) => {
              setScope(nextScope);
              replaceScope(nextScope);
            }}
          />
        </div>
      </div>

      {error ? <p className="text-sm text-destructive">{(error as Error).message}</p> : null}

      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="overflow-hidden rounded-md border border-border">
          <div className="hidden grid-cols-7 border-b border-border bg-muted/20 md:grid">
            {weekdayLabels.map((weekday) => (
              <div key={weekday} className="border-r border-border px-2 py-1.5 text-xs font-medium text-muted-foreground last:border-r-0">
                {weekday}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-7">
            {gridDays.map((day) => (
              <CalendarDayCell
                key={day.date}
                day={day}
                issues={issuesByDate.get(day.date) ?? []}
                agents={agents}
                liveIssueIds={undefined}
                currentUserId={currentUserId}
                currentActorAgentIds={currentActorAgentIds}
                selected={selectedDate === day.date}
                displayMode={displayMode}
                onSelectDate={setSelectedDate}
                onAddTask={handleAddTask}
                onPriorityChange={handlePriorityChange}
                onMarkDone={handleMarkDone}
              />
            ))}
          </div>
        </div>
        <DragOverlay>
          {activeIssue ? (
            <CalendarTaskCard
              issue={activeIssue}
              agents={agents}
              currentUserId={currentUserId}
              currentActorAgentIds={currentActorAgentIds}
              isOverlay
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading calendar...</p>
      ) : issues.length === 0 ? (
        <EmptyState icon={CalendarDays} message="No active due-dated tasks in this month." />
      ) : null}

      <div className="border-t border-border pt-3">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{dateLongLabel(selectedDate)}</h2>
          <span className="text-xs tabular-nums text-muted-foreground">{selectedIssues.length}</span>
        </div>
        {selectedIssues.length > 0 ? (
          <div className="space-y-1">
            {selectedIssues.map((issue) => (
              <CalendarAgendaTaskRow
                key={issue.id}
                issue={issue}
                currentUserId={currentUserId}
                currentActorAgentIds={currentActorAgentIds}
                onPriorityChange={handlePriorityChange}
                onMarkDone={handleMarkDone}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No active tasks due on this date.</p>
        )}
      </div>
    </div>
  );
}
