import { useEffect, useMemo } from "react";
import { useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { Star } from "lucide-react";

export function Favorites() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const queryClient = useQueryClient();

  const issueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Favorites",
        `${location.pathname}${location.search}${location.hash}`,
      ),
    [location.pathname, location.search, location.hash],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Favorites" }]);
  }, [setBreadcrumbs]);

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
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

  const { data: favorites, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.favorites(selectedCompanyId!),
    queryFn: () => issuesApi.listFavorites(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.favorites(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Star} message="Select a company to view favorites." />;
  }

  const isEmpty = !isLoading && (favorites ?? []).length === 0;

  if (isEmpty) {
    return (
      <EmptyState
        icon={Star}
        message="No favorites yet. Star issues to add them here for quick access."
      />
    );
  }

  return (
    <IssuesList
      issues={favorites ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      liveIssueIds={liveIssueIds}
      viewStateKey="paperclip:favorites-view"
      issueLinkState={issueLinkState}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
      // Disable filters for favorites - show all favorited issues
      showFilters={false}
    />
  );
}
