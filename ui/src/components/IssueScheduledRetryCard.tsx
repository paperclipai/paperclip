import { Clock, RotateCcw, AlertCircle, Loader2, CheckCircle2 } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { cn, formatDateTime } from "@/lib/utils";
import { formatMonitorOffset } from "@/lib/issue-monitor";
import { formatRetryReason } from "@/lib/runRetryState";
import type { IssueScheduledRetry } from "@paperclipai/shared";
import { useRetryNowMutation, type RetryNowError } from "../hooks/useRetryNowMutation";

const MAX_TURN_CONTINUATION = "max_turns_continuation";

function isContinuationReason(reason: string | null | undefined) {
  return reason === MAX_TURN_CONTINUATION;
}

function shortRunId(runId: string | null | undefined) {
  return typeof runId === "string" && runId.length >= 8 ? runId.slice(0, 8) : runId ?? "";
}

interface IssueScheduledRetryCardProps {
  issueId: string | null | undefined;
  scheduledRetry: IssueScheduledRetry | null | undefined;
}

export function IssueScheduledRetryCard({
  issueId,
  scheduledRetry,
}: IssueScheduledRetryCardProps) {
  const retryNow = useRetryNowMutation(issueId);

  if (!scheduledRetry || !issueId) return null;
  if (scheduledRetry.status !== "scheduled_retry") return null;

  const continuation = isContinuationReason(scheduledRetry.scheduledRetryReason);
  const dueAtIso = scheduledRetry.scheduledRetryAt
    ? new Date(scheduledRetry.scheduledRetryAt).toISOString()
    : null;
  const relative = dueAtIso ? formatMonitorOffset(dueAtIso) : null;
  const absolute = scheduledRetry.scheduledRetryAt
    ? formatDateTime(scheduledRetry.scheduledRetryAt)
    : null;
  const reason = formatRetryReason(scheduledRetry.scheduledRetryReason);
  const attempt =
    typeof scheduledRetry.scheduledRetryAttempt === "number"
    && Number.isFinite(scheduledRetry.scheduledRetryAttempt)
    && scheduledRetry.scheduledRetryAttempt > 0
      ? scheduledRetry.scheduledRetryAttempt
      : null;

  const badgeLabel = continuation ? "Continuation scheduled" : "Retry scheduled";
  const titleAction = continuation ? "Automatic continuation" : "Automatic retry";
  let titleSuffix: string;
  if (relative === "now") {
    titleSuffix = "due now";
  } else if (relative) {
    titleSuffix = relative;
  } else {
    titleSuffix = "pending schedule";
  }
  const title = `${titleAction} ${titleSuffix}`;

  const helperIdle = continuation
    ? "Pulls continuation forward immediately"
    : "Pulls retry forward immediately";
  const isError = retryNow.isError || retryNow.lastError !== null;
  const isSuccessTransient = retryNow.isSuccess
    && (retryNow.data?.outcome === "promoted" || retryNow.data?.outcome === "already_promoted");

  return (
    <div
      data-testid="issue-scheduled-retry-card"
      className="mb-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 px-3 py-3"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 font-medium text-cyan-700 dark:text-cyan-300">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {badgeLabel}
            </span>
            {attempt !== null ? (
              <span className="text-muted-foreground">Attempt {attempt}</span>
            ) : null}
            {reason ? (
              <span className="text-muted-foreground">{reason}</span>
            ) : null}
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">{title}</div>
          {(absolute || scheduledRetry.retryOfRunId) ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {absolute ? <span>{absolute}</span> : null}
              {absolute && scheduledRetry.retryOfRunId ? <span>{" · "}</span> : null}
              {scheduledRetry.retryOfRunId ? (
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
          {scheduledRetry.error ? (
            <div className="mt-1 text-xs text-muted-foreground">
              Last attempt failed: {scheduledRetry.error}. Paperclip will retry automatically.
            </div>
          ) : null}
          {isError ? (
            <RetryErrorBand
              error={retryNow.lastError}
              onRetry={() => {
                retryNow.reset();
                retryNow.mutate();
              }}
            />
          ) : null}
        </div>
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
          <span className="text-right text-xs text-muted-foreground sm:max-w-[12rem]">
            {retryNow.isPending
              ? "Promoting scheduled retry"
              : isSuccessTransient
                ? retryNow.data?.outcome === "already_promoted"
                  ? "Already promoted — run starting"
                  : "Promoted — run starting"
                : helperIdle}
          </span>
        </div>
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
