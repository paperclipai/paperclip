import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { heartbeatsApi, type FailedRunForIssue } from "../api/heartbeats";
import { approvalsApi } from "../api/approvals";
import { authApi } from "../api/auth";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { StatusIcon } from "../components/StatusIcon";
import { PriorityIcon } from "../components/PriorityIcon";
import { EntityRow } from "../components/EntityRow";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { formatDate } from "../lib/utils";
import type { Issue, Approval } from "@paperclipai/shared";
import {
  Briefcase,
  AlertTriangle,
  ShieldCheck,
  CircleDot,
  Clock,
  Play,
} from "lucide-react";

function SectionHeader({
  icon: Icon,
  label,
  count,
  tone = "default",
}: {
  icon: typeof Briefcase;
  label: string;
  count: number;
  tone?: "default" | "danger" | "warning";
}) {
  const toneClasses = {
    default: "text-muted-foreground",
    danger: "text-destructive",
    warning: "text-amber-500",
  };
  return (
    <div className="flex items-center gap-2 mb-2">
      <Icon className={`h-4 w-4 ${toneClasses[tone]}`} />
      <h2 className="text-sm font-semibold text-foreground">{label}</h2>
      <span
        className={`text-xs font-mono px-1.5 py-0.5 rounded-md ${
          tone === "danger"
            ? "bg-destructive/10 text-destructive"
            : tone === "warning"
              ? "bg-amber-500/10 text-amber-500"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {count}
      </span>
    </div>
  );
}

function FailedRunRow({ run }: { run: FailedRunForIssue }) {
  return (
    <EntityRow
      identifier={run.agentName}
      title={run.error ?? "Run failed"}
      subtitle={run.issueId ? `Issue: ${run.issueId.slice(0, 8)}` : undefined}
      to={`/runs/${run.id}`}
      leading={
        <div className="flex items-center gap-2">
          <Play className="h-3.5 w-3.5 text-destructive" />
        </div>
      }
      trailing={
        <span className="text-xs text-muted-foreground">
          {run.finishedAt ? formatDate(run.finishedAt) : formatDate(run.createdAt)}
        </span>
      }
    />
  );
}

function IssueRow({ issue }: { issue: Issue }) {
  return (
    <EntityRow
      identifier={issue.identifier ?? issue.id.slice(0, 8)}
      title={issue.title}
      to={`/issues/${issue.identifier ?? issue.id}`}
      leading={
        <>
          <PriorityIcon priority={issue.priority} />
          <StatusIcon status={issue.status} />
        </>
      }
      trailing={
        <span className="text-xs text-muted-foreground">
          {formatDate(issue.updatedAt ?? issue.createdAt)}
        </span>
      }
    />
  );
}

function approvalLabel(approval: Approval): string {
  const payload = approval.payload as Record<string, unknown> | undefined;
  if (payload?.skillName && typeof payload.skillName === "string")
    return `Skill: ${payload.skillName}`;
  if (payload?.summary && typeof payload.summary === "string")
    return payload.summary.slice(0, 80);
  return `${approval.type} approval`;
}

function ApprovalRow({ approval }: { approval: Approval }) {
  return (
    <EntityRow
      identifier={approval.id.slice(0, 8)}
      title={approvalLabel(approval)}
      to={`/approvals/${approval.id}`}
      leading={
        <ShieldCheck className="h-3.5 w-3.5 text-amber-500" />
      }
      trailing={
        <span className="text-xs text-muted-foreground">
          {formatDate(approval.createdAt)}
        </span>
      }
    />
  );
}

function SectionCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      {children}
    </div>
  );
}

export function MyWork() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "My Work" }]);
  }, [setBreadcrumbs]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;

  // Assigned issues (assigned to current user, active statuses)
  const { data: allIssues, isLoading: issuesLoading } = useQuery({
    queryKey: queryKeys.issues.list(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  // Touched issues (recently interacted with by current user)
  const { data: touchedIssues, isLoading: touchedLoading } = useQuery({
    queryKey: queryKeys.issues.listTouchedByMe(selectedCompanyId!),
    queryFn: () =>
      issuesApi.list(selectedCompanyId!, { touchedByUserId: currentUserId! }),
    enabled: !!selectedCompanyId && !!currentUserId,
  });

  // Pending approvals
  const { data: pendingApprovals, isLoading: approvalsLoading } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!, "pending"),
    queryFn: () => approvalsApi.list(selectedCompanyId!, "pending"),
    enabled: !!selectedCompanyId,
  });

  // Failed runs
  const { data: failedRuns, isLoading: runsLoading } = useQuery({
    queryKey: queryKeys.failedRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.failedRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Briefcase} message="Select a company to view your work." />;
  }

  const isLoading = issuesLoading || touchedLoading || approvalsLoading || runsLoading;
  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  // Filter assigned issues: assigned to current user (by userId), active statuses only
  const assignedIssues = (allIssues ?? []).filter(
    (i) =>
      i.assigneeUserId === currentUserId &&
      !["done", "cancelled"].includes(i.status),
  );

  // Recently touched: exclude those already in assigned, limit to 20 most recent
  const assignedIds = new Set(assignedIssues.map((i) => i.id));
  const recentlyTouched = (touchedIssues ?? [])
    .filter((i) => !assignedIds.has(i.id) && !["cancelled"].includes(i.status))
    .slice(0, 20);

  const approvals = pendingApprovals ?? [];
  const failed = failedRuns ?? [];

  const totalItems =
    failed.length + approvals.length + assignedIssues.length + recentlyTouched.length;

  return (
    <div className="animate-page-enter max-w-4xl space-y-6">
      {/* Summary strip */}
      <div className="flex items-center gap-6 text-sm">
        <div className="flex items-center gap-1.5">
          <Briefcase className="h-4 w-4 text-muted-foreground" />
          <span className="font-semibold text-foreground">My Work</span>
        </div>
        {totalItems === 0 && (
          <span className="text-muted-foreground">All clear</span>
        )}
      </div>

      {/* Failed Runs — always show first when present */}
      {failed.length > 0 && (
        <section>
          <SectionHeader
            icon={AlertTriangle}
            label="Failed Runs"
            count={failed.length}
            tone="danger"
          />
          <SectionCard>
            {failed.map((run) => (
              <FailedRunRow key={run.id} run={run} />
            ))}
          </SectionCard>
        </section>
      )}

      {/* Pending Approvals */}
      {approvals.length > 0 && (
        <section>
          <SectionHeader
            icon={ShieldCheck}
            label="Pending Approvals"
            count={approvals.length}
            tone="warning"
          />
          <SectionCard>
            {approvals.map((approval) => (
              <ApprovalRow key={approval.id} approval={approval} />
            ))}
          </SectionCard>
        </section>
      )}

      {/* Assigned Issues */}
      <section>
        <SectionHeader
          icon={CircleDot}
          label="Assigned to Me"
          count={assignedIssues.length}
        />
        {assignedIssues.length === 0 ? (
          <p className="text-sm text-muted-foreground pl-6">
            No issues assigned to you.
          </p>
        ) : (
          <SectionCard>
            {assignedIssues.map((issue) => (
              <IssueRow key={issue.id} issue={issue} />
            ))}
          </SectionCard>
        )}
      </section>

      {/* Recently Touched */}
      <section>
        <SectionHeader
          icon={Clock}
          label="Recently Touched"
          count={recentlyTouched.length}
        />
        {recentlyTouched.length === 0 ? (
          <p className="text-sm text-muted-foreground pl-6">
            No recently touched issues.
          </p>
        ) : (
          <SectionCard>
            {recentlyTouched.map((issue) => (
              <IssueRow key={issue.id} issue={issue} />
            ))}
          </SectionCard>
        )}
      </section>

      {totalItems === 0 && (
        <EmptyState
          icon={Briefcase}
          message="You're all caught up. No issues, approvals, or failed runs need your attention."
        />
      )}
    </div>
  );
}
