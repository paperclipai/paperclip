import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

export const ISSUE_CHILDREN_COMPLETED_WAKE_REASON = "issue_children_completed";

const IDEMPOTENT_CHILDREN_COMPLETED_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
] as const;

/**
 * Scoped to (parent, the child that just went terminal, current sibling set) so a reusable
 * watchdog/child issue oscillating terminal -> reopened -> terminal without any sibling-set
 * change collapses onto the same key instead of re-waking the parent every cycle.
 */
export function buildIssueChildrenCompletedWakeIdempotencyKey(input: {
  parentIssueId: string;
  completedChildIssueId: string;
  childIssueIds: string[];
}) {
  const siblingSetDigest = createHash("sha256")
    .update([...input.childIssueIds].sort().join(","))
    .digest("hex");
  return [
    ISSUE_CHILDREN_COMPLETED_WAKE_REASON,
    input.parentIssueId,
    input.completedChildIssueId,
    siblingSetDigest,
  ].join(":");
}

export async function findExistingIssueChildrenCompletedWake(
  db: Pick<Db, "select">,
  input: { companyId: string; idempotencyKey: string },
) {
  return db
    .select({ id: agentWakeupRequests.id, status: agentWakeupRequests.status })
    .from(agentWakeupRequests)
    .where(
      and(
        eq(agentWakeupRequests.companyId, input.companyId),
        eq(agentWakeupRequests.idempotencyKey, input.idempotencyKey),
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_CHILDREN_COMPLETED_WAKE_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}

/**
 * Makes the children-completed wake idempotency claim atomic: a Postgres advisory
 * transaction lock (tenant-scoped via companyId in the lock key) serializes concurrent
 * claims for the exact same idempotency key, so the existence check inside the lock
 * always observes any equivalent wake a concurrent caller already committed. `onClaimed`
 * only runs — and is only allowed to actually enqueue the wake — while the lock is held,
 * closing the check-then-enqueue race that a plain SELECT-then-INSERT leaves open.
 *
 * A partial unique index on agent_wakeup_requests (company_id, idempotency_key) scoped to
 * reason = 'issue_children_completed' backstops this: if the lock is ever bypassed, the
 * real insert performed inside `onClaimed` hits a DB conflict instead of silently
 * duplicating the wake.
 *
 * If the existence check itself fails (e.g. a database fault), this throws rather than
 * treating the failure as "no existing wake": callers must fail closed and skip the wake
 * rather than risk duplicate emission during an outage.
 */
export async function claimIssueChildrenCompletedWake<T>(
  db: Db,
  input: { companyId: string; idempotencyKey: string },
  onClaimed: () => Promise<T>,
): Promise<{ claimed: boolean; result: T | null }> {
  return db.transaction(async (tx) => {
    const lockKey = `issue-children-completed-wake:${input.companyId}:${input.idempotencyKey}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const existing = await findExistingIssueChildrenCompletedWake(tx, input);
    if (existing) {
      return { claimed: false, result: null };
    }
    const result = await onClaimed();
    return { claimed: true, result };
  });
}
