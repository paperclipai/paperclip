import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
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
  db: Db,
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
