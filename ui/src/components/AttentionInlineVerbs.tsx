import { useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ExternalLink, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import type { AttentionItem } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { budgetsApi } from "../api/budgets";
import { issuesApi } from "../api/issues";
import { useOptionalToastActions } from "../context/ToastContext";
import { invalidateAttentionRecordViews } from "../lib/attention-record-views";
import { taskRetryNotStartedReason } from "../hooks/useTaskRetry";
import { queryKeys } from "../lib/queryKeys";
import { cn, formatCents } from "../lib/utils";
import { DecisionCardFooter } from "./DecisionCardFooter";
import { NeedsYouPanel, NeedsYouPanelNote, NeedsYouPanelRow } from "./coordinator/NeedsYouCardKit";
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

/**
 * "card" is the Needs You card (PAP-775): an inset panel with the context, then
 * the footer with the primary action last. "panel" (default) is the row layout
 * the decisions queue uses.
 */
export type InlineVerbsPresentation = "card" | "panel";

function failedRunError(item: AttentionItem): string {
  const excerpt = item.detail?.kind === "failed_run" || item.detail?.kind === "agent_error" ? item.detail.failureReasonExcerpt : null;
  return metadataString(item, "error") ?? metadataString(item, "errorReason") ?? excerpt ?? metadataString(item, "errorCode") ?? "The run failed";
}

/** Retry the failed run's task, and open the run log. */
export function FailedRunActions({
  item,
  companyId,
  leading,
  footerContext,
  onResolved,
  presentation = "panel",
}: {
  item: AttentionItem;
  companyId: string;
  leading?: ReactNode;
  footerContext?: ReactNode;
  onResolved?: () => void;
  presentation?: InlineVerbsPresentation;
}) {
  const queryClient = useQueryClient();
  const toasts = useOptionalToastActions();
  const issueId = metadataString(item, "issueId") ?? item.relatedIssue?.id ?? null;
  // One idempotency key per card, so a double click or a lost response asks once.
  const idempotencyKey = useRef<string | null>(null);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const retry = useMutation({
    mutationFn: () => {
      idempotencyKey.current ??= crypto.randomUUID();
      return issuesApi.retryTask(issueId!, { idempotencyKey: idempotencyKey.current, observedRunId: item.subject.id });
    },
    onMutate: () => setRetryNotice(null),
    onSuccess: (result) => {
      const notStarted = taskRetryNotStartedReason(result);
      setRetryNotice(notStarted);
      toasts?.pushToast({
        title: notStarted ? "Retry did not start" : "Retry requested",
        body: notStarted ?? item.relatedIssue?.identifier ?? undefined,
        tone: notStarted ? "info" : "success",
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
      if (issueId) void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) });
      if (!notStarted) onResolved?.();
    },
    onError: (error) => {
      idempotencyKey.current = null;
      toasts?.pushToast({ title: "Could not retry this run", body: error instanceof Error ? error.message : undefined, tone: "error" });
    },
  });

  if (presentation === "card") {
    const error = failedRunError(item);
    const reason = metadataString(item, "retryExhaustedReason");
    const note = [reason && reason !== error ? reason : null, issueId ? "Retry starts a new run." : null].filter(Boolean).join(" ");
    return <>
      <NeedsYouPanel>
        <NeedsYouPanelRow icon={<TriangleAlert className="text-destructive" />} title={error} />
        {note ? <NeedsYouPanelNote>{note}</NeedsYouPanelNote> : null}
      </NeedsYouPanel>
      {footerContext}
      {retryNotice ? <p role="status" className="text-sm text-muted-foreground">{retryNotice}</p> : null}
      <DecisionCardFooter leading={leading}>
        {item.subject.href && (
          <Button asChild variant={issueId ? "outline" : "default"} size="sm">
            <Link to={item.subject.href}>View run</Link>
          </Button>
        )}
        {issueId && (
          <Button type="button" size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
            {retry.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Retry run
          </Button>
        )}
      </DecisionCardFooter>
    </>;
  }

  return (
    <>
    {retryNotice ? <p role="status" className="text-sm text-muted-foreground">{retryNotice}</p> : null}
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
    </>
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
  footerContext,
  onResolved,
  presentation = "panel",
}: {
  item: AttentionItem;
  companyId: string;
  leading?: ReactNode;
  footerContext?: ReactNode;
  onResolved?: () => void;
  presentation?: InlineVerbsPresentation;
}) {
  const queryClient = useQueryClient();
  const toasts = useOptionalToastActions();
  // The card asks for the new limit only once you choose to increase it.
  const [raising, setRaising] = useState(false);
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
      // The budget page and the folded override approval show the same stop.
      invalidateAttentionRecordViews(queryClient, companyId, item);
      onResolved?.();
    },
    onError: (error) => {
      toasts?.pushToast({ title: "Could not update the budget", body: error instanceof Error ? error.message : undefined, tone: "error" });
    },
  });

  const limitInput = (
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
        autoFocus={presentation === "card"}
      />
    </div>
  );
  const raiseDisabled = resolve.isPending || amount === null || tooLow;
  const raise = () => { if (amount !== null) resolve.mutate({ action: "raise_budget_and_resume", amount }); };

  if (presentation === "card") {
    const percent = metadataNumber(item, "observedPercent") ?? (limit > 0 ? Math.round((observed / limit) * 100) : 0);
    const scope = metadataString(item, "scopeType");
    return <>
      <NeedsYouPanel>
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-(length:--text-compact) font-medium text-foreground">{`${formatCents(observed)} spent of ${formatCents(limit)}`}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{`${percent}% used`}</span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Budget used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(percent, 100)}>
          <div className={cn("h-full rounded-full", !isWarning || percent >= 100 ? "bg-destructive" : "bg-amber-500")} style={{ width: `${Math.min(percent, 100)}%` }} />
        </div>
        <NeedsYouPanelNote>
          {[scope ? `${scope[0]!.toUpperCase()}${scope.slice(1)} limit` : "Limit", isWarning ? "Work continues until the limit is reached" : "New runs are paused"].join(" · ")}
        </NeedsYouPanelNote>
        {raising ? limitInput : null}
        {raising && tooLow ? <p className="text-xs text-destructive">The new limit must be more than the current spend.</p> : null}
      </NeedsYouPanel>
      {footerContext}
      <DecisionCardFooter leading={leading}>
        <Button type="button" variant="ghost" size="sm" disabled={resolve.isPending} onClick={() => resolve.mutate({ action: "keep_paused" })}>
          {isWarning ? "Dismiss warning" : "Keep paused"}
        </Button>
        {raising ? <>
          <Button type="button" variant="outline" size="sm" disabled={resolve.isPending} onClick={() => setRaising(false)}>Cancel</Button>
          <Button type="button" size="sm" disabled={raiseDisabled} onClick={raise}>
            {resolve.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {isWarning ? "Raise limit" : "Raise limit & resume"}
          </Button>
        </> : <Button type="button" size="sm" disabled={resolve.isPending} onClick={() => setRaising(true)}>Increase limit…</Button>}
      </DecisionCardFooter>
    </>;
  }

  return (
    <div className="space-y-3" data-attention-budget-actions>
      <p className="text-sm text-muted-foreground">
        {`Spend is ${formatCents(observed)} of a ${formatCents(limit)} limit.`}
        {isWarning ? " This warning does not pause work." : " Work in this scope is paused."}
      </p>
      {limitInput}
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
        <Button type="button" size="sm" disabled={raiseDisabled} onClick={raise}>
          {resolve.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpRight className="h-3.5 w-3.5" />}
          {isWarning ? "Raise limit" : "Raise limit & resume"}
        </Button>
      </ActionsFooter>
    </div>
  );
}
