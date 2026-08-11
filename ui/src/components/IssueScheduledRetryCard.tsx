import type { ReactNode } from "react";
import { Clock, RotateCcw, AlertCircle, AlertTriangle, Loader2, CheckCircle2 } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { cn, formatDateTime } from "@/lib/utils";
import { formatMonitorOffset } from "@/lib/issue-monitor";
import { formatRetryReason } from "@/lib/runRetryState";
import { copyTextToClipboard } from "@/lib/clipboard";
import {
  describeRecoverySlot,
  receiptChipTitle,
  recoveryAttemptLabel,
  recoverySlotHeadline,
  resolveRecoverySlot,
  shortRecoveryId,
  type RecoverySlot,
  type RecoverySlotIcon,
} from "@/lib/interrupted-run-recovery";
import type {
  InterruptedRunRecovery,
  IssueRecoveryAction,
  IssueScheduledRetry,
} from "@paperclipai/shared";
import { useRetryNowMutation, type RetryNowError } from "../hooks/useRetryNowMutation";
import { Badge } from "@/components/ui/badge";

const MAX_TURN_CONTINUATION = "max_turns_continuation";

function isContinuationReason(reason: string | null | undefined) {
  return reason === MAX_TURN_CONTINUATION;
}

function shortRunId(runId: string | null | undefined) {
  return typeof runId === "string" && runId.length >= 8 ? runId.slice(0, 8) : runId ?? "";
}

const SLOT_ICON: Record<RecoverySlotIcon, typeof Clock> = {
  clock: Clock,
  rotate: RotateCcw,
  alert: AlertTriangle,
};

/**
 * A run id as a machine value: 8-char short form, mono, full id in the tooltip,
 * linked when a destination exists (spec §3).
 */
function RunIdFragment({
  runId,
  agentId,
}: {
  runId: string;
  agentId: string | null;
}) {
  const short = shortRecoveryId(runId) ?? runId;
  if (!agentId) {
    return (
      <span className="font-mono text-foreground" title={runId}>
        {short}
      </span>
    );
  }
  return (
    <Link
      to={`/agents/${agentId}/runs/${runId}`}
      className="font-mono text-foreground hover:underline"
      title={runId}
    >
      {short}
    </Link>
  );
}

/**
 * Receipt ids have no detail surface yet, so the chip copies the full id on
 * click and carries `{id} · {outcome}` in its tooltip. If Phase 5A ever exposes
 * a receipt route this becomes a link; the copy contract does not change.
 */
function ReceiptFragment({ slot }: { slot: RecoverySlot }) {
  if (!slot.receiptId) return null;
  const receiptId = slot.receiptId;
  const short = shortRecoveryId(receiptId) ?? receiptId;
  return (
    <span>
      Receipt{" "}
      <button
        type="button"
        data-testid="issue-recovery-receipt-chip"
        title={receiptChipTitle(slot) ?? receiptId}
        onClick={() => {
          void copyTextToClipboard(receiptId);
        }}
        className="font-mono text-foreground hover:underline"
      >
        {short}
      </button>
    </span>
  );
}

function EvidenceRow({
  slot,
  absolute,
  leadRunLabel,
}: {
  slot: RecoverySlot;
  absolute: string | null;
  leadRunLabel: "Replaces run" | "Interrupted run" | "Continues run";
}) {
  const fragments: ReactNode[] = [];
  if (absolute) fragments.push(<span key="at">{absolute}</span>);
  if (slot.interruptedRunId) {
    fragments.push(
      <span key="run">
        {leadRunLabel}{" "}
        <RunIdFragment runId={slot.interruptedRunId} agentId={slot.agentId} />
      </span>,
    );
  }
  if (slot.receiptId) fragments.push(<ReceiptFragment key="receipt" slot={slot} />);
  if (fragments.length === 0) return null;
  return (
    <div className="mt-0.5 flex min-w-0 flex-wrap gap-x-1 text-xs text-muted-foreground">
      {fragments.map((fragment, index) => (
        // Fragments wrap between each other; ids never break mid-string.
        <span key={index} className="inline-flex items-center gap-1">
          {index > 0 ? <span aria-hidden>·</span> : null}
          {fragment}
        </span>
      ))}
    </div>
  );
}

interface IssueScheduledRetryCardProps {
  issueId: string | null | undefined;
  scheduledRetry: IssueScheduledRetry | null | undefined;
  /** Phase 5A read model. Absent on older servers; the card falls back. */
  interruptedRunRecovery?: InterruptedRunRecovery | null;
  /** When an owner has to act, the recovery-action card owns the slot instead. */
  activeRecoveryAction?: IssueRecoveryAction | null;
  issueStatus?: string | null;
}

export function IssueScheduledRetryCard({
  issueId,
  scheduledRetry,
  interruptedRunRecovery,
  activeRecoveryAction,
  issueStatus,
}: IssueScheduledRetryCardProps) {
  const retryNow = useRetryNowMutation(issueId);

  if (!issueId) return null;
  // Spec §1 pri 1 — a finished task has no next action to offer, and the same
  // rule the blocked notice already applies (`IssueBlockedNotice`).
  if (issueStatus === "done" || issueStatus === "cancelled") return null;

  const slot = resolveRecoverySlot({
    issueStatus,
    interruptedRunRecovery,
    scheduledRetry,
    activeRecoveryAction,
  });

  // Exclusivity (spec §1): at most one recovery card per task. When the
  // recovery-action card owns the slot this one stands down entirely.
  if (slot?.card === "recovery_action") return null;

  const continuation = isContinuationReason(scheduledRetry?.scheduledRetryReason);
  const presentation = slot && !continuation ? describeRecoverySlot(slot) : null;

  // No interruption state to explain: keep the pre-existing card, which only
  // speaks for a not-yet-promoted scheduled retry.
  if (!presentation) {
    if (!scheduledRetry) return null;
    if (scheduledRetry.status !== "scheduled_retry") return null;
  }

  const dueAtIso = scheduledRetry?.scheduledRetryAt
    ? new Date(scheduledRetry.scheduledRetryAt).toISOString()
    : null;
  const relative = dueAtIso ? formatMonitorOffset(dueAtIso) : null;
  const absolute = scheduledRetry?.scheduledRetryAt
    ? formatDateTime(scheduledRetry.scheduledRetryAt)
    : slot?.interruptedAt
      ? formatDateTime(slot.interruptedAt)
      : null;
  const reason = formatRetryReason(scheduledRetry?.scheduledRetryReason);
  const legacyAttempt =
    typeof scheduledRetry?.scheduledRetryAttempt === "number"
    && Number.isFinite(scheduledRetry.scheduledRetryAttempt)
    && scheduledRetry.scheduledRetryAttempt > 0
      ? scheduledRetry.scheduledRetryAttempt
      : null;

  const badgeLabel = presentation
    ? presentation.badgeLabel
    : continuation
      ? "Continuation scheduled"
      : "Retry scheduled";
  const attemptLabel = presentation && slot
    ? recoveryAttemptLabel(slot)
    : legacyAttempt !== null
      ? `Attempt ${legacyAttempt}`
      : null;

  let title: string;
  if (presentation && slot) {
    title = recoverySlotHeadline(slot, { relativeDue: relative });
  } else {
    const titleAction = continuation ? "Automatic continuation" : "Automatic retry";
    let titleSuffix: string;
    if (relative === "now") {
      titleSuffix = "due now";
    } else if (relative) {
      titleSuffix = relative;
    } else {
      titleSuffix = "pending schedule";
    }
    title = `${titleAction} ${titleSuffix}`;
  }

  const showRetryNow = presentation ? presentation.showRetryNow : true;
  const tone = presentation?.tone ?? null;
  const Icon = presentation ? SLOT_ICON[presentation.icon] : Clock;
  const helperIdle = continuation
    ? "Pulls continuation forward immediately"
    : "Pulls retry forward immediately";
  const isError = retryNow.isError || retryNow.lastError !== null;
  const isSuccessTransient = retryNow.isSuccess
    && (retryNow.data?.outcome === "promoted" || retryNow.data?.outcome === "already_promoted");
  const evidenceLead = slot?.variant === "recovered"
    ? "Continues run"
    : slot?.variant === "retry_queued"
      ? "Replaces run"
      : "Interrupted run";

  return (
    <div
      data-testid="issue-scheduled-retry-card"
      data-recovery-variant={slot?.variant}
      role="status"
      aria-label={`${badgeLabel} — ${title}`}
      className={cn(
        "mb-3 rounded-lg border px-3 py-3",
        tone ? tone.container : "border-blue-500/30 bg-blue-500/5",
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge
              variant="outline"
              className={tone?.badge ?? "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300"}
            >
              <Icon className="h-3 w-3" aria-hidden="true" />
              {badgeLabel}
            </Badge>
            {attemptLabel ? (
              <span className="text-muted-foreground">{attemptLabel}</span>
            ) : null}
            {!presentation && reason ? (
              <span className="text-muted-foreground">{reason}</span>
            ) : null}
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">{title}</div>
          {presentation?.body ? (
            <div
              data-testid="issue-scheduled-retry-card-body"
              className="mt-0.5 text-xs text-muted-foreground"
            >
              {presentation.body}
            </div>
          ) : null}
          {presentation && slot ? (
            <EvidenceRow slot={slot} absolute={absolute} leadRunLabel={evidenceLead} />
          ) : (absolute || scheduledRetry?.retryOfRunId) ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {absolute ? <span>{absolute}</span> : null}
              {absolute && scheduledRetry?.retryOfRunId ? <span>{" · "}</span> : null}
              {scheduledRetry?.retryOfRunId ? (
                <span>
                  Replaces run{" "}
                  <Link
                    to={`/agents/${scheduledRetry.agentId}/runs/${scheduledRetry.retryOfRunId}`}
                    className="font-mono text-foreground hover:underline"
                  >
                    {shortRunId(scheduledRetry.retryOfRunId)}
                  </Link>
                </span>
              ) : null}
            </div>
          ) : null}
          {!presentation && scheduledRetry?.error ? (
            <div className="mt-1 text-xs text-muted-foreground">
              Last attempt failed: {scheduledRetry.error}. Paperclip will retry automatically.
            </div>
          ) : null}
          {showRetryNow && isError ? (
            <RetryErrorBand
              error={retryNow.lastError}
              onRetry={() => {
                retryNow.reset();
                retryNow.mutate();
              }}
            />
          ) : null}
        </div>
        {showRetryNow ? (
          <div className="flex flex-col items-stretch gap-1 sm:items-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 shadow-none"
              onClick={() => retryNow.mutate()}
              disabled={retryNow.isPending || isSuccessTransient}
              data-testid="issue-scheduled-retry-card-retry-now"
            >
              {retryNow.isPending ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  Retrying…
                </span>
              ) : isSuccessTransient ? (
                <span className="inline-flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                  {retryNow.data?.outcome === "already_promoted" ? "Already promoted" : "Promoted"}
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  Retry now
                </span>
              )}
            </Button>
            <span className="text-right text-xs text-muted-foreground sm:max-w-(--sz-12rem)">
              {retryNow.isPending
                ? "Promoting scheduled retry"
                : isSuccessTransient
                  ? retryNow.data?.outcome === "already_promoted"
                    ? "Already promoted — run starting"
                    : "Promoted — run starting"
                  : helperIdle}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

interface RetryErrorBandProps {
  error: RetryNowError | null;
  onRetry: () => void;
  className?: string;
}

export function RetryErrorBand({ error, onRetry, className }: RetryErrorBandProps) {
  if (!error) return null;
  return (
    <div
      className={cn(
        "mt-2 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-300",
        className,
      )}
      role="alert"
      data-testid="issue-scheduled-retry-error-band"
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Couldn't retry now</div>
        <div className="mt-0.5 text-muted-foreground">{error.message}</div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 font-medium text-rose-700 hover:underline dark:text-rose-300"
      >
        Try again
      </button>
    </div>
  );
}
