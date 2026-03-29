import { useEffect, useState } from "react";
import { useNavigate, useLocation } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { approvalsApi } from "../api/approvals";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { PageTabBar } from "../components/PageTabBar";
import { Tabs } from "@/components/ui/tabs";
import { ShieldCheck } from "lucide-react";
import { ApprovalCard } from "../components/ApprovalCard";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  approvalAgeHours,
  approvalLane,
  approvalLaneLabel,
  approvalNeedsReminder,
  compareApprovalsByStatusThenCreated,
  contentTier,
  CONTENT_TIER_LABELS,
  CONTENT_TIER_ORDER,
  type ApprovalLane,
} from "../lib/approvals";

type StatusFilter = "pending" | "all";
type LaneFilter = "all" | ApprovalLane;
const LANE_ORDER: ApprovalLane[] = ["marketing", "intake", "ops", "unknown"];

export function Approvals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathSegment = location.pathname.split("/").pop() ?? "pending";
  const statusFilter: StatusFilter = pathSegment === "all" ? "all" : "pending";
  const [laneFilter, setLaneFilter] = useState<LaneFilter>("all");
  const [actionError, setActionError] = useState<string | null>(null);
  const [marketingTierOpen, setMarketingTierOpen] = useState<Record<string, boolean>>({
    blog: true,
    social: true,
    outreach: true,
  });

  useEffect(() => {
    setBreadcrumbs([{ label: "Approvals" }]);
  }, [setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      navigate(`/approvals/${id}?resolved=approved`);
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to approve");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : "Failed to reject");
    },
  });

  const statusFiltered = (data ?? [])
    .filter(
      (a) => statusFilter === "all" || a.status === "pending" || a.status === "revision_requested",
    )
    .sort(compareApprovalsByStatusThenCreated);
  const filtered = statusFiltered.filter(
    (approval) => laneFilter === "all" || approvalLane(approval) === laneFilter,
  );

  const pendingCount = (data ?? []).filter(
    (a) => a.status === "pending" || a.status === "revision_requested",
  ).length;
  const stalePendingCount = (data ?? []).filter((approval) => approvalNeedsReminder(approval)).length;
  const groupedByLane = LANE_ORDER.map((lane) => ({
    lane,
    label: approvalLaneLabel(lane),
    items: filtered.filter((approval) => approvalLane(approval) === lane),
  })).filter((group) => laneFilter === "all" ? group.items.length > 0 : true);

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Tabs value={statusFilter} onValueChange={(v) => navigate(`/approvals/${v}`)}>
          <PageTabBar items={[
            { value: "pending", label: <>Pending{pendingCount > 0 && (
              <span className={cn(
                "ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                "bg-yellow-500/20 text-yellow-500"
              )}>
                {pendingCount}
              </span>
            )}</> },
            { value: "all", label: "All" },
          ]} />
        </Tabs>
      </div>
      <div className="flex flex-wrap gap-2">
        {(["all", ...LANE_ORDER] as LaneFilter[]).map((lane) => (
          <button
            key={lane}
            type="button"
            onClick={() => setLaneFilter(lane)}
            className={cn(
              "rounded-full border px-2.5 py-1 text-xs transition-colors",
              laneFilter === lane
                ? "border-primary bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            {lane === "all" ? "All lanes" : approvalLaneLabel(lane)}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
      {stalePendingCount > 0 && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {stalePendingCount} approval{stalePendingCount === 1 ? "" : "s"} pending for more than 24h. Review to avoid stale queue drift.
        </p>
      )}

      {filtered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldCheck className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">
            {statusFilter === "pending" ? "No pending approvals." : "No approvals yet."}
          </p>
        </div>
      )}

      {filtered.length > 0 && (
        <div className="space-y-4">
          {groupedByLane.map((group) => {
            const staleCount = group.items.filter((approval) => approvalNeedsReminder(approval)).length;
            return (
              <section key={group.lane} className="space-y-2">
                {laneFilter === "all" && (
                  <div className="flex items-center gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{group.label} queue</h3>
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{group.items.length}</span>
                    {staleCount > 0 && (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
                        {staleCount} stale
                      </span>
                    )}
                  </div>
                )}
                {group.lane === "marketing" ? (
                  <div className="space-y-3">
                    {CONTENT_TIER_ORDER.map((tier) => {
                      const tierItems = group.items.filter((approval) => contentTier(approval) === tier);
                      const isOpen = marketingTierOpen[tier] ?? true;
                      if (tierItems.length === 0) return null;

                      return (
                        <div key={tier} className="rounded-md border border-border/60">
                          <button
                            type="button"
                            className="w-full flex items-center justify-between px-3 py-2 text-xs"
                            onClick={() => setMarketingTierOpen((prev) => ({ ...prev, [tier]: !isOpen }))}
                          >
                            <span className="font-semibold text-muted-foreground">{CONTENT_TIER_LABELS[tier]}</span>
                            <span className="inline-flex items-center gap-2">
                              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{tierItems.length}</span>
                              <span className="text-muted-foreground">{isOpen ? "▲" : "▼"}</span>
                            </span>
                          </button>
                          {isOpen && (
                            <div className="grid gap-3 border-t border-border/60 p-3">
                              {tierItems.map((approval) => (
                                <ApprovalCard
                                  key={approval.id}
                                  approval={approval}
                                  requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                                  onApprove={() => approveMutation.mutate(approval.id)}
                                  onReject={() => rejectMutation.mutate(approval.id)}
                                  detailLink={`/approvals/${approval.id}`}
                                  isPending={approveMutation.isPending || rejectMutation.isPending}
                                  needsReminder={approvalNeedsReminder(approval)}
                                  ageHours={approvalAgeHours(approval)}
                                />
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="grid gap-3">
                    {group.items.map((approval) => (
                      <ApprovalCard
                        key={approval.id}
                        approval={approval}
                        requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                        onApprove={() => approveMutation.mutate(approval.id)}
                        onReject={() => rejectMutation.mutate(approval.id)}
                        detailLink={`/approvals/${approval.id}`}
                        isPending={approveMutation.isPending || rejectMutation.isPending}
                        needsReminder={approvalNeedsReminder(approval)}
                        ageHours={approvalAgeHours(approval)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
