import { and, count, eq, isNotNull, sql } from "drizzle-orm";
import { toolActionRequests, toolCatalogEntries, toolConnections, toolInvocations, type Db } from "@paperclipai/db";
import type { ToolConnectionReviewCounts } from "@paperclipai/shared";

/** Counts for one already-authorized connection. Independent aggregates avoid catalog/request fanout. */
export async function getToolConnectionReviewCounts(
  db: Db,
  companyId: string,
  connectionId: string,
): Promise<ToolConnectionReviewCounts> {
  const pending = db.select({ count: count() }).from(toolActionRequests)
    .innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
    .where(and(
      eq(toolActionRequests.companyId, companyId),
      eq(toolInvocations.companyId, companyId),
      eq(toolInvocations.connectionId, connectionId),
      eq(toolActionRequests.status, "pending"),
      isNotNull(toolActionRequests.signedArguments),
    ));
  const quarantined = db.select({ count: count() }).from(toolCatalogEntries).where(and(
    eq(toolCatalogEntries.companyId, companyId),
    eq(toolCatalogEntries.connectionId, connectionId),
    eq(toolCatalogEntries.status, "quarantined"),
  ));
  const [counts] = await db.select({
    pendingActionRequestCount: sql<number>`case when ${toolConnections.status} = 'archived' then 0 else (${pending}) end`.mapWith(Number),
    quarantinedCatalogEntryCount: sql<number>`case when ${toolConnections.status} = 'archived' then 0 else (${quarantined}) end`.mapWith(Number),
  }).from(toolConnections).where(and(
    eq(toolConnections.companyId, companyId), eq(toolConnections.id, connectionId),
  ));
  // Missing/hidden resources are rejected by route admission before this reader.
  return counts ?? { pendingActionRequestCount: 0, quarantinedCatalogEntryCount: 0 };
}
