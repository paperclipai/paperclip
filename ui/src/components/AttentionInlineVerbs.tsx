import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ExternalLink, Loader2, RotateCcw } from "lucide-react";
import type { AttentionItem } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { budgetsApi } from "../api/budgets";
import { issuesApi } from "../api/issues";
import { useOptionalToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { formatCents } from "../lib/utils";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * Inline verbs for the cards whose server actions now work in place (PAP-749
 * plan §2, Rule 7): Retry on a failed run, and Raise limit / Keep paused on a
 * budget stop. Each verb calls the same endpoint as its native page, so the
 * activity log and the authorization checks are the same.
 */

function ActionsFooter({ leading, children }: { leading?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2" data-attention-actions="true">
      {leading ?? <span />}
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function metadataString(item: AttentionItem, key: string): string | null {
  const value = item.subject.metadata?.[key];
  return typeof value === "string" && value ? value : null;
}

function metadataNumber(item: AttentionItem, key: string): number | null {
  const value = item.subject.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Retry the failed run's task, and open the run log. */
export function FailedRunActions({
  item,
  companyId,
  leading,
  onResolved,
}: {
  item: AttentionItem;
  companyId: string;
  leading?: ReactNode;
  onResolved?: () => void;
}) {
  const queryClient = useQueryClient();
  const toasts = useOptionalToastActions();
  const issueId = metadataString(item, "issueId") ?? item.relatedIssue?.id ?? null;
  // One idempotency key per card, so a double click or a lost response asks once.
  const idempotencyKey = useRef<string | null>(null);
  const retry = useMutation({
    mutationFn: () => {
      idempotencyKey.current ??= crypto.randomUUID();
      return issuesApi.retryTask(issueId!, { idempotencyKey: idempotencyKey.current, observedRunId: item.subject.id });
    },
    onSuccess: (result) => {
      toasts?.pushToast({
        title: result.accepted ? "Retry requested" : "A retry is already running",
        body: item.relatedIssue?.identifier ?? undefined,
        tone: "success",
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      if (issueId) void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      onResolved?.();
    },
    onError: (error) => {
      idempotencyKey.current = null;
      toasts?.pushToast({ title: "Could not retry this run", body: error instanceof Error ? error.message : undefined, tone: "error" });
    },
  });

  return (
    <ActionsFooter leading={leading}>
      {item.subject.href && (
        <Button asChild variant="outline" size="sm">
          <Link to={item.subject.href}>
            Open run
            <ExternalLink className="h-3.5 w-3.5" />
          </Link>
        </Button>
      )}
      {issueId && (
        <Button type="button" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
          {retry.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          Retry
        </Button>
      )}
    </ActionsFooter>
  );
}

function centsInputValue(value: number) {
  return (value / 100).toFixed(2);
}

function parseDollarInput(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

/**
 * Raise limit / Keep paused on a budget card. "Keep paused" records that the
 * pause continues; it never says that work started again (PAP-749 plan §2,
 * Rule 6). A warning does not pause work, so its second verb dismisses it.
 */
export function BudgetAlertActions({
  item,
  companyId,
  leading,
  onResolved,
}: {
  item: AttentionItem;
  companyId: string;
  leading?: ReactNode;
  onResolved?: () => void;
}) {
  const queryClient = useQueryClient();
  const toasts = useOptionalToastActions();
  const observed = metadataNumber(item, "amountObserved") ?? 0;
  const limit = metadataNumber(item, "amountLimit") ?? 0;
  const isWarning = item.subject.metadata?.thresholdType === "soft";
  const [draft, setDraft] = useState(() => centsInputValue(Math.max(observed + 1000, limit + (isWarning ? 1000 : 0))));
  const amount = parseDollarInput(draft);
  const tooLow = amount !== null && amount <= observed;
  const resolve = useMutation({
    mutationFn: (input: { action: "keep_paused" | "raise_budget_and_resume"; amount?: number }) =>
      budgetsApi.resolveIncident(companyId, item.subject.id, input),
    onSuccess: (_result, input) => {
      toasts?.pushToast({
        title: input.action === "keep_paused" ? (isWarning ? "Warning dismissed" : "Kept paused") : "Limit raised",
        body: item.subject.title ?? undefined,
        tone: "success",
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(companyId) });
      onResolved?.();
    },
    onError: (error) => {
      toasts?.pushToast({ title: "Could not update the budget", body: error instanceof Error ? error.message : undefined, tone: "error" });
    },
  });

  return (
    <div className="space-y-3" data-attention-budget-actions>
      <p className="text-sm text-muted-foreground">
        {`Spend is ${formatCents(observed)} of a ${formatCents(limit)} limit.`}
        {isWarning ? " This warning does not pause work." : " Work in this scope is paused."}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="text-xs font-medium text-muted-foreground" htmlFor={`attention-budget-${item.id}`}>
          New limit (USD)
        </label>
        <Input
          id={`attention-budget-${item.id}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          inputMode="decimal"
          className="sm:max-w-40"
        />
      </div>
      {tooLow && <p className="text-xs text-destructive">The new limit must be more than the current spend.</p>}
      <ActionsFooter leading={leading}>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={resolve.isPending}
          onClick={() => resolve.mutate({ action: "keep_paused" })}
        >
          {isWarning ? "Dismiss warning" : "Keep paused"}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={resolve.isPending || amount === null || tooLow}
          onClick={() => { if (amount !== null) resolve.mutate({ action: "raise_budget_and_resume", amount }); }}
        >
          {resolve.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
          {isWarning ? "Raise limit" : "Raise limit & resume"}
        </Button>
      </ActionsFooter>
    </div>
  );
}
