import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentWakeupRequests, issues } from "@paperclipai/db";
import { logActivity } from "./activity-log.js";

export const ISSUE_BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved";

const IDEMPOTENT_DEPENDENCY_WAKE_STATUSES = [
  "queued",
  "deferred_issue_execution",
  "claimed",
  "completed",
] as const;

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

/**
 * Return a dependency-ready but unassigned `blocked` issue to the assignable
 * pool. Wake rows require an `agent_id`, so an unassigned dependent can never
 * receive an `issue_blockers_resolved` wake; without this transition it stays
 * `blocked` forever once its last blocker closes.
 *
 * The update is conditional on the issue still being `blocked` and still
 * unassigned, so it is safe against a concurrent assignment and idempotent
 * across repeated backstop sweeps (a second call updates no rows and returns
 * false without logging).
 */
export async function promoteUnblockedDependentToTodo(
  db: Db,
  input: {
    companyId: string;
    dependentIssueId: string;
    resolvedBlockerIssueId: string;
    blockerIssueIds: string[];
    source: string;
    actorType?: "agent" | "user" | "system" | "plugin";
    actorId?: string;
    runId?: string | null;
  },
): Promise<boolean> {
  const promoted = await db
    .update(issues)
    .set({ status: "todo", updatedAt: new Date() })
    .where(
      and(
        eq(issues.id, input.dependentIssueId),
        eq(issues.companyId, input.companyId),
        eq(issues.status, "blocked"),
        isNull(issues.assigneeAgentId),
      ),
    )
    .returning({ id: issues.id, identifier: issues.identifier })
    .then((rows) => rows[0] ?? null);
  if (!promoted) return false;

  await logActivity(db, {
    companyId: input.companyId,
    actorType: input.actorType ?? "system",
    actorId: input.actorId ?? "system",
    action: "issue.updated",
    entityType: "issue",
    entityId: promoted.id,
    runId: input.runId ?? null,
    details: {
      identifier: promoted.identifier,
      status: "todo",
      previousStatus: "blocked",
      resolvedBlockerIssueId: input.resolvedBlockerIssueId,
      blockerIssueIds: input.blockerIssueIds,
      source: input.source,
    },
  });

  return true;
}

export async function findExistingIssueBlockersResolvedWakeForAnyKey(
  db: Db,
  input: {
    companyId: string;
    idempotencyKeys: string[];
  },
) {
  const idempotencyKeys = [...new Set(input.idempotencyKeys.filter(Boolean))];
  if (idempotencyKeys.length === 0) return null;

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
        inArray(agentWakeupRequests.status, [...IDEMPOTENT_DEPENDENCY_WAKE_STATUSES]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
}
