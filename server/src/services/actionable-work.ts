import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { approvals, issues } from "@paperclipai/db";

// W2 actionable-work predicate — single source of truth shared by the
// heartbeat tickTimers pre-filter and the enqueueWakeup timer-skip gate so the
// two can never drift. An agent has actionable work when it is actively
// progressing an assigned issue (in_progress/in_review — which excludes
// blocked/backlog/todo/done by construction, and subsumes due-monitor wakes,
// since a due monitor implies such an assigned issue), or a gate/approval is
// pending for it.
export async function hasActionableWork(
  db: Db,
  agentId: string,
  companyId: string,
): Promise<boolean> {
  const assignedIssue = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.assigneeAgentId, agentId),
        inArray(issues.status, ["in_progress", "in_review"]),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (assignedIssue) return true;

  // Pending gate/approval routed to this agent — plan-gates activation stores
  // the target as payload.designatedAgentId (see plans.ts).
  const pendingGate = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, companyId),
        eq(approvals.status, "pending"),
        sql`${approvals.payload} ->> 'designatedAgentId' = ${agentId}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return pendingGate !== null;
}
