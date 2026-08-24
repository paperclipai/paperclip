import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PlanReviewGate } from "@paperclipai/shared";
import { CheckCircle2, ChevronDown, Loader2, ShieldCheck, ThumbsDown, ThumbsUp, XCircle, History } from "lucide-react";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatDateTime, relativeTime } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getGateStatusLabel(status: PlanReviewGate["status"]): string {
  switch (status) {
    case "pending": return "Pending";
    case "approved": return "Approved";
    case "rejected": return "Rejected";
    case "superseded": return "Superseded";
    default: return status;
  }
}

function getGateStatusClass(status: PlanReviewGate["status"]): string {
  switch (status) {
    case "approved":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "rejected":
      return "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300";
    case "superseded":
      return "border-muted-foreground/20 bg-muted-foreground/5 text-muted-foreground";
    case "pending":
    default:
      return "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
}

function getGateStatusIcon(status: PlanReviewGate["status"]) {
  switch (status) {
    case "approved": return <CheckCircle2 className="h-3.5 w-3.5" />;
    case "rejected": return <XCircle className="h-3.5 w-3.5" />;
    case "superseded": return <History className="h-3.5 w-3.5" />;
    case "pending":
    default: return <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  }
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface PlanApprovalGatesSectionProps {
  issueId: string;
  /** Current plan document revision id (gates are listed for the latest revision). */
  revisionId?: string | null;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PlanApprovalGatesSection({
  issueId,
  revisionId,
}: PlanApprovalGatesSectionProps) {
  const queryClient = useQueryClient();
  const [resolutionComment, setResolutionComment] = useState<string>("");
  const [expandedHistory, setExpandedHistory] = useState(false);
  const [activeGateId, setActiveGateId] = useState<string | null>(null);

  const { data: gates, isLoading } = useQuery({
    queryKey: queryKeys.issues.planGates(issueId, revisionId ?? null),
    queryFn: () => issuesApi.listPlanGates(issueId, revisionId ?? undefined),
  });

  const resolveGate = useMutation({
    mutationFn: ({
      gateId,
      status,
      comment,
    }: {
      gateId: string;
      status: "approved" | "rejected";
      comment: string | null;
    }) => issuesApi.resolvePlanGate(issueId, gateId, {
      status,
      resolutionComment: comment?.trim() || null,
    }),
    onSuccess: () => {
      setResolutionComment("");
      setActiveGateId(null);
      // Use 3-element prefix to match both revisionId-specific and __all__ keys
      queryClient.invalidateQueries({ queryKey: ["issues", "plan-gates", issueId] });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.planDocument(issueId) });
      // Refresh the issue detail to reflect gate status changes in plan status
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
    },
  });

  const allGates = useMemo(() => gates ?? [], [gates]);

  const pendingGates = useMemo(
    () => allGates.filter((g) => g.status === "pending"),
    [allGates],
  );
  const resolvedGates = useMemo(
    () => allGates.filter((g) => g.status !== "pending"),
    [allGates],
  );

  if (isLoading) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-border p-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading approval gates...
      </div>
    );
  }

  if (allGates.length === 0) {
    return null;
  }

  const allApproved = pendingGates.length === 0
    && resolvedGates.length > 0
    && resolvedGates.every((g) => g.status === "approved");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          <ShieldCheck className="h-4 w-4" />
          Approval gates
        </h3>
        <span className="text-[11px] text-muted-foreground/70">
          {pendingGates.length} pending · {resolvedGates.length} resolved
        </span>
      </div>

      {/* All gates approved → plan status transition notice */}
      {allApproved && (
        <div className="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">All gates approved</p>
            <p className="text-xs opacity-80">
              The plan status will transition to <span className="font-medium">Approved</span>.
            </p>
          </div>
        </div>
      )}

      {/* Pending gates */}
      {pendingGates.length > 0 && (
        <ul className="space-y-2">
          {pendingGates.map((gate) => (
            <li
              key={gate.id}
              className="rounded-md border border-amber-500/30 bg-card/50 p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-sm border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
                    {getGateStatusIcon(gate.status)}
                    Pending
                  </span>
                  <span className="text-[11px] text-muted-foreground/70">
                    revision {revisionId ? "gate" : ""}
                  </span>
                  <span
                    className="text-[11px] text-muted-foreground/70"
                    title={formatDateTime(gate.createdAt)}
                  >
                    created {relativeTime(gate.createdAt)}
                  </span>
                </div>
                {gate.milestoneId && (
                  <span className="text-[10px] text-muted-foreground/60">
                    milestone-linked gate
                  </span>
                )}
              </div>

              {/* Acceptance criteria */}
              {gate.acceptanceCriteria.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {gate.acceptanceCriteria.map((ac, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-1.5 text-xs text-muted-foreground/90"
                    >
                      <span className="mt-1 shrink-0 text-muted-foreground/40">-</span>
                      <span>{ac}</span>
                    </li>
                  ))}
                </ul>
              )}

              {/* Resolution controls */}
              {activeGateId === gate.id ? (
                <div className="mt-2 space-y-2">
                  <Textarea
                    value={resolutionComment}
                    onChange={(e) => setResolutionComment(e.target.value)}
                    placeholder="Optional comment (shown in gate history)"
                    className="min-h-[64px] text-xs"
                    maxLength={4000}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="default"
                      className="h-7 gap-1 bg-emerald-600 text-white hover:bg-emerald-700"
                      disabled={resolveGate.isPending}
                      onClick={() =>
                        resolveGate.mutate({
                          gateId: gate.id,
                          status: "approved",
                          comment: resolutionComment,
                        })
                      }
                    >
                      {resolveGate.isPending ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ThumbsUp className="h-3.5 w-3.5" />
                      )}
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 gap-1 border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-300"
                      disabled={resolveGate.isPending}
                      onClick={() =>
                        resolveGate.mutate({
                          gateId: gate.id,
                          status: "rejected",
                          comment: resolutionComment,
                        })
                      }
                    >
                      <ThumbsDown className="h-3.5 w-3.5" />
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() => {
                        setActiveGateId(null);
                        setResolutionComment("");
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10 dark:text-emerald-300"
                    onClick={() => {
                      setActiveGateId(gate.id);
                      setResolutionComment("");
                    }}
                  >
                    <ThumbsUp className="h-3.5 w-3.5" />
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 border-red-500/40 text-red-700 hover:bg-red-500/10 dark:text-red-300"
                    onClick={() => {
                      setActiveGateId(gate.id);
                      setResolutionComment("");
                    }}
                  >
                    <ThumbsDown className="h-3.5 w-3.5" />
                    Reject
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* Gate history */}
      {resolvedGates.length > 0 && (
        <div className="rounded-md border border-border/60">
          <button
            type="button"
            className="flex w-full items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground"
            onClick={() => setExpandedHistory((v) => !v)}
          >
            <span className="flex items-center gap-1.5">
              <History className="h-3.5 w-3.5" />
              Gate history ({resolvedGates.length})
            </span>
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", expandedHistory && "rotate-180")}
            />
          </button>
          {expandedHistory && (
            <div className="space-y-1.5 px-3 pb-3">
              {resolvedGates.map((gate) => (
                <div
                  key={gate.id}
                  className={cn(
                    "rounded-md border p-2.5",
                    getGateStatusClass(gate.status),
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium">
                      {getGateStatusIcon(gate.status)}
                      {getGateStatusLabel(gate.status)}
                    </span>
                    <span
                      className="text-[10px] opacity-70"
                      title={gate.resolvedAt ? formatDateTime(gate.resolvedAt) : undefined}
                    >
                      {gate.resolvedAt ? relativeTime(gate.resolvedAt) : ""}
                      {gate.resolvedByAgentId ? " · by agent" : gate.resolvedByUserId ? " · by board" : ""}
                    </span>
                  </div>
                  {gate.acceptanceCriteria.length > 0 && (
                    <ul className="mt-1 space-y-0.5">
                      {gate.acceptanceCriteria.map((ac, i) => (
                        <li key={i} className="flex items-start gap-1.5 text-[11px] opacity-80">
                          <span className="shrink-0 opacity-50">-</span>
                          <span>{ac}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {gate.resolutionComment && (
                    <p className="mt-1 text-[11px] italic opacity-80">
                      "{gate.resolutionComment}"
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}