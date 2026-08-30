import type { IssueRecoveryAction, IssueScheduledRetry } from "@paperclipai/shared";
import { formatMonitorOffset } from "./issue-monitor";

/**
 * Which bounded retry budget the server is currently spending on a recovery action.
 *
 * The owner-sticky contract keeps one recovery-action row per source issue and rewrites
 * its `wakePolicy` as the action moves between budgets: the original owner's repair
 * attempts, then a manager's path-repair attempts, then the board. The policy type is
 * therefore the canonical lane signal — every surface reads the same stored value rather
 * than re-deriving liveness on its own.
 */
export type RecoveryRetryLane = "source_owner" | "recovery_owner" | "board";

export interface RecoveryRetryLineage {
  lane: RecoveryRetryLane;
  /** Attempts already spent in the current lane. 0 before the first attempt is scheduled. */
  attempt: number;
  maxAttempts: number | null;
  attemptsRemaining: number | null;
  /** The lane has no attempts left (always true once the board owns the action). */
  exhausted: boolean;
  /** When the stored next attempt is due, as an ISO string. Null once a lane is exhausted. */
  nextRetryAt: string | null;
  /**
   * The stored attempt came due and nothing picked it up. The row still reports the time it
   * was due — an expired attempt is a missed promise worth showing, not a fact to hide — but
   * it no longer counts as a path anyone is waiting on.
   */
  retryExpired: boolean;
  /** The run the server parked for the next attempt, when it recorded one. */
  scheduledRunId: string | null;
  /**
   * The parked run, once a caller has confirmed it is genuinely in flight. A bare
   * `scheduledRunId` is only a record that a run was once created, so it is never enough on
   * its own; this field is set only from a liveness signal the caller passed in.
   */
  liveRunId: string | null;
  /** The agent the stored attempt will wake. */
  retryAgentId: string | null;
  /** The server recorded that this lane does not move the source deliverable. */
  preservesSourceAssignee: boolean;
  /** Attempts the original owner spent before the manager lane opened. */
  sourceAttempt: number | null;
  sourceMaxAttempts: number | null;
  /**
   * Something will still move this lane forward without anyone intervening: either a stored
   * attempt that is still ahead of us, or a parked run confirmed to be in flight. This — not
   * the mere existence of an open recovery action, and not a due time that already passed —
   * is what keeps a surface quiet.
   */
  hasDurablePath: boolean;
}

const SOURCE_LANE_POLICY = "bounded_owner_disposition_repair";
const RECOVERY_LANE_POLICY = "bounded_recovery_owner";
const BOARD_LANE_POLICY = "board_escalation";

/** Scheduled-run states that mean the parked attempt is actually in flight right now. */
const LIVE_SCHEDULED_RUN_STATUSES = new Set(["queued", "running"]);

/**
 * How far past its due time a stored attempt may sit before it counts as missed.
 *
 * `formatMonitorOffset` collapses anything inside a minute-rounded zero to "now", so reusing
 * that same band keeps the label and the verdict from ever contradicting each other: while a
 * surface still reads "next try now", the lane is still treated as durable. Past that, the
 * scheduler had its chance and did not take it.
 */
const RETRY_EXPIRY_GRACE_MS = 30_000;

export type RecoveryLineageInput = Pick<IssueRecoveryAction, "wakePolicy"> &
  Partial<Pick<IssueRecoveryAction, "evidence" | "attemptCount" | "maxAttempts" | "timeoutAt">>;

/**
 * The source issue's scheduled-retry record, which is what lets a surface tell a run that is
 * really executing from a run id the server wrote down once and never started.
 */
export type RecoveryScheduledRetryInput = Partial<Pick<IssueScheduledRetry, "runId" | "status">>;

/**
 * Everything outside the stored action that decides whether a lane is still live. Callers
 * that cannot observe the scheduled run leave `scheduledRetry` unset and get the conservative
 * answer, so a surface can under-promise but never over-promise.
 */
export interface RecoveryLivenessContext {
  /** Epoch ms to treat as now. Defaults to the wall clock. */
  now?: number;
  scheduledRetry?: RecoveryScheduledRetryInput | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  return floored >= 0 ? floored : null;
}

function asIsoDate(value: unknown): string | null {
  if (!value) return null;
  if (!(value instanceof Date) && typeof value !== "string") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Confirm the parked run is in flight. When the policy named a specific run, only that run
 * counts — a different live run on the issue is someone else's work and says nothing about
 * whether this retry will happen.
 */
function resolveLiveRunId(
  scheduledRunId: string | null,
  scheduledRetry: RecoveryScheduledRetryInput | null | undefined,
): string | null {
  if (!scheduledRetry) return null;
  const runId = asNonEmptyString(scheduledRetry.runId);
  const status = asNonEmptyString(scheduledRetry.status);
  if (!runId || !status || !LIVE_SCHEDULED_RUN_STATUSES.has(status)) return null;
  if (scheduledRunId !== null && scheduledRunId !== runId) return null;
  return runId;
}

/**
 * Read the bounded retry lineage the server stored on a recovery action, or null when the
 * action does not carry one (older kinds, or a board escalation that is not part of the
 * owner-sticky contract).
 */
export function readRecoveryRetryLineage(
  action: RecoveryLineageInput,
  context?: RecoveryLivenessContext,
): RecoveryRetryLineage | null {
  const policy = asRecord(action.wakePolicy);
  if (!policy) return null;
  const type = asNonEmptyString(policy.type);
  const preservesSourceAssignee = policy.preservesSourceAssignee === true;
  const evidence = asRecord(action.evidence) ?? {};
  const evidenceSourceAttempt = asCount(evidence.sourceAttemptCount);
  const evidenceSourceMaxAttempts = asCount(evidence.sourceMaxAttempts);

  let lane: RecoveryRetryLane;
  if (type === SOURCE_LANE_POLICY) lane = "source_owner";
  else if (type === RECOVERY_LANE_POLICY) lane = "recovery_owner";
  else if (
    type === BOARD_LANE_POLICY &&
    (preservesSourceAssignee || evidenceSourceMaxAttempts !== null)
  ) {
    lane = "board";
  } else return null;

  const attempt = asCount(policy.attempt) ?? asCount(action.attemptCount) ?? 0;
  const maxAttempts = asCount(policy.maxAttempts) ?? asCount(action.maxAttempts);
  const scheduledRunId = asNonEmptyString(policy.scheduledRunId);
  const storedRetryAt = asIsoDate(policy.retryAt) ?? asIsoDate(action.timeoutAt);
  const exhausted = lane === "board" || (maxAttempts !== null && attempt >= maxAttempts);
  const nextRetryAt = exhausted ? null : storedRetryAt;
  const liveRunId = resolveLiveRunId(scheduledRunId, context?.scheduledRetry);
  // A run that is already executing is the reason its due time is behind us, so a confirmed
  // live run is never "missed" — it is the attempt happening.
  const retryExpired =
    !exhausted &&
    liveRunId === null &&
    nextRetryAt !== null &&
    Date.parse(nextRetryAt) + RETRY_EXPIRY_GRACE_MS < (context?.now ?? Date.now());

  return {
    lane,
    attempt,
    maxAttempts,
    attemptsRemaining: maxAttempts === null ? null : Math.max(0, maxAttempts - attempt),
    exhausted,
    nextRetryAt,
    retryExpired,
    scheduledRunId,
    liveRunId,
    retryAgentId: asNonEmptyString(policy.retryAgentId) ?? asNonEmptyString(policy.ownerAgentId),
    preservesSourceAssignee: preservesSourceAssignee || lane === "source_owner",
    sourceAttempt: lane === "source_owner" ? attempt : evidenceSourceAttempt,
    sourceMaxAttempts: lane === "source_owner" ? maxAttempts : evidenceSourceMaxAttempts,
    hasDurablePath:
      !exhausted && (liveRunId !== null || (nextRetryAt !== null && !retryExpired)),
  };
}

/** "Attempt 2 of 5", or null when the server did not record a bounded budget. */
export function formatRecoveryAttemptLabel(lineage: RecoveryRetryLineage): string | null {
  if (lineage.maxAttempts === null) return null;
  return `Attempt ${Math.min(lineage.attempt, lineage.maxAttempts)} of ${lineage.maxAttempts}`;
}

/** "in 3m" / "now" / "3m ago" for the stored next attempt, or null when none is stored. */
export function formatRecoveryRetryOffset(lineage: RecoveryRetryLineage): string | null {
  if (!lineage.nextRetryAt) return null;
  try {
    return formatMonitorOffset(lineage.nextRetryAt);
  } catch {
    return null;
  }
}

/**
 * One compact sentence fragment shared by the card and the blocker chips so every surface
 * reports the same attempt count and due time.
 */
export function formatRecoveryLineageSummary(lineage: RecoveryRetryLineage): string | null {
  const parts: string[] = [];
  const attempt = formatRecoveryAttemptLabel(lineage);
  if (attempt) parts.push(attempt);
  const offset = formatRecoveryRetryOffset(lineage);
  if (lineage.liveRunId) {
    parts.push("attempt running now");
  } else if (lineage.retryExpired) {
    // Never "next try 5m ago": a due time in the past is a missed attempt, and phrasing it as
    // an upcoming one is exactly the false healthy state this helper exists to prevent.
    parts.push(offset ? `retry missed ${offset}` : "retry missed");
  } else if (offset) {
    parts.push(offset === "now" ? "next try now" : `next try ${offset}`);
  } else if (lineage.exhausted) {
    parts.push("retries used up");
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}
