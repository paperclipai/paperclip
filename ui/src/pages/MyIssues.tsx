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
    setBreadcrumbs([{ label: "My Issues" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={ListTodo} message="Select a company to view your issues." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  // Show issues that are not assigned (user-created or unassigned)
  const myIssues = (issues ?? []).filter(
    (i) => !i.assigneeAgentId && !["done", "cancelled"].includes(i.status)
  );

  // Status summary (open buckets only — done/cancelled are filtered out above).
  let blocked = 0, inProgress = 0, open = 0;
  for (const i of myIssues) {
    if (i.blockerAttention || i.status === "blocked") blocked++;
    else if (i.status === "in_progress") inProgress++;
    else open++;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-serif text-2xl font-medium tracking-tight">My Issues</h1>
        {myIssues.length > 0 && (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
            <span>
              <span className="font-mono text-foreground">{myIssues.length}</span>{" "}
              {myIssues.length === 1 ? "issue" : "issues"}
            </span>
            {[
              { n: blocked, label: "blocked", dot: "bg-status-error" },
              { n: inProgress, label: "in progress", dot: "bg-status-running" },
              { n: open, label: "open", dot: "bg-muted-foreground/50" },
            ]
              .filter((s) => s.n > 0)
              .map((s) => (
                <span key={s.label} className="inline-flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                  <span className="font-mono font-medium text-foreground">{s.n}</span> {s.label}
                </span>
              ))}
          </p>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}

      {myIssues.length === 0 && (
        <EmptyState icon={ListTodo} message="No issues assigned to you." />
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
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
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
