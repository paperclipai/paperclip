import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";

export type ModelUsageGroupBy = "model" | "agent" | "provider" | "taskType";

export interface ModelUsageOptions {
  from?: Date;
  to?: Date;
  groupBy?: ModelUsageGroupBy;
}

export interface ModelUsageRow {
  model: string | null;
  provider: string | null;
  agentId: string | null;
  agentName: string | null;
  taskType: string | null;
  runCount: number;
  successCount: number;
  failureCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  estimatedCostCents: number;
  avgLatencyMs: number | null;
  retryCount: number;
  fallbackUsedCount: number;
}

export function analyticsService(db: Db) {
  return {
    modelUsage: async (companyId: string, options: ModelUsageOptions = {}): Promise<ModelUsageRow[]> => {
      const { from, to, groupBy = "model" } = options;

      const fromClause = from ? sql`AND ce.occurred_at >= ${from.toISOString()}::timestamptz` : sql``;
      const toClause = to ? sql`AND ce.occurred_at <= ${to.toISOString()}::timestamptz` : sql``;

      // Each groupBy defines: SELECT fields, GROUP BY keys, DISTINCT ON keys for run dedup, and JOIN condition.
      let costSelect: ReturnType<typeof sql>;
      let costGroupBy: ReturnType<typeof sql>;
      let runDedupDistinctOn: ReturnType<typeof sql>;
      let runDedupOrderBy: ReturnType<typeof sql>;
      let runDedupGroupBy: ReturnType<typeof sql>;
      let joinOn: ReturnType<typeof sql>;

      switch (groupBy) {
        case "agent":
          costSelect = sql`NULL::text AS model, NULL::text AS provider, ce.agent_id, a.name AS agent_name, NULL::text AS task_type`;
          costGroupBy = sql`ce.agent_id, a.name`;
          runDedupDistinctOn = sql`ce.heartbeat_run_id, ce.agent_id`;
          runDedupOrderBy = sql`ce.heartbeat_run_id, ce.agent_id, ce.id`;
          runDedupGroupBy = sql`agent_id`;
          joinOn = sql`ra.agent_id = ca.agent_id`;
          break;
        case "provider":
          costSelect = sql`NULL::text AS model, ce.provider, NULL::uuid AS agent_id, NULL::text AS agent_name, NULL::text AS task_type`;
          costGroupBy = sql`ce.provider`;
          runDedupDistinctOn = sql`ce.heartbeat_run_id, ce.provider`;
          runDedupOrderBy = sql`ce.heartbeat_run_id, ce.provider, ce.id`;
          runDedupGroupBy = sql`provider`;
          joinOn = sql`ra.provider = ca.provider`;
          break;
        case "taskType":
          costSelect = sql`NULL::text AS model, NULL::text AS provider, NULL::uuid AS agent_id, NULL::text AS agent_name, ce.billing_type AS task_type`;
          costGroupBy = sql`ce.billing_type`;
          runDedupDistinctOn = sql`ce.heartbeat_run_id, ce.billing_type`;
          runDedupOrderBy = sql`ce.heartbeat_run_id, ce.billing_type, ce.id`;
          runDedupGroupBy = sql`task_type`;
          joinOn = sql`ra.task_type = ca.task_type`;
          break;
        default: // model
          costSelect = sql`ce.model, ce.provider, NULL::uuid AS agent_id, NULL::text AS agent_name, NULL::text AS task_type`;
          costGroupBy = sql`ce.model, ce.provider`;
          runDedupDistinctOn = sql`ce.heartbeat_run_id, ce.model, ce.provider`;
          runDedupOrderBy = sql`ce.heartbeat_run_id, ce.model, ce.provider, ce.id`;
          runDedupGroupBy = sql`model, provider`;
          joinOn = sql`ra.model = ca.model AND ra.provider = ca.provider`;
          break;
      }

      // Two CTEs to avoid double-counting run durations across multiple cost_events per run.
      // cost_agg sums tokens/cost from cost_events directly.
      // run_dedup picks one row per (run, group-key) so avgLatencyMs and retryCount aren't inflated.
      const result = await db.execute<{
        model: string | null;
        provider: string | null;
        agent_id: string | null;
        agent_name: string | null;
        task_type: string | null;
        run_count: string;
        success_count: string;
        failure_count: string;
        total_tokens_in: string;
        total_tokens_out: string;
        estimated_cost_cents: string;
        avg_latency_ms: string | null;
        retry_count: string;
      }>(sql`
        WITH cost_agg AS (
          SELECT
            ${costSelect},
            SUM(ce.input_tokens + ce.cached_input_tokens) AS total_tokens_in,
            SUM(ce.output_tokens) AS total_tokens_out,
            SUM(ce.cost_cents) AS estimated_cost_cents
          FROM cost_events ce
          LEFT JOIN agents a ON ce.agent_id = a.id
          WHERE ce.company_id = ${companyId}
            ${fromClause}
            ${toClause}
          GROUP BY ${costGroupBy}
        ),
        run_dedup AS (
          SELECT DISTINCT ON (${runDedupDistinctOn})
            ce.heartbeat_run_id,
            ce.model,
            ce.provider,
            ce.agent_id,
            ce.billing_type AS task_type,
            hr.status,
            CASE
              WHEN hr.finished_at IS NOT NULL AND hr.started_at IS NOT NULL
              THEN EXTRACT(EPOCH FROM (hr.finished_at - hr.started_at)) * 1000
              ELSE NULL
            END AS latency_ms,
            COALESCE(hr.process_loss_retry_count, 0) AS retry_val
          FROM cost_events ce
          LEFT JOIN heartbeat_runs hr ON ce.heartbeat_run_id = hr.id
          WHERE ce.company_id = ${companyId}
            ${fromClause}
            ${toClause}
          ORDER BY ${runDedupOrderBy}
        ),
        run_agg AS (
          SELECT
            ${runDedupGroupBy},
            COUNT(*)::int AS run_count,
            COUNT(CASE WHEN status = 'done' THEN 1 END)::int AS success_count,
            COUNT(CASE WHEN status IS NOT NULL AND status != 'done' THEN 1 END)::int AS failure_count,
            ROUND(AVG(latency_ms))::int AS avg_latency_ms,
            SUM(retry_val)::int AS retry_count
          FROM run_dedup
          GROUP BY ${runDedupGroupBy}
        )
        SELECT
          ca.model,
          ca.provider,
          ca.agent_id,
          ca.agent_name,
          ca.task_type,
          COALESCE(ra.run_count, 0) AS run_count,
          COALESCE(ra.success_count, 0) AS success_count,
          COALESCE(ra.failure_count, 0) AS failure_count,
          ca.total_tokens_in,
          ca.total_tokens_out,
          ca.estimated_cost_cents,
          ra.avg_latency_ms,
          COALESCE(ra.retry_count, 0) AS retry_count
        FROM cost_agg ca
        LEFT JOIN run_agg ra ON ${joinOn}
        ORDER BY ca.estimated_cost_cents DESC
      `);

      const rows = Array.isArray(result) ? result : [];
      return rows.map((row) => ({
        model: row.model ?? null,
        provider: row.provider ?? null,
        agentId: row.agent_id ?? null,
        agentName: row.agent_name ?? null,
        taskType: row.task_type ?? null,
        runCount: Number(row.run_count ?? 0),
        successCount: Number(row.success_count ?? 0),
        failureCount: Number(row.failure_count ?? 0),
        totalTokensIn: Number(row.total_tokens_in ?? 0),
        totalTokensOut: Number(row.total_tokens_out ?? 0),
        estimatedCostCents: Number(row.estimated_cost_cents ?? 0),
        avgLatencyMs: row.avg_latency_ms != null ? Number(row.avg_latency_ms) : null,
        retryCount: Number(row.retry_count ?? 0),
        fallbackUsedCount: 0,
      }));
    },
  };
}
