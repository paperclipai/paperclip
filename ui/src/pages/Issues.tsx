import { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState, createIssueDetailPath, readLegacyIssueDetailIdentifier } from "../lib/issueDetailBreadcrumb";
import { describeIssueUpdateError } from "../lib/issue-update-errors";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { CircleDot } from "lucide-react";

const ARCHIVE_CLOSED_CONFIRM_WINDOW_MS = 5000;
const OPEN_ISSUE_STATUSES = "backlog,todo,in_progress,in_review,blocked";

export function Issues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [showClosed, setShowClosed] = useState(false);
  const archiveClosedConfirmUntilRef = useRef(0);

  const initialSearch = searchParams.get("q") ?? "";
  const legacyIssueIdentifier = readLegacyIssueDetailIdentifier(location.search);
  const legacyIssueRedirectPath = legacyIssueIdentifier ? createIssueDetailPath(legacyIssueIdentifier) : null;
  const participantAgentId = searchParams.get("participantAgentId") ?? undefined;
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

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !legacyIssueRedirectPath,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !legacyIssueRedirectPath,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId && !legacyIssueRedirectPath,
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
        "Issues",
        `${location.pathname}${location.search}${location.hash}`,
        "issues",
      ),
    [location.pathname, location.search, location.hash],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "Issues" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "participant-agent",
      participantAgentId ?? "__all__",
      "show-closed",
      showClosed ? "true" : "false",
    ],
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, {
        participantAgentId,
        includeRelations: true,
        ...(showClosed ? {} : { status: OPEN_ISSUE_STATUSES }),
      }),
    enabled: !!selectedCompanyId && !legacyIssueRedirectPath,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
    onError: (err) => {
      const parsed = describeIssueUpdateError(err);
      pushToast({
        title: parsed.title,
        body: parsed.body,
        tone: "error",
      });
    },
  });

  const archiveClosedIssues = useMutation({
    mutationFn: () => issuesApi.archiveClosed(selectedCompanyId!, { olderThanDays: 14 }),
    onSuccess: (result) => {
      archiveClosedConfirmUntilRef.current = 0;
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
      pushToast({
        title: result.archivedCount > 0 ? `Archived ${result.archivedCount} closed issues` : "No closed issues to archive",
        tone: "success",
      });
    },
    onError: (err) => {
      archiveClosedConfirmUntilRef.current = 0;
      pushToast({
        title: "Failed to archive closed issues",
        body: err instanceof Error ? err.message : "Unable to archive closed issues.",
        tone: "error",
      });
    },
  });

  const handleArchiveClosed = useCallback(() => {
    const now = Date.now();
    if (archiveClosedConfirmUntilRef.current < now) {
      archiveClosedConfirmUntilRef.current = now + ARCHIVE_CLOSED_CONFIRM_WINDOW_MS;
      pushToast({
        title: "Press Archive Closed again to confirm",
        body: "Archives done/cancelled issues older than 14 days.",
        tone: "info",
      });
      return;
    }
    archiveClosedConfirmUntilRef.current = 0;
    archiveClosedIssues.mutate();
  }, [archiveClosedIssues, pushToast]);

  if (legacyIssueRedirectPath) {
    return <Navigate to={legacyIssueRedirectPath} replace />;
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view issues." />;
  }

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveIssueIds={liveIssueIds}
      viewStateKey="paperclip:issues-view"
      issueLinkState={issueLinkState}
      initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
      initialSearch={initialSearch}
      onSearchChange={handleSearchChange}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
      searchFilters={participantAgentId ? { participantAgentId } : undefined}
      showClosed={showClosed}
      onShowClosedChange={setShowClosed}
      onArchiveClosed={handleArchiveClosed}
      archiveClosedPending={archiveClosedIssues.isPending}
    />
  );
}
