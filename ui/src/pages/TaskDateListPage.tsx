import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { EmptyState } from "../components/EmptyState";
import { IssuesList, type IssueViewState } from "../components/IssuesList";
import { TaskScopeToggle, type TaskScope } from "../components/TaskScopeToggle";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import {
  addDays,
  dateLongLabel,
  formatDateOnly,
  taskDateRange,
  type TaskDatePreset,
} from "../lib/issue-date-ranges";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { queryKeys } from "../lib/queryKeys";

const ACTIVE_DATED_STATUS_FILTER = "backlog,todo,in_progress,in_review,blocked";

const pageLabels: Record<TaskDatePreset, string> = {
  today: "Today",
  tomorrow: "Tomorrow",
  next7: "Next 7 Days",
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

function replaceSearch(search: string) {
  const trimmedSearch = search.trim();
  const url = new URL(window.location.href);
  if (trimmedSearch) url.searchParams.set("q", trimmedSearch);
  else url.searchParams.delete("q");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

export function TodayTasks() {
  return <TaskDateListPage preset="today" />;
}

export function TomorrowTasks() {
  return <TaskDateListPage preset="tomorrow" />;
}

export function Next7DayTasks() {
  return <TaskDateListPage preset="next7" />;
}

export function TaskDateListPage({ preset }: { preset: TaskDatePreset }) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const today = formatDateOnly();
  const range = useMemo(() => taskDateRange(preset, today), [preset, today]);
  const [scope, setScope] = useState<TaskScope>(() => readScope(searchParams));
  const pageLabel = pageLabels[preset];
  const exactDueDate = range.dueDate ?? today;
  const initialSearch = searchParams.get("q") ?? "";

  useEffect(() => {
    setScope(readScope(searchParams));
  }, [searchParams]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const showMyScope = Boolean(currentUserId);
  const effectiveScope: TaskScope = scope === "my" && showMyScope ? "my" : "all";

  useEffect(() => {
    setBreadcrumbs([{ label: pageLabel }]);
  }, [pageLabel, setBreadcrumbs]);

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
    refetchInterval: 5000,
  });

  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        pageLabel,
        `${location.pathname}${location.search}${location.hash}`,
        "issues",
      ),
    [location.pathname, location.search, location.hash, pageLabel],
  );

  const filters = useMemo(
    () => ({
      status: ACTIVE_DATED_STATUS_FILTER,
      ...range,
      ...(effectiveScope === "my" ? { assigneeUserId: "me" } : {}),
    }),
    [effectiveScope, range],
  );

  const { data: issues, isLoading, error } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "date-list", preset, filters],
    queryFn: () => issuesApi.list(selectedCompanyId!, filters),
    enabled: !!selectedCompanyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(selectedCompanyId!) });
    },
  });

  const defaultViewStatePatch = useMemo<Partial<IssueViewState>>(
    () => ({
      viewMode: "list",
      sortField: "due",
      sortDir: "asc",
      groupBy: preset === "next7" ? "dueDate" : "none",
    }),
    [preset],
  );

  const defaultNewIssueValues = useMemo(() => {
    if (preset === "today") return { dueDate: today };
    if (preset === "tomorrow") return { dueDate: addDays(today, 1) };
    return { dueDate: today };
  }, [preset, today]);

  const topContent = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-y border-border py-2">
      <div className="min-w-0 text-xs text-muted-foreground">
        {preset === "next7"
          ? `${dateLongLabel(today)} - ${dateLongLabel(addDays(today, 6))}`
          : dateLongLabel(exactDueDate)}
      </div>
      <TaskScopeToggle
        value={effectiveScope}
        showMy={showMyScope}
        onChange={(nextScope) => {
          setScope(nextScope);
          replaceScope(nextScope);
        }}
      />
    </div>
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={CalendarDays} message="Select a company to view dated tasks." />;
  }

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveIssueIds={liveIssueIds}
      viewStateKey={`paperclip:tasks:${preset}`}
      issueLinkState={issueLinkState}
      defaultViewMode="list"
      defaultViewStatePatch={defaultViewStatePatch}
      lockedViewMode="list"
      lockedGroupBy={preset === "next7" ? "dueDate" : undefined}
      initialSearch={initialSearch}
      searchFilters={filters}
      defaultNewIssueValues={defaultNewIssueValues}
      emptyMessage={`No active tasks due ${preset === "next7" ? "in the next 7 days" : pageLabel.toLowerCase()}.`}
      topContent={topContent}
      onSearchChange={replaceSearch}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}
