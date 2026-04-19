import { useCallback, useEffect, useMemo } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleUserRound } from "lucide-react";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { heartbeatsApi } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { queryKeys } from "../lib/queryKeys";

export function MyIssues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const initialSearch = searchParams.get("q") ?? "";

  const handleSearchChange = useCallback((search: string) => {
    const trimmedSearch = search.trim();
    const currentSearch = new URLSearchParams(window.location.search).get("q") ?? "";
    if (currentSearch === trimmedSearch) return;

    const url = new URL(window.location.href);
    if (trimmedSearch) {
      url.searchParams.set("q", trimmedSearch);
    } else {
      url.searchParams.delete("q");
    }

    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState(window.history.state, "", nextUrl);
  }, []);

  useEffect(() => {
    setBreadcrumbs([{ label: "My Tasks" }]);
  }, [setBreadcrumbs]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

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
        "My Tasks",
        `${location.pathname}${location.search}${location.hash}`,
        "issues",
      ),
    [location.pathname, location.search, location.hash],
  );

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listAssignedToMe(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!, { assigneeUserId: "me" }),
    enabled: !!selectedCompanyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listAssignedToMe(selectedCompanyId!) });
    },
  });

  const reorderIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: { status: string; beforeIssueId?: string | null } }) =>
      issuesApi.reorder(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listAssignedToMe(selectedCompanyId!) });
    },
  });

  const defaultNewIssueValues = useMemo(
    () => (currentUserId ? { assigneeUserId: currentUserId } : undefined),
    [currentUserId],
  );

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleUserRound} message="Select a company to view your tasks." />;
  }

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveIssueIds={liveIssueIds}
      viewStateKey="paperclip:my-issues-view"
      issueLinkState={issueLinkState}
      initialSearch={initialSearch}
      searchFilters={{ assigneeUserId: "me" }}
      defaultNewIssueValues={defaultNewIssueValues}
      emptyMessage="No tasks assigned to you."
      onSearchChange={handleSearchChange}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
      onReorderIssue={(id, data) => reorderIssue.mutate({ id, data })}
    />
  );
}
