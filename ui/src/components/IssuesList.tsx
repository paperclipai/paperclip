import { useDeferredValue, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { issuesApi } from "../api/issues";
import { authApi } from "../api/auth";
import { queryKeys } from "../lib/queryKeys";
import { formatAssigneeUserLabel } from "../lib/assignees";
import { groupBy } from "../lib/groupBy";
import { formatDate, cn } from "../lib/utils";
import { timeAgo } from "../lib/timeAgo";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./PriorityIcon";
import { EmptyState } from "./EmptyState";
import { Identity } from "./Identity";
import { IssueRow } from "./IssueRow";
import { PageSkeleton } from "./PageSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { CircleDot, Plus, Filter, ArrowUpDown, Layers, Check, X, ChevronRight, List, Columns3, User, Search } from "lucide-react";
import { KanbanBoard } from "./KanbanBoard";
import type { Issue } from "@paperclipai/shared";

/* ── Helpers ── */

const statusOrder = ["in_progress", "todo", "backlog", "in_review", "blocked", "done", "cancelled"];
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
  projects: string[];
  sortField: "status" | "priority" | "title" | "created" | "updated";
  sortDir: "asc" | "desc";
  groupBy: "status" | "priority" | "assignee" | "none";
  viewMode: "list" | "board";
  collapsedGroups: string[];
};

const defaultViewState: IssueViewState = {
  statuses: [],
  priorities: [],
  assignees: [],
  labels: [],
  projects: [],
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

function applyFilters(issues: Issue[], state: IssueViewState, currentUserId?: string | null): Issue[] {
  let result = issues;
  if (state.statuses.length > 0) result = result.filter((i) => state.statuses.includes(i.status));
  if (state.priorities.length > 0) result = result.filter((i) => state.priorities.includes(i.priority));
  if (state.assignees.length > 0) {
    result = result.filter((issue) => {
      for (const assignee of state.assignees) {
        if (assignee === "__unassigned" && !issue.assigneeAgentId && !issue.assigneeUserId) return true;
        if (assignee === "__me" && currentUserId && issue.assigneeUserId === currentUserId) return true;
        if (issue.assigneeAgentId === assignee) return true;
      }
      return false;
    });
  }
  if (state.labels.length > 0) result = result.filter((i) => (i.labelIds ?? []).some((id) => state.labels.includes(id)));
  if (state.projects.length > 0) result = result.filter((i) => i.projectId != null && state.projects.includes(i.projectId));
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
  if (state.projects.length > 0) count++;
  return count;
}

function matchesIssueSearch(issue: Issue, normalizedSearch: string): boolean {
  if (!normalizedSearch) return true;

  return [
    issue.identifier,
    issue.title,
    issue.description,
  ]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(normalizedSearch));
}

/* ── Component ── */

interface Agent {
  id: string;
  name: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface IssuesListProps {
  issues: Issue[];
  isLoading?: boolean;
  error?: Error | null;
  agents?: Agent[];
  projects?: ProjectOption[];
  liveIssueIds?: Set<string>;
  projectId?: string;
  viewStateKey: string;
  issueLinkState?: unknown;
  initialAssignees?: string[];
  initialSearch?: string;
  searchFilters?: {
    participantAgentId?: string;
  };
  onSearchChange?: (search: string) => void;
  onUpdateIssue: (id: string, data: Record<string, unknown>) => void;
}

export function IssuesList({
  issues,
  isLoading,
  error,
  agents,
  projects,
  liveIssueIds,
  projectId,
  viewStateKey,
  issueLinkState,
  initialAssignees,
  initialSearch,
  searchFilters,
  onSearchChange,
  onUpdateIssue,
}: IssuesListProps) {
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  // Scope the storage key per company so folding/view state is independent across companies.
  const scopedKey = selectedCompanyId ? `${viewStateKey}:${selectedCompanyId}` : viewStateKey;

  const [viewState, setViewState] = useState<IssueViewState>(() => {
    if (initialAssignees) {
      return { ...defaultViewState, assignees: initialAssignees, statuses: [] };
    }
    return getViewState(scopedKey);
  });
  const [assigneePickerIssueId, setAssigneePickerIssueId] = useState<string | null>(null);
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set());
  const [assigneeSearch, setAssigneeSearch] = useState("");
  const [issueSearch, setIssueSearch] = useState(initialSearch ?? "");
  const deferredIssueSearch = useDeferredValue(issueSearch);
  const normalizedIssueSearch = deferredIssueSearch.trim().toLowerCase();

  useEffect(() => {
    setIssueSearch(initialSearch ?? "");
  }, [initialSearch]);

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
  const agentName = useCallback((id: string | null) => {
    if (!id || !agents) return null;
    return agents.find((a) => a.id === id)?.name ?? null;
  }, [agents]);

  const filtered = useMemo(() => {
    const sourceIssues = normalizedIssueSearch.length > 0
      ? issues.filter((issue) => matchesIssueSearch(issue, normalizedIssueSearch))
      : issues;
    const filteredByControls = applyFilters(sourceIssues, viewState, currentUserId);
    return sortIssues(filteredByControls, viewState);
  }, [issues, viewState, normalizedIssueSearch, currentUserId]);

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const activeFilterCount = countActiveFilters(viewState);

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
    // assignee
    const groups = groupBy(
      filtered,
      (issue) => issue.assigneeAgentId ?? (issue.assigneeUserId ? `__user:${issue.assigneeUserId}` : "__unassigned"),
    );
    return Object.keys(groups).map((key) => ({
      key,
      label:
        key === "__unassigned"
          ? "Unassigned"
          : key.startsWith("__user:")
            ? (formatAssigneeUserLabel(key.slice("__user:".length), currentUserId) ?? "User")
            : (agentName(key) ?? key.slice(0, 8)),
      items: groups[key]!,
    }));
  }, [filtered, viewState.groupBy, agents, agentName, currentUserId]);

  const newIssueDefaults = useCallback((groupKey?: string) => {
    const defaults: Record<string, string> = {};
    if (projectId) defaults.projectId = projectId;
    if (groupKey) {
      if (viewState.groupBy === "status") defaults.status = groupKey;
      else if (viewState.groupBy === "priority") defaults.priority = groupKey;
      else if (viewState.groupBy === "assignee" && groupKey !== "__unassigned") {
        if (groupKey.startsWith("__user:")) defaults.assigneeUserId = groupKey.slice("__user:".length);
        else defaults.assigneeAgentId = groupKey;
      }
    }
    return defaults;
  }, [projectId, viewState.groupBy]);

  const assignIssue = useCallback((issueId: string, assigneeAgentId: string | null, assigneeUserId: string | null = null) => {
    onUpdateIssue(issueId, { assigneeAgentId, assigneeUserId });
    setAssigneePickerIssueId(null);
    setAssigneeSearch("");
  }, [onUpdateIssue]);


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
                      updateView({ statuses: [], priorities: [], assignees: [], labels: [], projects: [] });
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
                      onClick={() => updateView({ statuses: [], priorities: [], assignees: [], labels: [] })}
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
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Assignee</span>
                      <div className="space-y-0.5 max-h-32 overflow-y-auto">
                        <label className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                          <Checkbox
                            checked={viewState.assignees.includes("__unassigned")}
                            onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, "__unassigned") })}
                          />
                          <span className="text-sm">No assignee</span>
                        </label>
                        {currentUserId && (
                          <label className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                            <Checkbox
                              checked={viewState.assignees.includes("__me")}
                              onCheckedChange={() => updateView({ assignees: toggleInArray(viewState.assignees, "__me") })}
                            />
                            <User className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-sm">Me</span>
                          </label>
                        )}
                        {(agents ?? []).map((agent) => (
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

                    {projects && projects.length > 0 && (
                      <div className="space-y-1">
                        <span className="text-xs text-muted-foreground">Project</span>
                        <div className="space-y-0.5 max-h-32 overflow-y-auto">
                          {projects.map((project) => (
                            <label key={project.id} className="flex items-center gap-2 px-2 py-1 rounded-sm hover:bg-accent/50 cursor-pointer">
                              <Checkbox
                                checked={viewState.projects.includes(project.id)}
                                onCheckedChange={() => updateView({ projects: toggleInArray(viewState.projects, project.id) })}
                              />
                              <span className="text-sm">{project.name}</span>
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
          onUpdateIssue={onUpdateIssue}
        />
      ) : (
        groupedContent.map((group) => (
          <Collapsible
            key={group.key}
            open={!viewState.collapsedGroups.includes(group.key)}
            onOpenChange={(open) => {
              updateView({
                collapsedGroups: open
                  ? viewState.collapsedGroups.filter((k) => k !== group.key)
                  : [...viewState.collapsedGroups, group.key],
              });
            }}
          >
            {group.label && (
              <div className="flex items-center py-1.5 pl-1 pr-3">
                <CollapsibleTrigger className="flex items-center gap-1.5">
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
                  <span className="text-sm font-semibold uppercase tracking-wide">
                    {group.label}
                  </span>
                </CollapsibleTrigger>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto text-muted-foreground"
                  onClick={() => openNewIssue(newIssueDefaults(group.key))}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>
            )}
            <CollapsibleContent>
              {(() => {
                const itemIds = new Set(group.items.map((i) => i.id));
                const roots = group.items.filter((i) => !i.parentId || !itemIds.has(i.parentId));
                const childMap = new Map<string, Issue[]>();
                for (const item of group.items) {
                  if (item.parentId && itemIds.has(item.parentId)) {
                    const arr = childMap.get(item.parentId) ?? [];
                    arr.push(item);
                    childMap.set(item.parentId, arr);
                  }
                }

                const renderIssueRow = (issue: Issue, isChild: boolean) => {
                  const children = childMap.get(issue.id) ?? [];
                  const hasChildren = children.length > 0;
                  const isExpanded = !collapsedParents.has(issue.id);
                  const toggleCollapse = (e: { preventDefault: () => void; stopPropagation: () => void }) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setCollapsedParents((prev) => {
                      const next = new Set(prev);
                      if (next.has(issue.id)) next.delete(issue.id); else next.add(issue.id);
                      return next;
                    });
                  };

                  return (
                    <div key={issue.id}>
                      <IssueRow
                        issue={issue}
                        issueLinkState={issueLinkState}
                        className={isChild ? "pl-6 sm:pl-7" : undefined}
                        mobileLeading={
                          hasChildren ? (
                            <button type="button" onClick={toggleCollapse}>
                              <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
                            </button>
                          ) : (
                            <span onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
                              <StatusIcon status={issue.status} onChange={(s) => onUpdateIssue(issue.id, { status: s })} />
                            </span>
                          )
                        }
                        desktopMetaLeading={(
                          <>
                            {hasChildren ? (
                              <button
                                type="button"
                                className="hidden shrink-0 items-center sm:inline-flex"
                                onClick={toggleCollapse}
                              >
                                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", isExpanded && "rotate-90")} />
                              </button>
                            ) : (
                              <span className="hidden w-3.5 shrink-0 sm:block" />
                            )}
                            <span
                              className="hidden shrink-0 sm:inline-flex"
                              onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                            >
                              <StatusIcon status={issue.status} onChange={(s) => onUpdateIssue(issue.id, { status: s })} />
                            </span>
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              {issue.identifier ?? issue.id.slice(0, 8)}
                            </span>
                            {liveIssueIds?.has(issue.id) && (
                              <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-1.5 py-0.5 sm:gap-1.5 sm:px-2">
                                <span className="relative flex h-2 w-2">
                                  <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
                                  <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
                                </span>
                                <span className="hidden text-[11px] font-medium text-blue-600 dark:text-blue-400 sm:inline">
                                  Live
                                </span>
                              </span>
                            )}
                          </>
                        )}
                        mobileMeta={timeAgo(issue.updatedAt)}
                        desktopTrailing={(
                          <>
                            {(issue.labels ?? []).length > 0 && (
                              <span className="hidden items-center gap-1 overflow-hidden md:flex md:max-w-[240px]">
                                {(issue.labels ?? []).slice(0, 3).map((label) => (
                                  <span
                                    key={label.id}
                                    className="inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
                                    style={{
                                      borderColor: label.color,
                                      color: pickTextColorForPillBg(label.color, 0.12),
                                      backgroundColor: `${label.color}1f`,
                                    }}
                                  >
                                    {label.name}
                                  </span>
                                ))}
                                {(issue.labels ?? []).length > 3 && (
                                  <span className="text-[10px] text-muted-foreground">
                                    +{(issue.labels ?? []).length - 3}
                                  </span>
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
                                  className="flex w-[180px] shrink-0 items-center rounded-md px-2 py-1 transition-colors hover:bg-accent/50"
                                  onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
                                >
                                  {issue.assigneeAgentId && agentName(issue.assigneeAgentId) ? (
                                    <Identity name={agentName(issue.assigneeAgentId)!} size="sm" />
                                  ) : issue.assigneeUserId ? (
                                    <span className="inline-flex items-center gap-1.5 text-xs">
                                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-muted-foreground/35 bg-muted/30">
                                        <User className="h-3 w-3" />
                                      </span>
                                      {formatAssigneeUserLabel(issue.assigneeUserId, currentUserId) ?? "User"}
                                    </span>
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
                                  className="mb-1 w-full border-b border-border bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50"
                                  placeholder="Search assignees..."
                                  value={assigneeSearch}
                                  onChange={(e) => setAssigneeSearch(e.target.value)}
                                  autoFocus
                                />
                                <div className="max-h-48 overflow-y-auto overscroll-contain">
                                  <button
                                    className={cn(
                                      "flex w-full items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50",
                                      !issue.assigneeAgentId && !issue.assigneeUserId && "bg-accent",
                                    )}
                                    onClick={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      assignIssue(issue.id, null, null);
                                    }}
                                  >
                                    No assignee
                                  </button>
                                  {currentUserId && (
                                    <button
                                      className={cn(
                                        "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                                        issue.assigneeUserId === currentUserId && "bg-accent",
                                      )}
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        assignIssue(issue.id, null, currentUserId);
                                      }}
                                    >
                                      <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                      <span>Me</span>
                                    </button>
                                  )}
                                  {(agents ?? [])
                                    .filter((agent) => {
                                      if (!assigneeSearch.trim()) return true;
                                      return agent.name.toLowerCase().includes(assigneeSearch.toLowerCase());
                                    })
                                    .map((agent) => (
                                      <button
                                        key={agent.id}
                                        className={cn(
                                          "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50",
                                          issue.assigneeAgentId === agent.id && "bg-accent",
                                        )}
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          assignIssue(issue.id, agent.id, null);
                                        }}
                                      >
                                        <Identity name={agent.name} size="sm" className="min-w-0" />
                                      </button>
                                    ))}
                                </div>
                              </PopoverContent>
                            </Popover>
                          </>
                        )}
                        trailingMeta={formatDate(issue.createdAt)}
                      />
                      {hasChildren && isExpanded && children.map((child) => renderIssueRow(child, true))}
                    </div>
                  );
                };

                return roots.map((issue) => renderIssueRow(issue, false));
              })()}
            </CollapsibleContent>
          </Collapsible>
        ))
      )}
    </div>
  );
}
