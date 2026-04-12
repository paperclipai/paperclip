import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";

export interface ThroughputRow {
  date: string;
  done: number;
  cancelled: number;
}

export interface FlowRow {
  date: string;
  backlog: number;
  active: number;
  review: number;
  blocked: number;
  terminal: number;
}

interface AnalyticsOpts {
  days?: number;
  deptLabelId?: string;
  initiativeId?: string;
}

/**
 * Count issues that transitioned to done/cancelled per day.
 * Uses the activity_log table to find issue.updated entries.
 */
export function createAnalyticsService(db: Db) {
  async function throughput(
    companyId: string,
    opts: AnalyticsOpts = {},
  ): Promise<ThroughputRow[]> {
    const days = opts.days ?? 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // When filtering by initiative, find all child issue IDs first
    let childIssueIds: string[] | null = null;
    if (opts.initiativeId) {
      const children = await db
        .select({ id: issues.id })
        .from(issues)
        .where(
          and(
            eq(issues.companyId, companyId),
            eq(issues.parentId, opts.initiativeId),
          ),
        );
      childIssueIds = children.map((c) => c.id);
      if (childIssueIds.length === 0) {
        return fillEmptyDays(days);
      }
    }

    // When filtering by dept label, find matching issue IDs
    let deptIssueIds: string[] | null = null;
    if (opts.deptLabelId) {
      const matched = await db.execute(sql`
        SELECT i.id FROM issues i
        JOIN issue_labels il ON il.issue_id = i.id
        WHERE i.company_id = ${companyId}
          AND il.label_id = ${opts.deptLabelId}
      `);
      deptIssueIds = (matched as unknown as Array<{ id: string }>).map((r) => r.id);
      if (deptIssueIds.length === 0) {
        return fillEmptyDays(days);
      }
    }

    // Combine entity ID filters
    let entityIds: string[] | null = null;
    if (childIssueIds && deptIssueIds) {
      const deptSet = new Set(deptIssueIds);
      entityIds = childIssueIds.filter((id) => deptSet.has(id));
      if (entityIds.length === 0) return fillEmptyDays(days);
    } else if (childIssueIds) {
      entityIds = childIssueIds;
    } else if (deptIssueIds) {
      entityIds = deptIssueIds;
    }

    const rows = await db.execute(sql`
      SELECT
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
        COUNT(*) FILTER (WHERE details->>'status' = 'done') AS done,
        COUNT(*) FILTER (WHERE details->>'status' = 'cancelled') AS cancelled
      FROM activity_log
      WHERE company_id = ${companyId}
        AND action = 'issue.updated'
        AND created_at >= ${since.toISOString()}::timestamptz
        AND (details->>'status') IN ('done', 'cancelled')
        ${entityIds ? sql`AND entity_id = ANY(${entityIds.map(String)})` : sql``}
      GROUP BY 1
      ORDER BY 1
    `);

    const resultMap = new Map<string, ThroughputRow>();
    for (const row of (rows as unknown as Array<Record<string, unknown>>) as Array<{ date: string; done: string; cancelled: string }>) {
      resultMap.set(row.date, {
        date: row.date,
        done: Number(row.done),
        cancelled: Number(row.cancelled),
      });
    }

    return fillDays(days, resultMap, () => ({ done: 0, cancelled: 0 }));
  }

  /**
   * Compute daily status distribution snapshot.
   * For each day, counts how many issues were in each bucket at end-of-day.
   * Simplified approach: uses current status + activity_log to track transitions.
   */
  async function flow(
    companyId: string,
    opts: AnalyticsOpts = {},
  ): Promise<FlowRow[]> {
    const days = opts.days ?? 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Get daily snapshots by counting the most recent status of each issue on each day
    const rows = await db.execute(sql`
      WITH date_series AS (
        SELECT generate_series(
          ${since.toISOString()}::date,
          CURRENT_DATE,
          '1 day'::interval
        )::date AS day
      ),
      issue_pool AS (
        SELECT i.id, i.status, i.created_at
        FROM issues i
        WHERE i.company_id = ${companyId}
          ${opts.deptLabelId ? sql`AND i.id IN (SELECT issue_id FROM issue_labels WHERE label_id = ${opts.deptLabelId})` : sql``}
          ${opts.initiativeId ? sql`AND i.parent_id = ${opts.initiativeId}` : sql``}
      ),
      daily_status AS (
        SELECT
          d.day,
          ip.id AS issue_id,
          COALESCE(
            (
              SELECT al.details->>'status'
              FROM activity_log al
              WHERE al.entity_id = ip.id::text
                AND al.action = 'issue.updated'
                AND al.details->>'status' IS NOT NULL
                AND al.created_at::date <= d.day
              ORDER BY al.created_at DESC
              LIMIT 1
            ),
            CASE WHEN ip.created_at::date <= d.day THEN ip.status ELSE NULL END
          ) AS effective_status
        FROM date_series d
        CROSS JOIN issue_pool ip
        WHERE ip.created_at::date <= d.day
      )
      SELECT
        to_char(day, 'YYYY-MM-DD') AS date,
        COUNT(*) FILTER (WHERE effective_status = 'backlog') AS backlog,
        COUNT(*) FILTER (WHERE effective_status IN ('todo', 'in_progress')) AS active,
        COUNT(*) FILTER (WHERE effective_status = 'in_review') AS review,
        COUNT(*) FILTER (WHERE effective_status = 'blocked') AS blocked,
        COUNT(*) FILTER (WHERE effective_status IN ('done', 'cancelled')) AS terminal
      FROM daily_status
      WHERE effective_status IS NOT NULL
      GROUP BY 1
      ORDER BY 1
    `);

    return ((rows as unknown as Array<Record<string, unknown>>) as Array<{
      date: string;
      backlog: string;
      active: string;
      review: string;
      blocked: string;
      terminal: string;
    }>).map((row) => ({
      date: row.date,
      backlog: Number(row.backlog),
      active: Number(row.active),
      review: Number(row.review),
      blocked: Number(row.blocked),
      terminal: Number(row.terminal),
    }));
  }

  return { throughput, flow };
}

/* ── Helpers ── */

function fillEmptyDays(days: number): ThroughputRow[] {
  return fillDays(days, new Map(), () => ({ done: 0, cancelled: 0 }));
}

function fillDays<T>(
  days: number,
  dataMap: Map<string, T>,
  defaults: () => Omit<T, "date">,
): Array<T & { date: string }> {
  const result: Array<T & { date: string }> = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const existing = dataMap.get(key);
    if (existing) {
      result.push(existing as T & { date: string });
    } else {
      result.push({ date: key, ...defaults() } as T & { date: string });
    }
  }
  return result;
}
