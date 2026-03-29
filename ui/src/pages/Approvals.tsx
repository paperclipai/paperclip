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
  type ApprovalLane,
  type ContentTier,
} from "../lib/approvals";

type StatusFilter = "pending" | "all";

type ColumnKey = ContentTier | "intake" | "ops";

const TIER_DOT: Record<string, string> = {
  blue: "bg-blue-500",
  purple: "bg-purple-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  gray: "bg-muted-foreground/50",
};

const MARKETING_TIERS: { key: ContentTier; label: string; tier: string; color: "blue" | "purple" | "green" }[] = [
  { key: "blog", label: "Blog", tier: "Tier 1", color: "blue" },
  { key: "social", label: "Social", tier: "Tier 2", color: "purple" },
  { key: "outreach", label: "Outreach", tier: "Tier 3", color: "green" },
];

const SECONDARY_LANES: { key: ApprovalLane; label: string; color: "amber" | "gray" }[] = [
  { key: "intake", label: "Intake", color: "amber" },
  { key: "ops", label: "Ops", color: "gray" },
];

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
  const [laneOpen, setLaneOpen] = useState<Record<string, boolean>>({ intake: false, ops: false });
  const [dismissingIds, setDismissingIds] = useState<Set<string>>(new Set());

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

  const dismissThenRefresh = (id: string) => {
    setDismissingIds((prev) => new Set(prev).add(id));
    window.setTimeout(() => {
      invalidate();
      setDismissingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 220);
  };

  const approveMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.approve(id),
    onSuccess: (_approval, id) => {
      setActionError(null);
      dismissThenRefresh(id);
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to approve"),
  });

  const rejectMutation = useMutation({
    mutationFn: (id: string) => approvalsApi.reject(id),
    onSuccess: (_approval, id) => {
      setActionError(null);
      dismissThenRefresh(id);
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : "Failed to reject"),
  });

  const requestRevisionMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => approvalsApi.requestRevision(id, note),
    onSuccess: (_approval, vars) => {
      setActionError(null);
      dismissThenRefresh(vars.id);
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
            {MARKETING_TIERS.map((tierDef) => {
              const items = marketingByTier[tierDef.key];
              const pending = pendingFor(items);
              return (
                <section key={tierDef.key} className="rounded-lg border border-border bg-card min-h-[200px]">
                  <div className="sticky top-0 z-10 border-b border-border bg-card px-3 py-2 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={cn("inline-flex h-2 w-2 rounded-full", TIER_DOT[tierDef.color])} />
                      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">{tierDef.label} · {tierDef.tier}</h3>
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
                          expanded={expandedByColumn[tierDef.key] === approval.id}
                          onToggle={() => toggleExpanded(tierDef.key, approval.id)}
                          onApprove={() => approveMutation.mutate(approval.id)}
                          onReject={() => rejectMutation.mutate(approval.id)}
                          onRequestRevision={(note) => requestRevisionMutation.mutate({ id: approval.id, note })}
                          isPending={approveMutation.isPending || rejectMutation.isPending || requestRevisionMutation.isPending}
                          needsReminder={approvalNeedsReminder(approval)}
                          ageHours={approvalAgeHours(approval)}
                          muted={statusFilter === "all" && isResolved}
                          dismissing={dismissingIds.has(approval.id)}
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
            {SECONDARY_LANES.map((laneDef) => {
              const laneItems = laneDef.key === "intake" ? intakeItems : opsItems;
              const pending = pendingFor(laneItems);
              const dimmed = pending === 0;
              const open = laneOpen[laneDef.key] ?? false;
              return (
                <section key={laneDef.key} className={cn("rounded-lg border border-border bg-card", dimmed && "opacity-70")}>
                  <button
                    type="button"
                    className="w-full flex items-center justify-between border-b border-border px-3 py-2"
                    onClick={() => setLaneOpen((prev) => ({ ...prev, [laneDef.key]: !open }))}
                  >
                    <div className="flex items-center gap-2">
                      <span className={cn("inline-flex h-2 w-2 rounded-full", TIER_DOT[laneDef.color])} />
                      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground">{laneDef.label}</h3>
                      <span className={cn("rounded px-1.5 py-0.5 text-[10px]", pending > 0 ? "bg-yellow-500/20 text-yellow-600 dark:text-yellow-400" : "bg-muted text-muted-foreground")}>{pending}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{open ? "▴" : "▾"}</span>
                  </button>

                  {open && (
                    <div className="p-2 space-y-2">
                      {laneItems.map((approval) => {
                        const isResolved = approval.status !== "pending" && approval.status !== "revision_requested";
                        return (
                          <ExpandableApprovalCard
                            key={approval.id}
                            approval={approval}
                            requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
                            expanded={expandedByColumn[laneDef.key as ColumnKey] === approval.id}
                            onToggle={() => toggleExpanded(laneDef.key as ColumnKey, approval.id)}
                            onApprove={() => approveMutation.mutate(approval.id)}
                            onReject={() => rejectMutation.mutate(approval.id)}
                            onRequestRevision={(note) => requestRevisionMutation.mutate({ id: approval.id, note })}
                            isPending={approveMutation.isPending || rejectMutation.isPending || requestRevisionMutation.isPending}
                            needsReminder={approvalNeedsReminder(approval)}
                            ageHours={approvalAgeHours(approval)}
                            muted={statusFilter === "all" && isResolved}
                            dismissing={dismissingIds.has(approval.id)}
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
