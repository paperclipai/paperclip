import { RUNNER_REVISION_WAIT_RETRY_REASON } from "./runner-revision-mismatch.js";
import { PROVIDER_ATTEMPT_CREDIT_GENERATION_LIMIT } from "./native-runtime/provider-attempt-outcome.js";

/**
 * A preparation that a restart interrupted before any provider work started
 * (its certificate records `providerWorkStarted: false`) spent no provider
 * work, so it never charges the failure budget (durable-ownership plan,
 * section F). Its own counter keeps a crash loop bounded, at the same limit
 * as the native controller-generation cap.
 */
export const INTERRUPTED_PREPARATION_RETRY_REASON = "interrupted_preparation";
export const INTERRUPTED_PREPARATION_RETRY_MAX_ATTEMPTS = PROVIDER_ATTEMPT_CREDIT_GENERATION_LIMIT;

/** Retry lanes that keep their own counter and never spend failures. */
const UNCHARGED_RETRY_LANES: ReadonlySet<string> = new Set([
  "workspace_busy", "ai_connection_busy", "ai_connection_pool_wait", RUNNER_REVISION_WAIT_RETRY_REASON,
  INTERRUPTED_PREPARATION_RETRY_REASON,
]);

type RetryRun = {
  scheduledRetryAttempt?: number | null;
  scheduledRetryReason?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
};

/** Server-owned counts for one automatic continuation chain. Repair slots live
 * in legacyDispositionEpisode and are never charged to either counter here. */
export interface ExecutionRetryAccounting {
  version: 1;
  failureRetries: number;
  maxTurnContinuations: number;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function savedAccounting(run: RetryRun): ExecutionRetryAccounting | null {
  const value = run.contextSnapshot?.executionRetryAccounting;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const saved = value as Record<string, unknown>;
  const failureRetries = count(saved.failureRetries);
  const maxTurnContinuations = count(saved.maxTurnContinuations);
  if (saved.version !== 1 || failureRetries === null || maxTurnContinuations === null) return null;
  return { version: 1, failureRetries, maxTurnContinuations };
}

function historicalFailureCount(run: RetryRun): number {
  if (run.scheduledRetryReason === "max_turns_continuation" || run.scheduledRetryReason === "issue_disposition_repair") return 0;
  if (run.scheduledRetryReason === "ai_connection_busy" || run.scheduledRetryReason === "ai_connection_pool_wait") {
    const saved = count(run.contextSnapshot?.failureRetriesBeforeAiConnectionWait);
    if (saved !== null) return saved;
  }
  if (run.scheduledRetryReason === "workspace_busy") {
    const saved = count(run.contextSnapshot?.failureRetriesBeforeWorkspaceWait);
    if (saved !== null) return saved;
  }
  // Historical ambiguous counters remain conservative rather than resetting.
  return count(run.scheduledRetryAttempt) ?? 0;
}

export function executionRetryAccounting(run: RetryRun): ExecutionRetryAccounting {
  const saved = savedAccounting(run);
  const reason = run.scheduledRetryReason ?? "";
  const nonFailureLane = reason === "max_turns_continuation" || reason === "issue_disposition_repair" || UNCHARGED_RETRY_LANES.has(reason);
  return {
    version: 1,
    failureRetries: Math.max(saved?.failureRetries ?? 0, saved && nonFailureLane ? 0 : historicalFailureCount(run)),
    maxTurnContinuations: Math.max(saved?.maxTurnContinuations ?? 0,
      run.scheduledRetryReason === "max_turns_continuation" ? count(run.scheduledRetryAttempt) ?? 0 : 0),
  };
}

/** Resource waits, repairs and productive continuations do not spend failures. */
export function executionFailureRetryCount(run: RetryRun): number {
  return executionRetryAccounting(run).failureRetries;
}

export function executionRetryAttemptCount(run: RetryRun, reason: string): number {
  if (UNCHARGED_RETRY_LANES.has(reason)) {
    return run.scheduledRetryReason === reason ? count(run.scheduledRetryAttempt) ?? 0 : 0;
  }
  const accounting = executionRetryAccounting(run);
  return reason === "max_turns_continuation" ? accounting.maxTurnContinuations : accounting.failureRetries;
}

export function accountingForScheduledRetry(run: RetryRun, reason: string, attempt: number): ExecutionRetryAccounting {
  const accounting = executionRetryAccounting(run);
  if (reason === "max_turns_continuation") accounting.maxTurnContinuations = attempt;
  else if (!UNCHARGED_RETRY_LANES.has(reason)) accounting.failureRetries = attempt;
  return accounting;
}
