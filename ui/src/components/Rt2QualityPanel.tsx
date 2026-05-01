import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rt2CollaborationApi } from "../api/rt2-collaboration";
import { rt2JarvisRuntimeApi } from "../api/rt2-jarvis-runtime";
import type { Rt2QualityMetrics, Rt2QualityTrendsResponse, Rt2QualityGatesResponse } from "../api/rt2-collaboration";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const STUB_METRICS: Rt2QualityMetrics = {
  defectRate: 2.3,
  codeReviewCoverage: 85,
  reviewCycleTime: 24,
  qualityScore: 78,
};

const STUB_TRENDS: Rt2QualityTrendsResponse = {
  companyId: "",
  projectId: "",
  dataPoints: [
    { date: "2026-04-19", defectRate: 3.1, reviewCoverage: 80, totalDeliverables: 5 },
    { date: "2026-04-20", defectRate: 2.8, reviewCoverage: 82, totalDeliverables: 6 },
    { date: "2026-04-21", defectRate: 2.3, reviewCoverage: 85, totalDeliverables: 4 },
  ],
  trend: "stable",
};

const STUB_GATES: Rt2QualityGatesResponse = {
  companyId: "",
  projectId: "",
  gates: [
    { id: "g1", name: "Code Review Coverage", status: "passing", threshold: 80, currentValue: 85 },
    { id: "g2", name: "Defect Rate", status: "passing", threshold: 5, currentValue: 2.3 },
    { id: "g3", name: "Quality Score", status: "warning", threshold: 70, currentValue: 65 },
  ],
  overallPassing: true,
};

export function Rt2QualityPanel({
  companyId,
  projectId,
}: {
  companyId: string;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const { data: metrics } = useQuery({
    queryKey: ["rt2-quality-metrics", companyId, projectId],
    queryFn: () => rt2CollaborationApi.getQualityMetrics(companyId, projectId),
    enabled: Boolean(companyId) && Boolean(projectId),
  });

  const { data: trends } = useQuery({
    queryKey: ["rt2-quality-trends", companyId, projectId],
    queryFn: () => rt2CollaborationApi.getQualityTrends(companyId, projectId),
    enabled: Boolean(companyId) && Boolean(projectId),
  });

  const { data: gatesData } = useQuery({
    queryKey: ["rt2-quality-gates", companyId, projectId],
    queryFn: () => rt2CollaborationApi.getQualityGates(companyId, projectId),
    enabled: Boolean(companyId) && Boolean(projectId),
  });

  const { data: reviewQueue } = useQuery({
    queryKey: ["rt2-jarvis-quality-reviews", companyId],
    queryFn: () => rt2JarvisRuntimeApi.getQualityReviews(companyId),
    enabled: Boolean(companyId),
  });

  const { data: rewriteProposals } = useQuery({
    queryKey: ["rt2-jarvis-rewrite-proposals", companyId],
    queryFn: () => rt2JarvisRuntimeApi.listRewriteProposals(companyId),
    enabled: Boolean(companyId),
  });

  const requestRewriteApprovalMutation = useMutation({
    mutationFn: (proposalId: string) => rt2JarvisRuntimeApi.requestRewriteApproval(companyId, proposalId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rt2-jarvis-rewrite-proposals", companyId] });
    },
  });

  const applyWikiRewriteMutation = useMutation({
    mutationFn: (proposalId: string) =>
      rt2JarvisRuntimeApi.applyApprovedWikiRewrite(companyId, proposalId, "관리자 cockpit에서 승인된 wiki draft 적용"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rt2-jarvis-rewrite-proposals", companyId] });
      queryClient.invalidateQueries({ queryKey: ["rt2-knowledge", companyId, "pages"] });
    },
  });

  const approveMutation = useMutation({
    mutationFn: (evaluationId: string) =>
      rt2JarvisRuntimeApi.approveQualityReview(companyId, evaluationId, "관리자 cockpit에서 승인"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rt2-jarvis-quality-reviews", companyId] });
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (evaluationId: string) =>
      rt2JarvisRuntimeApi.rejectQualityReview(companyId, evaluationId, "관리자 cockpit에서 거절"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["rt2-jarvis-quality-reviews", companyId] });
    },
  });

  const displayMetrics = metrics ?? STUB_METRICS;
  const displayTrends = trends ?? STUB_TRENDS;
  const displayGates = gatesData?.gates ?? STUB_GATES.gates;

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">AI Quality (Shadow Mode)</h3>
        <div className="flex items-center gap-2">
          {gatesData?.overallPassing !== undefined && (
            <Badge variant={gatesData.overallPassing ? "default" : "destructive"}>
              {gatesData.overallPassing ? "Passing" : "Failing"}
            </Badge>
          )}
          <Badge variant="outline" className="text-xs">
            Shadow: + applies, - records only
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-lg border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">Quality Score</div>
          <div className="text-lg font-semibold">{displayMetrics.qualityScore}%</div>
        </div>
        <div className="rounded-lg border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">Defect Rate</div>
          <div className="text-lg font-semibold">{displayMetrics.defectRate}%</div>
        </div>
        <div className="rounded-lg border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">Review Coverage</div>
          <div className="text-lg font-semibold">{displayMetrics.codeReviewCoverage}%</div>
        </div>
        <div className="rounded-lg border border-border px-3 py-2">
          <div className="text-xs text-muted-foreground">Review Cycle</div>
          <div className="text-lg font-semibold">
            {displayMetrics.reviewCycleTime != null ? `${displayMetrics.reviewCycleTime}h` : "—"}
          </div>
        </div>
      </div>

      {displayGates && displayGates.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Quality Gates
          </div>
          <div className="space-y-1">
            {displayGates.map((gate) => (
              <div
                key={gate.id}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <div
                    className={`h-2 w-2 rounded-full ${
                      gate.status === "passing"
                        ? "bg-green-500"
                        : gate.status === "failing"
                          ? "bg-red-500"
                          : "bg-amber-500"
                    }`}
                  />
                  <div className="text-sm font-medium">{gate.name}</div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {gate.currentValue} / {gate.threshold}
                  </span>
                  <Badge
                    variant={
                      gate.status === "passing"
                        ? "default"
                        : gate.status === "failing"
                          ? "destructive"
                          : "secondary"
                    }
                    className="text-xs"
                  >
                    {gate.status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {displayTrends.dataPoints && displayTrends.dataPoints.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Recent Trends
            </div>
            <Badge variant="outline" className="text-xs">
              {displayTrends.trend}
            </Badge>
          </div>
          <div className="space-y-1">
            {displayTrends.dataPoints.slice(-5).map((trend, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-lg border border-border px-3 py-2"
              >
                <div className="text-xs text-muted-foreground">
                  {new Date(trend.date + "T00:00:00").toLocaleDateString()}
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span>
                    <span className="text-muted-foreground">Defect:</span>{" "}
                    <span className="font-medium">{trend.defectRate}%</span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">Coverage:</span>{" "}
                    <span className="font-medium">{trend.reviewCoverage}%</span>
                  </span>
                  <span>
                    <span className="text-muted-foreground">Items:</span>{" "}
                    <span className="font-medium">{trend.totalDeliverables}</span>
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {reviewQueue && reviewQueue.items.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Jarvis Manager Review
            </div>
            <div className="flex gap-1">
              <Badge variant="outline" className="text-xs">Shadow {reviewQueue.stats.shadow}</Badge>
              <Badge variant="secondary" className="text-xs">Co-Pilot {reviewQueue.stats.copilotPending}</Badge>
              <Badge variant="default" className="text-xs">Auto {reviewQueue.stats.autoApproved}</Badge>
            </div>
          </div>
          <div className="space-y-2">
            {reviewQueue.items.slice(0, 4).map((item) => (
              <div key={item.evaluationId} className="rounded-lg border border-border px-3 py-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant={item.evaluationMode === "auto" ? "default" : item.evaluationMode === "copilot" ? "secondary" : "outline"} className="text-xs">
                        {item.evaluationMode}
                      </Badge>
                      <span className="truncate text-sm font-medium">{item.taskTitle}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.score}/100 · delta {item.expectedDeltaGold ?? "-"}g · {item.policyReason}
                    </p>
                    {item.rationale && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.rationale}</p>
                    )}
                  </div>
                  {item.managerDecision === "pending" && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        size="sm"
                        onClick={() => approveMutation.mutate(item.evaluationId)}
                        disabled={approveMutation.isPending}
                      >
                        승인
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => rejectMutation.mutate(item.evaluationId)}
                        disabled={rejectMutation.isPending}
                      >
                        거절
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {rewriteProposals && rewriteProposals.proposals.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Jarvis Rewrite Proposals
            </div>
            <div className="flex gap-1">
              <Badge variant="outline" className="text-xs">Blocked {rewriteProposals.stats.blocked}</Badge>
              <Badge variant="secondary" className="text-xs">Disagree {rewriteProposals.stats.disagreement}</Badge>
              <Badge variant="secondary" className="text-xs">Fallback {rewriteProposals.stats.providerUnavailable}</Badge>
            </div>
          </div>
          <div className="space-y-2">
            {rewriteProposals.proposals.slice(0, 4).map((proposal) => (
              <div key={proposal.id} className="rounded-lg border border-border px-3 py-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={proposal.riskLevel === "high" ? "destructive" : proposal.riskLevel === "medium" ? "secondary" : "outline"} className="text-xs">
                        {proposal.riskLevel}
                      </Badge>
                      <Badge variant="outline" className="text-xs">{proposal.status}</Badge>
                      <span className="truncate text-sm font-medium">{proposal.title}</span>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {proposal.targetType}:{proposal.targetKey} · {proposal.latestEval?.finalRecommendation ?? "no-eval"} · confidence {proposal.latestEval ? Math.round(proposal.latestEval.finalConfidence * 100) : "-"}%
                    </p>
                    {proposal.latestEval?.reasonCodes.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {proposal.latestEval.reasonCodes.map((code) => (
                          <Badge key={code} variant="secondary" className="text-xs">{code}</Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {proposal.status === "proposed" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => requestRewriteApprovalMutation.mutate(proposal.id)}
                        disabled={requestRewriteApprovalMutation.isPending}
                      >
                        승인 요청
                      </Button>
                    )}
                    {proposal.status === "approved" && ["wiki_page", "daily_wiki_page"].includes(proposal.targetType) && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => applyWikiRewriteMutation.mutate(proposal.id)}
                        disabled={applyWikiRewriteMutation.isPending}
                      >
                        적용
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {(!metrics || displayMetrics.defectRate === 0) && !gatesData && (
        <p className="text-sm text-muted-foreground">
          No quality data available yet. Complete deliverables to see quality metrics.
        </p>
      )}
    </div>
  );
}
