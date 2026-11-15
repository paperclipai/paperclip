import { and, asc, desc, eq, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { companies, decisionRetention, invites, joinRequests, type Db } from "@paperclipai/db";
import { DEFAULT_DECISION_ARCHIVE_DAYS } from "./decision-retention.js";
import { createDecisionRetentionSweep } from "./decision-retention-sweep.js";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { registerDeadlineWork } from "./deadline-work.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";

const archiveDelay = DEFAULT_DECISION_ARCHIVE_DAYS * 86_400_000;

export function joinRequestRetentionService(db: Db) {
  function candidates(database: Db, condition?: SQL, order = asc) {
    return database.select({ id: joinRequests.id, companyId: joinRequests.companyId,
      at: joinRequests.updatedAt, cursorAt: sql<string>`${joinRequests.updatedAt}::text`, deadlineAt: sql<number>`ceil(extract(epoch from ${joinRequests.updatedAt}) * 1000 + ${archiveDelay})`.mapWith(Number) }).from(joinRequests)
      .innerJoin(companies, eq(companies.id, joinRequests.companyId))
      .innerJoin(invites, and(eq(invites.id, joinRequests.inviteId), eq(invites.companyId, joinRequests.companyId)))
      .leftJoin(decisionRetention, and(eq(decisionRetention.companyId, joinRequests.companyId),
        eq(decisionRetention.sourceKind, "join_request"), sql`${decisionRetention.sourceId} = ${joinRequests.id}::text`))
      .where(and(sql`${joinRequests.status} = 'pending_approval'`, eq(companies.status, "active"),
        or(isNull(decisionRetention.id), eq(decisionRetention.keep, false)), isNull(decisionRetention.archivedAt), condition))
      .orderBy(order(joinRequests.updatedAt), order(joinRequests.id));
  }
  return createDecisionRetentionSweep(db, {
    sourceKind: "join_request", failureMessage: "Join request retention failed",
    end: async cutoff => {
      const [row] = await candidates(db, lte(joinRequests.updatedAt, cutoff), desc).limit(1);
      return row ? { at: row.cursorAt, id: row.id } : undefined;
    },
    page: async (cutoff, cursor, end, limit) => candidates(db, and(lte(joinRequests.updatedAt, cutoff),
      sql`(${joinRequests.updatedAt}, ${joinRequests.id}) <= (${end.at}::timestamptz, ${end.id}::uuid)`, cursor
      ? sql`(${joinRequests.updatedAt}, ${joinRequests.id}) > (${cursor.at}::timestamptz, ${cursor.id}::uuid)` : undefined)).limit(limit),
    lock: async (database, id, cutoff) => {
      const [row] = await candidates(database, and(eq(joinRequests.id, id), lte(joinRequests.updatedAt, cutoff)))
        .for("update", { of: joinRequests });
      return row;
    },
    next: async () => {
      const [row] = await candidates(db).limit(1);
      return row?.deadlineAt ?? null;
    },
  });
}

export function registerJoinRequestRetentionWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof joinRequestRetentionService>,
  canRun: () => boolean,
) {
  return registerDeadlineWork(coordinator, DELIVERY_QUEUES.joinRequestRetention, {
    run: signal => service.sweep(new Date(), signal), next: service.next, canRun, retryMs: 30_000, notificationCoalesceMs: 30_000,
  });
}
