import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Telescope, CheckCircle, Clock, XCircle, Filter, ChevronDown, ChevronRight } from "lucide-react";
import { nicheOpportunitiesApi } from "../api/nicheOpportunities";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { cn } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "../components/ui/button";
import type { NicheOpportunity, NicheOpportunityStatus } from "@paperclipai/shared";

type StatusFilter = "unreviewed" | "all";

interface NdaMetadata {
  signals?: {
    bsrMedianTop30?: number;
    estimatedMonthlySales?: number;
    keywordSearchVolume?: number;
    qualifiedTitlesInTop30?: number;
    competitivenessIndex?: number;
    medianPrice?: number;
    medianPageCount?: number;
    printCostEstimate?: number;
    reviewGaps?: string[];
    demandShape?: string;
    longTailVariants?: number;
    kdpPolicyProximity?: string;
    seasonalityCliffRisk?: boolean;
  };
  scoring?: {
    demand?: number;
    competition?: number;
    monetization?: number;
    defensibility?: number;
    risk?: number;
    royaltyPerUnit?: number;
  };
  reviewGaps?: string[];
}

interface CriteriaScores {
  demandScore: number;
  competitionScore: number;
  revenueScore: number;
  opportunityScore: number;
  adEfficiencyScore: number;
  verdict: "Publish" | "Consider" | "Avoid";
}

function parseMetadata(raw: string | null): NdaMetadata | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as NdaMetadata;
  } catch {
    return null;
  }
}

function verdictFromComposite(score: number): "Publish" | "Consider" | "Avoid" {
  return score >= 60 ? "Publish" : score >= 35 ? "Consider" : "Avoid";
}

function computeCriteriaScores(meta: NdaMetadata): CriteriaScores | null {
  const sc = meta.scoring;
  if (!sc) return null;

  const demandScore = sc.demand ?? 0;
  const competitionScore = sc.competition ?? 50;
  const revenueScore = sc.monetization ?? 0;
  const defensibilityScore = sc.defensibility ?? 0;

  // Opportunity Score: (Demand × 35% + Revenue × 40%) ÷ (Competition/100 + 0.1) × 10
  const opportunityScore =
    ((demandScore * 0.35 + revenueScore * 0.4) / (competitionScore / 100 + 0.1)) * 10;

  // Ad Efficiency: Revenue × 35% + Defensibility × 25% + Demand × 15% + Low-Competition bonus × 15% + Keyword Gap × 10%
  const lowCompBonus = Math.max(0, 100 - competitionScore);
  const keywordGap = Math.min(100, (meta.signals?.longTailVariants ?? 0) * 3);
  const adEfficiencyScore = Math.min(
    100,
    revenueScore * 0.35 +
      defensibilityScore * 0.25 +
      demandScore * 0.15 +
      lowCompBonus * 0.15 +
      keywordGap * 0.1,
  );

  const verdict =
    opportunityScore >= 600 ? "Publish" : opportunityScore >= 350 ? "Consider" : "Avoid";

  return { demandScore, competitionScore, revenueScore, opportunityScore, adEfficiencyScore, verdict };
}

const VERDICT_STYLE = {
  Publish: "bg-green-500/20 text-green-400 border-green-500/30",
  Consider: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  Avoid: "bg-red-500/20 text-red-400 border-red-500/30",
};

const TIER_COLOR: Record<string, string> = {
  S: "bg-yellow-500/20 text-yellow-500 border-yellow-500/30",
  A: "bg-purple-500/20 text-purple-500 border-purple-500/30",
  B: "bg-blue-500/20 text-blue-500 border-blue-500/30",
};

const STATUS_COLOR: Record<NicheOpportunityStatus, string> = {
  unreviewed: "bg-muted text-muted-foreground",
  approved_for_analysis: "bg-green-500/20 text-green-500",
  deferred: "bg-yellow-500/20 text-yellow-500",
  rejected: "bg-red-500/20 text-red-500",
};

const STATUS_LABEL: Record<NicheOpportunityStatus, string> = {
  unreviewed: "Unreviewed",
  approved_for_analysis: "Approved",
  deferred: "Deferred",
  rejected: "Rejected",
};

function ScoreBar({ score, max = 100, label }: { score: number; max?: number; label: string }) {
  const pct = Math.min(100, (score / max) * 100);
  return (
    <div className="flex items-center gap-2">
      <span className="w-36 text-xs text-muted-foreground shrink-0">{label}</span>
      <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full",
            pct >= 75 ? "bg-green-500" : pct >= 50 ? "bg-yellow-500" : "bg-blue-500",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground w-10 text-right">
        {score.toFixed(0)}
        {max !== 100 ? "" : "/100"}
      </span>
    </div>
  );
}

function OpportunityRow({
  opp,
  onReview,
  isPending,
}: {
  opp: NicheOpportunity;
  onReview: (id: string, action: "approve" | "defer" | "reject") => void;
  isPending: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = parseMetadata(opp.metadata);
  const criteria = meta ? computeCriteriaScores(meta) : null;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div
        className="flex items-start gap-3 p-4 cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="mt-0.5 text-muted-foreground shrink-0">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wider",
                TIER_COLOR[opp.tier] ?? TIER_COLOR.B,
              )}
            >
              {opp.tier}
            </span>
            <span className="text-sm font-medium truncate">{opp.headKeyword}</span>
            {(() => {
              const v = criteria ? criteria.verdict : verdictFromComposite(opp.compositeScore);
              return (
                <span
                  className={cn(
                    "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold",
                    VERDICT_STYLE[v],
                  )}
                >
                  {v}
                </span>
              );
            })()}
            <span
              className={cn(
                "ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0",
                STATUS_COLOR[opp.status],
              )}
            >
              {STATUS_LABEL[opp.status]}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground truncate">{opp.categoryPath}</p>

          {/* Summary scores row */}
          <div className="mt-2 flex items-center gap-4 flex-wrap">
            {criteria ? (
              <>
                <span className="text-xs text-muted-foreground">
                  Opp:{" "}
                  <span className="font-semibold text-foreground">
                    {criteria.opportunityScore.toFixed(0)}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  Demand:{" "}
                  <span className="font-semibold text-foreground">
                    {criteria.demandScore.toFixed(0)}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  Competition:{" "}
                  <span className="font-semibold text-foreground">
                    {criteria.competitionScore.toFixed(0)}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  Revenue:{" "}
                  <span className="font-semibold text-foreground">
                    {criteria.revenueScore.toFixed(0)}
                  </span>
                </span>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-24 rounded-full bg-muted overflow-hidden">
                  <div
                    className={cn(
                      "h-full rounded-full",
                      opp.compositeScore >= 75
                        ? "bg-yellow-500"
                        : opp.compositeScore >= 50
                          ? "bg-purple-500"
                          : "bg-blue-500",
                    )}
                    style={{ width: `${opp.compositeScore}%` }}
                  />
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {opp.compositeScore.toFixed(1)}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-4">
          {/* Criteria Scores */}
          {criteria ? (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Scoring Criteria
              </p>
              <ScoreBar score={criteria.demandScore} label="Demand Score" />
              <ScoreBar score={criteria.competitionScore} label="Competition Score" />
              <ScoreBar score={criteria.revenueScore} label="Revenue Potential" />
              <ScoreBar
                score={criteria.opportunityScore}
                max={1000}
                label="Opportunity Score"
              />
              <ScoreBar score={criteria.adEfficiencyScore} label="Ad Efficiency" />
              <div className="flex items-center gap-2 pt-1">
                <span className="w-36 text-xs text-muted-foreground shrink-0">Verdict</span>
                <span
                  className={cn(
                    "rounded border px-2 py-0.5 text-[10px] font-bold",
                    VERDICT_STYLE[criteria.verdict],
                  )}
                >
                  {criteria.verdict}{" "}
                  {criteria.verdict === "Publish"
                    ? "(600+)"
                    : criteria.verdict === "Consider"
                      ? "(350–599)"
                      : "(<350)"}
                </span>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Composite Score
              </p>
              <ScoreBar score={opp.compositeScore} label="Composite Score" />
              <div className="flex items-center gap-2 pt-1">
                <span className="w-36 text-xs text-muted-foreground shrink-0">Verdict</span>
                <span
                  className={cn(
                    "rounded border px-2 py-0.5 text-[10px] font-bold",
                    VERDICT_STYLE[verdictFromComposite(opp.compositeScore)],
                  )}
                >
                  {verdictFromComposite(opp.compositeScore)}{" "}
                  {verdictFromComposite(opp.compositeScore) === "Publish"
                    ? "(≥ 60)"
                    : verdictFromComposite(opp.compositeScore) === "Consider"
                      ? "(35–59)"
                      : "(< 35)"}
                </span>
              </div>
            </div>
          )}

          {/* Key Signals */}
          {meta?.signals && (
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Signals
              </p>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs">
                {meta.signals.bsrMedianTop30 != null && (
                  <>
                    <span className="text-muted-foreground">BSR Median (Top 30)</span>
                    <span>{meta.signals.bsrMedianTop30.toLocaleString()}</span>
                  </>
                )}
                {meta.signals.estimatedMonthlySales != null && (
                  <>
                    <span className="text-muted-foreground">Est. Monthly Sales</span>
                    <span>{meta.signals.estimatedMonthlySales.toLocaleString()} units</span>
                  </>
                )}
                {meta.signals.keywordSearchVolume != null && (
                  <>
                    <span className="text-muted-foreground">Search Volume</span>
                    <span>{meta.signals.keywordSearchVolume.toLocaleString()}/mo</span>
                  </>
                )}
                {meta.signals.medianPrice != null && (
                  <>
                    <span className="text-muted-foreground">Median Price</span>
                    <span>${meta.signals.medianPrice.toFixed(2)}</span>
                  </>
                )}
                {meta.scoring?.royaltyPerUnit != null && (
                  <>
                    <span className="text-muted-foreground">Royalty / Unit</span>
                    <span>${meta.scoring.royaltyPerUnit.toFixed(2)}</span>
                  </>
                )}
                {meta.signals.qualifiedTitlesInTop30 != null && (
                  <>
                    <span className="text-muted-foreground">Qualified Titles (Top 30)</span>
                    <span>{meta.signals.qualifiedTitlesInTop30}</span>
                  </>
                )}
                {meta.signals.longTailVariants != null && (
                  <>
                    <span className="text-muted-foreground">Long-tail Variants</span>
                    <span>{meta.signals.longTailVariants}</span>
                  </>
                )}
                {meta.signals.demandShape && (
                  <>
                    <span className="text-muted-foreground">Demand Shape</span>
                    <span className="capitalize">{meta.signals.demandShape}</span>
                  </>
                )}
                {meta.signals.kdpPolicyProximity && (
                  <>
                    <span className="text-muted-foreground">KDP Policy</span>
                    <span className="capitalize">{meta.signals.kdpPolicyProximity}</span>
                  </>
                )}
                {meta.signals.seasonalityCliffRisk != null && (
                  <>
                    <span className="text-muted-foreground">Seasonality Cliff</span>
                    <span>{meta.signals.seasonalityCliffRisk ? "Yes" : "No"}</span>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Review Gaps */}
          {(meta?.reviewGaps ?? meta?.signals?.reviewGaps)?.length ? (
            <div className="space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Review Gaps (Unmet Needs)
              </p>
              <ul className="space-y-1">
                {(meta?.reviewGaps ?? meta?.signals?.reviewGaps ?? []).map((gap, i) => (
                  <li key={i} className="text-xs text-muted-foreground pl-2 border-l border-border">
                    {gap}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Meta info */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs">
            <div className="text-muted-foreground">Discovered</div>
            <div>{new Date(opp.discoveredAt).toLocaleDateString()}</div>
            {opp.reviewedAt && (
              <>
                <div className="text-muted-foreground">Reviewed</div>
                <div>{new Date(opp.reviewedAt).toLocaleDateString()}</div>
              </>
            )}
            {opp.reviewNote && (
              <>
                <div className="text-muted-foreground">Note</div>
                <div>{opp.reviewNote}</div>
              </>
            )}
            {opp.miaIssueId && (
              <>
                <div className="text-muted-foreground">MIA Issue</div>
                <div className="font-mono">{opp.miaIssueId.slice(0, 8)}</div>
              </>
            )}
          </div>

          {opp.status === "unreviewed" && (
            <div className="flex items-center gap-2 pt-1">
              <Button
                size="sm"
                variant="default"
                className="gap-1.5 text-xs"
                disabled={isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  onReview(opp.id, "approve");
                }}
              >
                <CheckCircle className="h-3.5 w-3.5" />
                Approve for Analysis
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5 text-xs"
                disabled={isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  onReview(opp.id, "defer");
                }}
              >
                <Clock className="h-3.5 w-3.5" />
                Defer
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-xs text-destructive hover:text-destructive"
                disabled={isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  onReview(opp.id, "reject");
                }}
              >
                <XCircle className="h-3.5 w-3.5" />
                Reject
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function NicheOpportunities() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("unreviewed");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Niche Opportunities" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["nicheOpportunities", selectedCompanyId, statusFilter],
    queryFn: () =>
      nicheOpportunitiesApi.list(
        selectedCompanyId!,
        statusFilter === "unreviewed" ? "unreviewed" : undefined,
      ),
    enabled: !!selectedCompanyId,
  });

  const reviewMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "approve" | "defer" | "reject" }) =>
      nicheOpportunitiesApi.review(selectedCompanyId!, id, { action }),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({
        queryKey: ["nicheOpportunities", selectedCompanyId],
      });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Review action failed");
    },
  });

  const items = data?.items ?? [];
  const unreviewedCount = items.filter((o) => o.status === "unreviewed").length;

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              statusFilter === "unreviewed"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
            onClick={() => setStatusFilter("unreviewed")}
          >
            Unreviewed
            {unreviewedCount > 0 && statusFilter !== "unreviewed" && (
              <span className="ml-1.5 rounded-full bg-yellow-500/20 px-1 text-[10px] text-yellow-500">
                {unreviewedCount}
              </span>
            )}
          </button>
          <button
            className={cn(
              "rounded-full px-3 py-1 text-xs font-medium transition-colors",
              statusFilter === "all"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80",
            )}
            onClick={() => setStatusFilter("all")}
          >
            All
          </button>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Filter className="h-3.5 w-3.5" />
          <span>{data?.total ?? 0} total</span>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
        <span className="font-medium">Verdict:</span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-green-500" />
          Publish (Opp ≥ 600)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-yellow-500" />
          Consider (350–599)
        </span>
        <span className="flex items-center gap-1">
          <span className="h-2 w-2 rounded-full bg-red-500" />
          Avoid (&lt; 350)
        </span>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Telescope className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {statusFilter === "unreviewed"
              ? "No unreviewed opportunities. NDA will surface more on its next cycle."
              : "No niche opportunities yet."}
          </p>
        </div>
      )}

      {items.length > 0 && (
        <div className="grid gap-2">
          {items.map((opp) => (
            <OpportunityRow
              key={opp.id}
              opp={opp}
              onReview={(id, action) => reviewMutation.mutate({ id, action })}
              isPending={reviewMutation.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
