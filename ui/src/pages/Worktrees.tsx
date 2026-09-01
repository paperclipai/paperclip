import { useEffect, useMemo } from "react";
import { Link, Navigate } from "@/lib/router";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { WorktreeOverviewItem } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { executionWorktreesApi } from "../api/execution-worktrees";
import { instanceSettingsApi } from "../api/instanceSettings";
import { ProjectWorktreesContent } from "../components/ProjectWorktreesContent";
import { SummarySlotCard } from "../components/SummarySlotCard";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import type { ProjectWorktreeSummary } from "../lib/project-worktrees-tab";
import { queryKeys } from "../lib/queryKeys";
import { projectRouteRef } from "../lib/utils";

type ProjectWorktreeGroup = {
  projectId: string;
  projectName: string;
  projectRef: string;
  summaries: ProjectWorktreeSummary[];
  lastUpdatedAt: Date;
  runningServiceCount: number;
};

function overviewItemToSummary(item: WorktreeOverviewItem): ProjectWorktreeSummary {
  return {
    key: item.key,
    kind: item.kind,
    workspaceId: item.workspaceId,
    workspaceName: item.workspaceName,
    cwd: item.cwd,
    branchName: item.branchName,
    lastUpdatedAt: item.lastUpdatedAt,
    projectWorkspaceId: item.projectWorkspaceId,
    executionWorkspaceId: item.executionWorkspaceId,
    executionWorkspaceStatus: item.executionWorkspaceStatus,
    serviceCount: item.serviceCount,
    runningServiceCount: item.runningServiceCount,
    primaryServiceUrl: item.primaryServiceUrl,
    primaryServiceUrlRunning: item.primaryServiceUrlRunning,
    hasRuntimeConfig: item.hasRuntimeConfig,
    linkedIssueCount: item.linkedIssueCount,
    issues: item.linkedIssues,
  };
}

function buildProjectWorktreeGroups(items: WorktreeOverviewItem[]): ProjectWorktreeGroup[] {
  const groups = new Map<string, ProjectWorktreeGroup>();
  for (const item of items) {
    const existing = groups.get(item.projectId);
    const summary = overviewItemToSummary(item);
    if (existing) {
      existing.summaries.push(summary);
      if (summary.lastUpdatedAt.getTime() > existing.lastUpdatedAt.getTime()) {
        existing.lastUpdatedAt = summary.lastUpdatedAt;
      }
      existing.runningServiceCount += summary.runningServiceCount;
      continue;
    }
    groups.set(item.projectId, {
      projectId: item.projectId,
      projectName: item.projectName,
      projectRef: projectRouteRef({ id: item.projectId, name: item.projectName, urlKey: item.projectUrlKey }),
      summaries: [summary],
      lastUpdatedAt: summary.lastUpdatedAt,
      runningServiceCount: summary.runningServiceCount,
    });
  }

  return [...groups.values()].sort((a, b) => {
    const runningDiff = b.runningServiceCount - a.runningServiceCount;
    if (runningDiff !== 0) return runningDiff;
    const updatedDiff = b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime();
    return updatedDiff !== 0 ? updatedDiff : a.projectName.localeCompare(b.projectName);
  });
}

export function Worktrees() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const experimentalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const isolatedWorktreesEnabled = experimentalSettingsQuery.data?.enableIsolatedWorkspaces === true;

  const overviewQuery = useInfiniteQuery({
    queryKey: selectedCompanyId
      ? queryKeys.executionWorktrees.overview(selectedCompanyId)
      : ["execution-worktrees", "__worktrees-overview__", "disabled"],
    queryFn: ({ pageParam }) => executionWorktreesApi.listOverview(selectedCompanyId!, { offset: pageParam as number }),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    enabled: Boolean(selectedCompanyId && isolatedWorktreesEnabled),
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Worktrees" }]);
  }, [setBreadcrumbs]);

  const overviewPages = overviewQuery.data?.pages ?? [];
  const overviewItems = useMemo(
    () => overviewPages.flatMap((page) => page.items),
    [overviewPages],
  );
  const groups = useMemo(() => buildProjectWorktreeGroups(overviewItems), [overviewItems]);
  const firstPage = overviewPages[0] ?? null;
  const totalWorktreeCount = firstPage?.total ?? overviewItems.length;
  const dataLoading = overviewQuery.isLoading;
  const error = overviewQuery.error as Error | null;

  if (experimentalSettingsQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (!isolatedWorktreesEnabled) return <Navigate to="/issues" replace />;
  if (dataLoading) return <PageSkeleton variant="list" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Worktrees</h2>
      </div>

      <SummarySlotCard
        companyId={selectedCompanyId}
        scopeKind="workspaces_overview"
        title="Worktree summary"
        description="Summarizer tracks worktree activity, live services, and follow-up needs across projects."
      />

      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No worktree activity yet.</p>
      ) : (
        <div className="space-y-8">
          {groups.map((group) => (
            <section key={group.projectId} className="space-y-3">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div className="min-w-0">
                  <Link
                    to={`/projects/${group.projectRef}/worktrees`}
                    className="text-base font-semibold hover:underline"
                  >
                    {group.projectName}
                  </Link>
                </div>
                <span className="text-xs text-muted-foreground">
                  {group.summaries.length} worktree{group.summaries.length === 1 ? "" : "s"}
                </span>
              </div>
              <ProjectWorktreesContent
                companyId={selectedCompanyId!}
                projectId={group.projectId}
                projectRef={group.projectRef}
                summaries={group.summaries}
              />
            </section>
          ))}
          {overviewQuery.hasNextPage ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
              <p className="text-sm text-muted-foreground">
                Showing {overviewItems.length} of {totalWorktreeCount} worktrees.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void overviewQuery.fetchNextPage()}
                disabled={overviewQuery.isFetchingNextPage}
              >
                {overviewQuery.isFetchingNextPage ? "Loading..." : "Load more"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
