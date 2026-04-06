/**
 * RaavaTasks — Raava-branded Tasks list page (Figma Screen 15).
 *
 * Rendered when `isRaava` is true, replacing the default Issues list.
 * Uses pill-style filter tabs, full-width search bar, and a Raava-styled
 * task table with status icons, monospace IDs, avatars, and priority badges.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialog } from "../context/DialogContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState, createIssueDetailPath } from "../lib/issueDetailBreadcrumb";
import { timeAgo } from "../lib/timeAgo";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { Identity } from "../components/Identity";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle2, Circle, Clock, Search, Plus, ListTodo } from "lucide-react";
import type { Issue } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Filter tab definitions
// ---------------------------------------------------------------------------

type TaskFilter = "all" | "in_progress" | "waiting" | "completed" | "todo";

const FILTER_STATUS_MAP: Record<TaskFilter, string[] | null> = {
  all: null,
  in_progress: ["in_progress"],
  waiting: ["in_review", "blocked"],
  completed: ["done", "cancelled"],
  todo: ["todo", "backlog"],
};

function filterLabel(filter: TaskFilter): string {
  switch (filter) {
    case "all":
      return "All";
    case "in_progress":
      return "In Progress";
    case "waiting":
      return "Waiting on You";
    case "completed":
      return "Completed";
    case "todo":
      return "To Do";
  }
}

function countForFilter(issues: Issue[], filter: TaskFilter): number {
  const statuses = FILTER_STATUS_MAP[filter];
  if (!statuses) return issues.length;
  return issues.filter((i) => statuses.includes(i.status)).length;
}

// ---------------------------------------------------------------------------
// Status indicator for table rows
// ---------------------------------------------------------------------------

function TaskStatusDot({ status }: { status: string }) {
  switch (status) {
    case "done":
    case "cancelled":
      return <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />;
    case "in_progress":
      return <Clock className="h-4 w-4 text-yellow-500 shrink-0" />;
    case "in_review":
    case "blocked":
      return (
        <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
          <span className="absolute h-2.5 w-2.5 rounded-full bg-orange-400 animate-pulse opacity-50" />
          <span className="relative h-2 w-2 rounded-full bg-orange-500" />
        </span>
      );
    default:
      return <Circle className="h-4 w-4 text-blue-500 shrink-0" />;
  }
}

// ---------------------------------------------------------------------------
// Priority badge
// ---------------------------------------------------------------------------

const PRIORITY_BADGE: Record<string, { label: string; className: string }> = {
  critical: { label: "Critical", className: "bg-red-500/10 text-red-600 dark:text-red-400" },
  high: { label: "High", className: "bg-orange-500/10 text-orange-600 dark:text-orange-400" },
  medium: { label: "Medium", className: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400" },
  low: { label: "Low", className: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
};

function PriorityBadge({ priority }: { priority: string }) {
  const config = PRIORITY_BADGE[priority] ?? PRIORITY_BADGE.medium!;
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap", config.className)}>
      {config.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function RaavaTasks() {
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialog();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const [activeFilter, setActiveFilter] = useState<TaskFilter>("all");
  const [searchValue, setSearchValue] = useState(searchParams.get("q") ?? "");

  useEffect(() => {
    setBreadcrumbs([{ label: "Tasks" }]);
  }, [setBreadcrumbs]);

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Tasks",
        `${location.pathname}${location.search}${location.hash}`,
        "issues",
      ),
    [location.pathname, location.search, location.hash],
  );

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const a of agents ?? []) map.set(a.id, a);
    return map;
  }, [agents]);

  // Search filtering
  const { data: searchedIssues, isLoading: isSearchLoading, error: searchError } = useQuery({
    queryKey: queryKeys.issues.search(selectedCompanyId!, searchValue.trim()),
    queryFn: () => issuesApi.list(selectedCompanyId!, { q: searchValue.trim() }),
    enabled: !!selectedCompanyId && searchValue.trim().length > 0,
    placeholderData: (prev) => prev,
  });

  const isSearchActive = searchValue.trim().length > 0;
  const baseIssues = isSearchActive ? (searchedIssues ?? []) : (issues ?? []);

  const filteredIssues = useMemo(() => {
    const statuses = FILTER_STATUS_MAP[activeFilter];
    if (!statuses) return baseIssues;
    return baseIssues.filter((i) => statuses.includes(i.status));
  }, [baseIssues, activeFilter]);

  const sortedIssues = useMemo(
    () => [...filteredIssues].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [filteredIssues],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={ListTodo} message="Select a company to view tasks." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (error) {
    return (
      <div className="raava-card bg-destructive/5 p-6 text-center">
        <p className="text-sm text-destructive">{(error as Error).message}</p>
      </div>
    );
  }

  const allIssues = issues ?? [];
  const filters: TaskFilter[] = ["all", "in_progress", "waiting", "completed", "todo"];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-[22px] text-foreground">Tasks</h1>
        <Button variant="gradient" size="sm" onClick={() => openNewIssue({})}>
          <Plus className="h-4 w-4 mr-1" />
          New Task
        </Button>
      </div>

      {/* Filter pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {filters.map((filter) => {
          const count = countForFilter(allIssues, filter);
          const isActive = activeFilter === filter;
          return (
            <button
              key={filter}
              type="button"
              onClick={() => setActiveFilter(filter)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[13px] font-medium transition-colors",
                isActive
                  ? "[background:linear-gradient(90deg,#224AE8,#716EFF,#00BDB7)] text-white"
                  : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {filterLabel(filter)}
              <span
                className={cn(
                  "inline-flex items-center justify-center rounded-full px-1.5 min-w-[20px] text-[11px] font-semibold",
                  isActive ? "bg-white/20 text-white" : "bg-background text-muted-foreground",
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Search bar */}
      <div className="relative w-full">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          placeholder="Search tasks..."
          className="w-full pl-9 text-sm"
          aria-label="Search tasks"
        />
      </div>

      {/* Task table */}
      <div className="raava-card overflow-hidden bg-white dark:bg-card">
        {/* Table header */}
        <div className="hidden sm:grid grid-cols-[auto_80px_1fr_180px_100px_100px] items-center gap-3 border-b border-border px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <span className="w-5" />
          <span>ID</span>
          <span>Title</span>
          <span>Assigned To</span>
          <span>Priority</span>
          <span className="text-right">Updated</span>
        </div>

        {/* Rows */}
        {isSearchActive && searchError ? (
          <div className="px-5 py-8 text-center text-sm text-destructive">
            {searchError instanceof Error ? searchError.message : "Search failed."}
          </div>
        ) : isSearchActive && isSearchLoading ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            Searching...
          </div>
        ) : sortedIssues.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-muted-foreground">
            No tasks found.
          </div>
        ) : (
          sortedIssues.map((issue) => {
            const assigneeName = issue.assigneeAgentId
              ? agentMap.get(issue.assigneeAgentId)?.name ?? null
              : null;
            const identifier = issue.identifier ?? issue.id.slice(0, 8);

            return (
              <Link
                key={issue.id}
                to={createIssueDetailPath(issue.identifier ?? issue.id, issueLinkState)}
                state={issueLinkState}
                className="group grid grid-cols-1 sm:grid-cols-[auto_80px_1fr_180px_100px_100px] items-center gap-2 sm:gap-3 border-b border-border px-5 py-3 text-sm no-underline text-inherit transition-colors hover:bg-accent/40 last:border-b-0"
              >
                {/* Status icon */}
                <span className="hidden sm:flex w-5 justify-center">
                  <TaskStatusDot status={issue.status} />
                </span>

                {/* Mobile row: combined */}
                <span className="sm:hidden flex items-center gap-2">
                  <TaskStatusDot status={issue.status} />
                  <span className="font-mono text-xs text-muted-foreground">{identifier}</span>
                  <span className="truncate font-medium text-foreground">{issue.title}</span>
                </span>

                {/* ID */}
                <span className="hidden sm:inline font-mono text-xs text-muted-foreground">
                  {identifier}
                </span>

                {/* Title */}
                <span className="hidden sm:inline truncate font-medium text-foreground">
                  {issue.title}
                </span>

                {/* Assigned To */}
                <span className="hidden sm:inline">
                  {assigneeName ? (
                    <Identity name={assigneeName} size="sm" />
                  ) : (
                    <span className="text-xs text-muted-foreground">Unassigned</span>
                  )}
                </span>

                {/* Priority */}
                <span className="hidden sm:inline">
                  <PriorityBadge priority={issue.priority} />
                </span>

                {/* Updated */}
                <span className="hidden sm:inline text-right text-xs text-muted-foreground">
                  {timeAgo(issue.updatedAt)}
                </span>
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
