import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { issues, type Db } from "@paperclipai/db";

/** Atomic authority fence for the native compatibility liveness finish path.
 * Legacy disposition repair has its own persisted episode authority.
 */
export async function blockIssueAfterLivenessExhaustion(
  db: Db,
  input: { companyId: string; issueId: string; agentId: string; runId: string; now: Date },
): Promise<boolean> {
  const transitioned = await db.update(issues).set({
    status: "blocked",
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    unblockDescriptor: {
      owner: "board",
      action: "Inspect the exhausted bounded liveness continuation and provide a concrete execution or waiting path.",
    },
    blockedTransitionAt: input.now,
    blockedOwnerNotifiedAt: null,
    updatedAt: input.now,
  }).where(and(
    eq(issues.id, input.issueId),
    eq(issues.companyId, input.companyId),
    eq(issues.assigneeAgentId, input.agentId),
    // Release can promote accepted work before exhaustion. Check both owners
    // in the write, so PostgreSQL rechecks them after any concurrent row lock.
    or(isNull(issues.checkoutRunId), eq(issues.checkoutRunId, input.runId)),
    or(isNull(issues.executionRunId), eq(issues.executionRunId, input.runId)),
    or(
      inArray(issues.status, ["todo", "in_progress"]),
      and(eq(issues.status, "blocked"), isNull(issues.unblockDescriptor)),
    ),
  )).returning({ id: issues.id });
  return transitioned.length > 0;
}
