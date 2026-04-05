import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { issues } from "@ironworksai/db";

export type FlowMetrics = {
  avgCycleTimeMinutes: number;
  avgLeadTimeMinutes: number;
  throughputPerWeek: number;
  throughputTrend: "improving" | "stable" | "declining";
  bottleneckColumn: string | null;
  bottleneckCount: number;
  blockedIssues: number;
  avgBlockedDurationMinutes: number;
};

/**
 * Compute flow health metrics for a company.
 *
 * - Cycle time: avg(completedAt - startedAt) for issues completed in the last 30 days
 * - Lead time: avg(completedAt - createdAt) for issues completed in the last 30 days
 * - Throughput: count completed issues in rolling 4-week window divided by 4
 * - Trend: compare this week vs prior 3-week average
 * - Bottleneck: status with the most open issues
 * - Blocked: count of blocked issues + avg time since updatedAt (proxy for blocked duration)
 */
export async function computeFlowMetrics(db: Db, companyId: string): Promise<FlowMetrics> {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Cycle time and lead time for recently completed issues
  const [cycleLeadRow] = await db
    .select({
      avgCycleMinutes: sql<number>`
        coalesce(
          avg(
            extract(epoch from (${issues.completedAt} - ${issues.startedAt})) / 60
          ) filter (where ${issues.startedAt} is not null and ${issues.completedAt} is not null),
          0
        )::float
      `,
      avgLeadMinutes: sql<number>`
        coalesce(
          avg(
            extract(epoch from (${issues.completedAt} - ${issues.createdAt})) / 60
          ) filter (where ${issues.completedAt} is not null),
          0
        )::float
      `,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, thirtyDaysAgo),
      ),
    );

  // Throughput: completed in rolling 4 weeks
  const [throughput4wRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, fourWeeksAgo),
      ),
    );

  // Throughput: completed this week (for trend)
  const [throughputWeekRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, oneWeekAgo),
      ),
    );

  const total4w = Number(throughput4wRow?.count ?? 0);
  const totalThisWeek = Number(throughputWeekRow?.count ?? 0);
  const throughputPerWeek = total4w / 4;

  // Prior 3-week average = (4w total - this week) / 3
  const prior3wAvg = total4w > 0 ? (total4w - totalThisWeek) / 3 : 0;

  let throughputTrend: FlowMetrics["throughputTrend"] = "stable";
  if (prior3wAvg > 0) {
    const delta = (totalThisWeek - prior3wAvg) / prior3wAvg;
    if (delta > 0.1) throughputTrend = "improving";
    else if (delta < -0.1) throughputTrend = "declining";
  }

  // Bottleneck: status with the most non-done issues
  const statusCounts = await db
    .select({ status: issues.status, count: sql<number>`count(*)::int` })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        sql`${issues.status} NOT IN ('done', 'cancelled')`,
      ),
    )
    .groupBy(issues.status);

  let bottleneckColumn: string | null = null;
  let bottleneckCount = 0;
  for (const row of statusCounts) {
    const n = Number(row.count);
    if (n > bottleneckCount) {
      bottleneckCount = n;
      bottleneckColumn = row.status;
    }
  }

  // Blocked issues count + avg duration since last update (proxy for blocked duration)
  const [blockedRow] = await db
    .select({
      blockedCount: sql<number>`count(*)::int`,
      avgBlockedMinutes: sql<number>`
        coalesce(
          avg(extract(epoch from (now() - ${issues.updatedAt})) / 60),
          0
        )::float
      `,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "blocked"),
      ),
    );

  return {
    avgCycleTimeMinutes: Math.round(Number(cycleLeadRow?.avgCycleMinutes ?? 0)),
    avgLeadTimeMinutes: Math.round(Number(cycleLeadRow?.avgLeadMinutes ?? 0)),
    throughputPerWeek: Math.round(throughputPerWeek * 10) / 10,
    throughputTrend,
    bottleneckColumn,
    bottleneckCount,
    blockedIssues: Number(blockedRow?.blockedCount ?? 0),
    avgBlockedDurationMinutes: Math.round(Number(blockedRow?.avgBlockedMinutes ?? 0)),
  };
}
