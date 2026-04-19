import { and, eq, gte, sql, desc, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns } from "@paperclipai/db";

export interface AgentHeartbeatStats {
  agentId: string;
  agentName: string;
  agentStatus: string;
  adapterType: string;
  totalRuns: number;
  succeededRuns: number;
  failedRuns: number;
  timedOutRuns: number;
  otherRuns: number;
  successRate: number;
  avgDurationMs: number | null;
  maxDurationMs: number | null;
  minDurationMs: number | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  consecutiveFailures: number;
  isStuck: boolean;
}

export interface HeartbeatStatsResponse {
  companyId: string;
  periodDays: number;
  totalRuns: number;
  succeededRuns: number;
  failedRuns: number;
  overallSuccessRate: number;
  avgDurationMs: number | null;
  stuckAgentCount: number;
  agents: AgentHeartbeatStats[];
  dailyStats: DailyStats[];
}

export interface DailyStats {
  date: string;
  succeeded: number;
  failed: number;
  timedOut: number;
  other: number;
  avgDurationMs: number | null;
}

export function heartbeatStatsService(db: Db) {
  return {
    getStats: async (companyId: string, periodDays = 14): Promise<HeartbeatStatsResponse> => {
      const since = new Date();
      since.setDate(since.getDate() - periodDays);

      // Per-agent aggregation
      const agentStats = await db
        .select({
          agentId: heartbeatRuns.agentId,
          agentName: agents.name,
          agentStatus: agents.status,
          adapterType: agents.adapterType,
          totalRuns: sql<number>`count(*)::int`,
          succeededRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded')::int`,
          failedRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'failed')::int`,
          timedOutRuns: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'timed_out')::int`,
          avgDurationMs: sql<
            number | null
          >`avg(extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) * 1000) filter (where ${heartbeatRuns.finishedAt} is not null and ${heartbeatRuns.startedAt} is not null)`,
          maxDurationMs: sql<
            number | null
          >`max(extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) * 1000) filter (where ${heartbeatRuns.finishedAt} is not null and ${heartbeatRuns.startedAt} is not null)`,
          minDurationMs: sql<
            number | null
          >`min(extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) * 1000) filter (where ${heartbeatRuns.finishedAt} is not null and ${heartbeatRuns.startedAt} is not null)`,
          lastRunAt: sql<string | null>`max(${heartbeatRuns.createdAt})`,
        })
        .from(heartbeatRuns)
        .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
        .where(and(eq(heartbeatRuns.companyId, companyId), gte(heartbeatRuns.createdAt, since)))
        .groupBy(heartbeatRuns.agentId, agents.name, agents.status, agents.adapterType);

      // Get last run status and consecutive failures per agent
      const agentsWithDetails: AgentHeartbeatStats[] = [];
      for (const row of agentStats) {
        // Fetch recent runs for consecutive failure count
        const recentRuns = await db
          .select({
            status: heartbeatRuns.status,
          })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.agentId, row.agentId),
              eq(heartbeatRuns.companyId, companyId),
              isNotNull(heartbeatRuns.finishedAt),
            ),
          )
          .orderBy(desc(heartbeatRuns.finishedAt))
          .limit(10);

        let consecutiveFailures = 0;
        for (const r of recentRuns) {
          if (r.status === "failed" || r.status === "timed_out") {
            consecutiveFailures++;
          } else {
            break;
          }
        }

        const lastRunStatus = recentRuns[0]?.status ?? null;
        const totalRuns = Number(row.totalRuns);
        const succeededRuns = Number(row.succeededRuns);

        agentsWithDetails.push({
          agentId: row.agentId,
          agentName: row.agentName,
          agentStatus: row.agentStatus,
          adapterType: row.adapterType,
          totalRuns,
          succeededRuns,
          failedRuns: Number(row.failedRuns),
          timedOutRuns: Number(row.timedOutRuns),
          otherRuns: totalRuns - succeededRuns - Number(row.failedRuns) - Number(row.timedOutRuns),
          successRate: totalRuns > 0 ? Number(((succeededRuns / totalRuns) * 100).toFixed(1)) : 0,
          avgDurationMs: row.avgDurationMs != null ? Math.round(Number(row.avgDurationMs)) : null,
          maxDurationMs: row.maxDurationMs != null ? Math.round(Number(row.maxDurationMs)) : null,
          minDurationMs: row.minDurationMs != null ? Math.round(Number(row.minDurationMs)) : null,
          lastRunAt: row.lastRunAt,
          lastRunStatus,
          consecutiveFailures,
          isStuck:
            consecutiveFailures >= 3 ||
            (lastRunStatus === "running" &&
              row.lastRunAt != null &&
              new Date().getTime() - new Date(row.lastRunAt).getTime() > 30 * 60 * 1000),
        });
      }

      // Daily stats
      const dailyRows = await db
        .select({
          date: sql<string>`date(${heartbeatRuns.createdAt})`,
          succeeded: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'succeeded')::int`,
          failed: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'failed')::int`,
          timedOut: sql<number>`count(*) filter (where ${heartbeatRuns.status} = 'timed_out')::int`,
          other: sql<number>`count(*) filter (where ${heartbeatRuns.status} not in ('succeeded', 'failed', 'timed_out'))::int`,
          avgDurationMs: sql<
            number | null
          >`avg(extract(epoch from (${heartbeatRuns.finishedAt} - ${heartbeatRuns.startedAt})) * 1000) filter (where ${heartbeatRuns.finishedAt} is not null and ${heartbeatRuns.startedAt} is not null)`,
        })
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, companyId), gte(heartbeatRuns.createdAt, since)))
        .groupBy(sql`date(${heartbeatRuns.createdAt})`)
        .orderBy(sql`date(${heartbeatRuns.createdAt})`);

      const dailyStats: DailyStats[] = dailyRows.map((r) => ({
        date: String(r.date),
        succeeded: Number(r.succeeded),
        failed: Number(r.failed),
        timedOut: Number(r.timedOut),
        other: Number(r.other),
        avgDurationMs: r.avgDurationMs != null ? Math.round(Number(r.avgDurationMs)) : null,
      }));

      // Overall totals
      const totalRuns = agentsWithDetails.reduce((s, a) => s + a.totalRuns, 0);
      const succeededRuns = agentsWithDetails.reduce((s, a) => s + a.succeededRuns, 0);
      const failedRuns = agentsWithDetails.reduce((s, a) => s + a.failedRuns, 0);
      const allAvgDurations = agentsWithDetails.filter((a) => a.avgDurationMs != null).map((a) => a.avgDurationMs!);
      const overallAvgDuration =
        allAvgDurations.length > 0
          ? Math.round(allAvgDurations.reduce((s, d) => s + d, 0) / allAvgDurations.length)
          : null;

      return {
        companyId,
        periodDays,
        totalRuns,
        succeededRuns,
        failedRuns,
        overallSuccessRate: totalRuns > 0 ? Number(((succeededRuns / totalRuns) * 100).toFixed(1)) : 0,
        avgDurationMs: overallAvgDuration,
        stuckAgentCount: agentsWithDetails.filter((a) => a.isStuck).length,
        agents: agentsWithDetails.sort((a, b) => {
          // Stuck agents first, then by failure count desc
          if (a.isStuck !== b.isStuck) return a.isStuck ? -1 : 1;
          return b.consecutiveFailures - a.consecutiveFailures || b.totalRuns - a.totalRuns;
        }),
        dailyStats,
      };
    },
  };
}
