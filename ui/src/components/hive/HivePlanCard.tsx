import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "@/lib/router";
import { Play, CircleStop, Trash2, Layers } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { plansApi } from "../../api/plans";
import { useToastActions } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { formatTokens } from "../../lib/utils";
import { planFirstTierTicketCount } from "../../lib/hive-board";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

interface HivePlanCardProps {
  issue: Issue;
  companyId: string | null;
}

const STATE_STYLES: Record<string, string> = {
  draft: "border-border bg-muted/40 text-muted-foreground",
  activating: "border-blue-400/45 bg-blue-50/60 text-blue-700 dark:bg-blue-400/10 dark:text-blue-300",
  active: "border-green-400/45 bg-green-50/60 text-green-700 dark:bg-green-400/10 dark:text-green-300",
  stopped: "border-red-400/45 bg-red-50/60 text-red-700 dark:bg-red-400/10 dark:text-red-300",
  completed: "border-border bg-muted/40 text-muted-foreground",
};

// Plan-root card. Drafts can be Activated (materializes tier-1 tickets into
// Open); active plans can be Stopped (cancels the whole subtree) or Deleted.
export function HivePlanCard({ issue, companyId }: HivePlanCardProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [, setSearchParams] = useSearchParams();
  const [confirmStop, setConfirmStop] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const { data: plan } = useQuery({
    queryKey: queryKeys.hive.plan(issue.id),
    queryFn: () => plansApi.get(issue.id),
  });
  const state = plan?.planDetails.state ?? "draft";
  const capTokens = plan?.planDetails.budgetCapTokens ?? null;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.hive.plan(issue.id) });
    if (companyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.liveMeter(companyId) });
    }
  };

  const activate = useMutation({
    mutationFn: () => plansApi.activate(issue.id),
    onSuccess: (r) => {
      pushToast({
        title: "Plan activated",
        body: `${r.childIssueIds.length} ticket(s) opened.`,
        tone: "success",
      });
      invalidate();
    },
    onError: (e) => pushToast({ title: "Activation failed", body: errMsg(e), tone: "error" }),
  });

  const stop = useMutation({
    mutationFn: () => plansApi.stop(issue.id),
    onSuccess: (r) => {
      pushToast({ title: "Plan stopped", body: r.message, tone: "success" });
      setConfirmStop(false);
      invalidate();
    },
    onError: (e) => pushToast({ title: "Stop failed", body: errMsg(e), tone: "error" }),
  });

  const remove = useMutation({
    mutationFn: () => plansApi.remove(issue.id),
    onSuccess: (r) => {
      pushToast({
        title: "Plan deleted",
        body: `${r.deletedIssueIds.length} issue(s) removed.`,
        tone: "success",
      });
      setConfirmDelete(false);
      invalidate();
    },
    onError: (e) => pushToast({ title: "Delete failed", body: errMsg(e), tone: "error" }),
  });

  const childCount = plan?.planDetails.tiers.reduce(
    (n, t) => n + (t.childIssueIds.length || t.requestedChildren.length),
    0,
  );
  // Gate Activate on the server's actual rule (first tier only). Undefined while
  // loading → 0 → disabled, which is the safe default.
  const firstTierCount = planFirstTierTicketCount(plan?.planDetails.tiers);
  const canActivate = firstTierCount > 0;

  return (
    <div className="rounded-md border bg-card p-3 transition-shadow hover:shadow-sm">
      <button
        type="button"
        className="block w-full text-left"
        onClick={() => setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.set("plan", issue.id);
          return next;
        })}
      >
        <div className="mb-1.5 flex items-center gap-1.5">
          <Layers className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-mono text-xs text-muted-foreground">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          <span
            className={`ml-auto rounded-full border px-1.5 py-0.5 text-[10px] font-medium capitalize ${STATE_STYLES[state] ?? STATE_STYLES.draft}`}
          >
            {state}
          </span>
        </div>
        <p className="mb-2 line-clamp-2 text-sm font-medium leading-snug">{issue.title}</p>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          {typeof childCount === "number" && <span>{childCount} task(s)</span>}
          {capTokens ? <span>cap {formatTokens(capTokens)} tok</span> : null}
        </div>
      </button>

      <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-2">
        {state === "draft" && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            onClick={() => activate.mutate()}
            disabled={activate.isPending || !canActivate}
            aria-label="Activate plan"
            title={canActivate ? undefined : "Add at least one task before activating"}
          >
            <Play className="h-3 w-3" />
            Activate
          </button>
        )}
        {state === "active" && (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-accent"
            onClick={() => setConfirmStop(true)}
            aria-label="Stop plan"
          >
            <CircleStop className="h-3 w-3" />
            Stop
          </button>
        )}
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
          aria-label="Delete plan"
          title="Delete plan"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <ConfirmActionDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop this plan?"
        description="All running agents under this plan will be cancelled. Already-created tickets stay on the board."
        confirmLabel="Stop plan"
        pending={stop.isPending}
        onConfirm={() => stop.mutate()}
      />
      <ConfirmActionDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="Delete this plan?"
        description="The plan and every ticket created under it will be permanently deleted. Running work is cancelled first. This cannot be undone."
        confirmLabel="Delete plan"
        destructive
        pending={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
