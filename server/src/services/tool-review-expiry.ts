import { and, asc, eq, gt, isNotNull, lte, sql } from "drizzle-orm";
import { toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";
import { writeToolReviewChange } from "./tool-review-work-notifications.js";

export function toolReviewExpiryService(db: Db, onExpired: (input: {
  actionRequestId: string;
  invocationId: string;
  status: "expired";
  errorCode: string;
  errorMessage: string;
}) => Promise<void>) {
  return {
    async next(): Promise<number | null> {
      const [row] = await db.select({ at: sql<string | Date | null>`min(${toolActionRequests.expiresAt})` })
        .from(toolActionRequests).where(eq(toolActionRequests.status, "pending"));
      return row?.at == null ? null : new Date(row.at).getTime();
    },
    sweep,
    sweepForCompany: (companyId: string) => sweep(new Date(), companyId, 1),
    async deadlines(companyId?: string) {
      const pendingExpiry = and(eq(toolActionRequests.status, "pending"), isNotNull(toolActionRequests.expiresAt));
      const rows = companyId === undefined
        ? await db.select({ companyId: toolActionRequests.companyId,
          at: sql<string | Date>`min(${toolActionRequests.expiresAt})` })
          .from(toolActionRequests).where(pendingExpiry).groupBy(toolActionRequests.companyId)
        : await db.select({ companyId: toolActionRequests.companyId,
          at: sql<Date>`${toolActionRequests.expiresAt}` })
          .from(toolActionRequests).where(and(pendingExpiry, eq(toolActionRequests.companyId, companyId)))
          .orderBy(asc(toolActionRequests.expiresAt)).limit(1);
      return rows.map(row => ({ companyId: row.companyId, dueAt: new Date(row.at).getTime() }));
    },
  };
  async function sweep(now = new Date(), companyId?: string, maxPages = Infinity) {
    let cursor: string | undefined;
    let scanned = 0;
    for (let page = 0; page < maxPages; page++) {
      const rows = await db.select().from(toolActionRequests).where(and(
        eq(toolActionRequests.status, "pending"), lte(toolActionRequests.expiresAt, now),
        cursor ? gt(toolActionRequests.id, cursor) : undefined,
        companyId === undefined ? undefined : eq(toolActionRequests.companyId, companyId),
      )).orderBy(asc(toolActionRequests.id)).limit(100);
      for (const row of rows) {
        const errorCode = "action_expired";
        const errorMessage = "The approval request expired before a decision.";
        const changed = await writeToolReviewChange(db, row.companyId, async tx => {
          const [updated] = await tx.update(toolActionRequests)
            .set({ status: "expired", resolvedAt: now, updatedAt: now }).where(and(
              eq(toolActionRequests.id, row.id), eq(toolActionRequests.status, "pending"),
              eq(toolActionRequests.updatedAt, row.updatedAt),
            )).returning({ id: toolActionRequests.id });
          if (!updated) return false;
          await tx.update(toolInvocations).set({ status: "failed", errorCode, errorMessage,
            completedAt: now, updatedAt: now }).where(eq(toolInvocations.id, row.invocationId));
          return true;
        });
        if (changed) await onExpired({ actionRequestId: row.id, invocationId: row.invocationId,
          status: "expired", errorCode, errorMessage });
      }
      scanned += rows.length;
      if (rows.length < 100) break;
      cursor = rows[rows.length - 1].id;
    }
    return { scanned };
  }
}
