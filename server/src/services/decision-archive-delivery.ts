import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { decisionArchiveNotificationOutbox, type Db } from "@paperclipai/db";
import type { AttentionSourceKind } from "@paperclipai/shared";

const CLAIM_MS = 5 * 60_000;
export const DECISION_ARCHIVE_RETRY_MS = 30_000;

export type ArchiveNotificationBatch = {
  companyId: string;
  agentId: string;
  items: Array<{
    sourceKind: AttentionSourceKind;
    sourceId: string;
    archiveVersion: number;
    issueId: string;
  }>;
};

export function decisionArchiveDeliveryService(
  db: Db,
  options: { notifyOriginAgent?: (batch: ArchiveNotificationBatch) => Promise<unknown> },
) {
  async function deliverNotifications(limit = 500) {
    if (!options.notifyOriginAgent) return { notifiedAgents: 0, delivered: 0 };
    const claimAt = new Date();
    const staleClaimAt = new Date(claimAt.getTime() - CLAIM_MS);
    await db.update(decisionArchiveNotificationOutbox).set({ status: "pending", updatedAt: claimAt })
      .where(and(
        eq(decisionArchiveNotificationOutbox.status, "delivering"),
        or(isNull(decisionArchiveNotificationOutbox.lastAttemptAt), lte(decisionArchiveNotificationOutbox.lastAttemptAt, staleClaimAt)),
      ));
    const rows = await db.transaction(async (tx) => {
      const pendingIds = await tx.select({ id: decisionArchiveNotificationOutbox.id })
        .from(decisionArchiveNotificationOutbox)
        .where(eq(decisionArchiveNotificationOutbox.status, "pending"))
        .orderBy(sql`${decisionArchiveNotificationOutbox.lastAttemptAt} asc nulls first`,
          asc(decisionArchiveNotificationOutbox.createdAt), asc(decisionArchiveNotificationOutbox.id))
        .limit(limit)
        .then((values) => values.map((value) => value.id));
      if (pendingIds.length === 0) return [];
      return tx.update(decisionArchiveNotificationOutbox).set({
        status: "delivering",
        lastAttemptAt: claimAt,
        attemptCount: sql`${decisionArchiveNotificationOutbox.attemptCount} + 1`,
        updatedAt: claimAt,
      }).where(and(
        inArray(decisionArchiveNotificationOutbox.id, pendingIds),
        eq(decisionArchiveNotificationOutbox.status, "pending"),
      )).returning();
    });
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      const key = `${row.companyId}:${row.originAgentId}`;
      const grouped = groups.get(key) ?? [];
      grouped.push(row);
      groups.set(key, grouped);
    }
    let notifiedAgents = 0;
    let delivered = 0;
    for (const grouped of groups.values()) {
      const first = grouped[0]!;
      try {
        await options.notifyOriginAgent({
          companyId: first.companyId,
          agentId: first.originAgentId,
          items: grouped.map((row) => ({
            sourceKind: row.sourceKind as AttentionSourceKind,
            sourceId: row.sourceId,
            archiveVersion: row.archiveVersion,
            issueId: row.originIssueId,
          })),
        });
        const deliveredAt = new Date();
        const settled = await db.update(decisionArchiveNotificationOutbox).set({
          status: "delivered",
          deliveredAt,
          lastAttemptAt: deliveredAt,
          updatedAt: deliveredAt,
        }).where(and(
          inArray(decisionArchiveNotificationOutbox.id, grouped.map((row) => row.id)),
          eq(decisionArchiveNotificationOutbox.status, "delivering"),
          eq(decisionArchiveNotificationOutbox.lastAttemptAt, claimAt),
        )).returning({ id: decisionArchiveNotificationOutbox.id });
        if (settled.length > 0) notifiedAgents += 1;
        delivered += settled.length;
      } catch {
        const failedAt = new Date();
        await db.update(decisionArchiveNotificationOutbox).set({
          status: "pending",
          lastAttemptAt: failedAt,
          updatedAt: failedAt,
        }).where(and(
          inArray(decisionArchiveNotificationOutbox.id, grouped.map((row) => row.id)),
          eq(decisionArchiveNotificationOutbox.status, "delivering"),
          eq(decisionArchiveNotificationOutbox.lastAttemptAt, claimAt),
        ));
      }
    }
    return { notifiedAgents, delivered };
  }

  async function next() {
    if (!options.notifyOriginAgent) return null;
    const [pending] = await db.select({ id: decisionArchiveNotificationOutbox.id })
      .from(decisionArchiveNotificationOutbox).where(eq(decisionArchiveNotificationOutbox.status, "pending")).limit(1);
    const [claimed] = await db.select({ attemptedAt: decisionArchiveNotificationOutbox.lastAttemptAt })
      .from(decisionArchiveNotificationOutbox).where(eq(decisionArchiveNotificationOutbox.status, "delivering"))
      .orderBy(sql`${decisionArchiveNotificationOutbox.lastAttemptAt} asc nulls first`).limit(1);
    const pendingAt = pending ? Date.now() + DECISION_ARCHIVE_RETRY_MS : null;
    const claimAt = claimed ? (claimed.attemptedAt?.getTime() ?? Date.now() - CLAIM_MS) + CLAIM_MS : null;
    return pendingAt === null ? claimAt : claimAt === null ? pendingAt : Math.min(pendingAt, claimAt);
  }

  return { deliver: deliverNotifications, next };
}
