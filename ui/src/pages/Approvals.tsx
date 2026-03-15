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
import { EmptyState } from "../components/EmptyState";

type StatusFilter = "pending" | "all";

export function Approvals() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const pathSegment = location.pathname.split("/").pop() ?? "pending";
  const statusFilter: StatusFilter = pathSegment === "all" ? "all" : "pending";
  const [actionError, setActionError] = useState<string | null>(null);

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

  const filtered = (data ?? [])
    .filter(
      (a) => statusFilter === "all" || a.status === "pending" || a.status === "revision_requested",
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const pendingCount = (data ?? []).filter(
    (a) => a.status === "pending" || a.status === "revision_requested",
  ).length;
  const resolvedCount = (data ?? []).filter(
    (a) => a.status === "approved" || a.status === "rejected",
  ).length;

  if (!selectedCompanyId) {
    return <p className="text-sm text-muted-foreground">Select a company first.</p>;
  }

  if (isLoading) {
    return <PageSkeleton variant="approvals" />;
  }

  return (
    <div className="space-y-5">
      <section className="paperclip-gov-hero px-5 py-5 sm:px-6">
        <div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
          <div className="space-y-3">
            <p className="paperclip-gov-kicker">Governance Queue</p>
            <div className="space-y-2">
              <h1 className="paperclip-gov-title">Approvals</h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Review hires, revisions, and sensitive actions from the same operator console used to run the company.
              </p>
            </div>
          </div>
          {/* Keep the approval backlog readable before users drill into specific requests. */}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="paperclip-gov-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-gov-label">Pending</p>
              <p className="mt-2 text-2xl font-semibold">{pendingCount}</p>
            </div>
            <div className="paperclip-gov-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-gov-label">Resolved</p>
              <p className="mt-2 text-2xl font-semibold">{resolvedCount}</p>
            </div>
            <div className="paperclip-gov-stat min-w-[8.5rem] px-4 py-3">
              <p className="paperclip-gov-label">Total</p>
              <p className="mt-2 text-2xl font-semibold">{data?.length ?? 0}</p>
            </div>
          </div>
        </div>
      </section>

      <div className="paperclip-gov-toolbar p-3 sm:p-4">
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

      {error && <p className="text-sm text-destructive">{error.message}</p>}
      {actionError && <p className="text-sm text-destructive">{actionError}</p>}

      {filtered.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          message={statusFilter === "pending" ? "No pending approvals." : "No approvals yet."}
        />
      )}

      {filtered.length > 0 && (
        <div className="grid gap-3">
          {filtered.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              requesterAgent={approval.requestedByAgentId ? (agents ?? []).find((a) => a.id === approval.requestedByAgentId) ?? null : null}
              onApprove={() => approveMutation.mutate(approval.id)}
              onReject={() => rejectMutation.mutate(approval.id)}
              detailLink={`/approvals/${approval.id}`}
              isPending={approveMutation.isPending || rejectMutation.isPending}
            />
          ))}
        </div>
      )}
    </div>
  );
}
