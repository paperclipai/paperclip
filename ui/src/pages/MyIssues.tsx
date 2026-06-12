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
import { formatDate } from "../lib/utils";
import { ListTodo } from "lucide-react";

export function MyIssues() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "My Tasks" }]);
  }, [setBreadcrumbs]);

  // Push the status filter server-side so the bare `["issues", companyId]`
  // key isn't reused for an unbounded fetch. The page rendered a client-side
  // `.filter` to drop done/cancelled rows, which on a busy company meant we
  // pulled and serialized the full list (~1.28 MB) just to display the
  // open-and-unassigned subset. Cap at 200 — if a user has more than 200
  // open unassigned issues, a paginated infinite-scroll surface (Issues.tsx)
  // is the right place to view them.
  const { data: issues, isLoading, error } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "my-issues", "open", 200],
    queryFn: () => issuesApi.list(selectedCompanyId!, {
      status: "backlog,todo,in_progress,in_review,blocked",
      limit: 200,
    }),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ListTodo} message="Select a company to view your tasks." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  // Show issues that are not assigned (user-created or unassigned)
  const myIssues = (issues ?? []).filter(
    (i) => !i.assigneeAgentId && !["done", "cancelled"].includes(i.status)
  );

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error.message}</p>}

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
                <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} />
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
