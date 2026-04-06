import { useEffect, useMemo } from "react";
import { Link } from "@/lib/router";
import { useQueries } from "@tanstack/react-query";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { issuesApi } from "../api/issues";
import { dashboardApi } from "../api/dashboard";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "../components/StatusIcon";
import { CompanyPatternIcon } from "../components/CompanyPatternIcon";
import { PageSkeleton } from "../components/PageSkeleton";
import { timeAgo } from "../lib/timeAgo";
import { Globe } from "lucide-react";
import type { Company, Issue } from "@paperclipai/shared";

const ACTIVE_STATUSES = "backlog,todo,in_progress,in_review,blocked";

export function GlobalDashboard() {
  const { companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "All Companies" }]);
  }, [setBreadcrumbs]);

  const activeCompanies = useMemo(
    () => companies.filter((c) => c.status !== "archived"),
    [companies],
  );

  const issueQueries = useQueries({
    queries: activeCompanies.map((company) => ({
      queryKey: queryKeys.global.issues(company.id),
      queryFn: () => issuesApi.list(company.id, { status: ACTIVE_STATUSES }),
      enabled: activeCompanies.length > 0,
    })),
  });

  const dashboardQueries = useQueries({
    queries: activeCompanies.map((company) => ({
      queryKey: queryKeys.global.dashboard(company.id),
      queryFn: () => dashboardApi.summary(company.id),
      enabled: activeCompanies.length > 0,
    })),
  });

  const isLoading = issueQueries.some((q) => q.isLoading) || dashboardQueries.some((q) => q.isLoading);

  if (activeCompanies.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <Globe className="h-10 w-10 mb-3 opacity-40" />
        <p className="text-sm">No companies yet.</p>
      </div>
    );
  }

  if (isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-2">
        {activeCompanies.map((company, idx) => {
          const dash = dashboardQueries[idx]?.data;
          const issues = issueQueries[idx]?.data ?? [];
          return (
            <CompanySummaryCard
              key={company.id}
              company={company}
              activeIssueCount={issues.length}
              agentCount={dash ? dash.agents.active + dash.agents.running + dash.agents.paused : 0}
              runningAgents={dash?.agents.running ?? 0}
            />
          );
        })}
      </div>

      {/* Issues by company */}
      {activeCompanies.map((company, idx) => {
        const issues = issueQueries[idx]?.data ?? [];
        if (issues.length === 0) return null;
        const sorted = [...issues].sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        );
        return (
          <CompanyIssueSection key={company.id} company={company} issues={sorted} />
        );
      })}
    </div>
  );
}

function CompanySummaryCard({
  company,
  activeIssueCount,
  agentCount,
  runningAgents,
}: {
  company: Company;
  activeIssueCount: number;
  agentCount: number;
  runningAgents: number;
}) {
  return (
    <Link
      to={`/${company.issuePrefix}/dashboard`}
      className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 hover:bg-accent/50 transition-colors no-underline text-inherit"
    >
      <CompanyPatternIcon
        companyName={company.name}
        logoUrl={company.logoUrl}
        brandColor={company.brandColor}
        className="rounded-[10px] shrink-0"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{company.name}</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {activeIssueCount} active issue{activeIssueCount !== 1 ? "s" : ""}
          {" · "}
          {agentCount} agent{agentCount !== 1 ? "s" : ""}
          {runningAgents > 0 && (
            <span className="text-blue-500"> · {runningAgents} running</span>
          )}
        </p>
      </div>
    </Link>
  );
}

function CompanyIssueSection({
  company,
  issues,
}: {
  company: Company;
  issues: Issue[];
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <CompanyPatternIcon
          companyName={company.name}
          logoUrl={company.logoUrl}
          brandColor={company.brandColor}
          className="rounded-[8px] shrink-0 !h-5 !w-5"
        />
        <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          {company.name}
        </h3>
        <span className="text-xs text-muted-foreground">({issues.length})</span>
      </div>
      <div className="border border-border divide-y divide-border overflow-hidden rounded-md">
        {issues.slice(0, 15).map((issue) => (
          <Link
            key={issue.id}
            to={`/${company.issuePrefix}/issues/${issue.identifier ?? issue.id}`}
            className="px-4 py-3 text-sm cursor-pointer hover:bg-accent/50 transition-colors no-underline text-inherit block"
          >
            <div className="flex items-center gap-3">
              <StatusIcon status={issue.status} />
              <span className="text-xs font-mono text-muted-foreground shrink-0">
                {issue.identifier ?? issue.id.slice(0, 8)}
              </span>
              <span className="flex-1 min-w-0 truncate">{issue.title}</span>
              <span className="text-xs text-muted-foreground shrink-0">
                {timeAgo(issue.updatedAt)}
              </span>
            </div>
          </Link>
        ))}
        {issues.length > 15 && (
          <Link
            to={`/${company.issuePrefix}/issues`}
            className="px-4 py-2 text-xs text-muted-foreground hover:bg-accent/50 transition-colors no-underline text-inherit block text-center"
          >
            View all {issues.length} issues
          </Link>
        )}
      </div>
    </div>
  );
}
