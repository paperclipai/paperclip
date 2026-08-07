import type {
  agentWakeupRequests,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";

// Queued retries can legitimately wait behind long agent runs. Anchor the
// grace to the FIRST started sibling to finish at or after eligibility (the
// capacity release that unblocked this retry), then require a materially
// overdue hour past that anchor, in addition to the no-active-run gate.
// The caller supplies this anchor as a MIN, so it is monotonic: later
// unrelated runs cannot push it forward. That bounds the grace at
// (first release + GRACE) and keeps the reaper a real backstop even for an
// agent that finishes work more often than once per hour (GOLAA-8435 F4:
// a rolling MAX anchor never fired on a busy agent, including GOLAA-6880's
// own assignee).
export const STALE_QUEUED_EXECUTION_LOCK_GRACE_MS = 60 * 60 * 1000;
export const STALE_QUEUED_EXECUTION_LOCK_ERROR_CODE = "stale_queued_execution_lock";

type IssueExecutionLock = Pick<
  typeof issues.$inferSelect,
  "id" | "executionRunId"
>;

type QueuedRun = Pick<
  typeof heartbeatRuns.$inferSelect,
  | "id"
  | "status"
  | "wakeupRequestId"
  | "createdAt"
  | "scheduledRetryAt"
  | "startedAt"
  | "finishedAt"
  | "exitCode"
  | "signal"
  | "externalRunId"
  | "processPid"
  | "processGroupId"
  | "processStartedAt"
  | "logStore"
  | "logRef"
  | "logBytes"
  | "logSha256"
  | "stdoutExcerpt"
  | "stderrExcerpt"
  | "lastOutputAt"
  | "lastOutputSeq"
  | "lastOutputStream"
  | "lastOutputBytes"
>;

type QueuedWakeup = Pick<
  typeof agentWakeupRequests.$inferSelect,
  "id" | "runId" | "status" | "claimedAt" | "finishedAt"
>;

export type StaleQueuedExecutionLockClassification =
  | { stale: false }
  | {
      stale: true;
      eligibilityAt: Date;
      graceAnchorAt: Date;
      agentCapacityReleaseAt: Date | null;
      staleAt: Date;
      graceMs: number;
    };

function hasExecutionEvidence(run: QueuedRun) {
  return run.startedAt !== null
    || run.finishedAt !== null
    || run.exitCode !== null
    || run.signal !== null
    || run.externalRunId !== null
    || run.processPid !== null
    || run.processGroupId !== null
    || run.processStartedAt !== null
    || run.logStore !== null
    || run.logRef !== null
    || (run.logBytes !== null && run.logBytes > 0)
    || run.logSha256 !== null
    || run.stdoutExcerpt !== null
    || run.stderrExcerpt !== null
    || run.lastOutputAt !== null
    || run.lastOutputSeq !== 0
    || run.lastOutputStream !== null
    || (run.lastOutputBytes !== null && run.lastOutputBytes > 0);
}

/**
 * Classifies the legacy lock shape conservatively. Callers use this exact
 * predicate both before row locking and after all three rows are locked.
 */
export function classifyStaleQueuedExecutionLock(input: {
  issue: IssueExecutionLock;
  run: QueuedRun;
  wakeup: QueuedWakeup | null;
  agentHasRunningRun: boolean;
  agentCapacityReleaseAt: Date | null;
  now: Date;
}): StaleQueuedExecutionLockClassification {
  const {
    issue,
    run,
    wakeup,
    agentHasRunningRun,
    agentCapacityReleaseAt,
    now,
  } = input;

  if (issue.executionRunId !== run.id || run.status !== "queued") {
    return { stale: false };
  }
  if (agentHasRunningRun) return { stale: false };
  if (hasExecutionEvidence(run)) return { stale: false };
  if (
    !run.wakeupRequestId
    || !wakeup
    || wakeup.id !== run.wakeupRequestId
    || wakeup.runId !== run.id
    || wakeup.status !== "queued"
    || wakeup.claimedAt !== null
    || wakeup.finishedAt !== null
  ) {
    return { stale: false };
  }

  const eligibilityAt = run.scheduledRetryAt ?? run.createdAt;
  const eligibilityMs = eligibilityAt.getTime();
  if (!Number.isFinite(eligibilityMs)) return { stale: false };
  // Defensive coercion: the caller decodes this aggregate through the schema
  // column so it arrives as a Date, but tolerate a raw string/number here so a
  // future refactor that drops the decode degrades to eligibility rather than
  // throwing inside the reap transaction.
  const capacityReleaseAt = agentCapacityReleaseAt == null
    ? null
    : agentCapacityReleaseAt instanceof Date
      ? agentCapacityReleaseAt
      : new Date(agentCapacityReleaseAt as string | number);
  const capacityReleaseMs = capacityReleaseAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  // The caller already filters the anchor to finishes at/after eligibility, so
  // it is >= eligibility when present; the guard keeps the invariant explicit
  // and falls back to eligibility for a fully idle agent (null anchor).
  const graceAnchorAt = Number.isFinite(capacityReleaseMs) && capacityReleaseMs > eligibilityMs
    ? capacityReleaseAt!
    : eligibilityAt;
  const staleAt = new Date(graceAnchorAt.getTime() + STALE_QUEUED_EXECUTION_LOCK_GRACE_MS);
  if (now.getTime() < staleAt.getTime()) return { stale: false };

  return {
    stale: true,
    eligibilityAt,
    graceAnchorAt,
    agentCapacityReleaseAt: capacityReleaseAt,
    staleAt,
    graceMs: STALE_QUEUED_EXECUTION_LOCK_GRACE_MS,
  };
}
