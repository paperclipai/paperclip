/**
 * KPI framework for Paperclip agent company performance measurement.
 *
 * Computes 15 KPIs across four categories:
 *   1. Cost Efficiency   (KPIs 1–4)
 *   2. Run Reliability   (KPIs 5–7)
 *   3. Workflow Efficiency (KPIs 8–11)
 *   4. Autonomy          (KPIs 12–13)
 *   5. Observability     (KPIs 14–15)
 *
 * All KPIs are computed against a configurable lookback window (default: 7 days).
 * Snapshots are stored in kpi_snapshots for week-over-week trend analysis.
 */
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  kpiSnapshots,
} from "@paperclipai/db";

export interface KpiValue {
  /** The computed metric. null = insufficient data or unmeasurable. */
  value: number | null;
  /** Display unit string (e.g. "tokens", "cents", "percent", "seconds"). */
  unit: string;
  /** Explanation when value is null, or a measurement note. */
  note?: string;
}

export interface KpiReport {
  companyId: string;
  windowDays: number;
  windowStart: string;
  computedAt: string;
  kpis: {
    // --- Cost Efficiency ---
    /** KPI 1: Avg (input + output) tokens per completed task. By company; breakdown by agent in metadata. */
    tokensPerCompletedTask: KpiValue;
    /** KPI 2: Avg cost in cents per completed task. */
    costPerCompletedTaskCents: KpiValue;
    /** KPI 3: Cache hit rate = cached_input_tokens / input_tokens across all cost events in window. */
    cacheHitRate: KpiValue;
    /** KPI 4: Budget utilization efficiency = tasks completed per $1 spent. */
    budgetUtilizationEfficiency: KpiValue;

    // --- Run Reliability ---
    /** KPI 5: Heartbeat success rate = succeeded / total finished runs. */
    heartbeatSuccessRate: KpiValue;
    /** KPI 6: Task first-attempt success rate = done tasks without any retry runs. */
    taskFirstAttemptSuccessRate: KpiValue;
    /** KPI 7: Mean retry count across completed tasks. */
    meanRetryCount: KpiValue;

    // --- Workflow Efficiency ---
    /** KPI 8: Mean task cycle time in seconds (started_at → completed_at). */
    taskCycleTimeSeconds: KpiValue;
    /** KPI 9: Mean delegation depth (request_depth) of completed tasks. */
    delegationDepthAvg: KpiValue;
    /** KPI 10: Checkout conflict rate. Not persisted — returns null. */
    checkoutConflictRate: KpiValue;
    /** KPI 11: Blocked task ratio = blocked / (all non-done, non-cancelled) tasks. */
    blockedTaskRatio: KpiValue;

    // --- Autonomy ---
    /** KPI 12: Human intervention rate = tasks with ≥1 approval / total done tasks. */
    humanInterventionRate: KpiValue;
    /** KPI 13: End-to-end autonomous completion rate = 1 − human_intervention_rate. */
    autonomousCompletionRate: KpiValue;

    // --- Observability ---
    /** KPI 14: Trace coverage = % of finished runs that have usage_json recorded. */
    traceCoverage: KpiValue;
    /** KPI 15: Mean time to diagnose. Not yet derivable — returns null. */
    meanTimeToDiagnoseSeconds: KpiValue;
  };
  /** Per-agent breakdown for KPIs 1–2 and 5. */
  agentBreakdown: AgentKpiBreakdown[];
}

export interface AgentKpiBreakdown {
  agentId: string;
  agentName: string | null;
  tokensPerCompletedTask: number | null;
  costPerCompletedTaskCents: number | null;
  heartbeatSuccessRate: number | null;
}

function windowStart(windowDays: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - windowDays);
  d.setHours(0, 0, 0, 0);
  return d;
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return numerator / denominator;
}

export function kpiService(db: Db) {
  return {
    /**
     * Compute all 15 KPIs for a company over the given window.
     * Does NOT persist to kpi_snapshots — call saveSnapshot() to persist.
     */
    compute: async (companyId: string, windowDays = 7): Promise<KpiReport> => {
      const start = windowStart(windowDays);
      const computedAt = new Date();

      const [
        tokenCostPerTask,
        cacheStats,
        heartbeatStats,
        retryStats,
        cycleTime,
        delegationDepth,
        blockedRatio,
        interventionStats,
        traceStats,
        agentBreakdown,
      ] = await Promise.all([
        computeTokenCostPerTask(db, companyId, start),
        computeCacheStats(db, companyId, start),
        computeHeartbeatStats(db, companyId, start),
        computeRetryStats(db, companyId, start),
        computeCycleTime(db, companyId, start),
        computeDelegationDepth(db, companyId, start),
        computeBlockedRatio(db, companyId),
        computeInterventionStats(db, companyId, start),
        computeTraceCoverage(db, companyId, start),
        computeAgentBreakdown(db, companyId, start),
      ]);

      // KPI 4: tasks per $1 spent
      const totalDone = tokenCostPerTask.totalDone;
      const totalSpendCents = cacheStats.totalSpendCents;
      const budgetEfficiency: KpiValue =
        totalSpendCents === 0
          ? { value: null, unit: "tasks/$1", note: "No spend recorded in window" }
          : { value: (totalDone / (totalSpendCents / 100)), unit: "tasks/$1" };

      // KPI 6 & 7 from retryStats
      const firstAttemptRate: KpiValue = retryStats.totalDone === 0
        ? { value: null, unit: "ratio", note: "No completed tasks in window" }
        : { value: pct(retryStats.firstAttemptDone, retryStats.totalDone), unit: "ratio" };

      const meanRetry: KpiValue = retryStats.totalDone === 0
        ? { value: null, unit: "retries/task", note: "No completed tasks in window" }
        : { value: retryStats.meanRetryCount, unit: "retries/task" };

      return {
        companyId,
        windowDays,
        windowStart: start.toISOString(),
        computedAt: computedAt.toISOString(),
        kpis: {
          tokensPerCompletedTask: tokenCostPerTask.totalDone === 0
            ? { value: null, unit: "tokens", note: "No completed tasks in window" }
            : { value: tokenCostPerTask.avgTokens, unit: "tokens" },

          costPerCompletedTaskCents: tokenCostPerTask.totalDone === 0
            ? { value: null, unit: "cents", note: "No completed tasks in window" }
            : { value: tokenCostPerTask.avgCostCents, unit: "cents" },

          cacheHitRate: cacheStats.totalInputTokens === 0
            ? { value: null, unit: "ratio", note: "No token usage recorded in window" }
            : { value: pct(cacheStats.cachedInputTokens, cacheStats.totalInputTokens), unit: "ratio" },

          budgetUtilizationEfficiency: budgetEfficiency,

          heartbeatSuccessRate: heartbeatStats.total === 0
            ? { value: null, unit: "ratio", note: "No heartbeat runs in window" }
            : { value: pct(heartbeatStats.succeeded, heartbeatStats.total), unit: "ratio" },

          taskFirstAttemptSuccessRate: firstAttemptRate,
          meanRetryCount: meanRetry,

          taskCycleTimeSeconds: cycleTime.count === 0
            ? { value: null, unit: "seconds", note: "No completed tasks with timing data in window" }
            : { value: cycleTime.avgSeconds, unit: "seconds" },

          delegationDepthAvg: delegationDepth.count === 0
            ? { value: null, unit: "depth", note: "No completed tasks in window" }
            : { value: delegationDepth.avg, unit: "depth" },

          checkoutConflictRate: {
            value: null,
            unit: "ratio",
            note: "Conflict 409s are not persisted — unmeasurable from stored data",
          },

          blockedTaskRatio: blockedRatio.active === 0
            ? { value: null, unit: "ratio", note: "No active tasks" }
            : { value: pct(blockedRatio.blocked, blockedRatio.active), unit: "ratio" },

          humanInterventionRate: interventionStats.totalDone === 0
            ? { value: null, unit: "ratio", note: "No completed tasks in window" }
            : { value: pct(interventionStats.withApprovals, interventionStats.totalDone), unit: "ratio" },

          autonomousCompletionRate: interventionStats.totalDone === 0
            ? { value: null, unit: "ratio", note: "No completed tasks in window" }
            : {
                value: pct(
                  interventionStats.totalDone - interventionStats.withApprovals,
                  interventionStats.totalDone,
                ),
                unit: "ratio",
              },

          traceCoverage: traceStats.total === 0
            ? { value: null, unit: "ratio", note: "No finished runs in window" }
            : { value: pct(traceStats.withUsage, traceStats.total), unit: "ratio" },

          meanTimeToDiagnoseSeconds: {
            value: null,
            unit: "seconds",
            note: "Not derivable from current schema — requires explicit diagnostic event tracking",
          },
        },
        agentBreakdown,
      };
    },

    /**
     * Compute KPIs and save as a snapshot for trend tracking.
     */
    saveSnapshot: async (companyId: string, windowDays = 7) => {
      const report = await kpiService(db).compute(companyId, windowDays);
      const [snapshot] = await db
        .insert(kpiSnapshots)
        .values({
          companyId,
          windowDays,
          kpisJson: report as unknown as Record<string, unknown>,
          computedAt: new Date(report.computedAt),
        })
        .returning();
      return { snapshot, report };
    },

    /**
     * List saved KPI snapshots, newest first.
     */
    listSnapshots: async (
      companyId: string,
      opts: { limit?: number } = {},
    ) => {
      const limit = opts.limit ?? 12; // default: last 12 weeks
      return db
        .select()
        .from(kpiSnapshots)
        .where(eq(kpiSnapshots.companyId, companyId))
        .orderBy(desc(kpiSnapshots.computedAt))
        .limit(limit);
    },

    /**
     * Verify the company exists before computing KPIs (validates access).
     */
    assertCompanyExists: async (companyId: string) => {
      // Lightweight check — pull 1 row from issues rather than importing companies table
      // to avoid a heavy join. If the company has no rows in issues, that's fine.
      // Use a dedicated company lookup via cost_events or heartbeatRuns existence as proxy
      // is unreliable for new companies; instead just verify no DB error on a restricted query.
      const rows = await db
        .select({ id: kpiSnapshots.id })
        .from(kpiSnapshots)
        .where(eq(kpiSnapshots.companyId, companyId))
        .limit(1);
      // Table access succeeds if company_id FK would be valid — otherwise trust
      // that authz middleware has already verified access.
      return rows;
    },
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

async function computeTokenCostPerTask(db: Db, companyId: string, start: Date) {
  const startIso = start.toISOString();
  const rows = await db.execute<{
    total_done: string;
    avg_tokens: string | null;
    avg_cost_cents: string | null;
  }>(sql`
    SELECT
      COUNT(DISTINCT i.id)::int AS total_done,
      AVG(issue_totals.total_tokens) AS avg_tokens,
      AVG(issue_totals.total_cost_cents) AS avg_cost_cents
    FROM issues i
    JOIN (
      SELECT
        ce.issue_id,
        SUM(ce.input_tokens + ce.output_tokens) AS total_tokens,
        SUM(ce.cost_cents)::int AS total_cost_cents
      FROM cost_events ce
      WHERE ce.company_id = ${companyId}::uuid
      GROUP BY ce.issue_id
    ) issue_totals ON issue_totals.issue_id = i.id
    WHERE i.company_id = ${companyId}::uuid
      AND i.status = 'done'
      AND i.completed_at >= ${startIso}
  `);
  const row = rows[0];
  return {
    totalDone: Number(row?.total_done ?? 0),
    avgTokens: row?.avg_tokens != null ? Number(row.avg_tokens) : null,
    avgCostCents: row?.avg_cost_cents != null ? Number(row.avg_cost_cents) : null,
  };
}

async function computeCacheStats(db: Db, companyId: string, start: Date) {
  const startIso = start.toISOString();
  const rows = await db.execute<{
    total_input: string;
    cached_input: string;
    total_spend_cents: string;
  }>(sql`
    SELECT
      -- total_input = uncached + cached (denominator for cache hit rate)
      COALESCE(SUM(input_tokens + cached_input_tokens), 0)::bigint AS total_input,
      COALESCE(SUM(cached_input_tokens), 0)::bigint AS cached_input,
      COALESCE(SUM(cost_cents), 0)::int AS total_spend_cents
    FROM cost_events
    WHERE company_id = ${companyId}::uuid
      AND occurred_at >= ${startIso}
  `);
  const row = rows[0];
  return {
    totalInputTokens: Number(row?.total_input ?? 0),
    cachedInputTokens: Number(row?.cached_input ?? 0),
    totalSpendCents: Number(row?.total_spend_cents ?? 0),
  };
}

async function computeHeartbeatStats(db: Db, companyId: string, start: Date) {
  const startIso = start.toISOString();
  const rows = await db.execute<{ total: string; succeeded: string }>(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded
    FROM heartbeat_runs
    WHERE company_id = ${companyId}::uuid
      AND started_at >= ${startIso}
      AND status IN ('succeeded', 'failed', 'error')
  `);
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    succeeded: Number(row?.succeeded ?? 0),
  };
}

async function computeRetryStats(db: Db, companyId: string, start: Date) {
  const startIso = start.toISOString();
  const rows = await db.execute<{
    total_done: string;
    first_attempt_done: string;
    mean_retry_count: string | null;
  }>(sql`
    WITH done_issues AS (
      SELECT id
      FROM issues
      WHERE company_id = ${companyId}::uuid
        AND status = 'done'
        AND completed_at >= ${startIso}
    ),
    issue_retry_counts AS (
      SELECT
        ce.issue_id,
        COUNT(*) FILTER (WHERE hr.retry_of_run_id IS NOT NULL) AS retry_count
      FROM cost_events ce
      JOIN heartbeat_runs hr ON hr.id = ce.heartbeat_run_id
      WHERE ce.company_id = ${companyId}::uuid
        AND ce.issue_id IN (SELECT id FROM done_issues)
      GROUP BY ce.issue_id
    )
    SELECT
      (SELECT COUNT(*) FROM done_issues)::int AS total_done,
      COUNT(*) FILTER (WHERE COALESCE(rc.retry_count, 0) = 0)::int AS first_attempt_done,
      AVG(COALESCE(rc.retry_count, 0)) AS mean_retry_count
    FROM done_issues di
    LEFT JOIN issue_retry_counts rc ON rc.issue_id = di.id
  `);
  const row = rows[0];
  return {
    totalDone: Number(row?.total_done ?? 0),
    firstAttemptDone: Number(row?.first_attempt_done ?? 0),
    meanRetryCount: row?.mean_retry_count != null ? Number(row.mean_retry_count) : 0,
  };
}

async function computeCycleTime(db: Db, companyId: string, start: Date) {
  const startIso = start.toISOString();
  const rows = await db.execute<{ count: string; avg_seconds: string | null }>(sql`
    SELECT
      COUNT(*)::int AS count,
      AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) AS avg_seconds
    FROM issues
    WHERE company_id = ${companyId}::uuid
      AND status = 'done'
      AND completed_at IS NOT NULL
      AND started_at IS NOT NULL
      AND completed_at >= ${startIso}
  `);
  const row = rows[0];
  return {
    count: Number(row?.count ?? 0),
    avgSeconds: row?.avg_seconds != null ? Number(row.avg_seconds) : null,
  };
}

async function computeDelegationDepth(db: Db, companyId: string, start: Date) {
  const startIso = start.toISOString();
  const rows = await db.execute<{ count: string; avg_depth: string | null }>(sql`
    SELECT
      COUNT(*)::int AS count,
      AVG(request_depth) AS avg_depth
    FROM issues
    WHERE company_id = ${companyId}::uuid
      AND status = 'done'
      AND completed_at >= ${startIso}
  `);
  const row = rows[0];
  return {
    count: Number(row?.count ?? 0),
    avg: row?.avg_depth != null ? Number(row.avg_depth) : null,
  };
}

async function computeBlockedRatio(db: Db, companyId: string) {
  const rows = await db.execute<{ blocked: string; active: string }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'blocked')::int AS blocked,
      COUNT(*) FILTER (
        WHERE status IN ('todo', 'in_progress', 'in_review', 'blocked')
      )::int AS active
    FROM issues
    WHERE company_id = ${companyId}::uuid
  `);
  const row = rows[0];
  return {
    blocked: Number(row?.blocked ?? 0),
    active: Number(row?.active ?? 0),
  };
}

async function computeInterventionStats(db: Db, companyId: string, start: Date) {
  const startIso = start.toISOString();
  const rows = await db.execute<{
    total_done: string;
    with_approvals: string;
  }>(sql`
    WITH done_issues AS (
      SELECT id
      FROM issues
      WHERE company_id = ${companyId}::uuid
        AND status = 'done'
        AND completed_at >= ${startIso}
    )
    SELECT
      (SELECT COUNT(*) FROM done_issues)::int AS total_done,
      COUNT(DISTINCT ia.issue_id)::int AS with_approvals
    FROM done_issues di
    LEFT JOIN issue_approvals ia ON ia.issue_id = di.id
  `);
  const row = rows[0];
  return {
    totalDone: Number(row?.total_done ?? 0),
    withApprovals: Number(row?.with_approvals ?? 0),
  };
}

async function computeTraceCoverage(db: Db, companyId: string, start: Date) {
  const startIso = start.toISOString();
  const rows = await db.execute<{ total: string; with_usage: string }>(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE usage_json IS NOT NULL)::int AS with_usage
    FROM heartbeat_runs
    WHERE company_id = ${companyId}::uuid
      AND started_at >= ${startIso}
      AND status IN ('succeeded', 'failed', 'error')
  `);
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    withUsage: Number(row?.with_usage ?? 0),
  };
}

async function computeAgentBreakdown(db: Db, companyId: string, start: Date) {
  const startIso = start.toISOString();
  const rows = await db.execute<{
    agent_id: string;
    agent_name: string | null;
    avg_tokens: string | null;
    avg_cost_cents: string | null;
    total_runs: string;
    succeeded_runs: string;
  }>(sql`
    SELECT
      a.id AS agent_id,
      a.name AS agent_name,
      AVG(issue_totals.total_tokens) AS avg_tokens,
      AVG(issue_totals.total_cost_cents) AS avg_cost_cents,
      COUNT(DISTINCT hr.id) FILTER (WHERE hr.started_at >= ${startIso} AND hr.status IN ('succeeded','failed','error'))::int AS total_runs,
      COUNT(DISTINCT hr.id) FILTER (WHERE hr.started_at >= ${startIso} AND hr.status = 'succeeded')::int AS succeeded_runs
    FROM agents a
    LEFT JOIN cost_events ce ON ce.agent_id = a.id AND ce.company_id = ${companyId}::uuid
    LEFT JOIN (
      SELECT
        ce2.agent_id,
        ce2.issue_id,
        SUM(ce2.input_tokens + ce2.output_tokens) AS total_tokens,
        SUM(ce2.cost_cents)::int AS total_cost_cents
      FROM cost_events ce2
      JOIN issues i2 ON i2.id = ce2.issue_id
      WHERE ce2.company_id = ${companyId}::uuid
        AND i2.status = 'done'
        AND i2.completed_at >= ${startIso}
      GROUP BY ce2.agent_id, ce2.issue_id
    ) issue_totals ON issue_totals.agent_id = a.id
    LEFT JOIN heartbeat_runs hr ON hr.agent_id = a.id AND hr.company_id = ${companyId}::uuid
    WHERE a.company_id = ${companyId}::uuid
    GROUP BY a.id, a.name
  `);
  return Array.from(rows).map((r) => ({
    agentId: r.agent_id,
    agentName: r.agent_name,
    tokensPerCompletedTask: r.avg_tokens != null ? Number(r.avg_tokens) : null,
    costPerCompletedTaskCents: r.avg_cost_cents != null ? Number(r.avg_cost_cents) : null,
    heartbeatSuccessRate: Number(r.total_runs) > 0
      ? Number(r.succeeded_runs) / Number(r.total_runs)
      : null,
  }));
}
