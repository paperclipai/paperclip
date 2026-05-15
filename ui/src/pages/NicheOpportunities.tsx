import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Telescope, CheckCircle, Clock, XCircle, Filter } from "lucide-react";
import { nicheOpportunitiesApi } from "../api/nicheOpportunities";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { cn } from "../lib/utils";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "../components/ui/button";
import type { NicheOpportunity, NicheOpportunityStatus } from "@paperclipai/shared";

type StatusFilter = "unreviewed" | "all";

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

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 rounded-full bg-muted overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full",
            score >= 75 ? "bg-yellow-500" : score >= 50 ? "bg-purple-500" : "bg-blue-500",
          )}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-muted-foreground">{score.toFixed(1)}</span>
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

  return (
    <div className="rounded-lg border border-border bg-card">
      <div
        className="flex items-start gap-3 p-4 cursor-pointer"
        onClick={() => setExpanded((v) => !v)}
      >
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
            <span
              className={cn(
                "ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium",
                STATUS_COLOR[opp.status],
              )}
            >
              {STATUS_LABEL[opp.status]}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground truncate">{opp.categoryPath}</p>
          <div className="mt-2">
            <ScoreBar score={opp.compositeScore} />
          </div>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
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
                <div className="col-span-1">{opp.reviewNote}</div>
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
