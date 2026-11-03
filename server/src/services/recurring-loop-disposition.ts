import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { routines, routineTriggers } from "@paperclipai/db";

export interface RecurringLoopDisposition {
  routineId: string;
  triggerId: string;
  companyId: string;
  issueId: string;
  agentId: string;
  nextRunAt: Date;
}

export async function readRecurringLoopDisposition(
  db: Db,
  issue: { id: string; companyId: string; assigneeAgentId: string | null },
): Promise<RecurringLoopDisposition | null> {
  if (!issue.assigneeAgentId) return null;
  const [row] = await db.select({
    routineId: routines.id,
    triggerId: routineTriggers.id,
    nextRunAt: routineTriggers.nextRunAt,
  }).from(routines).innerJoin(routineTriggers, and(
    eq(routineTriggers.routineId, routines.id),
    eq(routineTriggers.companyId, routines.companyId),
  )).where(and(
    eq(routines.companyId, issue.companyId),
    eq(routines.parentIssueId, issue.id),
    eq(routines.assigneeAgentId, issue.assigneeAgentId),
    eq(routines.status, "active"),
    eq(routineTriggers.kind, "schedule"),
    eq(routineTriggers.enabled, true),
    eq(routineTriggers.archived, false),
    eq(routineTriggers.setupPending, false),
    isNotNull(routineTriggers.cronExpression),
    isNotNull(routineTriggers.timezone),
    isNotNull(routineTriggers.nextRunAt),
  )).limit(1);
  return row?.nextRunAt ? {
    ...row, nextRunAt: row.nextRunAt,
    companyId: issue.companyId, issueId: issue.id, agentId: issue.assigneeAgentId,
  } : null;
}
