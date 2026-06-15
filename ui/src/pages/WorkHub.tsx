import { useEffect, useMemo } from "react";
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
import { BriefcaseBusiness, Bot, Users, ArrowLeftRight } from "lucide-react";

const WORK_HUB_PAGE_SIZE = 500;

interface IssueLike {
  id: string;
  [key: string]: unknown;
}

function getNextPageOffset(loadedPageSize: number, currentOffset: number): number | undefined {
  return loadedPageSize >= WORK_HUB_PAGE_SIZE ? currentOffset + WORK_HUB_PAGE_SIZE : undefined;
}

function mergePages(pages: IssueLike[][]): IssueLike[] {
  const seen = new Set<string>();
  const merged: IssueLike[] = [];
  for (const page of pages) {
    for (const item of page) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      merged.push(item);
    }
  }
  return merged;
}

type WorkItemFilter = "all" | "initiative" | "human_task" | "ai_task";

const FILTER_CONFIG: Record<WorkItemFilter, { label: string; icon: typeof BriefcaseBusiness; workItemTypes: string[] }> = {
  all: { label: "All Work", icon: ArrowLeftRight, workItemTypes: [] },
  initiative: { label: "Initiatives", icon: BriefcaseBusiness, workItemTypes: ["initiative"] },
  human_task: { label: "Human Tasks", icon: Users, workItemTypes: ["human_task"] },
  ai_task: { label: "AI Execution", icon: Bot, workItemTypes: ["ai_task"] },
};

export function WorkHub() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeFilter = (searchParams.get("filter") as WorkItemFilter) || "all";

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
    () => createIssueDetailLocationState("Work Hub", "/work", "work"),
    [],
  );

  const filterConfig = FILTER_CONFIG[activeFilter];
  const workItemTypeParam = filterConfig.workItemTypes.length > 0
    ? filterConfig.workItemTypes.join(",")
    : undefined;

  const {
    data: issuePages,
    isLoading,
    isFetchingNextPage,
    error,
    hasNextPage,
    fetchNextPage,
  } = useInfiniteQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "work-hub", activeFilter],
    queryFn: ({ pageParam }) => {
      const params: Record<string, unknown> = {
        limit: WORK_HUB_PAGE_SIZE,
        offset: pageParam,
      };
      if (workItemTypeParam) params.workItemType = workItemTypeParam;
      return issuesApi.list(selectedCompanyId!, params as Parameters<typeof issuesApi.list>[1]);
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage: IssueLike[], _allPages: unknown, lastPageParam: number) =>
      getNextPageOffset(lastPage.length, lastPageParam),
    enabled: !!selectedCompanyId,
    placeholderData: (previousData: unknown) => previousData,
  });

  const issues = useMemo(() => mergePages((issuePages as any)?.pages ?? []), [issuePages]);
  const hasMore = hasNextPage === true;

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
    onError: (err: unknown) => {
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
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-all ${
                isActive
                  ? "bg-foreground text-background shadow-sm"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon className="h-3 w-3" />
              {config.label}
            </button>
          );
        })}
      </div>

      <div className="flex-1 min-h-0">
        <IssuesList
          issues={issues ?? []}
          isLoading={isLoading}
          isLoadingMoreIssues={isFetchingNextPage}
          error={error as Error | null}
          agents={agents}
          projects={projects}
          liveIssueIds={liveIssueIds}
          viewStateKey="paperclip:workhub-view"
          issueLinkState={issueLinkState}
          hasMoreIssues={hasMore}
          onLoadMoreIssues={fetchNextPage}
          onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
          enableRoutineVisibilityFilter
        />
      </div>
    </div>
  );
}
