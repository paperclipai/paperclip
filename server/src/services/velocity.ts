import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { issues } from "@ironworksai/db";

// ── Velocity Data ──────────────────────────────────────────────────────────

export interface VelocityWeek {
  week: string;
  completed: number;
  cancelled: number;
}

/**
 * Returns weekly issue completion and cancellation counts for the last N weeks.
 * Each entry has a `week` string (YYYY-MM-DD of the Monday), `completed`, and `cancelled`.
 *
 * @param db       - Database connection
 * @param companyId - Company to query
 * @param weeks    - Number of weeks to look back (default 12)
 */
export async function getVelocityData(
  db: Db,
  companyId: string,
  weeks: number = 12,
): Promise<VelocityWeek[]> {
  const cutoff = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);

  // Query completed issues grouped by week
  const completedRows = await db
    .select({
      week: sql<string>`to_char(date_trunc('week', ${issues.completedAt}), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "done"),
        gte(issues.completedAt, cutoff),
      ),
    )
    .groupBy(sql`date_trunc('week', ${issues.completedAt})`)
    .orderBy(sql`date_trunc('week', ${issues.completedAt})`);

  // Query cancelled issues grouped by week
  const cancelledRows = await db
    .select({
      week: sql<string>`to_char(date_trunc('week', ${issues.cancelledAt}), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "cancelled"),
        gte(issues.cancelledAt, cutoff),
      ),
    )
    .groupBy(sql`date_trunc('week', ${issues.cancelledAt})`)
    .orderBy(sql`date_trunc('week', ${issues.cancelledAt})`);

  // Merge into a single map keyed by week
  const weekMap = new Map<string, VelocityWeek>();

  for (const row of completedRows) {
    const week = row.week;
    if (!weekMap.has(week)) {
      weekMap.set(week, { week, completed: 0, cancelled: 0 });
    }
    weekMap.get(week)!.completed = Number(row.count);
  }

  for (const row of cancelledRows) {
    const week = row.week;
    if (!weekMap.has(week)) {
      weekMap.set(week, { week, completed: 0, cancelled: 0 });
    }
    weekMap.get(week)!.cancelled = Number(row.count);
  }

  // Sort by week ascending
  return [...weekMap.values()].sort((a, b) => a.week.localeCompare(b.week));
}
