import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "@/lib/router";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { usePublishSharedQueryData, useSharedPollingQuery } from "@/hooks/useSharedPolling";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { TaskViewsMenu } from "../components/TaskViewsMenu";
import { Button } from "@/components/ui/button";
import { CircleDot, Plus } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import { useCombinedInboxTasksEnabled } from "../hooks/useCombinedInboxTasksEnabled";
import { useDialogActions } from "../context/DialogContext";
import { useInboxBadge } from "../hooks/useInboxBadge";
import { Inbox } from "./Inbox";
import {
  ORGANIZATION_SCOPED_PARAMS,
  TASK_VIEW_PARAM,
  loadLastTaskView,
  normalizeTaskViewKey,
  resolveInitialTaskView,
  saveLastTaskView,
  taskView,
  type TaskViewKey,
} from "../lib/task-views";

const WORKSPACE_FILTER_ISSUE_LIMIT = 1000;
const ISSUES_PAGE_SIZE = 100;
export const ISSUES_ROW_PRESENTATION = "task" as const;
export const ISSUES_TOOLBAR_PRESENTATION = "collection" as const;

export function resolveIssuesPresentation(streamlinedUiEnabled: boolean) {
  return streamlinedUiEnabled
    ? { rowPresentation: ISSUES_ROW_PRESENTATION, toolbarPresentation: ISSUES_TOOLBAR_PRESENTATION }
    : { rowPresentation: "legacy" as const, toolbarPresentation: "legacy" as const };
}

export function getNextIssuesPageOffset(
  loadedPageSize: number,
  currentOffset: number,
  pageSize: number = ISSUES_PAGE_SIZE,
): number | undefined {
  return loadedPageSize >= pageSize ? currentOffset + pageSize : undefined;
}

export function mergeIssuePagesStable<T extends { id: string }>(pages: T[][]): T[] {
  const seenIssueIds = new Set<string>();
  const merged: T[] = [];

  for (const page of pages) {
    for (const issue of page) {
      if (seenIssueIds.has(issue.id)) continue;
      seenIssueIds.add(issue.id);
      merged.push(issue);
    }
  }

  return merged;
}

export function buildIssuesSearchUrl(currentHref: string, search: string): string | null {
  const url = new URL(currentHref);
  const currentSearch = url.searchParams.get("q") ?? "";
  if (currentSearch === search) return null;

  if (search.length > 0) {
    url.searchParams.set("q", search);
  } else {
    url.searchParams.delete("q");
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Tasks — the single task surface after PAP-670 merged Inbox into it.
 *
 * This component only resolves `?view=` to a view and hands off: My-work views
 * render the inbox list, organization views render the task collection. Both
 * get the same Views control in their toolbar, so the switch reads as one page.
 */
export function Issues() {
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const { enabled: combinedInboxTasksEnabled } = useCombinedInboxTasksEnabled();
  // The merged surface is Combined Inbox + Task List only. With the flag off, and always in
  // the legacy shell, Tasks is the plain task list and Inbox keeps its pages.
  return streamlinedUiEnabled && combinedInboxTasksEnabled ? <StreamlinedTasks /> : <OrganizationIssues />;
}

function StreamlinedTasks() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedCompanyId } = useCompany();
  const { openNewIssue } = useDialogActions();
  const inboxBadge = useInboxBadge(selectedCompanyId);

  const requestedView = searchParams.get(TASK_VIEW_PARAM);
  const hasOrganizationScopedParam = ORGANIZATION_SCOPED_PARAMS.some(
    (param) => (searchParams.get(param) ?? "").length > 0,
  );
  // Read the stored view once per mount so a later write can't yank the view
  // out from under the user mid-session.
  const [lastUsedView] = useState<TaskViewKey>(() => loadLastTaskView());
  const view = resolveInitialTaskView(requestedView, hasOrganizationScopedParam, lastUsedView);
  const definition = taskView(view);

  // Make the resolved view addressable without dropping the params that
  // brought the user here — and correct a requested view that was overridden
  // (an inbox view carrying an organization filter opens All tasks).
  useEffect(() => {
    if (normalizeTaskViewKey(requestedView) === view) return;
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set(TASK_VIEW_PARAM, view);
      return next;
    }, { replace: true });
  }, [requestedView, view, setSearchParams]);

  const selectView = useCallback((next: TaskViewKey) => {
    saveLastTaskView(next);
    // A view switch starts clean: the previous view's search and filters are
    // its own, not the new view's.
    navigate(`/issues?${TASK_VIEW_PARAM}=${next}`);
  }, [navigate]);

  const viewsMenu = (
    <TaskViewsMenu value={view} onChange={selectView} badgeCount={inboxBadge.inbox} />
  );

  if (definition.surface === "inbox") {
    return (
      <Inbox
        tab={definition.inboxTab}
        surfaceLabel="Tasks"
        toolbarContext={(
          <div className="flex min-w-0 items-center gap-2">
            {viewsMenu}
            <Button size="sm" variant="outline" aria-label="New Task" onClick={() => openNewIssue()}>
              <Plus className="h-4 w-4 sm:mr-1" />
              <span className="hidden sm:inline">New Task</span>
            </Button>
          </div>
        )}
      />
    );
  }

  return <OrganizationIssues toolbarContext={viewsMenu} initialStatuses={definition.statuses} />;
}

function OrganizationIssues({
  toolbarContext,
  initialStatuses,
}: { toolbarContext?: ReactNode; initialStatuses?: string[] } = {}) {
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const issuesPresentation = resolveIssuesPresentation(streamlinedUiEnabled);
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const fetchNextPageInFlightRef = useRef(false);

  const urlSearch = searchParams.get("q") ?? "";
  const [searchOverride, setSearchOverride] = useState<{ search: string; locationSearch: string } | null>(null);
  const syncedSearch = useMemo(() => {
    if (typeof window !== "undefined" && searchOverride?.locationSearch === window.location.search) {
      return searchOverride.search;
    }
    return urlSearch;
  }, [searchOverride, urlSearch, location.search]);
  const participantAgentId = searchParams.get("participantAgentId") ?? undefined;
  const initialWorkspaces = searchParams.getAll("workspace").filter((workspaceId) => workspaceId.length > 0);
  const workspaceIdFilter = initialWorkspaces.length === 1 ? initialWorkspaces[0] : undefined;
  const handleSearchChange = useCallback((search: string) => {
    const nextUrl = buildIssuesSearchUrl(window.location.href, search);
    if (!nextUrl) {
      setSearchOverride(null);
      return;
    }
    window.history.replaceState(window.history.state, "", nextUrl);
    setSearchOverride({ search, locationSearch: window.location.search });
  }, []);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });

  const liveRunsQueryKey = queryKeys.liveRuns(selectedCompanyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!selectedCompanyId,
    // Event-sourced via LiveUpdatesProvider (GitHub issue 9627); no interval poll needed.
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

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Tasks",
        `${location.pathname}${location.search}${location.hash}`,
        "issues",
      ),
    [location.pathname, location.search, location.hash],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Tasks" }]);
  }, [setBreadcrumbs]);

  const issuePageSize = workspaceIdFilter ? WORKSPACE_FILTER_ISSUE_LIMIT : ISSUES_PAGE_SIZE;

  const {
    data: issuePages,
    isLoading,
    isFetchingNextPage,
    error,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "participant-agent",
      participantAgentId ?? "__all__",
      "workspace",
      workspaceIdFilter ?? "__all__",
      "compact",
      "with-routine-executions",
      "infinite",
      issuePageSize,
    ],
    queryFn: ({ pageParam, signal }) => issuesApi.listCompact(selectedCompanyId!, {
      participantAgentId,
      workspaceId: workspaceIdFilter,
      includeRoutineExecutions: true,
      limit: issuePageSize,
      offset: pageParam,
      sortField: "updated",
      sortDir: "desc",
    }, { signal }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      getNextIssuesPageOffset(lastPage.length, lastPageParam, issuePageSize),
    enabled: !!selectedCompanyId,
    placeholderData: (previousData) => previousData,
  });

  const issues = useMemo(() => mergeIssuePagesStable(issuePages?.pages ?? []) as Issue[], [issuePages]);
  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns, issues), [issues, liveRuns]);
  const hasMoreServerIssues = syncedSearch.trim().length === 0
    && hasNextPage === true;
  const loadMoreServerIssues = useCallback(() => {
    if (!hasNextPage || isFetchingNextPage || fetchNextPageInFlightRef.current) return;
    fetchNextPageInFlightRef.current = true;
    void fetchNextPage({ cancelRefetch: false }).finally(() => {
      fetchNextPageInFlightRef.current = false;
    });
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
    onError: (error) => pushToast({ title: "Failed to update task", body: error.message, tone: "error" }),
  });

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={CircleDot}
        message={streamlinedUiEnabled
          ? "Select an organization to view tasks."
          : "Select a company to view tasks."}
      />
    );
  }

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      isLoadingMoreIssues={isFetchingNextPage}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveIssueIds={liveIssueIds}
      viewStateKey="paperclip:issues-view"
      rowPresentation={issuesPresentation.rowPresentation}
      toolbarPresentation={issuesPresentation.toolbarPresentation}
      issueLinkState={issueLinkState}
      initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
      initialWorkspaces={initialWorkspaces.length > 0 ? initialWorkspaces : undefined}
      initialStatuses={initialStatuses}
      toolbarContext={toolbarContext}
      initialSearch={syncedSearch}
      onSearchChange={handleSearchChange}
      enableRoutineVisibilityFilter
      hasMoreIssues={hasMoreServerIssues}
      onLoadMoreIssues={loadMoreServerIssues}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
      searchFilters={participantAgentId || workspaceIdFilter ? { participantAgentId, workspaceId: workspaceIdFilter } : undefined}
    />
  );
}
