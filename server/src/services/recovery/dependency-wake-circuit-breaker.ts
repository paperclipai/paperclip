import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, issues, workspaceOperations } from "@paperclipai/db";

/**
 * Circuit breaker for the resolved-dependency wake backstop.
 *
 * The backstop wakes the assignee of a blocked task whose blockers are all done.
 * Its idempotency key includes the task's blocked cycle, so a woken run that
 * fails and leaves the task blocked again starts a new cycle and a new key. When
 * that failure is deterministic, every sweep woke the task again: one production
 * task ran 11,000+ failed runs this way. The failed run has its own recovery
 * (retry scheduling, permanent failure classification); the blockers have not
 * changed, so the backstop must not keep re-delivering the same news.
 *
 * Policy: count the consecutive failed runs of this agent on this task, newest
 * first, that finished after the latest blocker result. Each failure multiplies
 * the wait before the next dependency wake by 5 (1m, 5m, 25m, ...), capped at
 * DEPENDENCY_WAKE_MAX_BACKOFF_MS. The breaker never closes for good: after the
 * wait, one wake probes again, so a fix that ships later is picked up. A run
 * that did not fail (any wake reason) or a newer blocker result resets it.
 * Interrupted runs (server restart, deploy) are neutral.
 */
export const DEPENDENCY_WAKE_BASE_BACKOFF_MS = 60_000;
export const DEPENDENCY_WAKE_BACKOFF_FACTOR = 5;
export const DEPENDENCY_WAKE_MAX_BACKOFF_MS = 24 * 60 * 60_000;
/** Streak at which the backstop reports the task as repeatedly failing. */
export const DEPENDENCY_WAKE_REPEATED_FAILURE_STREAK = 3;
const RUN_SAMPLE_LIMIT = 12;

const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
const NEUTRAL_RUN_STATUSES = new Set(["interrupted"]);

export type DependencyWakeRunSample = {
  id: string;
  status: string;
  finishedAt: Date | null;
};

export type DependencyWakeCircuitDecision =
  | { state: "closed"; consecutiveFailures: number }
  | { state: "backoff"; consecutiveFailures: number; retryAt: number };

export function dependencyWakeBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const exponent = Math.min(consecutiveFailures - 1, 16);
  return Math.min(DEPENDENCY_WAKE_BASE_BACKOFF_MS * DEPENDENCY_WAKE_BACKOFF_FACTOR ** exponent,
    DEPENDENCY_WAKE_MAX_BACKOFF_MS);
}

/** `runs` are this agent's terminal runs on the task, newest finish first. */
export function decideDependencyWakeCircuit(input: {
  runs: DependencyWakeRunSample[];
  latestBlockerResultAt: Date | null;
  now: number;
}): DependencyWakeCircuitDecision {
  const seen = new Set<string>();
  let consecutiveFailures = 0;
  let latestFailureAt: number | null = null;
  for (const run of input.runs) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    if (!run.finishedAt) continue;
    // Only attempts made with the current blocker results count.
    if (input.latestBlockerResultAt && run.finishedAt.getTime() <= input.latestBlockerResultAt.getTime()) break;
    if (NEUTRAL_RUN_STATUSES.has(run.status)) continue;
    if (!FAILED_RUN_STATUSES.has(run.status)) break;
    consecutiveFailures += 1;
    latestFailureAt ??= run.finishedAt.getTime();
  }
  if (consecutiveFailures === 0 || latestFailureAt === null) return { state: "closed", consecutiveFailures };
  const retryAt = latestFailureAt + dependencyWakeBackoffMs(consecutiveFailures);
  if (retryAt > input.now) return { state: "backoff", consecutiveFailures, retryAt };
  return { state: "closed", consecutiveFailures };
}

export async function readDependencyWakeCircuit(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; blockerIssueIds: string[]; now?: number },
): Promise<DependencyWakeCircuitDecision> {
  const runs = await db
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      eq(heartbeatRuns.agentId, input.agentId),
      sql`${heartbeatRuns.finishedAt} is not null`,
      sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
    ))
    .orderBy(desc(heartbeatRuns.finishedAt), desc(heartbeatRuns.id))
    .limit(RUN_SAMPLE_LIMIT);
  if (!runs.some((run) => FAILED_RUN_STATUSES.has(run.status))) return { state: "closed", consecutiveFailures: 0 };

  let latestBlockerResultAt: Date | null = null;
  if (input.blockerIssueIds.length > 0) {
    const [completed] = await db.select({ at: max(issues.completedAt) }).from(issues).where(and(
      eq(issues.companyId, input.companyId),
      inArray(issues.id, input.blockerIssueIds),
    ));
    const [finalized] = await db.select({ at: max(workspaceOperations.finishedAt) }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, input.companyId),
      inArray(workspaceOperations.issueId, input.blockerIssueIds),
      eq(workspaceOperations.phase, "workspace_finalize"),
      eq(workspaceOperations.status, "succeeded"),
    ));
    for (const value of [completed?.at, finalized?.at]) {
      const at = value == null ? null : value instanceof Date ? value : new Date(value);
      if (at && (!latestBlockerResultAt || at > latestBlockerResultAt)) latestBlockerResultAt = at;
    }
  }
  return decideDependencyWakeCircuit({ runs, latestBlockerResultAt, now: input.now ?? Date.now() });
}
