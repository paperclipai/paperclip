import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "../components/StatusIcon";

import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { formatDate } from "../lib/utils";
import { ListTodo } from "lucide-react";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";

export function MyIssues() {
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "My Tasks" }]);
  }, [setBreadcrumbs]);

  const issuesQuery = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: issues, isLoading } = issuesQuery;
  const issuesView = useQueryView(issuesQuery);

  if (!selectedCompanyId) {
    return (
      <EmptyState
        icon={ListTodo}
        message={streamlinedUiEnabled
          ? "Select an organization to view your tasks."
          : "Select a company to view your tasks."}
      />
    );
  }

  // Keep a loaded list on screen through a failed refetch; only a real
  // failure, or an outage before the first load, replaces the page.
  if (isLoading || issuesView.kind === "reconnecting") {
    return <PageSkeleton variant="list" />;
  }
  if (issuesView.kind === "error") {
    return (
      <QueryErrorState
        size="page"
        error={issuesView.error}
        action="load your tasks"
        onRetry={issuesView.retry}
        retrying={issuesView.isFetching}
      />
    );
  }

  // Show issues that are not assigned (user-created or unassigned)
  const myIssues = (issues ?? []).filter(
    (i) => !i.assigneeAgentId && !["done", "cancelled"].includes(i.status)
  );

  return (
    <div className="space-y-4">
      {myIssues.length === 0 && (
        <EmptyState icon={ListTodo} message="No tasks assigned to you." />
      )}

      {myIssues.length > 0 && (
        <div className="border border-border">
          {myIssues.map((issue) => (
            <EntityRow
              key={issue.id}
              identifier={issue.identifier ?? issue.id.slice(0, 8)}
              title={issue.title}
              to={`/issues/${issue.identifier ?? issue.id}`}
              leading={
                <StatusIcon status={issue.status} externalConversationState={issue.externalConversationState} blockerAttention={issue.blockerAttention} />
              }
              trailing={
                <span className="text-xs text-muted-foreground">
                  {formatDate(issue.createdAt)}
                </span>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}
