import { useEffect, useMemo, useState } from "react";
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
import { ExpandableApprovalCard } from "../components/ExpandableApprovalCard";
import { PageSkeleton } from "../components/PageSkeleton";
import {
  approvalAgeHours,
  approvalLane,
  approvalNeedsReminder,
  compareApprovalsByStatusThenCreated,
  contentTier,
  CONTENT_TIER_LABELS,
  CONTENT_TIER_ORDER,
  type ApprovalLane,
  type ContentTier,
} from "../lib/approvals";

type StatusFilter = "pending" | "all";

type ColumnKey = ContentTier | "intake" | "ops";

const TIER_DOT: Record<ContentTier, string> = {
  blog: "bg-blue-500",
  social: "bg-purple-500",
  outreach: "bg-emerald-500",
};

export function Approvals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathSegment = location.pathname.split("/").pop() ?? "pending";
  const statusFilter: StatusFilter = pathSegment === "all" ? "all" : "pending";

  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedByColumn, setExpandedByColumn] = useState<Record<ColumnKey, string | null>>({
    blog: null,
    social: null,
    outreach: null,
    intake: null,
    ops: null,
  });
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);

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

  const invalidate = () => queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      setActionError(null);
      invalidate();
      navigate(`/approvals/${id}?resolved=approved`);
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to approve"),
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to reject"),
  });

  const requestRevisionMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => approvalsApi.requestRevision(id, note),
    onSuccess: () => {
      setActionError(null);
      invalidate();
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to request edits"),
  });

  const statusFiltered = (data ?? [])
    .filter((a) => statusFilter === "all" || a.status === "pending" || a.status === "revision_requested")
    .sort(compareApprovalsByStatusThenCreated);

  const pendingCount = (data ?? []).filter((a) => a.status === "pending" || a.status === "revision_requested").length;
  const stalePendingCount = (data ?? []).filter((approval) => approvalNeedsReminder(approval)).length;

  const marketingItems = statusFiltered.filter((a) => approvalLane(a) === "marketing");
  const intakeItems = statusFiltered.filter((a) => approvalLane(a) === "intake");
  const opsItems = statusFiltered.filter((a) => approvalLane(a) === "ops");

  const marketingByTier = useMemo(() => {
    const map: Record<ContentTier, typeof marketingItems> = { blog: [], social: [], outreach: [] };
    for (const item of marketingItems) map[contentTier(item)].push(item);
    return map;
  }, [marketingItems]);

  const pendingFor = (items: typeof statusFiltered) =>
    items.filter((a) => a.status === "pending" || a.status === "revision_requested").length;

  const toggleExpanded = (column: ColumnKey, id: string) => {
    setExpandedByColumn((prev) => ({ ...prev, [column]: prev[column] === id ? null : id }));
  };

  if (!selectedCompanyId) return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  if (isLoading) return <PageSkeleton variant="approvals" />;

  return (
    <div className="space-y-4 w-full">
      <div className="flex items-center justify-between">
        <Tabs value={statusFilter} onValueChange={(v) => navigate(`/approvals/${v}`)}>
          <PageTabBar items={[
            {
              value: "pending",
              label: (
                <>
                  Pending
                  {pendingCount > 0 && (
                    <span className={cn("ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium", "bg-yellow-500/20 text-yellow-500")}>
                      {pendingCount}
                    </span>
                  )}
                </>
              ),
            },
            { value: "all", label: "All" },
          ]} />
        </Tabs>
      </div>

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {stalePendingCount > 0 && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          {stalePendingCount} approval{stalePendingCount === 1 ? "" : "s"} pending for more than 24h. Review to avoid stale queue drift.
        </p>
      )}

      {statusFiltered.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ShieldCheck className="h-8 w-8 text-muted-foreground/30 mb-3" />
          <p className="text-sm text-muted-foreground">{statusFilter === "pending" ? "No pending approvals." : "No approvals yet."}</p>
        </div>
      )}

      {statusFiltered.length > 0 && (
        <>
          {/* Marketing tiers */}
          <div className="grid grid-cols-3 gap-3 items-start">
            {CONTENT_TIER_ORDER.map((tier) => {
              const items = marketingByTier[tier];
              const pending = pendingFor(items);
              return (
                <section key={tier} className="rounded-lg border border-border bg-card min-h-[200px]">
                  <div className="sticky top-0 z-10 border-b border-border bg-card px-3 py-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={cn("inline-flex h-2 w-2 rounded-full", TIER_DOT[tier])} />
                      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">{CONTENT_TIER_LABELS[tier]}</h3>
                    </div>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px]",
                        pending > 0 ? "bg-yellow-500/20 text-yellow-600 dark:text-yellow-400" : "bg-muted text-muted-foreground",
                      )}
                    >
                      {pending}
                    </span>
                  </div>

                  <div className="p-2 space-y-2">
                    {items.map((approval) => {
                      const isResolved = approval.status !== "pending" && approval.status !== "revision_requested";
                      return (
                        <ExpandableApprovalCard
                          key={approval.id}
                          approval={approval}
                          requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                          expanded={expandedByColumn[tier] === approval.id}
                          onToggle={() => toggleExpanded(tier, approval.id)}
                          onApprove={() => approveMutation.mutate(approval.id)}
                          onReject={() => rejectMutation.mutate(approval.id)}
                          onRequestRevision={(note) => requestRevisionMutation.mutate({ id: approval.id, note })}
                          isPending={approveMutation.isPending || rejectMutation.isPending || requestRevisionMutation.isPending}
                          needsReminder={approvalNeedsReminder(approval)}
                          ageHours={approvalAgeHours(approval)}
                          muted={statusFilter === "all" && isResolved}
                          detailLink={`/approvals/${approval.id}`}
                        />
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>

          {/* Intake + Ops */}
          <div className="grid grid-cols-2 gap-3 items-start">
            {([
              { key: "intake" as const, title: "Intake", open: intakeOpen, setOpen: setIntakeOpen, items: intakeItems },
              { key: "ops" as const, title: "Ops", open: opsOpen, setOpen: setOpsOpen, items: opsItems },
            ]).map((lane) => {
              const pending = pendingFor(lane.items);
              const dimmed = pending === 0;
              return (
                <section key={lane.key} className={cn("rounded-lg border border-border bg-card", dimmed && "opacity-70")}>
                  <button
                    type="button"
                    className="w-full flex items-center justify-between border-b border-border px-3 py-2"
                    onClick={() => lane.setOpen(!lane.open)}
                  >
                    <div className="flex items-center gap-2">
                      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">{lane.title}</h3>
                      <span className={cn("rounded px-1.5 py-0.5 text-[10px]", pending > 0 ? "bg-yellow-500/20 text-yellow-600 dark:text-yellow-400" : "bg-muted text-muted-foreground")}>{pending}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{lane.open ? "▴" : "▾"}</span>
                  </button>

                  {lane.open && (
                    <div className="p-2 space-y-2">
                      {lane.items.map((approval) => {
                        const isResolved = approval.status !== "pending" && approval.status !== "revision_requested";
                        return (
                          <ExpandableApprovalCard
                            key={approval.id}
                            approval={approval}
                            requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                            expanded={expandedByColumn[lane.key] === approval.id}
                            onToggle={() => toggleExpanded(lane.key, approval.id)}
                            onApprove={() => approveMutation.mutate(approval.id)}
                            onReject={() => rejectMutation.mutate(approval.id)}
                            onRequestRevision={(note) => requestRevisionMutation.mutate({ id: approval.id, note })}
                            isPending={approveMutation.isPending || rejectMutation.isPending || requestRevisionMutation.isPending}
                            needsReminder={approvalNeedsReminder(approval)}
                            ageHours={approvalAgeHours(approval)}
                            muted={statusFilter === "all" && isResolved}
                            detailLink={`/approvals/${approval.id}`}
                          />
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
