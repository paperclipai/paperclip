import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, heartbeatRuns } from "@paperclipai/db";
import { ISSUE_BLOCKERS_RESOLVED_WAKE_REASON } from "../issue-dependency-wakeups.js";

/**
 * Circuit breaker for the resolved-dependency wake backstop.
 *
 * The backstop wakes the assignee of a blocked task whose blockers are all done.
 * Its idempotency key includes the task's blocked cycle, so a woken run that
 * fails and leaves the task blocked again starts a new cycle and a new key. When
 * that failure is deterministic, every sweep woke the task again: one production
 * task ran 11,000+ failed runs this way. The failed run already has its own
 * recovery (retry scheduling, permanent failure classification); the blocker
 * set has not changed, so the backstop must not keep re-delivering the same news.
 *
 * Policy: after a backstop-visible wake for the same blocker set ends in a failed
 * run, wait before waking again (backoff), and stop after
 * DEPENDENCY_WAKE_FAILURE_LIMIT consecutive failures. A change in the blocker set
 * or any run that did not fail resets the streak.
 */
export const DEPENDENCY_WAKE_FAILURE_LIMIT = 3;
export const DEPENDENCY_WAKE_FAILURE_BACKOFF_MS = [60_000, 5 * 60_000] as const;

const FAILED_RUN_STATUSES = new Set(["failed", "timed_out"]);
const HISTORY_LIMIT = DEPENDENCY_WAKE_FAILURE_LIMIT * 4;

export type DependencyWakeHistoryEntry = {
  blockerIssueIds: unknown;
  runStatus: string | null;
  runFinishedAt: Date | null;
};

export type DependencyWakeCircuitDecision =
  | { state: "closed"; consecutiveFailures: number }
  | { state: "backoff"; consecutiveFailures: number; retryAt: number }
  | { state: "open"; consecutiveFailures: number };

function sortedIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))].sort();
}

function sameBlockerSet(a: string[], b: string[] | null) {
  return b !== null && a.length === b.length && a.every((id, index) => id === b[index]);
}

/** `history` is newest first. */
export function decideDependencyWakeCircuit(
  history: DependencyWakeHistoryEntry[],
  blockerIssueIds: string[],
  now: number,
): DependencyWakeCircuitDecision {
  const current = sortedIds(blockerIssueIds) ?? [];
  let consecutiveFailures = 0;
  let latestFailureAt: number | null = null;
  for (const entry of history) {
    if (!sameBlockerSet(current, sortedIds(entry.blockerIssueIds))) break;
    // A wake that never produced a run (skipped, coalesced away, still queued)
    // says nothing about whether waking helps.
    if (!entry.runStatus) continue;
    if (!FAILED_RUN_STATUSES.has(entry.runStatus)) break;
    consecutiveFailures += 1;
    if (latestFailureAt === null && entry.runFinishedAt) latestFailureAt = entry.runFinishedAt.getTime();
  }
  if (consecutiveFailures >= DEPENDENCY_WAKE_FAILURE_LIMIT) return { state: "open", consecutiveFailures };
  if (consecutiveFailures === 0) return { state: "closed", consecutiveFailures };
  const backoffMs = DEPENDENCY_WAKE_FAILURE_BACKOFF_MS[consecutiveFailures - 1]
    ?? DEPENDENCY_WAKE_FAILURE_BACKOFF_MS[DEPENDENCY_WAKE_FAILURE_BACKOFF_MS.length - 1];
  const retryAt = (latestFailureAt ?? now) + backoffMs;
  if (retryAt > now) return { state: "backoff", consecutiveFailures, retryAt };
  return { state: "closed", consecutiveFailures };
}

export async function readDependencyWakeCircuit(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; blockerIssueIds: string[]; now?: number },
): Promise<DependencyWakeCircuitDecision> {
  const history = await db
    .select({
      blockerIssueIds: sql<unknown>`${agentWakeupRequests.payload}->'blockerIssueIds'`,
      runStatus: heartbeatRuns.status,
      runFinishedAt: heartbeatRuns.finishedAt,
    })
    .from(agentWakeupRequests)
    .leftJoin(heartbeatRuns, and(
      eq(heartbeatRuns.id, agentWakeupRequests.runId),
      eq(heartbeatRuns.companyId, agentWakeupRequests.companyId),
    ))
    .where(and(
      eq(agentWakeupRequests.companyId, input.companyId),
      eq(agentWakeupRequests.agentId, input.agentId),
      eq(agentWakeupRequests.reason, ISSUE_BLOCKERS_RESOLVED_WAKE_REASON),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${input.issueId}`,
    ))
    .orderBy(desc(agentWakeupRequests.requestedAt), desc(agentWakeupRequests.id))
    .limit(HISTORY_LIMIT);
  return decideDependencyWakeCircuit(history, input.blockerIssueIds, input.now ?? Date.now());
}
