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

const CLAIM_MAX_ATTEMPTS = 3;
const CLAIM_RETRY_DELAY_MS = 25;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * The transaction is retried up to `CLAIM_MAX_ATTEMPTS` times (small fixed backoff) before
 * giving up. The caller's terminal child transition is already committed by the time this
 * runs, so a single transient fault (a dropped connection, a lock-wait timeout) would
 * otherwise permanently lose the parent's only notification for this transition — retrying
 * a few times closes most of that gap without reintroducing the duplicate-emission risk,
 * since every attempt still goes through the same atomic claim. If every attempt fails, this
 * throws rather than treating the failure as "no existing wake": callers must fail closed and
 * skip the wake rather than risk duplicate emission during a sustained outage.
 */
export async function claimIssueChildrenCompletedWake<T>(
  db: Db,
  input: { companyId: string; idempotencyKey: string },
  onClaimed: () => Promise<T>,
): Promise<{ claimed: boolean; result: T | null }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CLAIM_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        const lockKey = `issue-children-completed-wake:${input.companyId}:${input.idempotencyKey}`;
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const existing = await findExistingIssueChildrenCompletedWake(tx, input);
        if (existing) {
          return { claimed: false, result: null };
        }
        const result = await onClaimed();
        return { claimed: true, result };
      });
    } catch (err) {
      lastErr = err;
      if (attempt < CLAIM_MAX_ATTEMPTS) {
        await delay(CLAIM_RETRY_DELAY_MS * attempt);
      }
    }
  }
  throw lastErr;
}
