import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { CircleDot } from "lucide-react";
import type { Issue, IssueWorkItemType } from "@paperclipai/shared";

const WORKSPACE_FILTER_ISSUE_LIMIT = 1000;
const ISSUES_PAGE_SIZE = 500;

type IssuesView = "all" | "initiatives" | "tickets" | "ai";

type IssuesViewConfig = {
  title: string;
  description: string;
  breadcrumb: string;
  linkSource: string;
  storageKey: string;
  workItemType?: IssueWorkItemType;
  createIssueLabel?: string;
  createDefaults?: Record<string, unknown>;
  includeRoutineExecutions?: boolean;
  excludeRoutineExecutions?: boolean;
};

const ISSUE_VIEW_CONFIG: Record<IssuesView, IssuesViewConfig> = {
  all: {
    title: "Issues",
    description: "All tracked work across human coordination and AI execution.",
    breadcrumb: "Issues",
    linkSource: "issues",
    storageKey: "paperclip:issues-view",
    includeRoutineExecutions: true,
  },
  initiatives: {
    title: "Initiatives",
    description: "Bigger scopes of work that collect human tickets and AI execution issues.",
    breadcrumb: "Initiatives",
    linkSource: "initiatives",
    storageKey: "paperclip:initiatives-view",
    workItemType: "initiative",
    createIssueLabel: "Initiative",
    createDefaults: { workItemType: "initiative" },
    excludeRoutineExecutions: true,
  },
  tickets: {
    title: "Tickets",
    description: "Human-owned tasks for coordination, follow-up, and delivery accountability.",
    breadcrumb: "Tickets",
    linkSource: "tickets",
    storageKey: "paperclip:tickets-view",
    workItemType: "human_task",
    createIssueLabel: "Ticket",
    createDefaults: { workItemType: "human_task" },
    excludeRoutineExecutions: true,
  },
  ai: {
    title: "AI Issues",
    description: "Execution work delegated to agents, kept separate from human workload.",
    breadcrumb: "AI Issues",
    linkSource: "ai-issues",
    storageKey: "paperclip:ai-issues-view",
    workItemType: "ai_task",
    createIssueLabel: "AI Issue",
    createDefaults: { workItemType: "ai_task" },
    excludeRoutineExecutions: true,
  },
};

export function getNextIssuesPageOffset(
  loadedPageSize: number,
  currentOffset: number,
  pageSize: number = ISSUES_PAGE_SIZE,
): number | undefined {
  return loadedPageSize >= pageSize ? currentOffset + pageSize : undefined;
}

export function mergeIssuePagesStable(pages: Issue[][]): Issue[] {
  const seenIssueIds = new Set<string>();
  const merged: Issue[] = [];

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

export function Issues({ view = "all" }: { view?: IssuesView }) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const fetchNextPageInFlightRef = useRef(false);
  const viewConfig = ISSUE_VIEW_CONFIG[view];

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

  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns), [liveRuns]);

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        viewConfig.title,
        `${location.pathname}${location.search}${location.hash}`,
        viewConfig.linkSource,
      ),
    [location.pathname, location.search, location.hash, viewConfig.linkSource, viewConfig.title],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: viewConfig.breadcrumb }]);
  }, [setBreadcrumbs, viewConfig.breadcrumb]);

  const issuePageSize = workspaceIdFilter ? WORKSPACE_FILTER_ISSUE_LIMIT : ISSUES_PAGE_SIZE;
  const workItemType = viewConfig.workItemType;
  const searchFilters = useMemo(
    () => ({
      ...(participantAgentId ? { participantAgentId } : {}),
      ...(workspaceIdFilter ? { workspaceId: workspaceIdFilter } : {}),
      ...(workItemType ? { workItemType } : {}),
      ...(viewConfig.excludeRoutineExecutions ? { excludeRoutineExecutions: true } : {}),
    }),
    [participantAgentId, viewConfig.excludeRoutineExecutions, workItemType, workspaceIdFilter],
  );
  const hasSearchFilters = Object.keys(searchFilters).length > 0;

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
      "work-item-type",
      workItemType ?? "__all__",
      viewConfig.includeRoutineExecutions ? "with-routine-executions" : "without-routine-executions",
      viewConfig.excludeRoutineExecutions ? "exclude-routine-executions" : "include-routine-executions",
      "infinite",
      issuePageSize,
    ],
    queryFn: ({ pageParam }) => issuesApi.list(selectedCompanyId!, {
      participantAgentId,
      workspaceId: workspaceIdFilter,
      ...(workItemType ? { workItemType } : {}),
      ...(viewConfig.includeRoutineExecutions ? { includeRoutineExecutions: true } : {}),
      ...(viewConfig.excludeRoutineExecutions ? { excludeRoutineExecutions: true } : {}),
      limit: issuePageSize,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      getNextIssuesPageOffset(lastPage.length, lastPageParam, issuePageSize),
    enabled: !!selectedCompanyId,
    placeholderData: (previousData) => previousData,
  });

  const issues = useMemo(() => mergeIssuePagesStable(issuePages?.pages ?? []), [issuePages]);
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
    onError: (err) => {
      pushToast({
        title: "Failed to update issue",
        body: err instanceof Error ? err.message : "Unknown error",
        tone: "error",
      });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view issues." />;
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-col gap-1 border-b border-border/70 pb-3">
        <h1 className="text-lg font-semibold tracking-normal text-foreground">{viewConfig.title}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{viewConfig.description}</p>
      </header>
      <IssuesList
        issues={issues ?? []}
        isLoading={isLoading}
        isLoadingMoreIssues={isFetchingNextPage}
        error={error as Error | null}
        agents={agents}
        projects={projects}
        liveIssueIds={liveIssueIds}
        viewStateKey={viewConfig.storageKey}
        issueLinkState={issueLinkState}
        initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
        initialWorkspaces={initialWorkspaces.length > 0 ? initialWorkspaces : undefined}
        initialSearch={syncedSearch}
        onSearchChange={handleSearchChange}
        enableRoutineVisibilityFilter={view === "all"}
        hasMoreIssues={hasMoreServerIssues}
        onLoadMoreIssues={loadMoreServerIssues}
        onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
        searchFilters={hasSearchFilters ? searchFilters : undefined}
        baseCreateIssueDefaults={viewConfig.createDefaults}
        createIssueLabel={viewConfig.createIssueLabel}
      />
    </div>
  );
}
