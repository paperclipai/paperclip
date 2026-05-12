import { formatDateTime } from "./utils";
import { RETRY_BADGE_ZH, RETRY_REASON_ZH, runRetryUi } from "./i18n";

type RetryAwareRun = {
  status: string;
  retryOfRunId?: string | null;
  scheduledRetryAt?: string | Date | null;
  scheduledRetryAttempt?: number | null;
  scheduledRetryReason?: string | null;
  retryExhaustedReason?: string | null;
};

export type RunRetryStateSummary = {
  kind: "scheduled" | "exhausted" | "attempted";
  badgeLabel: string;
  tone: string;
  detail: string | null;
  secondary: string | null;
  retryOfRunId: string | null;
};

const RETRY_REASON_LABELS: Record<string, string> = RETRY_REASON_ZH;

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function joinFragments(parts: Array<string | null>) {
  const filtered = parts.filter((part): part is string => Boolean(part));
  return filtered.length > 0 ? filtered.join(" · ") : null;
}

function needsManualInterventionPhrase(exhaustedReason: string) {
  return /manual intervention required/i.test(exhaustedReason)
    || exhaustedReason.includes(runRetryUi.manualInterventionPhrase);
}

export function formatRetryReason(reason: string | null | undefined) {
  const normalized = readNonEmptyString(reason);
  if (!normalized) return null;
  return RETRY_REASON_LABELS[normalized] ?? normalized.replace(/_/g, " ");
}

export function describeRunRetryState(run: RetryAwareRun): RunRetryStateSummary | null {
  const attempt =
    typeof run.scheduledRetryAttempt === "number" && Number.isFinite(run.scheduledRetryAttempt) && run.scheduledRetryAttempt > 0
      ? run.scheduledRetryAttempt
      : null;
  const attemptLabel = attempt ? runRetryUi.attemptLabel(attempt) : null;
  const reasonLabel = formatRetryReason(run.scheduledRetryReason);
  const retryOfRunId = readNonEmptyString(run.retryOfRunId);
  const exhaustedReason = readNonEmptyString(run.retryExhaustedReason);
  const dueAt = run.scheduledRetryAt ? formatDateTime(run.scheduledRetryAt) : null;
  const isMaxTurnContinuation = run.scheduledRetryReason === "max_turns_continuation";
  const hasRetryMetadata =
    Boolean(retryOfRunId)
    || Boolean(reasonLabel)
    || Boolean(dueAt)
    || Boolean(attemptLabel)
    || Boolean(exhaustedReason);

  if (!hasRetryMetadata) return null;

  if (run.status === "scheduled_retry") {
    return {
      kind: "scheduled",
      badgeLabel: isMaxTurnContinuation ? RETRY_BADGE_ZH.continuationScheduled : RETRY_BADGE_ZH.retryScheduled,
      tone: "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
      detail: joinFragments([attemptLabel, reasonLabel]),
      secondary: dueAt
        ? `${isMaxTurnContinuation ? RETRY_BADGE_ZH.nextContinuation : RETRY_BADGE_ZH.nextRetry} ${dueAt}`
        : `${isMaxTurnContinuation ? RETRY_BADGE_ZH.nextContinuation : RETRY_BADGE_ZH.nextRetry} ${RETRY_BADGE_ZH.nextPendingSchedule}`,
      retryOfRunId,
    };
  }

  if (exhaustedReason) {
    return {
      kind: "exhausted",
      badgeLabel: isMaxTurnContinuation ? RETRY_BADGE_ZH.continuationExhausted : RETRY_BADGE_ZH.retryExhausted,
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      detail: joinFragments([attemptLabel, reasonLabel, RETRY_BADGE_ZH.automaticRetriesExhausted]),
      secondary: needsManualInterventionPhrase(exhaustedReason)
        ? exhaustedReason
        : `${exhaustedReason} 需要人工介入。`,
      retryOfRunId,
    };
  }

  return {
    kind: "attempted",
    badgeLabel: isMaxTurnContinuation ? RETRY_BADGE_ZH.continuedRun : RETRY_BADGE_ZH.retriedRun,
    tone: "border-slate-500/20 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    detail: joinFragments([attemptLabel, reasonLabel]),
    secondary: null,
    retryOfRunId,
  };
}
