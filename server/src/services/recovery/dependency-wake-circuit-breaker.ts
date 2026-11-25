import { and, desc, eq, inArray, isNull, max, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, issueRelations, issues, workspaceOperations } from "@paperclipai/db";
import { boundRunIssueIdSql } from "../run-task-binding.js";

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
 * first, that finished after the latest blocker change (a blocker result, or an
 * edit of the blocker set). Each failure multiplies
 * the wait before the next dependency wake by 5 (1m, 5m, 25m, ...), capped at
 * DEPENDENCY_WAKE_MAX_BACKOFF_MS. The breaker never closes for good: after the
 * wait, one wake probes again, so a fix that ships later is picked up. A run
 * that did not fail (any wake reason) or a newer blocker change resets it.
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

/** `runs` are this agent's recent runs on the task, in any order. */
export function decideDependencyWakeCircuit(input: {
  runs: DependencyWakeRunSample[];
  latestBlockerChangeAt: Date | null;
  now: number;
}): DependencyWakeCircuitDecision {
  const seen = new Set<string>();
  let consecutiveFailures = 0;
  let latestFailureAt: number | null = null;
  const runs = [...input.runs].sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0));
  for (const run of runs) {
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    if (!run.finishedAt) continue;
    // Only attempts made against the current blockers and their results count.
    if (input.latestBlockerChangeAt && run.finishedAt.getTime() <= input.latestBlockerChangeAt.getTime()) break;
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
  // Match the canonical run-task binding. The OR over the three indexed binding
  // paths (issue_id, native_issue_id, context issueId) lets the planner use
  // their company-scoped indexes; the coalesced binding keeps the match exact.
  // Unfinished runs are skipped.
  const runs = await db
    .select({ id: heartbeatRuns.id, status: heartbeatRuns.status, finishedAt: heartbeatRuns.finishedAt })
    .from(heartbeatRuns)
    .where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      or(
        eq(heartbeatRuns.issueId, input.issueId),
        eq(heartbeatRuns.nativeIssueId, input.issueId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
      ),
      sql`${boundRunIssueIdSql()} = ${input.issueId}`,
      eq(heartbeatRuns.agentId, input.agentId),
    ))
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(RUN_SAMPLE_LIMIT);
  if (!runs.some((run) => FAILED_RUN_STATUSES.has(run.status))) return { state: "closed", consecutiveFailures: 0 };

  const changeTimes: unknown[] = [];
  if (input.blockerIssueIds.length > 0) {
    const [completed] = await db.select({ at: max(issues.completedAt) }).from(issues).where(and(
      eq(issues.companyId, input.companyId),
      inArray(issues.id, input.blockerIssueIds),
    ));
    // Join through each blocker's execution workspace so the read uses
    // workspace_operations_company_workspace_issue_started_idx.
    const [finalized] = await db.select({ at: max(workspaceOperations.finishedAt) })
      .from(issues)
      .innerJoin(workspaceOperations, and(
        eq(workspaceOperations.companyId, issues.companyId),
        eq(workspaceOperations.executionWorkspaceId, issues.executionWorkspaceId),
        eq(workspaceOperations.issueId, issues.id),
      ))
      .where(and(
        eq(issues.companyId, input.companyId),
        inArray(issues.id, input.blockerIssueIds),
        eq(workspaceOperations.phase, "workspace_finalize"),
        eq(workspaceOperations.status, "succeeded"),
      ));
    // Workspace recovery saves blocker work without an execution workspace. The
    // null workspace still matches the leading columns of the same index.
    const [recovered] = await db.select({ at: max(workspaceOperations.finishedAt) }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, input.companyId),
      isNull(workspaceOperations.executionWorkspaceId),
      inArray(workspaceOperations.issueId, input.blockerIssueIds),
      eq(workspaceOperations.phase, "workspace_finalize"),
      eq(workspaceOperations.status, "succeeded"),
      sql`${workspaceOperations.metadata}->>'owningService' = 'workspace_recovery'`,
    ));
    changeTimes.push(completed?.at, finalized?.at, recovered?.at);
  }
  // A changed blocker set is a new attempt: an added blocker leaves a relation
  // row, and every add or removal through the API records issue.blockers_updated.
  const [related] = await db.select({ at: max(issueRelations.createdAt) }).from(issueRelations).where(and(
    eq(issueRelations.companyId, input.companyId),
    eq(issueRelations.relatedIssueId, input.issueId),
    eq(issueRelations.type, "blocks"),
  ));
  const [edited] = await db.select({ at: max(activityLog.createdAt) }).from(activityLog).where(and(
    eq(activityLog.companyId, input.companyId),
    eq(activityLog.entityType, "issue"),
    eq(activityLog.entityId, input.issueId),
    eq(activityLog.action, "issue.blockers_updated"),
  ));
  changeTimes.push(related?.at, edited?.at);
  let latestBlockerChangeAt: Date | null = null;
  for (const value of changeTimes) {
    if (value == null) continue;
    const at = value instanceof Date ? value : new Date(value as string);
    if (Number.isNaN(at.getTime())) continue;
    if (!latestBlockerChangeAt || at > latestBlockerChangeAt) latestBlockerChangeAt = at;
  }
  return decideDependencyWakeCircuit({ runs, latestBlockerChangeAt, now: input.now ?? Date.now() });
}
