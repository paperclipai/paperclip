import { and, asc, eq, gt } from "drizzle-orm";
import { toolActionRequests, toolInvocations, type Db } from "@paperclipai/db";

export async function recoverApprovedToolReviews(db: Db, recover: (input: {
  request: typeof toolActionRequests.$inferSelect;
  invocation: typeof toolInvocations.$inferSelect;
}) => Promise<boolean>) {
  let cursor: string | undefined;
  let scanned = 0, retry = false;
  for (;;) {
    const rows = await db.select({ request: toolActionRequests, invocation: toolInvocations })
      .from(toolActionRequests).innerJoin(toolInvocations, eq(toolInvocations.id, toolActionRequests.invocationId))
      .where(and(eq(toolActionRequests.status, "approved"), cursor ? gt(toolActionRequests.id, cursor) : undefined))
      .orderBy(asc(toolActionRequests.id)).limit(100);
    for (const row of rows) retry = await recover(row) || retry;
    scanned += rows.length;
    if (rows.length < 100) break;
    cursor = rows[rows.length - 1].request.id;
  }
  return { scanned, retry };
}
