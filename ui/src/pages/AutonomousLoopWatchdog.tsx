import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Eye, ShieldCheck } from "lucide-react";
import { Link } from "@/lib/router";
import { autonomousLoopWatchdogApi } from "../api/autonomousLoopWatchdog";
import type { AutonomousLoopWatchdogCandidate } from "../api/autonomousLoopWatchdog";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";

const WATCHDOG_PREVIEW_LIMIT = 25;

function severityClassName(severity: string) {
  switch (severity) {
    case "critical":
    case "high":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "medium":
      return "border-amber-500/30 bg-amber-500/10 text-amber-600";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

function CandidateCard({ candidate }: { candidate: AutonomousLoopWatchdogCandidate }) {
  const issueLabel = candidate.identifier ?? candidate.issueId;
  const issuePathId = candidate.identifier ?? candidate.issueId;
  const isInternalRepair = candidate.userVisible === false;

  return (
    <article className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className={`rounded-full border px-2 py-0.5 font-medium ${severityClassName(candidate.severity)}`}>
              {candidate.severity}
            </span>
            <span>owner: {candidate.owner}</span>
            {isInternalRepair ? <span>Internal repair</span> : <span>User-visible</span>}
          </div>
          <h2 className="text-base font-semibold text-foreground">
            <Link to={`/issues/${issuePathId}`} className="hover:underline">
              {candidate.title ?? issueLabel}
            </Link>
          </h2>
          <p className="text-xs text-muted-foreground">
            {issueLabel} · {candidate.status ?? "unknown status"}
          </p>
        </div>
        <div className="rounded-full border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
          {candidate.kind}
        </div>
      </div>

      <dl className="mt-4 grid gap-3 text-sm md:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Reason</dt>
          <dd className="mt-1 font-mono text-xs text-foreground">{candidate.reason}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Recovery action</dt>
          <dd className="mt-1 font-mono text-xs text-foreground">{candidate.recoveryAction ?? "manual_review"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Generated</dt>
          <dd className="mt-1 text-xs text-foreground">{candidate.generatedAt}</dd>
        </div>
      </dl>

      <p className="mt-4 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
        {candidate.recommendedAction}
      </p>
    </article>
  );
}

export function AutonomousLoopWatchdog() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: "Observability" }]);
  }, [setBreadcrumbs]);

  const { data, error, isLoading } = useQuery({
    queryKey: queryKeys.autonomousLoopWatchdog.preview(selectedCompanyId!, WATCHDOG_PREVIEW_LIMIT),
    queryFn: () => autonomousLoopWatchdogApi.preview(selectedCompanyId!, { limit: WATCHDOG_PREVIEW_LIMIT }),
    enabled: !!selectedCompanyId,
    refetchInterval: 30_000,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Eye} message="Select a company to view autonomous loop observability." />;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const candidates = data?.candidates ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Eye className="h-4 w-4" />
            Read-only preview
          </div>
          <h1 className="mt-1 text-2xl font-semibold text-foreground">Autonomous loop watchdog</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Operator-facing view of autonomous-loop repair candidates from the latest {WATCHDOG_PREVIEW_LIMIT} open issues.
            It only reads supervisor state; it does not wake agents, edit issues, or request approvals.
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
          <div className="font-medium text-foreground">{data?.totalIssuesScanned ?? 0} issues scanned</div>
          <div>{candidates.length} candidates</div>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          Failed to load watchdog preview: {error.message}
        </div>
      ) : null}

      {data?.readOnly === true ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          <ShieldCheck className="h-4 w-4" />
          Preview mode is read-only. Operator actions stay outside this panel.
        </div>
      ) : null}

      {data && candidates.length === 0 ? (
        <EmptyState
          icon={AlertTriangle}
          message={`No watchdog candidates in the latest ${data.totalIssuesScanned} scanned open issues.`}
        />
      ) : null}

      {candidates.length > 0 ? (
        <div className="space-y-3">
          {candidates.map((candidate) => (
            <CandidateCard key={candidate.id} candidate={candidate} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
