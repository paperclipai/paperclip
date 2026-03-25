import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { issuesApi } from "../api/issues";
import { taskCronsApi } from "../api/taskCrons";
import { queryKeys } from "../lib/queryKeys";
import { groupBy } from "../lib/groupBy";
import { formatDate, formatDateTime, cn, timeUntil } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { EmptyState } from "./EmptyState";
import { Identity } from "./Identity";
import { PageSkeleton } from "./PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CircleDot,
  Plus,
  Filter,
  ArrowUpDown,
  Layers,
  Check,
  X,
  ChevronRight,
  List,
  Columns3,
  User,
  Search,
  CalendarClock,
  Clock3,
  Pause,
  Play,
  Save,
  History,
  Zap,
} from "lucide-react";
import { KanbanBoard } from "./KanbanBoard";
import type { Issue } from "@paperclipai/shared";
import type { TaskCronSchedule } from "@paperclipai/shared";

/* ── Helpers ── */

const statusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
const pastStatuses = new Set(["done", "cancelled"]);
const priorityOrder = ["critical", "high", "medium", "low"];

function statusLabel(status: string): string {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ── View state ── */

export type IssueViewState = {
  statuses: string[];
  priorities: string[];
  assignees: string[];
  labels: string[];
  recurringFilter: "all" | "recurring_only";
  sortField: "status" | "priority" | "title" | "created" | "updated";
  sortDir: "asc" | "desc";
  groupBy: "status" | "priority" | "assignee" | "recurring" | "none";
  viewMode: "list" | "board";
  collapsedGroups: string[];
};

const defaultViewState: IssueViewState = {
  statuses: [],
  priorities: [],
  assignees: [],
  labels: [],
  recurringFilter: "all",
  sortField: "updated",
  sortDir: "desc",
  groupBy: "none",
  viewMode: "list",
  collapsedGroups: [],
};

const quickFilterPresets = [
  { label: "All", statuses: [] as string[] },
  { label: "Active", statuses: ["todo", "in_progress", "in_review", "blocked"] },
  { label: "Backlog", statuses: ["backlog"] },
  { label: "Done", statuses: ["done", "cancelled"] },
];

function getViewState(key: string): IssueViewState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...defaultViewState, ...JSON.parse(raw) };
  } catch { /* ignore */ }
  return { ...defaultViewState };
}

function saveViewState(key: string, state: IssueViewState) {
  localStorage.setItem(key, JSON.stringify(state));
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

function toggleInArray(arr: string[], value: string): string[] {
  return arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
}

function applyFilters(
  issues: Issue[],
  state: IssueViewState,
  recurringIssueIds: Set<string>,
): Issue[] {
  let result = issues;
  if (state.statuses.length > 0) result = result.filter((i) => state.statuses.includes(i.status));
  if (state.priorities.length > 0) result = result.filter((i) => state.priorities.includes(i.priority));
  if (state.assignees.length > 0) result = result.filter((i) => i.assigneeAgentId != null && state.assignees.includes(i.assigneeAgentId));
  if (state.labels.length > 0) result = result.filter((i) => (i.labelIds ?? []).some((id) => state.labels.includes(id)));
  if (state.recurringFilter === "recurring_only") result = result.filter((i) => recurringIssueIds.has(i.id));
  return result;
}

function sortIssues(issues: Issue[], state: IssueViewState): Issue[] {
  const sorted = [...issues];
  const dir = state.sortDir === "asc" ? 1 : -1;
  sorted.sort((a, b) => {
    switch (state.sortField) {
      case "status":
        return dir * (statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status));
      case "priority":
        return dir * (priorityOrder.indexOf(a.priority) - priorityOrder.indexOf(b.priority));
      case "title":
        return dir * a.title.localeCompare(b.title);
      case "created":
        return dir * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      case "updated":
        return dir * (new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
      default:
        return 0;
    }
  });
  return sorted;
}

function countActiveFilters(state: IssueViewState): number {
  let count = 0;
  if (state.statuses.length > 0) count++;
  if (state.priorities.length > 0) count++;
  if (state.assignees.length > 0) count++;
  if (state.labels.length > 0) count++;
  if (state.recurringFilter === "recurring_only") count++;
  return count;
}

/* ── Component ── */

interface Agent {
  id: string;
  name: string;
}

interface IssuesListProps {
  issues: Issue[];
  isLoading?: boolean;
  error?: Error | null;
  agents?: Agent[];
  liveIssueIds?: Set<string>;
  projectId?: string;
  viewStateKey: string;
  issueLinkState?: unknown;
  initialAssignees?: string[];
  initialSearch?: string;
  onSearchChange?: (search: string) => void;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

export function IssuesList({
  issues,
  isLoading,
  error,
  agents,
  liveIssueIds,
  projectId,
  viewStateKey,
  issueLinkState,
  initialAssignees,
  initialSearch,
  onSearchChange,
  onUpdateIssue,
}: IssuesListProps) {
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const queryClient = useQueryClient();

  // Scope the storage key per company so folding/view state is independent across companies.
  const scopedKey = selectedCompanyId ? `${viewStateKey}:${selectedCompanyId}` : viewStateKey;

  const [viewState, setViewState] = useState<IssueViewState>(() => {
    if (initialAssignees) {
      return { ...defaultViewState, assignees: initialAssignees, statuses: [] };
    }
    return getViewState(scopedKey);
  });
  const [assigneePickerIssueId, setAssigneePickerIssueId] = useState<string | null>(null);
  const [recurringPickerIssueId, setRecurringPickerIssueId] = useState<string | null>(null);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [recurringDrafts, setRecurringDrafts] = useState<Record<string, string>>({});
  const [issueSearch, setIssueSearch] = useState(initialSearch ?? "");
  const [debouncedIssueSearch, setDebouncedIssueSearch] = useState(issueSearch);
  const normalizedIssueSearch = debouncedIssueSearch.trim();

  useEffect(() => {
    setIssueSearch(initialSearch ?? "");
  }, [initialSearch]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedIssueSearch(issueSearch);
    }, 300);
    return () => window.clearTimeout(timeoutId);
  }, [issueSearch]);

  // Reload view state from localStorage when company changes (scopedKey changes).
  const prevScopedKey = useRef(scopedKey);
  useEffect(() => {
    if (prevScopedKey.current !== scopedKey) {
      prevScopedKey.current = scopedKey;
      setViewState(initialAssignees
        ? { ...defaultViewState, assignees: initialAssignees, statuses: [] }
        : getViewState(scopedKey));
    }
  }, [scopedKey, initialAssignees]);

  const updateView = useCallback((patch: Partial<IssueViewState>) => {
    setViewState((prev) => {
      const next = { ...prev, ...patch };
      saveViewState(scopedKey, next);
      return next;
    });
  }, [scopedKey]);

  const { data: searchedIssues = [] } = useQuery({
    queryKey: queryKeys.issues.search(selectedCompanyId!, normalizedIssueSearch, projectId),
    queryFn: () => issuesApi.list(selectedCompanyId!, { q: normalizedIssueSearch, projectId }),
    enabled: !!selectedCompanyId && normalizedIssueSearch.length > 0,
  });

  const { data: recurringSchedules = [] } = useQuery({
    queryKey: queryKeys.taskCrons.company(selectedCompanyId!),
    queryFn: () => taskCronsApi.listCompanySchedules(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const recurringByIssueId = useMemo(() => {
    const map = new Map<string, TaskCronSchedule[]>();
    for (const schedule of recurringSchedules) {
      if (!schedule.issueId) continue;
      const existing = map.get(schedule.issueId);
      if (existing) existing.push(schedule);
      else map.set(schedule.issueId, [schedule]);
    }
    return map;
  }, [recurringSchedules]);

  const recurringIssueIds = useMemo(
    () => new Set<string>(Array.from(recurringByIssueId.keys())),
    [recurringByIssueId],
  );

  const updateSchedule = useMutation({
    mutationFn: ({
      scheduleId,
      patch,
    }: {
      scheduleId: string;
      patch: { enabled?: boolean; expression?: string };
    }) =>
      taskCronsApi.updateSchedule(scheduleId, patch, selectedCompanyId ?? undefined),
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.taskCrons.company(selectedCompanyId) });
    },
  });

  const agentName = useCallback((id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  }, [agents]);

  const filtered = useMemo(() => {
    const sourceIssues = normalizedIssueSearch.length > 0 ? searchedIssues : issues;
    const filteredByControls = applyFilters(sourceIssues, viewState, recurringIssueIds);
    return sortIssues(filteredByControls, viewState);
  }, [issues, searchedIssues, viewState, normalizedIssueSearch, recurringIssueIds]);

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeFilterCount = countActiveFilters(viewState);

  const upcomingSchedules = useMemo(() => {
    const now = Date.now();
    // When viewing inside a project, only show schedules linked to issues in this project
    const projectIssueIds = projectId ? new Set(issues.map((i) => i.id)) : null;
    return recurringSchedules
      .filter((s) => {
        if (!s.enabled || !s.nextTriggerAt || new Date(s.nextTriggerAt).getTime() <= now) return false;
        // If scoped to a project, only include schedules whose linked issue belongs to this project
        if (projectIssueIds) return s.issueId != null && projectIssueIds.has(s.issueId);
        return true;
      })
      .sort((a, b) => new Date(a.nextTriggerAt!).getTime() - new Date(b.nextTriggerAt!).getTime())
      .slice(0, 8);
  }, [recurringSchedules, projectId, issues]);

  const activeIssues = useMemo(() => filtered.filter((i) => !pastStatuses.has(i.status)), [filtered]);
  const pastIssues = useMemo(() => filtered.filter((i) => pastStatuses.has(i.status)), [filtered]);

  const groupedContent = useMemo(() => {
    if (viewState.groupBy === "none") {
      return [{ key: "__all", label: null as string | null, items: filtered }];
    }
    if (viewState.groupBy === "status") {
      const groups = groupBy(filtered, (i) => i.status);
      return statusOrder
        .filter((s) => groups[s]?.length)
        .map((s) => ({ key: s, label: statusLabel(s), items: groups[s]! }));
    }
    if (viewState.groupBy === "priority") {
      const groups = groupBy(filtered, (i) => i.priority);
      return priorityOrder
        .filter((p) => groups[p]?.length)
        .map((p) => ({ key: p, label: statusLabel(p), items: groups[p]! }));
    }
    if (viewState.groupBy === "recurring") {
      const recurring = filtered.filter((i) => recurringIssueIds.has(i.id));
      const oneOff = filtered.filter((i) => !recurringIssueIds.has(i.id));
      const result: { key: string; label: string | null; items: typeof filtered }[] = [];
      if (recurring.length) result.push({ key: "recurring", label: "Recurring", items: recurring });
      if (oneOff.length) result.push({ key: "one-off", label: "One-off", items: oneOff });
      return result;
    }
    // assignee
    const groups = groupBy(filtered, (i) => i.assigneeAgentId ?? "__unassigned");
    return Object.keys(groups).map((key) => ({
      key,
      label: key === "__unassigned" ? "Unassigned" : (agentName(key) ?? key.slice(0, 8)),
      items: groups[key]!,
    }));
  }, [filtered, viewState.groupBy, agents, recurringIssueIds]); // eslint-disable-line react-hooks/exhaustive-deps

  const newIssueDefaults = (groupKey?: string) => {
    const defaults: Record<string, string> = {};
    if (projectId) defaults.projectId = projectId;
    if (groupKey) {
      if (viewState.groupBy === "status") defaults.status = groupKey;
      else if (viewState.groupBy === "priority") defaults.priority = groupKey;
      else if (viewState.groupBy === "assignee" && groupKey !== "__unassigned") defaults.assigneeAgentId = groupKey;
    }
    return defaults;
  };

  const assignIssue = (issueId: string, assigneeAgentId: string | null) => {
    onUpdateIssue(issueId, { assigneeAgentId, assigneeUserId: null });
    setAssigneePickerIssueId(null);
    setAssigneeSearch("");
  };

  const scheduleDraftValue = (schedule: TaskCronSchedule) =>
    recurringDrafts[schedule.id] ?? schedule.expression;

  const renderIssueRow = useCallback((issue: Issue) => (
    <Link
      key={issue.id}
      to={`/issues/${issue.identifier ?? issue.id}`}
      state={issueLinkState}
      className="flex items-start gap-2 py-2.5 pl-3 pr-3 text-sm last:border-b-0 cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit sm:items-center sm:py-2"
    >
      <span className="shrink-0 pt-px sm:hidden" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
        <StatusIcon
          status={issue.status}
          onChange={(s) => onUpdateIssue(issue.id, { status: s })}
        />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:contents">
        <span className="sm:order-2 sm:flex-1 sm:min-w-0">
          <span className="line-clamp-2 text-sm sm:line-clamp-1 sm:truncate block">
            {issue.title}
          </span>
          {issue.description && (
            <span className="line-clamp-1 text-[11px] text-muted-foreground mt-0.5 block">
              {issue.description.replace(/[\n\r]+/g, " ").slice(0, 120)}
            </span>
          )}
        </span>

        <span className="flex items-center gap-2 sm:order-1 sm:shrink-0">
          <span className="w-3.5 shrink-0 hidden sm:block" />
          <span className="hidden sm:inline-flex"><PriorityIcon priority={issue.priority} /></span>
          <span className="hidden shrink-0 sm:inline-flex" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
            <StatusIcon
              status={issue.status}
              onChange={(s) => onUpdateIssue(issue.id, { status: s })}
            />
          </span>
          <span className="text-xs text-muted-foreground font-mono shrink-0">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {recurringIssueIds.has(issue.id) && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
              <Clock3 className="h-2.5 w-2.5" />
              Recurring
            </span>
          )}
          {liveIssueIds?.has(issue.id) && (
            <span className="inline-flex items-center gap-1 sm:gap-1.5 px-1.5 sm:px-2 py-0.5 rounded-full bg-blue-500/10">
              <span className="relative flex h-2 w-2">
                <span className="animate-pulse absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
              </span>
              <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hidden sm:inline">Live</span>
            </span>
          )}
          <span className="text-xs text-muted-foreground sm:hidden">&middot;</span>
          <span className="text-xs text-muted-foreground sm:hidden">
            {timeAgo(issue.updatedAt)}
          </span>
        </span>
      </span>

      <span className="hidden sm:flex sm:order-3 items-center gap-2 sm:gap-3 shrink-0 ml-auto">
        {(() => {
          const issueSchedules = recurringByIssueId.get(issue.id) ?? [];
          if (issueSchedules.length === 0) return null;
          const enabledCount = issueSchedules.filter((schedule) => schedule.enabled).length;
          return (
            <Popover
              open={recurringPickerIssueId === issue.id}
              onOpenChange={(open) => setRecurringPickerIssueId(open ? issue.id : null)}
            >
              <PopoverTrigger asChild>
                <button
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent/50 transition-colors"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                >
                  <Clock3 className="h-3.5 w-3.5" />
                  {enabledCount}/{issueSchedules.length}
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="w-80 p-2"
                align="end"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="space-y-2">
                  {issueSchedules.map((schedule) => (
                    <div key={schedule.id} className="rounded border border-border p-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium truncate">{schedule.name}</span>
                        <span className="ml-auto">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-[10px]"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              updateSchedule.mutate({
                                scheduleId: schedule.id,
                                patch: { enabled: !schedule.enabled },
                              });
                            }}
                            disabled={updateSchedule.isPending}
                          >
                            {schedule.enabled ? (
                              <>
                                <Pause className="h-3 w-3 mr-1" />
                                Stop
                              </>
                            ) : (
                              <>
                                <Play className="h-3 w-3 mr-1" />
                                Start
                              </>
                            )}
                          </Button>
                        </span>
                      </div>
                      <div className="mt-2 flex items-center gap-1.5">
                        <input
                          className="w-full rounded-md border border-border bg-transparent px-2 py-1 text-[11px] font-mono"
                          value={scheduleDraftValue(schedule)}
                          onChange={(e) =>
                            setRecurringDrafts((prev) => ({
                              ...prev,
                              [schedule.id]: e.target.value,
                            }))
                          }
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            updateSchedule.mutate({
                              scheduleId: schedule.id,
                              patch: { expression: scheduleDraftValue(schedule).trim() },
                            });
                          }}
                          disabled={
                            updateSchedule.isPending ||
                            scheduleDraftValue(schedule).trim().length === 0
                          }
                        >
                          <Save className="h-3 w-3 mr-1" />
                          Save
                        </Button>
                      </div>
                      <div className="mt-1 text-[10px] text-muted-foreground">
                        {schedule.timezone} - {schedule.enabled ? "enabled" : "disabled"} - next{" "}
                        {schedule.nextTriggerAt ? timeAgo(schedule.nextTriggerAt) : "not scheduled"}
                      </div>
                    </div>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          );
        })()}
        {(issue.labels ?? []).length > 0 && (
          <span className="hidden md:flex items-center gap-1 max-w-[240px] overflow-hidden">
            {(issue.labels ?? []).slice(0, 3).map((label) => (
              <span
                key={label.id}
                className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                style={{
                  borderColor: label.color,
                  color: label.color,
                  backgroundColor: `${label.color}1f`,
                }}
              >
                {label.name}
              </span>
            ))}
            {(issue.labels ?? []).length > 3 && (
              <span className="text-[10px] text-muted-foreground">+{(issue.labels ?? []).length - 3}</span>
            )}
          </span>
        )}
        <Popover
          open={assigneePickerIssueId === issue.id}
          onOpenChange={(open) => {
            setAssigneePickerIssueId(open ? issue.id : null);
            if (!open) setAssigneeSearch("");
          }}
        >
          <PopoverTrigger asChild>
            <button
              className="flex w-[180px] shrink-0 items-center rounded-md px-2 py-1 hover:bg-accent/50 transition-colors"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              {issue.assigneeAgentId && agentName(issue.assigneeAgentId) ? (
                <Identity name={agentName(issue.assigneeAgentId)!} size="sm" />
              ) : (
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/35 bg-muted/30">
                    <User className="h-3 w-3" />
                  </span>
                  Assignee
                </span>
              )}
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="w-56 p-1"
            align="end"
            onClick={(e) => e.stopPropagation()}
            onPointerDownOutside={() => setAssigneeSearch("")}
          >
            <input
              className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
              placeholder="Search agents..."
              value={assigneeSearch}
              onChange={(e) => setAssigneeSearch(e.target.value)}
              autoFocus
            />
            <div className="max-h-48 overflow-y-auto overscroll-contain">
              <button
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                  !issue.assigneeAgentId && "bg-accent"
                )}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  assignIssue(issue.id, null);
                }}
              >
                No assignee
              </button>
              {(agents ?? [])
                .filter((agent) => {
                  if (!assigneeSearch.trim()) return true;
                  return agent.name.toLowerCase().includes(assigneeSearch.toLowerCase());
                })
                .map((agent) => (
                  <button
                    key={agent.id}
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
                      issue.assigneeAgentId === agent.id && "bg-accent"
                    )}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      assignIssue(issue.id, agent.id);
                    }}
                  >
                    <Identity name={agent.name} size="sm" className="min-w-0" />
                  </button>
                ))}
            </div>
          </PopoverContent>
        </Popover>
        <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
          {formatDateTime(issue.updatedAt)}
        </span>
      </span>
    </Link>
  ), [issueLinkState, onUpdateIssue, recurringIssueIds, liveIssueIds, recurringByIssueId, recurringPickerIssueId, updateSchedule, scheduleDraftValue, recurringDrafts, assigneePickerIssueId, assigneeSearch, agentName, agents]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 sm:gap-3">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Button size="sm" variant="outline" onClick={() => openNewIssue(newIssueDefaults())}>
            <Plus className="h-4 w-4 sm:mr-1" />
            <span className="hidden sm:inline">New Issue</span>
          </Button>
          <div className="relative w-48 sm:w-64 md:w-80">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={issueSearch}
              onChange={(e) => {
                setIssueSearch(e.target.value);
                onSearchChange?.(e.target.value);
              }}
              placeholder="Search issues..."
              className="pl-7 text-xs sm:text-sm"
              aria-label="Search issues"
            />
          </div>
        </div>

        <div className="flex items-center gap-0.5 sm:gap-1 shrink-0">
          <Select
            value={viewState.recurringFilter}
            onValueChange={(value) =>
              updateView({ recurringFilter: value as "all" | "recurring_only" })
            }
          >
            <SelectTrigger className="h-8 w-[130px] text-xs">
              <SelectValue placeholder="Scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All issues</SelectItem>
              <SelectItem value="recurring_only">Recurring only</SelectItem>
            </SelectContent>
          </Select>

          {/* View mode toggle */}
          <div className="flex items-center border border-border rounded-md overflow-hidden mr-1">
            <button
              className={`p-1.5 transition-colors ${viewState.viewMode === "list" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateView({ viewMode: "list" })}
              title="List view"
            >
              <List className="h-3.5 w-3.5" />
            </button>
            <button
              className={`p-1.5 transition-colors ${viewState.viewMode === "board" ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              onClick={() => updateView({ viewMode: "board" })}
              title="Board view"
            >
              <Columns3 className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Filter */}
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className={`text-xs ${activeFilterCount > 0 ? "text-blue-600 dark:text-blue-400" : ""}`}>
                <Filter className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                <span className="hidden sm:inline">{activeFilterCount > 0 ? `Filters: ${activeFilterCount}` : "Filter"}</span>
                {activeFilterCount > 0 && (
                  <span className="sm:hidden text-[10px] font-medium ml-0.5">{activeFilterCount}</span>
                )}
                {activeFilterCount > 0 && (
                  <X
                    className="h-3 w-3 ml-1 hidden sm:block"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateView({ statuses: [], priorities: [], assignees: [], labels: [], recurringFilter: "all" });
                    }}
                  />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(480px,calc(100vw-2rem))] p-0">
              <div className="p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Filters</span>
                  {activeFilterCount > 0 && (
                    <button
                      className="text-xs text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        updateView({
                          statuses: [],
                          priorities: [],
                          assignees: [],
                          labels: [],
                          recurringFilter: "all",
                        })
                      }
                    >
                      Clear
                    </button>
                  )}
                </div>

                {/* Quick filters */}
                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Quick filters</span>
                  <div className="flex flex-wrap gap-1.5">
                    {quickFilterPresets.map((preset) => {
                      const isActive = arraysEqual(viewState.statuses, preset.statuses);
                      return (
                        <button
                          key={preset.label}
                          className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                            isActive
                              ? "bg-primary text-primary-foreground border-primary"
                              : "border-border text-muted-foreground hover:text-foreground hover:border-foreground/30"
                          }`}
                          onClick={() => updateView({ statuses: isActive ? [] : [...preset.statuses] })}
                        >
                          {preset.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="border-t border-border" />

                <div className="space-y-1.5">
                  <span className="text-xs text-muted-foreground">Scope</span>
                  <label className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                    <Checkbox
                      checked={viewState.recurringFilter === "recurring_only"}
                      onCheckedChange={(checked) =>
                        updateView({ recurringFilter: checked ? "recurring_only" : "all" })
                      }
                    />
                    <Clock3 className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm">Recurring only</span>
                  </label>
                </div>

                <div className="border-t border-border" />

                {/* Multi-column filter sections */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                  {/* Status */}
                  <div className="space-y-1">
                    <span className="text-xs text-muted-foreground">Status</span>
                    <div className="space-y-0.5">
                      {statusOrder.map((s) => (
                        <label key={s} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                          <Checkbox
                            checked={viewState.statuses.includes(s)}
                            onCheckedChange={() => updateView({ statuses: toggleInArray(viewState.statuses, s) })}
                          />
                          <StatusIcon status={s} />
                          <span className="text-sm">{statusLabel(s)}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  {/* Priority + Assignee stacked in right column */}
                  <div className="space-y-3">
                    {/* Priority */}
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Priority</span>
                      <div className="space-y-0.5">
                        {priorityOrder.map((p) => (
                          <label key={p} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                            <Checkbox
                              checked={viewState.priorities.includes(p)}
                              onCheckedChange={() => updateView({ priorities: toggleInArray(viewState.priorities, p) })}
                            />
                            <PriorityIcon priority={p} />
                            <span className="text-sm">{statusLabel(p)}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* Assignee */}
                    {agents && agents.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">Assignee</span>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {agents.map((agent) => (
                            <label key={agent.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                              <Checkbox
                                checked={viewState.assignees.includes(agent.id)}
                                onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, agent.id) })}
                              />
                              <span className="text-sm">{agent.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}

                    {labels && labels.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">Labels</span>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {labels.map((label) => (
                            <label key={label.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                              <Checkbox
                                checked={viewState.labels.includes(label.id)}
                                onCheckedChange={() => updateView({ labels: toggleInArray(viewState.labels, label.id) })}
                              />
                              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: label.color }} />
                              <span className="text-sm">{label.name}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          {/* Sort (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs">
                  <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Sort</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-48 p-0">
                <div className="p-2 space-y-0.5">
                  {([
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["title", "Title"],
                    ["created", "Created"],
                    ["updated", "Updated"],
                  ] as const).map(([field, label]) => (
                    <button
                      key={field}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.sortField === field ? "bg-accent/50 text-foreground" : "hover:bg-accent/50 text-muted-foreground"
                      }`}
                      onClick={() => {
                        if (viewState.sortField === field) {
                          updateView({ sortDir: viewState.sortDir === "asc" ? "desc" : "asc" });
                        } else {
                          updateView({ sortField: field, sortDir: "asc" });
                        }
                      }}
                    >
                      <span>{label}</span>
                      {viewState.sortField === field && (
                        <span className="text-xs text-muted-foreground">
                          {viewState.sortDir === "asc" ? "\u2191" : "\u2193"}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}

          {/* Group (list view only) */}
          {viewState.viewMode === "list" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs">
                  <Layers className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                  <span className="hidden sm:inline">Group</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-0">
                <div className="p-2 space-y-0.5">
                  {([
                    ["status", "Status"],
                    ["priority", "Priority"],
                    ["assignee", "Assignee"],
                    ["recurring", "Recurring"],
                    ["none", "None"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      className={`flex items-center justify-between w-full px-2 py-1.5 text-sm rounded-sm ${
                        viewState.groupBy === value ? "bg-accent/50 text-foreground" : "hover:bg-accent/50 text-muted-foreground"
                      }`}
                      onClick={() => updateView({ groupBy: value })}
                    >
                      <span>{label}</span>
                      {viewState.groupBy === value && <Check className="h-3.5 w-3.5" />}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>

      {!isLoading && upcomingSchedules.length > 0 && (
        <Collapsible defaultOpen>
          <div className="flex items-center py-1.5 pl-1 pr-3">
            <CollapsibleTrigger className="flex items-center gap-1.5">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
              <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-sm font-semibold uppercase tracking-wide">
                Upcoming
              </span>
              <span className="text-xs text-muted-foreground font-normal normal-case ml-1">
                ({upcomingSchedules.length})
              </span>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            <div className="border border-border rounded-lg mb-4 divide-y divide-border">
              {upcomingSchedules.map((schedule) => {
                const linkedIssue = schedule.issueId
                  ? issues.find((i) => i.id === schedule.issueId)
                  : null;
                const assignedAgent = agents?.find((a) => a.id === schedule.agentId);
                return (
                  <div key={schedule.id} className="flex items-start gap-3 px-3 py-2.5 hover:bg-accent/50 transition-colors">
                    <CalendarClock className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium truncate">{schedule.name}</span>
                        {linkedIssue && (
                          <Link
                            to={`/issues/${linkedIssue.identifier ?? linkedIssue.id}`}
                            className="text-xs text-muted-foreground hover:text-foreground truncate font-mono"
                          >
                            {linkedIssue.identifier ?? linkedIssue.id.slice(0, 8)}
                          </Link>
                        )}
                        <span className={cn(
                          "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] shrink-0",
                          schedule.issueMode === "create_new"
                            ? "border border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : "border border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400"
                        )}>
                          {schedule.issueMode === "create_new" ? "new" : schedule.issueMode === "reopen_existing" ? "reopen" : "reuse"}
                        </span>
                      </div>
                      {linkedIssue?.description && (
                        <span className="line-clamp-1 text-[11px] text-muted-foreground mt-0.5 block">
                          {linkedIssue.description.replace(/[\n\r]+/g, " ").slice(0, 120)}
                        </span>
                      )}
                      <div className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                        {assignedAgent && <Identity name={assignedAgent.name} size="xs" />}
                        {!assignedAgent && <span>{schedule.agentId.slice(0, 8)}</span>}
                        <span>&middot;</span>
                        <span className="font-mono">{schedule.expression}</span>
                        <span>&middot;</span>
                        <span className="tabular-nums">{formatDateTime(schedule.nextTriggerAt!)}</span>
                      </div>
                    </div>
                    <span className="text-xs font-medium text-muted-foreground shrink-0 tabular-nums mt-0.5">
                      {timeUntil(schedule.nextTriggerAt!)}
                    </span>
                  </div>
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {isLoading && <PageSkeleton variant="issues-list" />}
      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {!isLoading && filtered.length === 0 && viewState.viewMode === "list" && (
        <EmptyState
          icon={CircleDot}
          message="No issues match the current filters or search."
          action="Create Issue"
          onAction={() => openNewIssue(newIssueDefaults())}
        />
      )}

      {viewState.viewMode === "board" ? (
        <KanbanBoard
          issues={filtered}
          agents={agents}
          liveIssueIds={liveIssueIds}
          recurringIssueIds={recurringIssueIds}
          onUpdateIssue={onUpdateIssue}
        />
      ) : (
        <>
          {viewState.groupBy === "none" ? (
            <>
              {activeIssues.length > 0 && (
                <IssueSection
                  sectionKey="__active"
                  label="Active"
                  icon={<Zap className="h-3.5 w-3.5 text-muted-foreground" />}
                  items={activeIssues}
                  defaultOpen
                  collapsedGroups={viewState.collapsedGroups}
                  onToggle={(key, open) => updateView({
                    collapsedGroups: open
                      ? viewState.collapsedGroups.filter((k) => k !== key)
                      : [...viewState.collapsedGroups, key],
                  })}
                  renderRow={renderIssueRow}
                />
              )}
              {pastIssues.length > 0 && (
                <IssueSection
                  sectionKey="__past"
                  label="Past"
                  icon={<History className="h-3.5 w-3.5 text-muted-foreground" />}
                  items={pastIssues}
                  defaultOpen={false}
                  collapsedGroups={viewState.collapsedGroups}
                  onToggle={(key, open) => updateView({
                    collapsedGroups: open
                      ? [...viewState.collapsedGroups, key]
                      : viewState.collapsedGroups.filter((k) => k !== key),
                  })}
                  renderRow={renderIssueRow}
                />
              )}
            </>
          ) : (
            groupedContent.map((group) => (
              <IssueSection
                key={group.key}
                sectionKey={group.key}
                label={group.label}
                items={group.items}
                defaultOpen
                collapsedGroups={viewState.collapsedGroups}
                onToggle={(key, open) => updateView({
                  collapsedGroups: open
                    ? viewState.collapsedGroups.filter((k) => k !== key)
                    : [...viewState.collapsedGroups, key],
                })}
                renderRow={renderIssueRow}
                onAdd={() => openNewIssue(newIssueDefaults(group.key))}
              />
            ))
          )}
        </>
      )}
    </div>
  );
}

/* ── Reusable collapsible section for issue groups ── */

function IssueSection({
  sectionKey,
  label,
  icon,
  items,
  defaultOpen = true,
  collapsedGroups,
  onToggle,
  renderRow,
  onAdd,
}: {
  sectionKey: string;
  label: string | null;
  icon?: React.ReactNode;
  items: Issue[];
  defaultOpen?: boolean;
  collapsedGroups: string[];
  onToggle: (key: string, open: boolean) => void;
  renderRow: (issue: Issue) => React.ReactNode;
  onAdd?: () => void;
}) {
  const inCollapsed = collapsedGroups.includes(sectionKey);
  const effectiveOpen = defaultOpen ? !inCollapsed : inCollapsed;

  return (
    <Collapsible
      open={effectiveOpen}
      onOpenChange={(open) => onToggle(sectionKey, open)}
    >
      {label && (
        <div className="flex items-center py-1.5 pl-1 pr-3">
          <CollapsibleTrigger className="flex items-center gap-1.5">
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
            {icon}
            <span className="text-sm font-semibold uppercase tracking-wide">
              {label}
            </span>
            <span className="text-xs text-muted-foreground font-normal normal-case">
              ({items.length})
            </span>
          </CollapsibleTrigger>
          {onAdd && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="ml-auto text-muted-foreground"
              onClick={onAdd}
            >
              <Plus className="h-3 w-3" />
            </Button>
          )}
        </div>
      )}
      <CollapsibleContent>
        <div className="border border-border rounded-lg divide-y divide-border mb-4">
          {items.map(renderRow)}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
