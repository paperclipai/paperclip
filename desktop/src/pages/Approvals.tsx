import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { approvalsApi } from "@/api/approvals";
import type { Approval } from "@/api/approvals";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";

type FilterTab = "pending" | "all";

const TYPE_STYLES: Record<string, { bg: string; fg: string }> = {
  budget: { bg: "var(--warning-subtle)", fg: "var(--warning)" },
  access: { bg: "var(--accent-subtle)", fg: "var(--accent)" },
  deploy: { bg: "var(--success-subtle)", fg: "var(--success)" },
  hire: { bg: "var(--bg-muted)", fg: "var(--fg-secondary)" },
};

const STATUS_STYLES: Record<string, { bg: string; fg: string; label: string }> = {
  pending: { bg: "var(--warning-subtle)", fg: "var(--warning)", label: "Pending" },
  approved: { bg: "var(--success-subtle)", fg: "var(--success)", label: "Approved" },
  rejected: { bg: "var(--destructive-subtle)", fg: "var(--destructive)", label: "Rejected" },
  revision_requested: { bg: "var(--accent-subtle)", fg: "var(--accent)", label: "Revision Requested" },
};

export function Approvals() {
  const [filter, setFilter] = useState<FilterTab>("pending");
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decisionNote, setDecisionNote] = useState("");
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();

  const { data: approvals = [], isLoading } = useQuery({
    queryKey: queryKeys.approvals.list(selectedCompanyId!),
    queryFn: () => approvalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const approveMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => approvalsApi.approve(id, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      setDecidingId(null);
      setDecisionNote("");
    },
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => approvalsApi.reject(id, note),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.approvals.list(selectedCompanyId!) });
      setDecidingId(null);
      setDecisionNote("");
    },
  });

  if (isLoading) return <div className="p-8 text-center" style={{ color: "var(--fg-muted)" }}>Loading...</div>;

  const pendingCount = approvals.filter((a) => a.status === "pending").length;

  const filtered = approvals.filter((a) => {
    if (filter === "pending") return a.status === "pending";
    return true;
  });

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Approvals</h1>
      </div>

      {/* Filter tabs */}
      <div className="mb-6 flex gap-0 border-b" style={{ borderColor: "var(--border)" }}>
        {(["pending", "all"] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={cn("relative px-4 py-2 pb-3 text-[13px] capitalize")}
            style={{
              color: filter === tab ? "var(--fg)" : "var(--fg-muted)",
              fontWeight: filter === tab ? 500 : 400,
              background: "none",
              border: "none",
              fontFamily: "var(--font-body)",
            }}
          >
            {tab}
            {tab === "pending" && (
              <span
                className="ml-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
              >
                {pendingCount}
              </span>
            )}
            {filter === tab && (
              <span className="absolute bottom-[-1px] left-0 right-0 h-[2px] rounded-t" style={{ background: "var(--accent)" }} />
            )}
          </button>
        ))}
      </div>

      {/* Approval cards */}
      <div className="flex flex-col gap-3">
        {filtered.map((approval) => {
          const typeStyle = TYPE_STYLES[approval.type] || TYPE_STYLES.budget;
          const statusStyle = STATUS_STYLES[approval.status] || STATUS_STYLES.pending;
          const isDeciding = decidingId === approval.id;
          const requester = approval.requested_by_agent_id ? agentMap.get(approval.requested_by_agent_id) : null;
          const requesterName = requester?.name ?? "Unknown";

          return (
            <div
              key={approval.id}
              className="rounded-lg border px-5 py-4"
              style={{ background: "var(--card-bg)", borderColor: "var(--card-border)" }}
            >
              <div className="flex items-start gap-3">
                {/* Requester avatar */}
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold"
                  style={{ background: "var(--accent-subtle)", color: "var(--accent)" }}
                >
                  {requesterName[0]}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="mb-1 flex items-center gap-2 flex-wrap">
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
                      style={{ background: typeStyle.bg, color: typeStyle.fg }}
                    >
                      {approval.type}
                    </span>
                    <span className="text-[13px] font-medium">{requesterName}</span>
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{ background: statusStyle.bg, color: statusStyle.fg }}
                    >
                      {statusStyle.label}
                    </span>
                    <span className="ml-auto text-[11px]" style={{ color: "var(--fg-muted)" }}>
                      {new Date(approval.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  <p className="text-sm" style={{ color: "var(--fg-secondary)" }}>{approval.type} approval request</p>

                  {/* Action buttons for pending */}
                  {approval.status === "pending" && !isDeciding && (
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => setDecidingId(approval.id)}
                        className="rounded-md px-3 py-1.5 text-[12px] font-medium"
                        style={{ background: "var(--success-subtle)", color: "var(--success)" }}
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => setDecidingId(approval.id)}
                        className="rounded-md px-3 py-1.5 text-[12px] font-medium"
                        style={{ background: "var(--destructive-subtle)", color: "var(--destructive)" }}
                      >
                        Reject
                      </button>
                    </div>
                  )}

                  {/* Decision note textarea */}
                  {isDeciding && (
                    <div className="mt-3">
                      <textarea
                        value={decisionNote}
                        onChange={(e) => setDecisionNote(e.target.value)}
                        placeholder="Add a note (optional)..."
                        rows={2}
                        className="mb-2 w-full resize-none rounded-md border p-2 text-sm outline-none focus:border-[var(--accent)]"
                        style={{
                          background: "var(--input-bg)",
                          borderColor: "var(--input-border)",
                          color: "var(--fg)",
                          fontFamily: "var(--font-body)",
                        }}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => approveMutation.mutate({ id: approval.id, note: decisionNote || undefined })}
                          disabled={approveMutation.isPending}
                          className="rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
                          style={{ background: "var(--success)", color: "#fff" }}
                        >
                          Confirm Approve
                        </button>
                        <button
                          onClick={() => rejectMutation.mutate({ id: approval.id, note: decisionNote || undefined })}
                          disabled={rejectMutation.isPending}
                          className="rounded-md px-3 py-1.5 text-[12px] font-medium disabled:opacity-40"
                          style={{ background: "var(--destructive)", color: "#fff" }}
                        >
                          Confirm Reject
                        </button>
                        <button
                          onClick={() => { setDecidingId(null); setDecisionNote(""); }}
                          className="rounded-md px-3 py-1.5 text-[12px] font-medium"
                          style={{ color: "var(--fg-muted)" }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="py-16 text-center text-[13px]" style={{ color: "var(--fg-muted)" }}>
            No approvals match this filter.
          </div>
        )}
      </div>
    </div>
  );
}
