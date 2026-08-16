import { and, eq, gt, inArray, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
] as const;

/**
 * Terminal outcomes that must still hold the idempotency slot for a cooldown.
 * A wake for the same (dependent, blocker) pair that was cancelled or skipped
 * moments ago means the system actively decided not to run it; re-emitting the
 * identical event on the next reconciler tick can only loop (observed
 * 2026-08-16: emit→cancel every ~7s, 354 cancelled wakes + 719 churned
 * continuation runs in 90 min on one issue). A stale terminal wake must NOT
 * suppress a genuinely new resolution, so suppression is recency-bounded.
 */
const TERMINAL_DEPENDENCY_WAKE_STATUSES = ["cancelled", "skipped"] as const;

/** How long a cancelled/skipped wake keeps suppressing identical re-emission. */
export const DEPENDENCY_WAKE_TERMINAL_SUPPRESSION_MS = 15 * 60_000;

export function buildIssueBlockersResolvedWakeIdempotencyKey(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_WAKE_REASON,
    input.dependentIssueId,
    input.resolvedBlockerIssueId,
  ].join(":");
}

export async function findExistingIssueBlockersResolvedWake(
  db: Db,
  input: {
    companyId: string;
    idempotencyKey: string;
  },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

export async function findExistingIssueBlockersResolvedWakeForAnyKey(
  db: Db,
  input: {
    companyId: string;
    idempotencyKeys: string[];
    /**
     * When set, a cancelled/skipped wake for one of the keys created within
     * the last `terminalSuppressionMs` also counts as existing, so reconciler
     * re-scans cannot re-emit an event the system just declined to run.
     * Event-driven emitters (real resolution PATCHes) omit this and keep the
     * original live-statuses-only semantics.
     */
    terminalSuppressionMs?: number;
  },
) {
  const idempotencyKeys = [...new Set(input.idempotencyKeys.filter(Boolean))];
  if (idempotencyKeys.length === 0) return null;

  const liveMatch = inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]);
  const statusCondition = input.terminalSuppressionMs
    ? or(
        liveMatch,
        and(
          inArray(agentWakeupRequests.status, [...TERMINAL_DEPENDENCY_WAKE_STATUSES]),
          gt(agentWakeupRequests.createdAt, new Date(Date.now() - input.terminalSuppressionMs)),
        ),
      )
    : liveMatch;

  return db
    .select({
      id: agentWakeupRequests.id,
      status: agentWakeupRequests.status,
      idempotencyKey: agentWakeupRequests.idempotencyKey,
    })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        inArray(agentWakeupRequests.idempotencyKey, idempotencyKeys),
        statusCondition,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
