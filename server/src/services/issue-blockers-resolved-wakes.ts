import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests } from "@paperclipai/db";

export const ISSUE_BLOCKERS_RESOLVED_REASON = "issue_blockers_resolved";

// A wake row in any of these statuses counts as "already delivered" so we
// suppress duplicate emits for the same (dependent, blocker) pair. `skipped`
// and `cancelled` rows are intentionally excluded so a wake that was vetoed
// (e.g. by a tree hold or a dependency-blocked check) does not permanently
// mute the resolution path; the next legitimate transition can still fire.
const DELIVERED_WAKE_STATUSES = ["queued", "deferred_issue_execution", "completed"];

export function buildIssueBlockersResolvedIdempotencyKey(input: {
  dependentIssueId: string;
  resolvedBlockerIssueId: string;
}) {
  return [
    ISSUE_BLOCKERS_RESOLVED_REASON,
    input.dependentIssueId,
    input.resolvedBlockerIssueId,
  ].join(":");
}

export async function findDeliveredIssueBlockersResolvedWake(
  db: Pick<Db, "select">,
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
        inArray(agentWakeupRequests.status, DELIVERED_WAKE_STATUSES),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
