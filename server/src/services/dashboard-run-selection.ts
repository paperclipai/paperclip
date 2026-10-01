import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import { desc, eq, sql } from "drizzle-orm";

/** Select dashboard cards before limiting by count, so repeated runs cannot hide other tasks. */
export async function selectDashboardRunIds(db: Db, companyId: string, limit: number): Promise<string[]> {
  if (limit <= 0) return [];

  const issueId = sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`;
  const cardKey = sql<string>`coalesce('issue:' || nullif(${issueId}, ''), 'run:' || ${heartbeatRuns.id}::text)`;
  const activeFirst = sql<number>`case when ${heartbeatRuns.status} in ('queued', 'running') then 0 else 1 end`;
  const rankedRuns = db
    .select({
      id: heartbeatRuns.id,
      createdAt: heartbeatRuns.createdAt,
      activeFirst: activeFirst.as("active_first"),
      cardRank: sql<number>`row_number() over (
        partition by ${cardKey}
        order by ${activeFirst}, ${heartbeatRuns.createdAt} desc, ${heartbeatRuns.id} desc
      )`.as("card_rank"),
    })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.companyId, companyId))
    .as("ranked_dashboard_runs");

  const selected = await db
    .select({ id: rankedRuns.id })
    .from(rankedRuns)
    .where(eq(rankedRuns.cardRank, 1))
    .orderBy(rankedRuns.activeFirst, desc(rankedRuns.createdAt), desc(rankedRuns.id))
    .limit(limit);

  return selected.map((run) => run.id);
}
