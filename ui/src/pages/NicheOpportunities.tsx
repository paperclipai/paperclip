import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Telescope,
  CheckCircle,
  Clock,
  XCircle,
  Filter,
  Download,
  TrendingUp,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useSearchParams } from "@/lib/router";
import { nicheOpportunitiesApi } from "../api/nicheOpportunities";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { cn } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { EmptyState } from "../components/EmptyState";
import { Button } from "../components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import type { NicheOpportunity, NicheOpportunityStatus } from "@paperclipai/shared";

type StatusFilter = "unreviewed" | "all";
type VerdictFilter = "all" | "Publish" | "Consider" | "Avoid";
type TierFilter = "all" | "S" | "A" | "B";
type SortKey = "score-desc" | "score-asc" | "date-desc" | "date-asc";
type DatePreset = "all" | "7d" | "30d" | "90d" | "custom";

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

function getVerdict(opp: NicheOpportunity): "Publish" | "Consider" | "Avoid" {
  const meta = parseMetadata(opp.metadata);
  if (meta) {
    const criteria = computeCriteriaScores(meta);
    if (criteria) return criteria.verdict;
  }
  return verdictFromComposite(opp.compositeScore);
}

function getEffectiveScore(opp: NicheOpportunity): number {
  const meta = parseMetadata(opp.metadata);
  if (meta) {
    const criteria = computeCriteriaScores(meta);
    if (criteria) return criteria.opportunityScore;
  }
  return opp.compositeScore * 10;
}

function applySortKey(items: NicheOpportunity[], sortKey: SortKey): NicheOpportunity[] {
  return [...items].sort((a, b) => {
    switch (sortKey) {
      case "score-desc": return getEffectiveScore(b) - getEffectiveScore(a);
      case "score-asc":  return getEffectiveScore(a) - getEffectiveScore(b);
      case "date-desc":  return new Date(b.discoveredAt).getTime() - new Date(a.discoveredAt).getTime();
      case "date-asc":   return new Date(a.discoveredAt).getTime() - new Date(b.discoveredAt).getTime();
    }
  });
}

function getDateFilterFrom(preset: DatePreset, customFrom?: string): Date | null {
  const now = new Date();
  switch (preset) {
    case "7d":  { const d = new Date(now); d.setDate(d.getDate() - 7); return d; }
    case "30d": { const d = new Date(now); d.setDate(d.getDate() - 30); return d; }
    case "90d": { const d = new Date(now); d.setDate(d.getDate() - 90); return d; }
    case "custom": return customFrom ? new Date(customFrom) : null;
    default: return null;
  }
}

function parseCategoryPath(raw: string): string[] {
  if (raw.startsWith("{") && raw.endsWith("}")) {
    return raw
      .slice(1, -1)
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((s) => s.replace(/^"|"$/g, "").trim())
      .filter(Boolean);
  }
  return raw.split(" > ").map((s) => s.trim()).filter(Boolean);
}

function formatCategoryPath(raw: string): string {
  return parseCategoryPath(raw).join(" > ");
}

function extractTopCategory(categoryPath: string): string {
  const parts = parseCategoryPath(categoryPath);
  if (parts[0]?.toLowerCase() === "books" && parts.length > 1) return parts[1];
  return parts[0] ?? categoryPath;
}

function exportNichesToCsv(items: NicheOpportunity[]) {
  const headers = [
    "Keyword",
    "Category",
    "Tier",
    "Status",
    "Verdict",
    "Opportunity Score",
    "Demand Score",
    "Competition Score",
    "Revenue Score",
    "Ad Efficiency",
    "Composite Score",
    "BSR Median",
    "Est. Monthly Sales",
    "Search Volume",
    "Median Price",
    "Royalty/Unit",
    "Discovered At",
  ];

  const rows = items.map((opp) => {
    const meta = parseMetadata(opp.metadata);
    const criteria = meta ? computeCriteriaScores(meta) : null;
    const verdict = criteria ? criteria.verdict : verdictFromComposite(opp.compositeScore);
    return [
      opp.headKeyword,
      formatCategoryPath(opp.categoryPath),
      opp.tier,
      opp.status,
      verdict,
      criteria ? criteria.opportunityScore.toFixed(0) : "",
      criteria ? criteria.demandScore.toFixed(0) : "",
      criteria ? criteria.competitionScore.toFixed(0) : "",
      criteria ? criteria.revenueScore.toFixed(0) : "",
      criteria ? criteria.adEfficiencyScore.toFixed(0) : "",
      opp.compositeScore.toFixed(0),
      meta?.signals?.bsrMedianTop30 ?? "",
      meta?.signals?.estimatedMonthlySales ?? "",
      meta?.signals?.keywordSearchVolume ?? "",
      meta?.signals?.medianPrice?.toFixed(2) ?? "",
      meta?.scoring?.royaltyPerUnit?.toFixed(2) ?? "",
      new Date(opp.discoveredAt).toLocaleDateString(),
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`);
  });

  const csv = [headers.map((h) => `"${h}"`).join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `niche-opportunities-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const VERDICT_STYLE = {
  Publish: "bg-green-500/20 text-green-400 border-green-500/30",
  Consider: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  Avoid: "bg-red-500/20 text-red-400 border-red-500/30",
};

const VERDICT_SCORE_COLOR = {
  Publish: "text-green-400",
  Consider: "text-yellow-400",
  Avoid: "text-red-400",
};

const VERDICT_BORDER = {
  Publish: "border-green-500/20",
  Consider: "border-yellow-500/20",
  Avoid: "border-red-500/20",
};

const VERDICT_BG = {
  Publish: "bg-green-500/5",
  Consider: "bg-yellow-500/5",
  Avoid: "bg-red-500/5",
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

function MiniBar({
  score,
  max = 100,
  colorClass,
}: {
  score: number;
  max?: number;
  colorClass: string;
}) {
  const pct = Math.min(100, Math.max(0, (score / max) * 100));
  return (
    <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden">
      <div className={cn("h-full rounded-full", colorClass)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function ScoreRow({
  label,
  score,
  max = 100,
  barClass,
  labelWidth = "w-[72px]",
}: {
  label: string;
  score: number;
  max?: number;
  barClass: string;
  labelWidth?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn(labelWidth, "shrink-0 text-[10px] text-muted-foreground")}>{label}</span>
      <MiniBar score={score} max={max} colorClass={barClass} />
      <span className="w-7 shrink-0 text-right text-[10px] tabular-nums font-medium text-foreground">
        {score.toFixed(0)}
      </span>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  children,
  colorClass,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  colorClass?: string;
}) {
  return (
    <button
      className={cn(
        "rounded-full px-3 py-1 text-xs font-medium transition-colors border",
        active
          ? colorClass ?? "bg-primary text-primary-foreground border-primary"
          : "bg-transparent border-border text-muted-foreground hover:border-muted-foreground/50",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function KpiPill({
  label,
  value,
  colorClass,
}: {
  label: string;
  value: number;
  colorClass?: string;
}) {
  return (
    <span className="text-xs text-muted-foreground">
      {label}:{" "}
      <span className={cn("font-semibold tabular-nums", colorClass ?? "text-foreground")}>
        {value}
      </span>
    </span>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
        <span className="text-sm text-destructive">{message}</span>
      </div>
    </div>
  );
}

function SignalRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1 border-b border-border/30 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className="text-xs font-medium text-right">{value}</span>
    </div>
  );
}

function NicheDetailSheet({
  opp,
  open,
  onClose,
  onReview,
  isPending,
}: {
  opp: NicheOpportunity | null;
  open: boolean;
  onClose: () => void;
  onReview: (id: string, action: "approve" | "defer" | "reject") => void;
  isPending: boolean;
}) {
  if (!opp) return null;
  const meta = parseMetadata(opp.metadata);
  const criteria = meta ? computeCriteriaScores(meta) : null;
  const verdict = criteria ? criteria.verdict : verdictFromComposite(opp.compositeScore);
  const oppScore = criteria ? criteria.opportunityScore : opp.compositeScore * 10;
  const sig = meta?.scoring;
  const signals = meta?.signals;
  const reviewGaps: string[] = meta?.reviewGaps ?? signals?.reviewGaps ?? [];

  return (
    <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent side="right" className="w-[420px] sm:w-[480px] overflow-y-auto p-0">
        <div className="flex flex-col h-full">
          {/* Header */}
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-border/50 space-y-1">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 min-w-0">
                <span className={cn("mt-0.5 inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wider shrink-0", TIER_COLOR[opp.tier] ?? TIER_COLOR.B)}>
                  {opp.tier}
                </span>
                <SheetTitle className="text-base font-semibold leading-snug">{opp.headKeyword}</SheetTitle>
              </div>
              <span className={cn("mt-0.5 rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0", STATUS_COLOR[opp.status])}>
                {STATUS_LABEL[opp.status]}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{formatCategoryPath(opp.categoryPath)}</p>
            {/* KPI strip */}
            <div className="flex items-center gap-4 pt-1 flex-wrap">
              <span className="text-xs text-muted-foreground">Opp: <span className={cn("font-bold tabular-nums", VERDICT_SCORE_COLOR[verdict])}>{oppScore.toFixed(0)}</span></span>
              {criteria && <>
                <span className="text-xs text-muted-foreground">Demand: <span className="font-semibold text-foreground">{criteria.demandScore.toFixed(0)}</span></span>
                <span className="text-xs text-muted-foreground">Competition: <span className="font-semibold text-foreground">{criteria.competitionScore.toFixed(0)}</span></span>
                <span className="text-xs text-muted-foreground">Revenue: <span className="font-semibold text-foreground">{criteria.revenueScore.toFixed(0)}</span></span>
              </>}
            </div>
          </SheetHeader>

          <div className="flex-1 px-5 py-4 space-y-5 overflow-y-auto">
            {/* Scoring Criteria */}
            {criteria && (
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Scoring Criteria</h3>
                <div className="space-y-2">
                  <ScoreRow label="Demand Score" score={criteria.demandScore} barClass="bg-yellow-500" labelWidth="w-[90px]" />
                  <ScoreRow label="Competition" score={criteria.competitionScore} barClass="bg-blue-500" labelWidth="w-[90px]" />
                  <ScoreRow label="Rev Potential" score={criteria.revenueScore} barClass="bg-green-500" labelWidth="w-[90px]" />
                  <ScoreRow label="Opp Score" score={criteria.opportunityScore} max={criteria.opportunityScore > 100 ? criteria.opportunityScore : 100} barClass="bg-green-400" labelWidth="w-[90px]" />
                  <ScoreRow label="Ad Efficiency" score={criteria.adEfficiencyScore} barClass="bg-purple-500" labelWidth="w-[90px]" />
                </div>
                <div className="mt-3">
                  <span className={cn("inline-flex items-center rounded border px-2.5 py-0.5 text-xs font-bold", VERDICT_STYLE[verdict])}>
                    {verdict} ({oppScore.toFixed(0)})
                  </span>
                </div>
              </section>
            )}

            {/* Signals */}
            {signals && (
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Signals</h3>
                <div className="rounded-md border border-border/50 px-3 py-1">
                  {signals.bsrMedianTop30 != null && <SignalRow label="BSR Median (Top 30)" value={signals.bsrMedianTop30.toLocaleString()} />}
                  {signals.estimatedMonthlySales != null && <SignalRow label="Est. Monthly Sales" value={`${signals.estimatedMonthlySales.toLocaleString()} units`} />}
                  {signals.keywordSearchVolume != null && <SignalRow label="Search Volume" value={`${signals.keywordSearchVolume.toLocaleString()}/mo`} />}
                  {signals.medianPrice != null && <SignalRow label="Median Price" value={`$${signals.medianPrice.toFixed(2)}`} />}
                  {sig?.royaltyPerUnit != null && <SignalRow label="Royalty / Unit" value={`$${sig.royaltyPerUnit.toFixed(2)}`} />}
                  {signals.qualifiedTitlesInTop30 != null && <SignalRow label="Qualified Titles (Top 30)" value={signals.qualifiedTitlesInTop30} />}
                  {signals.longTailVariants != null && <SignalRow label="Long-tail Variants" value={signals.longTailVariants} />}
                  {signals.demandShape && <SignalRow label="Demand Shape" value={signals.demandShape} />}
                  {signals.kdpPolicyProximity && <SignalRow label="KDP Policy" value={signals.kdpPolicyProximity} />}
                  {signals.seasonalityCliffRisk != null && <SignalRow label="Seasonality Cliff" value={signals.seasonalityCliffRisk ? "Yes" : "No"} />}
                </div>
              </section>
            )}

            {/* Review Gaps */}
            {reviewGaps.length > 0 && (
              <section>
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Review Gaps (Unmet Needs)</h3>
                <div className="space-y-1.5">
                  {reviewGaps.map((gap, i) => (
                    <p key={i} className="text-xs text-muted-foreground italic border-l-2 border-border/50 pl-2">{gap}</p>
                  ))}
                </div>
              </section>
            )}

            {/* Discovered */}
            <div className="flex items-center justify-between text-xs text-muted-foreground pt-1 border-t border-border/30">
              <span>Discovered</span>
              <span>{new Date(opp.discoveredAt).toLocaleDateString()}</span>
            </div>
          </div>

          {/* Action buttons */}
          {opp.status === "unreviewed" && (
            <div className="px-5 pb-5 pt-3 border-t border-border/50 flex items-center gap-2">
              <Button size="sm" variant="default" className="flex-1 gap-1.5 text-xs" disabled={isPending} onClick={() => { onReview(opp.id, "approve"); onClose(); }}>
                <CheckCircle className="h-3.5 w-3.5" />
                Approve for Analysis
              </Button>
              <Button size="sm" variant="outline" className="gap-1.5 text-xs px-3" disabled={isPending} onClick={() => { onReview(opp.id, "defer"); onClose(); }}>
                <Clock className="h-3.5 w-3.5" />
                Defer
              </Button>
              <Button size="sm" variant="ghost" className="gap-1.5 text-xs px-3 text-destructive hover:text-destructive" disabled={isPending} onClick={() => { onReview(opp.id, "reject"); onClose(); }}>
                <XCircle className="h-3.5 w-3.5" />
                Reject
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function NicheCard({
  opp,
  onReview,
  isPending,
  onSelect,
}: {
  opp: NicheOpportunity;
  onReview: (id: string, action: "approve" | "defer" | "reject") => void;
  isPending: boolean;
  onSelect: (opp: NicheOpportunity) => void;
}) {
  const meta = parseMetadata(opp.metadata);
  const criteria = meta ? computeCriteriaScores(meta) : null;
  const verdict = criteria ? criteria.verdict : verdictFromComposite(opp.compositeScore);
  const oppScore = criteria ? criteria.opportunityScore : opp.compositeScore * 10;

  // Monthly earnings: estimatedMonthlySales × medianPrice × 60% royalty
  const monthlySales = meta?.signals?.estimatedMonthlySales;
  const medianPrice = meta?.signals?.medianPrice;
  const monthlyEarnings =
    monthlySales != null && medianPrice != null
      ? monthlySales * medianPrice * 0.6
      : null;

  return (
    <div
      className={cn(
        "rounded-lg border bg-card flex flex-col cursor-pointer hover:ring-1 hover:ring-ring/40 transition-shadow",
        VERDICT_BORDER[verdict],
        VERDICT_BG[verdict],
      )}
      onClick={() => onSelect(opp)}
    >
      {/* Header */}
      <div className="px-4 pt-4 pb-3 flex-1 space-y-3">
        {/* Title row */}
        <div className="flex items-start gap-2">
          <span
            className={cn(
              "mt-0.5 inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-bold tracking-wider shrink-0",
              TIER_COLOR[opp.tier] ?? TIER_COLOR.B,
            )}
          >
            {opp.tier}
          </span>
          <span className="text-sm font-semibold leading-snug flex-1 min-w-0">
            {opp.headKeyword}
          </span>
          <span
            className={cn(
              "mt-0.5 ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0",
              STATUS_COLOR[opp.status],
            )}
          >
            {STATUS_LABEL[opp.status]}
          </span>
        </div>

        {/* Category */}
        <p className="text-[10px] text-muted-foreground truncate leading-none">
          {formatCategoryPath(opp.categoryPath)}
        </p>

        {/* Opportunity score + verdict badge */}
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">
              Opp Score
            </p>
            <p className={cn("text-3xl font-bold tabular-nums leading-none", VERDICT_SCORE_COLOR[verdict])}>
              {oppScore.toFixed(0)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span
              className={cn(
                "inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-bold",
                VERDICT_STYLE[verdict],
              )}
            >
              {verdict}
            </span>
            {monthlyEarnings != null && (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <TrendingUp className="h-3 w-3" />
                ${monthlyEarnings.toLocaleString(undefined, { maximumFractionDigits: 0 })}/mo
              </span>
            )}
          </div>
        </div>

        {/* Score bars */}
        {criteria ? (
          <div className="space-y-1.5 pt-1">
            <ScoreRow label="Demand" score={criteria.demandScore} barClass="bg-yellow-500" />
            <ScoreRow label="Competition" score={criteria.competitionScore} barClass="bg-blue-500" />
            <ScoreRow label="Revenue" score={criteria.revenueScore} barClass="bg-green-500" />
            <ScoreRow label="Ad Efficiency" score={criteria.adEfficiencyScore} barClass="bg-purple-500" />
          </div>
        ) : (
          <div className="space-y-1.5 pt-1">
            <ScoreRow label="Composite" score={opp.compositeScore} barClass="bg-purple-500" />
          </div>
        )}

        {/* Signal chips: BSR, Volume, Price */}
        {meta?.signals && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1">
            {meta.signals.bsrMedianTop30 != null && (
              <span className="text-[10px] text-muted-foreground">
                BSR <span className="text-foreground font-medium">{meta.signals.bsrMedianTop30.toLocaleString()}</span>
              </span>
            )}
            {meta.signals.keywordSearchVolume != null && (
              <span className="text-[10px] text-muted-foreground">
                Vol <span className="text-foreground font-medium">{meta.signals.keywordSearchVolume.toLocaleString()}/mo</span>
              </span>
            )}
            {medianPrice != null && (
              <span className="text-[10px] text-muted-foreground">
                Price <span className="text-foreground font-medium">${medianPrice.toFixed(2)}</span>
              </span>
            )}
            {meta.signals.qualifiedTitlesInTop30 != null && (
              <span className="text-[10px] text-muted-foreground">
                Top30 <span className="text-foreground font-medium">{meta.signals.qualifiedTitlesInTop30}</span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Action buttons — always visible for unreviewed */}
      {opp.status === "unreviewed" && (
        <div className="px-4 pb-3 pt-2 border-t border-border/50 flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
          <Button
            size="sm"
            variant="default"
            className="flex-1 gap-1 text-xs h-7"
            disabled={isPending}
            onClick={() => onReview(opp.id, "approve")}
          >
            <CheckCircle className="h-3 w-3" />
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1 text-xs h-7 px-2.5"
            disabled={isPending}
            onClick={() => onReview(opp.id, "defer")}
          >
            <Clock className="h-3 w-3" />
            Defer
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1 text-xs h-7 px-2.5 text-destructive hover:text-destructive"
            disabled={isPending}
            onClick={() => onReview(opp.id, "reject")}
          >
            <XCircle className="h-3 w-3" />
            Reject
          </Button>
        </div>
      )}
    </div>
  );
}

export function NicheOpportunities() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedOpp, setSelectedOpp] = useState<NicheOpportunity | null>(null);

  const statusFilter = (searchParams.get("tab") ?? "unreviewed") as StatusFilter;
  const verdictFilter = (searchParams.get("verdict") ?? "all") as VerdictFilter;
  const tierFilter = (searchParams.get("tier") ?? "all") as TierFilter;
  const categoryFilter = searchParams.get("cat") ?? "all";
  const sortKey = (searchParams.get("sort") ?? "score-desc") as SortKey;
  const datePreset = (searchParams.get("datePreset") ?? "all") as DatePreset;
  const dateFrom = searchParams.get("dateFrom") ?? "";
  const dateTo = searchParams.get("dateTo") ?? "";

  function setStatusFilter(v: StatusFilter) {
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set("tab", v); return p; }, { replace: true });
  }
  function setVerdictFilter(v: VerdictFilter) {
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set("verdict", v); return p; }, { replace: true });
  }
  function setTierFilter(v: TierFilter) {
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set("tier", v); return p; }, { replace: true });
  }
  function setCategoryFilter(v: string) {
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set("cat", v); return p; }, { replace: true });
  }
  function setSortKey(v: SortKey) {
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set("sort", v); return p; }, { replace: true });
  }
  function setDatePreset(v: DatePreset) {
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set("datePreset", v); return p; }, { replace: true });
  }
  function setDateFrom(v: string) {
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set("dateFrom", v); return p; }, { replace: true });
  }
  function setDateTo(v: string) {
    setSearchParams((prev) => { const p = new URLSearchParams(prev); p.set("dateTo", v); return p; }, { replace: true });
  }
  function clearFilters() {
    setSearchParams((prev) => {
      const p = new URLSearchParams(prev);
      p.set("verdict", "all");
      p.set("tier", "all");
      p.set("cat", "all");
      p.delete("datePreset");
      p.delete("dateFrom");
      p.delete("dateTo");
      return p;
    }, { replace: true });
  }

  useEffect(() => {
    setBreadcrumbs([{ label: "Niche Opportunities" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["nicheOpportunities", selectedCompanyId, statusFilter],
    queryFn: () =>
      nicheOpportunitiesApi.list(
        selectedCompanyId!,
        statusFilter === "unreviewed" ? "unreviewed" : undefined,
        500,
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

  const allItems = data?.items ?? [];

  const publishCount = useMemo(() => allItems.filter((o) => getVerdict(o) === "Publish").length, [allItems]);
  const considerCount = useMemo(() => allItems.filter((o) => getVerdict(o) === "Consider").length, [allItems]);
  const avoidCount = useMemo(() => allItems.filter((o) => getVerdict(o) === "Avoid").length, [allItems]);
  const unreviewedCount = useMemo(() => allItems.filter((o) => o.status === "unreviewed").length, [allItems]);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const opp of allItems) {
      seen.add(extractTopCategory(opp.categoryPath));
    }
    return Array.from(seen).sort();
  }, [allItems]);

  const sortedAll = useMemo(() => applySortKey(allItems, sortKey), [allItems, sortKey]);
  const items = useMemo(() => {
    const fromDate = getDateFilterFrom(datePreset, dateFrom || undefined);
    const toDate = datePreset === "custom" && dateTo ? new Date(dateTo + "T23:59:59") : null;
    return sortedAll.filter((opp) => {
      if (tierFilter !== "all" && opp.tier !== tierFilter) return false;
      if (verdictFilter !== "all" && getVerdict(opp) !== verdictFilter) return false;
      if (categoryFilter !== "all" && extractTopCategory(opp.categoryPath) !== categoryFilter)
        return false;
      if (fromDate) {
        const discovered = new Date(opp.discoveredAt);
        if (discovered < fromDate) return false;
        if (toDate && discovered > toDate) return false;
      }
      return true;
    });
  }, [sortedAll, tierFilter, verdictFilter, categoryFilter, datePreset, dateFrom, dateTo]);

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const tabItems = [
    { value: "unreviewed", label: "Unreviewed" },
    { value: "all", label: "All" },
  ];

  return (
    <div className="space-y-4">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <PageTabBar
            items={tabItems}
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as StatusFilter)}
            align="start"
          />
        </Tabs>

        <div className="flex items-center gap-2">
          <label className="sr-only" htmlFor="niche-sort-select">Sort by</label>
          <select
            id="niche-sort-select"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as SortKey)}
            className="h-8 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          >
            <option value="score-desc">Highest Score</option>
            <option value="score-asc">Lowest Score</option>
            <option value="date-desc">Newest First</option>
            <option value="date-asc">Oldest First</option>
          </select>
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Filter className="h-3.5 w-3.5" />
            <span>
              {items.length !== allItems.length
                ? `${items.length} of ${allItems.length}`
                : `${allItems.length}`}{" "}
              total
            </span>
          </div>
          {allItems.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-8 text-xs"
              onClick={() => exportNichesToCsv(items)}
              title="Export visible niches as CSV"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          )}
        </div>
      </div>

      {/* KPI strip */}
      {!isLoading && allItems.length > 0 && (
        <div className="flex items-center gap-4 flex-wrap py-1 border-b border-border pb-2">
          <KpiPill label="Total" value={allItems.length} />
          <KpiPill label="Publish" value={publishCount} colorClass="text-green-400" />
          <KpiPill label="Consider" value={considerCount} colorClass="text-yellow-400" />
          <KpiPill label="Avoid" value={avoidCount} colorClass="text-red-400" />
          <KpiPill label="Unreviewed" value={unreviewedCount} />
        </div>
      )}

      {/* Filter bar */}
      {allItems.length > 0 && (
        <div className="flex flex-wrap gap-3 items-start border border-border rounded-lg p-3 bg-card/50">
          {/* Verdict filter */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Verdict
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              <FilterPill active={verdictFilter === "all"} onClick={() => setVerdictFilter("all")}>All</FilterPill>
              <FilterPill active={verdictFilter === "Publish"} onClick={() => setVerdictFilter("Publish")} colorClass="bg-green-500/20 text-green-400 border-green-500/40">Publish</FilterPill>
              <FilterPill active={verdictFilter === "Consider"} onClick={() => setVerdictFilter("Consider")} colorClass="bg-yellow-500/20 text-yellow-400 border-yellow-500/40">Consider</FilterPill>
              <FilterPill active={verdictFilter === "Avoid"} onClick={() => setVerdictFilter("Avoid")} colorClass="bg-red-500/20 text-red-400 border-red-500/40">Avoid</FilterPill>
            </div>
          </div>

          {/* Tier filter */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Tier
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              <FilterPill active={tierFilter === "all"} onClick={() => setTierFilter("all")}>All</FilterPill>
              <FilterPill active={tierFilter === "S"} onClick={() => setTierFilter("S")} colorClass="bg-yellow-500/20 text-yellow-500 border-yellow-500/40">S</FilterPill>
              <FilterPill active={tierFilter === "A"} onClick={() => setTierFilter("A")} colorClass="bg-purple-500/20 text-purple-500 border-purple-500/40">A</FilterPill>
              <FilterPill active={tierFilter === "B"} onClick={() => setTierFilter("B")} colorClass="bg-blue-500/20 text-blue-500 border-blue-500/40">B</FilterPill>
            </div>
          </div>

          {/* Category filter */}
          {categories.length > 1 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Category
              </span>
              {categories.length <= 5 ? (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <FilterPill active={categoryFilter === "all"} onClick={() => setCategoryFilter("all")}>All</FilterPill>
                  {categories.map((cat) => (
                    <FilterPill key={cat} active={categoryFilter === cat} onClick={() => setCategoryFilter(cat)}>
                      {cat}
                    </FilterPill>
                  ))}
                </div>
              ) : (
                <>
                  <label className="sr-only" htmlFor="niche-cat-select">Filter by category</label>
                  <select
                    id="niche-cat-select"
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value)}
                    className="h-7 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="all">All Categories</option>
                    {categories.map((cat) => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                </>
              )}
            </div>
          )}

          {/* Discovered (date) filter */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              Discovered
              {datePreset !== "all" && (
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
              )}
            </span>
            <div className="flex items-center gap-1.5 flex-wrap">
              <FilterPill active={datePreset === "all"} onClick={() => setDatePreset("all")}>All time</FilterPill>
              <FilterPill active={datePreset === "7d"} onClick={() => setDatePreset("7d")}>Last 7d</FilterPill>
              <FilterPill active={datePreset === "30d"} onClick={() => setDatePreset("30d")}>Last 30d</FilterPill>
              <FilterPill active={datePreset === "90d"} onClick={() => setDatePreset("90d")}>Last 90d</FilterPill>
              <FilterPill active={datePreset === "custom"} onClick={() => setDatePreset("custom")}>Custom</FilterPill>
            </div>
            {datePreset === "custom" && (
              <div className="flex items-center gap-1.5 flex-wrap mt-0.5">
                <label className="sr-only" htmlFor="niche-date-from">From date</label>
                <input
                  id="niche-date-from"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                />
                <span className="text-[10px] text-muted-foreground">–</span>
                <label className="sr-only" htmlFor="niche-date-to">To date</label>
                <input
                  id="niche-date-to"
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Scoring legend */}
      {allItems.length > 0 && (
        <div className="flex items-center gap-4 text-[10px] text-muted-foreground flex-wrap">
          <span className="font-medium">Verdict:</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-500" />Publish (≥ 600)</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-yellow-500" />Consider (350–599)</span>
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" />Avoid (&lt; 350)</span>
          <span className="ml-auto text-[10px] italic">Score = (Demand×35% + Revenue×40%) ÷ (Comp/100+0.1) × 10</span>
        </div>
      )}

      {/* Errors */}
      {error && <ErrorCard message={error.message} />}
      {actionError && <ErrorCard message={actionError} />}

      {/* Empty state — no data */}
      {!isLoading && allItems.length === 0 && (
        <EmptyState
          icon={Telescope}
          message={
            statusFilter === "unreviewed"
              ? "No unreviewed opportunities. NDA will surface more on its next cycle."
              : "No niche opportunities yet."
          }
        />
      )}

      {/* Empty state — filters exclude all */}
      {allItems.length > 0 && items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Telescope className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">No results match the current filters.</p>
          <button
            className="mt-2 text-xs text-primary underline-offset-2 hover:underline"
            onClick={clearFilters}
          >
            Clear filters
          </button>
        </div>
      )}

      {/* Card grid — 1 col mobile, 2 col md, 3 col xl */}
      {items.length > 0 && (
        <div className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
          {items.map((opp) => (
            <NicheCard
              key={opp.id}
              opp={opp}
              onReview={(id, action) => reviewMutation.mutate({ id, action })}
              isPending={reviewMutation.isPending}
              onSelect={setSelectedOpp}
            />
          ))}
        </div>
      )}

      {/* Detail side panel */}
      <NicheDetailSheet
        opp={selectedOpp}
        open={selectedOpp !== null}
        onClose={() => setSelectedOpp(null)}
        onReview={(id, action) => reviewMutation.mutate({ id, action })}
        isPending={reviewMutation.isPending}
      />
    </div>
  );
}
