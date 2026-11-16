import { RUNNER_REVISION_WAIT_RETRY_REASON } from "./runner-revision-mismatch.js";
import { STORAGE_UNAVAILABLE_WAIT_RETRY_REASON } from "../storage/storage-unavailable.js";
import { PROVIDER_ATTEMPT_CREDIT_GENERATION_LIMIT } from "./native-runtime/provider-attempt-outcome.js";
import { AGENT_DIRECTORY_BUSY_RETRY_REASON } from "../modules/run-dispatch/index.js";

/**
 * A preparation that a restart interrupted before any provider work started
 * (its certificate records `providerWorkStarted: false`) spent no provider
 * work, so it never charges the failure budget (durable-ownership plan,
 * section F). Its own counter keeps a crash loop bounded, at the same limit
 * as the native controller-generation cap.
 */
export const INTERRUPTED_PREPARATION_RETRY_REASON = "interrupted_preparation";
export const INTERRUPTED_PREPARATION_RETRY_MAX_ATTEMPTS = PROVIDER_ATTEMPT_CREDIT_GENERATION_LIMIT;
export const AGENT_DIRECTORY_WAIT_RETRY_REASON = AGENT_DIRECTORY_BUSY_RETRY_REASON;

/**
 * A run that ended only because its server process was replaced or restarted
 * (a deploy's graceful shutdown, or a run found without its owner after a
 * restart) did not fail. Its continuation never spends the failure budget. Its
 * own bound stops a loop: at most SERVER_RESTART_RETRY_MAX_ATTEMPTS
 * continuations inside one SERVER_RESTART_RETRY_WINDOW_MS window. A chain that
 * is interrupted again after the window has passed starts a new window, so a
 * long task survives several deploys a day.
 */
export const SERVER_RESTART_RETRY_REASON = "server_restart";
export const SERVER_RESTART_RETRY_MAX_ATTEMPTS = 6;
export const SERVER_RESTART_RETRY_WINDOW_MS = 60 * 60_000;

/** Retry lanes that keep their own counter and never spend failures. */
const UNCHARGED_RETRY_LANES: ReadonlySet<string> = new Set([
  "workspace_busy", "ai_connection_busy", "ai_connection_pool_wait", AGENT_DIRECTORY_WAIT_RETRY_REASON, RUNNER_REVISION_WAIT_RETRY_REASON,
  INTERRUPTED_PREPARATION_RETRY_REASON, STORAGE_UNAVAILABLE_WAIT_RETRY_REASON, SERVER_RESTART_RETRY_REASON,
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
  /**
   * Interrupted-preparation retries in this chain. Saved with the chain, so a
   * wait retry in between never resets it. Omitted while zero.
   */
  interruptedPreparations?: number;
  /** Storage-outage waits in this chain, kept across intervening resource waits. Omitted while zero. */
  storageWaits?: number;
  /** Agent-directory waits in this chain, kept across intervening resource waits. Omitted while zero. */
  agentDirectoryWaits?: number;
  /** Server-restart continuations in the current window. Omitted while zero. */
  serverRestarts?: number;
  /** Start of the current server-restart window (ISO time). Saved with serverRestarts. */
  serverRestartWindowStartedAt?: string;
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
  const interruptedPreparations = count(saved.interruptedPreparations) ?? 0;
  const storageWaits = count(saved.storageWaits) ?? 0;
  const agentDirectoryWaits = count(saved.agentDirectoryWaits) ?? 0;
  const serverRestarts = count(saved.serverRestarts) ?? 0;
  const windowStartedAt = typeof saved.serverRestartWindowStartedAt === "string"
    && Number.isFinite(Date.parse(saved.serverRestartWindowStartedAt)) ? saved.serverRestartWindowStartedAt : null;
  return { version: 1, failureRetries, maxTurnContinuations,
    ...(interruptedPreparations > 0 ? { interruptedPreparations } : {}),
    ...(storageWaits > 0 ? { storageWaits } : {}),
    ...(agentDirectoryWaits > 0 ? { agentDirectoryWaits } : {}),
    ...(serverRestarts > 0 && windowStartedAt ? { serverRestarts, serverRestartWindowStartedAt: windowStartedAt } : {}) };
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
  const interruptedPreparations = Math.max(saved?.interruptedPreparations ?? 0,
    reason === INTERRUPTED_PREPARATION_RETRY_REASON ? count(run.scheduledRetryAttempt) ?? 0 : 0);
  const storageWaits = Math.max(saved?.storageWaits ?? 0,
    reason === STORAGE_UNAVAILABLE_WAIT_RETRY_REASON ? count(run.scheduledRetryAttempt) ?? 0 : 0);
  const agentDirectoryWaits = Math.max(saved?.agentDirectoryWaits ?? 0,
    reason === AGENT_DIRECTORY_WAIT_RETRY_REASON ? count(run.scheduledRetryAttempt) ?? 0 : 0);
  return {
    version: 1,
    failureRetries: Math.max(saved?.failureRetries ?? 0, saved && nonFailureLane ? 0 : historicalFailureCount(run)),
    maxTurnContinuations: Math.max(saved?.maxTurnContinuations ?? 0,
      run.scheduledRetryReason === "max_turns_continuation" ? count(run.scheduledRetryAttempt) ?? 0 : 0),
    ...(interruptedPreparations > 0 ? { interruptedPreparations } : {}),
    ...(storageWaits > 0 ? { storageWaits } : {}),
    ...(agentDirectoryWaits > 0 ? { agentDirectoryWaits } : {}),
    ...(saved?.serverRestarts ? { serverRestarts: saved.serverRestarts,
      serverRestartWindowStartedAt: saved.serverRestartWindowStartedAt } : {}),
  };
}

/** Server-restart continuations already spent in the window that is open at `now`. */
export function serverRestartAttemptCount(run: RetryRun, now: Date): number {
  const accounting = executionRetryAccounting(run);
  const startedAt = Date.parse(accounting.serverRestartWindowStartedAt ?? "");
  if (!accounting.serverRestarts || !Number.isFinite(startedAt)) return 0;
  return now.getTime() - startedAt < SERVER_RESTART_RETRY_WINDOW_MS ? accounting.serverRestarts : 0;
}

/** True when another server-restart continuation would exceed the window's bound. */
export function serverRestartBudgetSpent(run: RetryRun, now = new Date()): boolean {
  return serverRestartAttemptCount(run, now) >= SERVER_RESTART_RETRY_MAX_ATTEMPTS;
}

/** Resource waits, repairs and productive continuations do not spend failures. */
export function executionFailureRetryCount(run: RetryRun): number {
  return executionRetryAccounting(run).failureRetries;
}

export function executionRetryAttemptCount(run: RetryRun, reason: string): number {
  if (reason === INTERRUPTED_PREPARATION_RETRY_REASON) return executionRetryAccounting(run).interruptedPreparations ?? 0;
  if (reason === STORAGE_UNAVAILABLE_WAIT_RETRY_REASON) return executionRetryAccounting(run).storageWaits ?? 0;
  if (reason === AGENT_DIRECTORY_WAIT_RETRY_REASON) return executionRetryAccounting(run).agentDirectoryWaits ?? 0;
  if (UNCHARGED_RETRY_LANES.has(reason)) {
    return run.scheduledRetryReason === reason ? count(run.scheduledRetryAttempt) ?? 0 : 0;
  }
  const accounting = executionRetryAccounting(run);
  return reason === "max_turns_continuation" ? accounting.maxTurnContinuations : accounting.failureRetries;
}

export function accountingForScheduledRetry(run: RetryRun, reason: string, attempt: number, now = new Date()): ExecutionRetryAccounting {
  const accounting = executionRetryAccounting(run);
  if (reason === SERVER_RESTART_RETRY_REASON) {
    // Attempt 1 opens a new window; a later attempt stays in the open one.
    if (attempt <= 1 || serverRestartAttemptCount(run, now) === 0) accounting.serverRestartWindowStartedAt = now.toISOString();
    accounting.serverRestarts = attempt;
    return accounting;
  }
  if (reason === "max_turns_continuation") accounting.maxTurnContinuations = attempt;
  else if (reason === INTERRUPTED_PREPARATION_RETRY_REASON) accounting.interruptedPreparations = attempt;
  else if (reason === STORAGE_UNAVAILABLE_WAIT_RETRY_REASON) accounting.storageWaits = attempt;
  else if (reason === AGENT_DIRECTORY_WAIT_RETRY_REASON) accounting.agentDirectoryWaits = attempt;
  else if (!UNCHARGED_RETRY_LANES.has(reason)) accounting.failureRetries = attempt;
  return accounting;
}
