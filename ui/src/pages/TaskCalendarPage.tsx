import { useEffect, useMemo, useState, type CSSProperties } from "react";
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
import { CalendarDays, ChevronLeft, ChevronRight, CircleDot } from "lucide-react";
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
import {
  addMonths,
  dateLongLabel,
  firstOfMonth,
  formatDateOnly,
  monthGrid,
  monthLabel,
  visibleMonthRange,
} from "../lib/issue-date-ranges";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";

const ACTIVE_DATED_STATUS_FILTER = "backlog,todo,in_progress,in_review,blocked";
const MAX_VISIBLE_DAY_TASKS = 3;
const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

function groupIssuesByDueDate(issues: Issue[]) {
  const groups = new Map<string, Issue[]>();
  for (const issue of issues) {
    if (!issue.dueDate) continue;
    const group = groups.get(issue.dueDate) ?? [];
    group.push(issue);
    groups.set(issue.dueDate, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => {
      if (a.priority !== b.priority) {
        const priorityOrder = ["critical", "high", "medium", "low"];
        return priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority);
      }
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
  dragProps,
}: {
  issue: Issue;
  agents?: AgentOption[];
  isLive?: boolean;
  isOverlay?: boolean;
  dragProps?: {
    setNodeRef: CalendarDragProps["setNodeRef"];
    attributes: CalendarDragProps["attributes"];
    listeners?: CalendarDragProps["listeners"];
    style?: CalendarDragProps["style"];
    isDragging?: CalendarDragProps["isDragging"];
  };
}) {
  return (
    <div
      ref={dragProps?.setNodeRef}
      style={dragProps?.style}
      {...dragProps?.attributes}
      {...dragProps?.listeners}
      className={cn(
        "rounded-md border border-border bg-card px-2 py-1.5 text-left text-xs transition-shadow",
        dragProps && "cursor-grab active:cursor-grabbing",
        dragProps?.isDragging && !isOverlay && "opacity-30",
        isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:bg-accent/40",
      )}
    >
      <Link
        to={`/issues/${issue.identifier ?? issue.id}`}
        disableIssueQuicklook
        className="block min-w-0 text-inherit no-underline"
        onClick={(event) => {
          if (dragProps?.isDragging) event.preventDefault();
        }}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          <StatusIcon status={issue.status} />
          <PriorityIcon priority={issue.priority} />
          <span className="min-w-0 flex-1 truncate">{issue.title}</span>
          {isLive ? (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
          ) : null}
          <IssueAssigneeIcon issue={issue} agents={agents} className="-mr-0.5" />
        </div>
      </Link>
    </div>
  );
}

function DraggableCalendarTask({
  issue,
  agents,
  isLive,
}: {
  issue: Issue;
  agents?: AgentOption[];
  isLive?: boolean;
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
      dragProps={{ attributes, listeners, setNodeRef, style, isDragging }}
    />
  );
}

function CalendarDayCell({
  day,
  issues,
  agents,
  liveIssueIds,
  selected,
  onSelectDate,
}: {
  day: ReturnType<typeof monthGrid>[number];
  issues: Issue[];
  agents?: AgentOption[];
  liveIssueIds?: Set<string>;
  selected: boolean;
  onSelectDate: (date: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `date:${day.date}` });
  const visibleIssues = issues.slice(0, MAX_VISIBLE_DAY_TASKS);
  const hiddenCount = Math.max(0, issues.length - visibleIssues.length);

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "min-h-[132px] border-b border-r border-border p-1.5 transition-colors md:min-h-[148px]",
        !day.inCurrentMonth && "bg-muted/10 text-muted-foreground",
        isOver && "bg-accent/50",
        selected && "ring-1 ring-inset ring-primary/50",
      )}
    >
      <button
        type="button"
        className={cn(
          "mb-1 flex h-6 min-w-6 items-center justify-center rounded-sm px-1 text-xs font-medium",
          day.isToday ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
        onClick={() => onSelectDate(day.date)}
        aria-label={dateLongLabel(day.date)}
      >
        {day.dayOfMonth}
      </button>
      <div className="space-y-1">
        {visibleIssues.map((issue) => (
          <DraggableCalendarTask
            key={issue.id}
            issue={issue}
            agents={agents}
            isLive={liveIssueIds?.has(issue.id) === true}
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

export function TaskCalendarPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const today = formatDateOnly();
  const [scope, setScope] = useState<TaskScope>(() => readScope(searchParams));
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

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

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
        <TaskScopeToggle
          value={visibleScope}
          showMy={showMyScope}
          onChange={(nextScope) => {
            setScope(nextScope);
            replaceScope(nextScope);
          }}
        />
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
                selected={selectedDate === day.date}
                onSelectDate={setSelectedDate}
              />
            ))}
          </div>
        </div>
        <DragOverlay>
          {activeIssue ? <CalendarTaskCard issue={activeIssue} agents={agents} isOverlay /> : null}
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
              <Link
                key={issue.id}
                to={`/issues/${issue.identifier ?? issue.id}`}
                className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm text-inherit no-underline transition-colors hover:bg-accent/50"
              >
                <StatusIcon status={issue.status} />
                <PriorityIcon priority={issue.priority} />
                <span className="min-w-0 flex-1 truncate">{issue.title}</span>
                <IssueDueBadge issue={issue} compact />
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No active tasks due on this date.</p>
        )}
      </div>
    </div>
  );
}
