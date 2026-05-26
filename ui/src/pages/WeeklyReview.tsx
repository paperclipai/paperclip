import { useEffect, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ClipboardList, RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { weeklyReviewsApi } from "../api/weeklyReviews";
import type {
  WeeklyReviewCitationRecord,
  WeeklyReviewActionRecord,
  WeeklyReviewDetail,
  WeeklyReviewFindingRecord,
  WeeklyReviewRecommendationRecord,
  WeeklyReviewReadiness,
  WeeklyReviewRecord,
} from "../api/weeklyReviews";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { asObject, cn, formatDate, formatDateTime } from "../lib/utils";

const FINDING_GROUPS = [
  { category: "decision_blocker", label: "Decision blockers" },
  { category: "action_required", label: "Actions needed" },
  { category: "evidence_gap", label: "Evidence gaps" },
  { category: "stale_item", label: "Stale items" },
  { category: "budget_signal", label: "Budget signals" },
  { category: "quality_signal", label: "Operational signals" },
  { category: "win_context", label: "Wins/context" },
] as const;

const severityClassName: Record<string, string> = {
  critical: "border-red-300 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-950/50 dark:text-red-300",
  high: "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-300",
  medium: "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-950/50 dark:text-blue-300",
  low: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-950/50 dark:text-emerald-300",
};

const statusClassName: Record<string, string> = {
  ready: "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-950/50 dark:text-emerald-300",
  validation_failed: "border-red-300 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-950/50 dark:text-red-300",
  generating: "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-950/50 dark:text-blue-300",
  stale: "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-950/50 dark:text-amber-300",
  draft: "border-border bg-muted/40 text-muted-foreground",
  archived: "border-border bg-muted/40 text-muted-foreground",
};

export function WeeklyReview() {
  const { selectedCompanyId, selectedCompany, companies } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  useEffect(() => {
    setBreadcrumbs([{ label: "Weekly Review" }]);
  }, [setBreadcrumbs]);

  const reviewsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.weeklyReviews.list(selectedCompanyId) : ["weekly-reviews", "none"],
    queryFn: () => weeklyReviewsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const latestReview = useMemo(() => selectLatestReview(reviewsQuery.data ?? []), [reviewsQuery.data]);

  const detailQuery = useQuery({
    queryKey: latestReview ? queryKeys.weeklyReviews.detail(latestReview.id) : ["weekly-reviews", "detail", "none"],
    queryFn: () => weeklyReviewsApi.getReview(latestReview!.id),
    enabled: !!latestReview,
  });

  const readinessQuery = useQuery({
    queryKey: latestReview ? queryKeys.weeklyReviews.readiness(latestReview.id) : ["weekly-reviews", "readiness", "none"],
    queryFn: () => weeklyReviewsApi.getReadiness(latestReview!.id),
    enabled: !!latestReview,
  });

  const refreshMutation = useMutation({
    mutationFn: (reviewId: string) => weeklyReviewsApi.refresh(reviewId),
    onSuccess: async (payload) => {
      await invalidateReviewQueries(queryClient, selectedCompanyId, payload.review.id);
    },
  });

  const generateMutation = useMutation({
    mutationFn: () => {
      const period = defaultReviewPeriod();
      return weeklyReviewsApi.generate(selectedCompanyId!, period);
    },
    onSuccess: async (payload) => {
      await invalidateReviewQueries(queryClient, selectedCompanyId, payload.review.id);
    },
  });

  const actionMutation = useMutation({
    mutationFn: (input: { recommendationId: string; actionKind: string; title?: string; priority?: string }) => {
      const payload: { actionKind: string; title?: string; priority?: string } = { actionKind: input.actionKind };
      if (input.title) payload.title = input.title;
      if (input.priority) payload.priority = input.priority;
      return weeklyReviewsApi.createRecommendationAction(input.recommendationId, payload);
    },
    onSuccess: async (payload) => {
      await invalidateReviewQueries(queryClient, selectedCompanyId, payload.action.reviewId);
    },
  });

  if (!selectedCompanyId) {
    if (companies.length === 0) {
      return <EmptyState icon={ClipboardList} message="Create a company before generating a weekly review." />;
    }
    return <EmptyState icon={ClipboardList} message="Create or select a company to view the weekly review." />;
  }

  if (reviewsQuery.isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  if ((reviewsQuery.data ?? []).length === 0) {
    return (
      <div className="space-y-4">
        <PageHeader
          companyName={selectedCompany?.name ?? "Selected company"}
          title="Weekly Review"
          status={null}
          action={
            <Button
              size="sm"
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
            >
              <RefreshCw className={cn("mr-2 h-4 w-4", generateMutation.isPending && "animate-spin")} />
              Generate
            </Button>
          }
        />
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <div className="bg-muted/50 p-4 mb-4">
            <ClipboardList className="h-10 w-10 text-muted-foreground/50" />
          </div>
          <p className="text-sm text-muted-foreground">No weekly review yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Generate a review after the Northstar fixture has source evidence.
          </p>
        </div>
        {renderQueryError(reviewsQuery.error ?? generateMutation.error)}
      </div>
    );
  }

  if (detailQuery.isLoading) {
    return <PageSkeleton variant="dashboard" />;
  }

  const detail = detailQuery.data;
  if (!detail) {
    return (
      <div className="space-y-4">
        <PageHeader companyName={selectedCompany?.name ?? "Selected company"} title="Weekly Review" status={null} />
        {renderQueryError(detailQuery.error ?? reviewsQuery.error)}
      </div>
    );
  }

  const readiness = readinessQuery.data ?? null;
  const citationsByFindingId = groupCitations(detail.citations);
  const recommendationsByFindingId = groupRecommendations(detail.recommendations);
  const actionsByRecommendationId = groupActions(detail.actions);
  const validation = readValidation(detail.latestVersion?.validationJson, readiness?.citationValidation);
  const findingCounts = countBy(detail.findings, (finding) => finding.category);
  const severityCounts = countBy(detail.findings, (finding) => finding.severity);

  return (
    <div className="space-y-5">
      <PageHeader
        companyName={selectedCompany?.name ?? "Selected company"}
        title="Weekly Review"
        status={detail.latestVersion?.status ?? detail.review.status}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => refreshMutation.mutate(detail.review.id)}
            disabled={refreshMutation.isPending}
          >
            <RefreshCw className={cn("mr-2 h-4 w-4", refreshMutation.isPending && "animate-spin")} />
            Refresh
          </Button>
        }
        metadata={[
          `${formatDate(detail.review.periodStart)} - ${formatDate(detail.review.periodEnd)}`,
          detail.latestVersion ? `Version ${detail.latestVersion.versionNumber}` : "No version",
          detail.latestVersion?.generatedAt ? `Generated ${formatDateTime(detail.latestVersion.generatedAt)}` : null,
        ]}
      />

      {renderQueryError(detailQuery.error ?? readinessQuery.error ?? refreshMutation.error)}
      <ValidationBanner validation={validation} />

      <section className="grid gap-3 md:grid-cols-4">
        <Metric label="Open findings" value={String(detail.findings.length)} />
        <Metric label="Critical" value={String(severityCounts.critical ?? 0)} />
        <Metric label="High" value={String(severityCounts.high ?? 0)} />
        <Metric label="Evidence gaps" value={String(findingCounts.evidence_gap ?? 0)} />
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <main className="space-y-4">
          {FINDING_GROUPS.map((group) => {
            const findings = detail.findings.filter((finding) => finding.category === group.category);
            if (findings.length === 0) return null;
            return (
              <FindingSection
                key={group.category}
                label={group.label}
                findings={findings}
                citationsByFindingId={citationsByFindingId}
                recommendationsByFindingId={recommendationsByFindingId}
                actionsByRecommendationId={actionsByRecommendationId}
                onRecommendationAction={(recommendationId, actionKind) => {
                  actionMutation.mutate({
                    recommendationId,
                    actionKind,
                    title: actionKind === "create_followup_issue"
                      ? "Follow up weekly review recommendation"
                      : undefined,
                    priority: actionKind === "create_followup_issue" ? "high" : undefined,
                  });
                }}
                actionPending={actionMutation.isPending}
              />
            );
          })}
        </main>

        <aside className="space-y-4">
          <ReadinessPanel readiness={readiness} />
          <ModelAssurancePanel readiness={readiness} />
          <ActionHistoryPanel actions={detail.actions} />
        </aside>
      </div>
    </div>
  );
}

function PageHeader({
  companyName,
  title,
  status,
  action,
  metadata = [],
}: {
  companyName: string;
  title: string;
  status: string | null;
  action?: ReactNode;
  metadata?: Array<string | null>;
}) {
  return (
    <header className="flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-start md:justify-between">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold tracking-normal">{title}</h1>
          {status ? <StatusPill status={status} /> : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <span>{companyName}</span>
          {metadata.filter(Boolean).map((item) => (
            <span key={item ?? ""}>{item}</span>
          ))}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={cn("rounded-md border px-2 py-0.5 text-xs font-medium", statusClassName[status] ?? statusClassName.draft)}>
      {status === "validation_failed" ? "Validation failed" : humanize(status)}
    </span>
  );
}

function ValidationBanner({ validation }: { validation: ValidationState }) {
  if (validation.valid !== false) return null;
  return (
    <section className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-900 dark:border-red-500/30 dark:bg-red-950/40 dark:text-red-100">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="space-y-1">
          <div className="font-medium">Validation failed</div>
          <div className="flex flex-wrap gap-2">
            {validation.errors.map((error) => (
              <span key={`${error.code}:${error.findingStableId ?? ""}`} className="rounded border border-red-300/70 px-2 py-0.5 text-xs">
                {error.code}{error.findingStableId ? ` ${error.findingStableId}` : ""}
              </span>
            ))}
            {validation.materialFindingsWithoutCitations.map((stableId) => (
              <span key={stableId} className="rounded border border-red-300/70 px-2 py-0.5 text-xs">
                {stableId}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

function FindingSection({
  label,
  findings,
  citationsByFindingId,
  recommendationsByFindingId,
  actionsByRecommendationId,
  onRecommendationAction,
  actionPending,
}: {
  label: string;
  findings: WeeklyReviewFindingRecord[];
  citationsByFindingId: Map<string, WeeklyReviewCitationRecord[]>;
  recommendationsByFindingId: Map<string, WeeklyReviewRecommendationRecord[]>;
  actionsByRecommendationId: Map<string, WeeklyReviewActionRecord[]>;
  onRecommendationAction: (recommendationId: string, actionKind: string) => void;
  actionPending: boolean;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between border-b border-border pb-1">
        <h2 className="text-sm font-semibold">{label}</h2>
        <span className="text-xs text-muted-foreground">{findings.length}</span>
      </div>
      <div className="divide-y divide-border rounded-md border border-border">
        {findings.map((finding) => (
          <FindingRow
            key={finding.id}
            finding={finding}
            citations={citationsByFindingId.get(finding.id) ?? []}
            recommendations={recommendationsByFindingId.get(finding.id) ?? []}
            actionsByRecommendationId={actionsByRecommendationId}
            onRecommendationAction={onRecommendationAction}
            actionPending={actionPending}
          />
        ))}
      </div>
    </section>
  );
}

function FindingRow({
  finding,
  citations,
  recommendations,
  actionsByRecommendationId,
  onRecommendationAction,
  actionPending,
}: {
  finding: WeeklyReviewFindingRecord;
  citations: WeeklyReviewCitationRecord[];
  recommendations: WeeklyReviewRecommendationRecord[];
  actionsByRecommendationId: Map<string, WeeklyReviewActionRecord[]>;
  onRecommendationAction: (recommendationId: string, actionKind: string) => void;
  actionPending: boolean;
}) {
  return (
    <article className="space-y-2 px-3 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{finding.stableId}</span>
            <SeverityPill severity={finding.severity} />
            {finding.workstream ? <span className="text-xs text-muted-foreground">{finding.workstream}</span> : null}
          </div>
          <h3 className="text-sm font-semibold leading-5">{finding.title}</h3>
        </div>
        <span className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {humanize(finding.status)}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{finding.summary}</p>
      {finding.recommendationText ? (
        <p className="text-sm">{finding.recommendationText}</p>
      ) : null}
      <RecommendationList
        recommendations={recommendations}
        actionsByRecommendationId={actionsByRecommendationId}
        onRecommendationAction={onRecommendationAction}
        actionPending={actionPending}
      />
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Citations ({citations.length})</summary>
        {citations.length > 0 ? (
          <div className="mt-2 space-y-2">
            {citations.map((citation) => (
              <div key={citation.id} className="rounded-md bg-muted/40 px-2 py-1.5">
                <div className="font-medium">{citation.label}</div>
                <div className="text-muted-foreground">
                  {citation.entityType}:{citation.entityId}{citation.field ? `:${citation.field}` : ""}
                </div>
                {citation.excerpt ? <div className="mt-1">{citation.excerpt}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2 text-muted-foreground">No citations attached.</div>
        )}
      </details>
    </article>
  );
}

function RecommendationList({
  recommendations,
  actionsByRecommendationId,
  onRecommendationAction,
  actionPending,
}: {
  recommendations: WeeklyReviewRecommendationRecord[];
  actionsByRecommendationId: Map<string, WeeklyReviewActionRecord[]>;
  onRecommendationAction: (recommendationId: string, actionKind: string) => void;
  actionPending: boolean;
}) {
  if (recommendations.length === 0) return null;
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-2">
      <div className="text-xs font-semibold text-muted-foreground">Recommended actions</div>
      {recommendations.map((recommendation) => {
        const actions = actionsByRecommendationId.get(recommendation.id) ?? [];
        return (
          <div key={recommendation.id} className="space-y-2 rounded-sm bg-background p-2 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="font-medium">{recommendation.title}</div>
                {recommendation.rationale ? (
                  <div className="text-xs text-muted-foreground">{recommendation.rationale}</div>
                ) : null}
              </div>
              <span className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
                {humanize(recommendation.state)}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={actionPending || recommendation.state !== "open"}
                onClick={() => onRecommendationAction(recommendation.id, "accept_recommendation")}
              >
                Accept
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={actionPending || recommendation.state !== "open"}
                onClick={() => onRecommendationAction(recommendation.id, "dismiss_recommendation")}
              >
                Dismiss
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={actionPending || recommendation.state !== "open"}
                onClick={() => onRecommendationAction(recommendation.id, "create_followup_issue")}
              >
                Follow-up issue
              </Button>
              {recommendation.kind.includes("fallback") ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionPending || recommendation.state !== "open"}
                  onClick={() => onRecommendationAction(recommendation.id, recommendation.kind)}
                >
                  Request fallback
                </Button>
              ) : null}
            </div>
            {actions.length > 0 ? (
              <div className="text-xs text-muted-foreground">
                Latest action: {actions[0]?.actionKind.replaceAll("_", " ")} ({actions[0]?.status})
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function SeverityPill({ severity }: { severity: string }) {
  return (
    <span className={cn("rounded-md border px-2 py-0.5 text-xs font-medium", severityClassName[severity] ?? severityClassName.low)}>
      {humanize(severity)}
    </span>
  );
}

function ReadinessPanel({ readiness }: { readiness: WeeklyReviewReadiness | null }) {
  const byAdapterType = asObject(asObject(readiness?.adapterReadiness).byAdapterType);
  const entries = Object.entries(byAdapterType);
  return (
    <section className="rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Readiness</h2>
      </div>
      <div className="divide-y divide-border">
        {entries.length > 0 ? entries.map(([adapterType, raw]) => {
          const probe = asObject(raw);
          return (
            <div key={adapterType} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="font-mono text-xs">{adapterType}</span>
              <span className="text-xs text-muted-foreground">{String(probe.status ?? "unknown")}</span>
            </div>
          );
        }) : (
          <div className="px-3 py-3 text-sm text-muted-foreground">Readiness metadata unavailable.</div>
        )}
      </div>
    </section>
  );
}

function ModelAssurancePanel({ readiness }: { readiness: WeeklyReviewReadiness | null }) {
  const byAgent = asObject(asObject(readiness?.modelAssurance).byAgent);
  const entries = Object.entries(byAgent);
  return (
    <section className="rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Model assurance</h2>
      </div>
      <div className="divide-y divide-border">
        {entries.length > 0 ? entries.map(([agentId, raw]) => {
          const model = asObject(raw);
          return (
            <div key={agentId} className="space-y-1 px-3 py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs">{String(model.adapterType ?? agentId)}</span>
                <span className="text-xs text-muted-foreground">{String(model.policyStatus ?? "unknown")}</span>
              </div>
              <div className="text-xs text-muted-foreground">
                {String(model.resolvedModel ?? model.selectedModel ?? "model unresolved")}
              </div>
            </div>
          );
        }) : (
          <div className="px-3 py-3 text-sm text-muted-foreground">Model assurance metadata unavailable.</div>
        )}
      </div>
    </section>
  );
}

function ActionHistoryPanel({ actions }: { actions: WeeklyReviewActionRecord[] }) {
  return (
    <section className="rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ClipboardList className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Action history</h2>
      </div>
      <div className="divide-y divide-border">
        {actions.length > 0 ? actions.map((action) => (
          <div key={action.id} className="space-y-1 px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs">{action.actionKind.replaceAll("_", " ")}</span>
              <span className="text-xs text-muted-foreground">{action.status}</span>
            </div>
            {action.targetEntityType && action.targetEntityId ? (
              <div className="truncate text-xs text-muted-foreground">
                {action.targetEntityType}:{action.targetEntityId}
              </div>
            ) : null}
          </div>
        )) : (
          <div className="px-3 py-3 text-sm text-muted-foreground">No governance actions yet.</div>
        )}
      </div>
    </section>
  );
}

interface ValidationState {
  valid: boolean | null;
  errors: Array<{ code: string; findingStableId?: string | null }>;
  materialFindingsWithoutCitations: string[];
}

function readValidation(versionValidation: unknown, readinessValidation: unknown): ValidationState {
  const source = asObject(versionValidation) || asObject(readinessValidation);
  const validation = Object.keys(source).length > 0 ? source : asObject(readinessValidation);
  const errors = Array.isArray(validation.errors)
    ? validation.errors.flatMap((error) => {
      const row = asObject(error);
      return typeof row.code === "string"
        ? [{ code: row.code, findingStableId: typeof row.findingStableId === "string" ? row.findingStableId : null }]
        : [];
    })
    : [];
  const materialFindingsWithoutCitations = Array.isArray(validation.materialFindingsWithoutCitations)
    ? validation.materialFindingsWithoutCitations.filter((value): value is string => typeof value === "string")
    : [];
  return {
    valid: typeof validation.valid === "boolean" ? validation.valid : null,
    errors,
    materialFindingsWithoutCitations,
  };
}

function groupCitations(citations: WeeklyReviewCitationRecord[]) {
  const grouped = new Map<string, WeeklyReviewCitationRecord[]>();
  for (const citation of citations) {
    if (!citation.findingId) continue;
    const existing = grouped.get(citation.findingId) ?? [];
    existing.push(citation);
    grouped.set(citation.findingId, existing);
  }
  return grouped;
}

function groupRecommendations(recommendations: WeeklyReviewRecommendationRecord[]) {
  const grouped = new Map<string, WeeklyReviewRecommendationRecord[]>();
  for (const recommendation of recommendations) {
    if (!recommendation.findingId) continue;
    const existing = grouped.get(recommendation.findingId) ?? [];
    existing.push(recommendation);
    grouped.set(recommendation.findingId, existing);
  }
  return grouped;
}

function groupActions(actions: WeeklyReviewActionRecord[]) {
  const grouped = new Map<string, WeeklyReviewActionRecord[]>();
  for (const action of actions) {
    if (!action.recommendationId) continue;
    const existing = grouped.get(action.recommendationId) ?? [];
    existing.push(action);
    grouped.set(action.recommendationId, existing);
  }
  for (const rows of grouped.values()) {
    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  return grouped;
}

function countBy<T>(items: T[], selector: (item: T) => string) {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const key = selector(item);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function selectLatestReview(reviews: WeeklyReviewRecord[]) {
  return [...reviews].sort((a, b) => {
    const byPeriod = new Date(b.periodEnd).getTime() - new Date(a.periodEnd).getTime();
    if (byPeriod !== 0) return byPeriod;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  })[0] ?? null;
}

function defaultReviewPeriod() {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd);
  periodStart.setUTCDate(periodStart.getUTCDate() - 7);
  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
  };
}

async function invalidateReviewQueries(
  queryClient: QueryClient,
  companyId: string | null | undefined,
  reviewId: string,
) {
  if (companyId) {
    await queryClient.invalidateQueries({ queryKey: queryKeys.weeklyReviews.list(companyId) });
  }
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.weeklyReviews.detail(reviewId) }),
    queryClient.invalidateQueries({ queryKey: queryKeys.weeklyReviews.readiness(reviewId) }),
  ]);
}

function renderQueryError(error: unknown) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : "Weekly review request failed";
  return <p className="text-sm text-destructive">{message}</p>;
}

function humanize(value: string) {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}
