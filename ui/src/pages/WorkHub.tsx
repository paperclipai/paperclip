import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useSearchParams } from "@/lib/router";
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
import { BriefcaseBusiness, Users, ArrowLeftRight } from "lucide-react";
import type { Issue, IssueWorkItemType } from "@paperclipai/shared";

const WORK_HUB_PAGE_SIZE = 500;
const WORK_HUB_WORK_ITEM_TYPES = ["initiative", "human_task"] as const satisfies readonly IssueWorkItemType[];

type WorkItemFilter = "all" | "initiative" | "human_task";

const FILTER_CONFIG: Record<WorkItemFilter, { label: string; icon: typeof BriefcaseBusiness; workItemTypes: readonly IssueWorkItemType[] }> = {
  all: { label: "All Work", icon: ArrowLeftRight, workItemTypes: WORK_HUB_WORK_ITEM_TYPES },
  initiative: { label: "Initiatives", icon: BriefcaseBusiness, workItemTypes: ["initiative"] },
  human_task: { label: "Human Tasks", icon: Users, workItemTypes: ["human_task"] },
};

function mergeIssuePagesStable(pages: Issue[][]): Issue[] {
  const seen = new Set<string>();
  const merged: Issue[] = [];
  for (const page of pages) {
    for (const issue of page) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      merged.push(issue);
    }
  }
  return merged;
}

function getNextPageOffset(loaded: number, offset: number): number | undefined {
  return loaded >= WORK_HUB_PAGE_SIZE ? offset + WORK_HUB_PAGE_SIZE : undefined;
}

export function WorkHub() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetchNextPageInFlightRef = useRef(false);

  const filterParam = searchParams.get("filter");
  const activeFilter: WorkItemFilter = filterParam === "all"
    || filterParam === "initiative"
    || filterParam === "human_task"
    ? filterParam
    : "all";
  const filterConfig = FILTER_CONFIG[activeFilter];
  const workItemTypeParam = filterConfig.workItemTypes.join(",");
  const createWorkItemType: IssueWorkItemType = activeFilter === "initiative" ? "initiative" : "human_task";
  const createIssueLabel = activeFilter === "initiative" ? "Initiative" : "Human Task";

  useEffect(() => {
    setBreadcrumbs([{ label: "Work Hub" }]);
  }, [setBreadcrumbs]);

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
    () => createIssueDetailLocationState("Work Hub", "/work", "issues"),
    [],
  );

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
      "work-hub",
      activeFilter,
      WORK_HUB_PAGE_SIZE,
    ],
    queryFn: ({ pageParam }) => issuesApi.list(selectedCompanyId!, {
      participantAgentId: undefined,
      workspaceId: undefined,
      excludeRoutineExecutions: true,
      workItemType: workItemTypeParam,
      limit: WORK_HUB_PAGE_SIZE,
      offset: pageParam,
    }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      getNextPageOffset(lastPage.length, lastPageParam),
    enabled: !!selectedCompanyId,
    placeholderData: (previousData) => previousData,
  });

  const issues = useMemo(() => mergeIssuePagesStable((issuePages as any)?.pages ?? []), [issuePages]);
  const hasMore = hasNextPage === true;

  const loadMoreIssues = useCallback(() => {
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
    return <EmptyState icon={BriefcaseBusiness} message="Select a company to view the Work Hub." />;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border/60 bg-background/60 backdrop-blur-sm sticky top-0 z-10">
        {(Object.entries(FILTER_CONFIG) as [WorkItemFilter, typeof FILTER_CONFIG[WorkItemFilter]][]).map(([key, config]) => {
          const isActive = activeFilter === key;
          const Icon = config.icon;
          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                if (key === "all") {
                  next.delete("filter");
                } else {
                  next.set("filter", key);
                }
                setSearchParams(next);
              }}
              className={"inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all " +
                (isActive
                  ? "bg-foreground text-background shadow-sm"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground")}
            >
              <Icon className="h-3 w-3" />
              {config.label}
            </button>
          );
        })}
      </div>
      <div className="flex-1 min-h-0">
        <IssuesList
          issues={issues}
          isLoading={isLoading}
          isLoadingMoreIssues={isFetchingNextPage}
          error={error as Error | null}
          agents={agents}
          projects={projects}
          liveIssueIds={liveIssueIds}
          viewStateKey="paperclip:workhub-view"
          issueLinkState={issueLinkState}
          searchFilters={{ workItemType: workItemTypeParam, excludeRoutineExecutions: true }}
          baseCreateIssueDefaults={{ workItemType: createWorkItemType }}
          createIssueLabel={createIssueLabel}
          hasMoreIssues={hasMore}
          onLoadMoreIssues={loadMoreIssues}
          onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
        />
      </div>
    </div>
  );
}
