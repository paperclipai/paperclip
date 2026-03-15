import { useEffect, useMemo, useCallback, useRef } from "react";
import { useSearchParams } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { CircleDot } from "lucide-react";

export function Issues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();

  const initialSearch = searchParams.get("q") ?? "";
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleSearchChange = useCallback((search: string) => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
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
    }, 300);
  }, []);

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

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

  useEffect(() => {
    setBreadcrumbs([{ label: "Issues" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId!) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={CircleDot} message="Select a company to view issues." />;
  }

  return (
    <div className="space-y-5">
      <section className="paperclip-work-hero px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-3">
            <p className="paperclip-work-kicker">Work Queue</p>
            <div className="space-y-2">
              <h1 className="paperclip-work-title">Issues</h1>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Scan the full operating backlog, live execution, and recently updated requests in one dense surface.
              </p>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="paperclip-work-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-work-label">Total</p>
              <p className="mt-2 text-2xl font-semibold">{issues?.length ?? 0}</p>
            </div>
            <div className="paperclip-work-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-work-label">Active</p>
              <p className="mt-2 text-2xl font-semibold">
                {issues?.filter((issue) => ["todo", "in_progress", "in_review", "blocked"].includes(issue.status)).length ?? 0}
              </p>
            </div>
            <div className="paperclip-work-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-work-label">Live</p>
              <p className="mt-2 text-2xl font-semibold">{liveIssueIds.size}</p>
            </div>
          </div>
        </div>
      </section>

      <IssuesList
        issues={issues ?? []}
        isLoading={isLoading}
        error={error as Error | null}
        agents={agents}
        liveIssueIds={liveIssueIds}
        viewStateKey="paperclip:issues-view"
        initialAssignees={searchParams.get("assignee") ? [searchParams.get("assignee")!] : undefined}
        initialSearch={initialSearch}
        onSearchChange={handleSearchChange}
        onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
      />
    </div>
  );
}
