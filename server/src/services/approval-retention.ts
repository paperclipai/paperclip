import { approvalExecutionIssueCondition } from "./approval-visibility.js";
import { and, asc, desc, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { approvals, companies, decisionRetention, type Db } from "@paperclipai/db";
import { DEFAULT_DECISION_ARCHIVE_DAYS } from "./decision-retention.js";
import { createDecisionRetentionSweep } from "./decision-retention-sweep.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

const archiveDelay = DEFAULT_DECISION_ARCHIVE_DAYS * 86_400_000;

export function approvalRetentionService(db: Db) {
  function candidates(database: Db, condition?: SQL, order = asc) {
    return database.select({ id: approvals.id, companyId: approvals.companyId, at: approvals.updatedAt, cursorAt: sql<string>`${approvals.updatedAt}::text`, deadlineAt: sql<number>`ceil(extract(epoch from ${approvals.updatedAt}) * 1000 + ${archiveDelay})`.mapWith(Number) }).from(approvals)
      .innerJoin(companies, eq(companies.id, approvals.companyId))
      .leftJoin(decisionRetention, and(eq(decisionRetention.companyId, approvals.companyId),
        eq(decisionRetention.sourceKind, "approval"), sql`${decisionRetention.sourceId} = ${approvals.id}::text`))
      .where(and(sql`${approvals.status} = 'pending'`, eq(companies.status, "active"), approvalExecutionIssueCondition(),
        or(isNull(decisionRetention.id), eq(decisionRetention.keep, false)), isNull(decisionRetention.archivedAt), condition))
      .orderBy(order(approvals.updatedAt), order(approvals.id));
  }
  return createDecisionRetentionSweep(db, {
    sourceKind: "approval", failureMessage: "Approval retention failed",
    end: async cutoff => {
      const [row] = await candidates(db, lte(approvals.updatedAt, cutoff), desc).limit(1);
      return row ? { at: row.cursorAt, id: row.id } : undefined;
    },
    page: async (cutoff, cursor, end, limit) => candidates(db, and(lte(approvals.updatedAt, cutoff),
      sql`(${approvals.updatedAt}, ${approvals.id}) <= (${end.at}::timestamptz, ${end.id}::uuid)`, cursor
      ? sql`(${approvals.updatedAt}, ${approvals.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined)).limit(limit),
    lock: async (database, id, cutoff) => {
      const [row] = await candidates(database, and(eq(approvals.id, id), lte(approvals.updatedAt, cutoff)))
        .for("update", { of: approvals });
      return row;
    },
    next: async () => {
      const [row] = await candidates(db).limit(1);
      return row?.deadlineAt ?? null;
    },
  });
}

export function registerApprovalRetentionWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof approvalRetentionService>,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.approvalRetention, {
    run: signal => service.sweep(new Date(), signal), next: service.next, canRun, retryMs: 30_000, notificationCoalesceMs: 30_000,
  });
}
