import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

const MAX_CANDIDATES_PER_POOL = 1_000;
const ACTIVE_STATUSES = ["queued", "running"];

/** Same identity recovery uses: native issue, then context issue, then task id. */
export function dashboardTaskIssueId() {
  return sql<string | null>`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId', ${heartbeatRuns.contextSnapshot}->>'taskId')`;
}

/** Select recent dashboard cards without ranking the company's full run history. */
export async function selectDashboardRunIds(db: Db, companyId: string, limit: number): Promise<string[]> {
  if (limit <= 0) return [];

  const columns = {
    id: heartbeatRuns.id,
    status: heartbeatRuns.status,
    createdAt: heartbeatRuns.createdAt,
    issueId: dashboardTaskIssueId(),
  };
  const [activeRuns, recentRuns] = await Promise.all([
    db.select(columns)
      .from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.status, ACTIVE_STATUSES)))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(MAX_CANDIDATES_PER_POOL),
    db.select(columns)
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
      .limit(MAX_CANDIDATES_PER_POOL),
  ]);

  const candidates = [...new Map([...activeRuns, ...recentRuns].map((run) => [run.id, run])).values()];
  candidates.sort((a, b) => {
    const activeOrder = Number(ACTIVE_STATUSES.includes(b.status)) - Number(ACTIVE_STATUSES.includes(a.status));
    if (activeOrder !== 0) return activeOrder;
    const createdOrder = b.createdAt.getTime() - a.createdAt.getTime();
    return createdOrder || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  });

  const selectedIds: string[] = [];
  const seenCards = new Set<string>();
  for (const run of candidates) {
    const cardKey = run.issueId ? `issue:${run.issueId}` : `run:${run.id}`;
    if (seenCards.has(cardKey)) continue;
    seenCards.add(cardKey);
    selectedIds.push(run.id);
    if (selectedIds.length === limit) break;
  }
  return selectedIds;
}
