import { useEffect, useMemo, useCallback } from "react";
import { useLocation, useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { rt2TasksApi } from "../api/rt2-tasks";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { AlertTriangle, CircleDot, FileUp, GitBranch, Smartphone } from "lucide-react";

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

export function Issues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const initialSearch = searchParams.get("q") ?? "";
  const participantAgentId = searchParams.get("participantAgentId") ?? undefined;
  const handleSearchChange = useCallback((search: string) => {
    const nextUrl = buildIssuesSearchUrl(window.location.href, search);
    if (!nextUrl) return;
    window.history.replaceState(window.history.state, "", nextUrl);
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
        "업무 보드",
        `${location.pathname}${location.search}${location.hash}`,
        "issues",
      ),
    [location.pathname, location.search, location.hash],
  );

  useEffect(() => {
    setBreadcrumbs([{ label: "업무 보드" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: [
      ...queryKeys.issues.list(selectedCompanyId!),
      "participant-agent",
      participantAgentId ?? "__all__",
      "with-routine-executions",
    ],
    queryFn: () => issuesApi.list(selectedCompanyId!, { participantAgentId, includeRoutineExecutions: true }),
    enabled: !!selectedCompanyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  const { data: captureQueue } = useQuery({
    queryKey: selectedCompanyId ? ["rt2", "capture-drafts", selectedCompanyId] : ["rt2", "capture-drafts", "__disabled__"],
    queryFn: () => rt2TasksApi.listCaptureQueue(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const promoteCaptureDraft = useMutation({
    mutationFn: ({ draftId, projectId }: { draftId: string; projectId: string }) =>
      rt2TasksApi.promoteCaptureDraft(selectedCompanyId!, draftId, {
        target: "task",
        projectId,
        priority: "medium",
        taskMode: "solo",
        capacity: 1,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rt2", "capture-drafts", selectedCompanyId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  const failCaptureDraft = useMutation({
    mutationFn: ({ draftId, failureCode, failureMessage }: { draftId: string; failureCode: "duplicate" | "permission" | "source_failure" | "parse_error"; failureMessage: string }) =>
      rt2TasksApi.failCaptureDraft(selectedCompanyId!, draftId, { failureCode, failureMessage }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rt2", "capture-drafts", selectedCompanyId] });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="업무 보드를 보려면 회사를 선택하세요." />;
  }

  const defaultProjectId = projects?.[0]?.id ?? null;
  const visibleDrafts = (captureQueue?.drafts ?? []).slice(0, 5);

  return (
    <div className="space-y-4">
      <section className="rounded-md border border-border bg-card p-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">Native capture queue</h2>
              <p className="text-xs text-muted-foreground">mobile/native/messenger draft review</p>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap gap-1 text-xs text-muted-foreground">
            <span className="rounded-sm bg-muted px-2 py-1">review {captureQueue?.summary.reviewRequired ?? 0}</span>
            <span className="rounded-sm bg-muted px-2 py-1">duplicate {captureQueue?.summary.duplicate ?? 0}</span>
            <span className="rounded-sm bg-muted px-2 py-1">permission {captureQueue?.summary.permissionBlocked ?? 0}</span>
            <span className="rounded-sm bg-muted px-2 py-1">failed {captureQueue?.summary.failed ?? 0}</span>
          </div>
        </div>
        {visibleDrafts.length > 0 ? (
          <div className="mt-3 grid gap-2">
            {visibleDrafts.map((draft) => (
              <div key={draft.id} className="grid gap-2 rounded-md border border-border bg-background p-2 text-xs md:grid-cols-[1fr_auto]">
                <div className="min-w-0">
                  <div className="mb-1 flex flex-wrap items-center gap-1">
                    <span className="rounded-sm bg-muted px-1.5 py-0.5">{draft.source}</span>
                    <span className="rounded-sm bg-muted px-1.5 py-0.5">{draft.status}</span>
                    {draft.duplicateOfDraftId ? <span className="rounded-sm bg-amber-500/10 px-1.5 py-0.5 text-amber-700">duplicate</span> : null}
                    {draft.permissionStatus !== "allowed" ? <span className="rounded-sm bg-red-500/10 px-1.5 py-0.5 text-red-700">{draft.permissionStatus}</span> : null}
                  </div>
                  <p className="truncate font-medium">{String(draft.parsedDraft.taskTitle ?? draft.rawText)}</p>
                  <p className="truncate text-muted-foreground">{draft.rawText}</p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs disabled:opacity-50"
                    disabled={!defaultProjectId || draft.status !== "review_required" || promoteCaptureDraft.isPending}
                    onClick={() => defaultProjectId && promoteCaptureDraft.mutate({ draftId: draft.id, projectId: defaultProjectId })}
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    Task
                  </button>
                  <button
                    type="button"
                    className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs disabled:opacity-50"
                    disabled={draft.status === "promoted" || failCaptureDraft.isPending}
                    onClick={() => failCaptureDraft.mutate({ draftId: draft.id, failureCode: draft.duplicateOfDraftId ? "duplicate" : "source_failure", failureMessage: draft.duplicateOfDraftId ? "Duplicate capture reviewed." : "Source problem reviewed by operator." })}
                  >
                    {draft.duplicateOfDraftId ? <FileUp className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
                    Audit
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </section>
      <IssuesList
        issues={issues ?? []}
        isLoading={isLoading}
        error={error as Error | null}
        agents={agents}
        projects={projects}
        liveIssueIds={liveIssueIds}
        viewStateKey="realtycoon2:work-board"
        issueLinkState={issueLinkState}
        defaultViewMode="board"
        initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
        initialSearch={initialSearch}
        onSearchChange={handleSearchChange}
        enableRoutineVisibilityFilter
        onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
        searchFilters={participantAgentId ? { participantAgentId } : undefined}
      />
    </div>
  );
}
