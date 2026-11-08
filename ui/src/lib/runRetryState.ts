import { t } from "@/i18n";
import { formatDateTime } from "./utils";

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

const RETRY_REASON_LABELS: Record<string, string> = {
  get "native_provider_overloaded"() { return t("display:copy_040a37c72ee3"); },
  get "ai_connection_pool_wait"() { return t("display:copy_a01e6d3bb1d2"); },
  get "transient_failure"() { return t("display:copy_f8a1024e3695"); },
  get "missing_issue_comment"() { return t("display:copy_1ad218f77e92"); },
  get "process_lost"() { return t("display:copy_cf3c64c6a215"); },
  get "assignment_recovery"() { return t("display:copy_8056775d4b06"); },
  get "issue_continuation_needed"() { return t("display:copy_849e40d5b95b"); },
  get "max_turns_continuation"() { return t("display:copy_2a1b691676d8"); },
};

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function joinFragments(parts: Array<string | null>) {
  const filtered = parts.filter((part): part is string => Boolean(part));
  return filtered.length > 0 ? filtered.join(" · ") : null;
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
  const attemptLabel = attempt ? t("display:copy_51b5e051fe38", { value0: attempt }) : null;
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
      badgeLabel: run.scheduledRetryReason === "ai_connection_pool_wait" ? t("display:copy_be2420548c4f") : isMaxTurnContinuation ? t("display:copy_0f2659612c55") : t("display:copy_0f39ab272e44"),
      tone: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300",
      detail: joinFragments([attemptLabel, reasonLabel]),
      secondary: dueAt
        ? `${isMaxTurnContinuation ? t("display:copy_9a09ab841476") : t("display:copy_e0bc62a6326b")} ${dueAt}`
        : t("display:copy_05e93902f66b", { value0: isMaxTurnContinuation ? t("display:copy_9a09ab841476") : t("display:copy_e0bc62a6326b") }),
      retryOfRunId,
    };
  }

  if (exhaustedReason) {
    return {
      kind: "exhausted",
      badgeLabel: isMaxTurnContinuation ? t("display:copy_e96a7984d382") : t("display:copy_e338bd1f19bd"),
      tone: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      detail: joinFragments([attemptLabel, reasonLabel, t("display:copy_84d89149193c")]),
      secondary: exhaustedReason.includes("Manual intervention required")
        ? exhaustedReason
        : t("display:copy_2d6921292773", { value0: exhaustedReason }),
      retryOfRunId,
    };
  }

  return {
    kind: "attempted",
    badgeLabel: isMaxTurnContinuation ? t("display:copy_d1829314ce0c") : t("display:copy_e55a8e67c290"),
    tone: "border-slate-500/20 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    detail: joinFragments([attemptLabel, reasonLabel]),
    secondary: null,
    retryOfRunId,
  };
}
